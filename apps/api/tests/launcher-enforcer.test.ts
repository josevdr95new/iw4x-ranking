/**
 * Tests del ENFORCER launcher-only (anti no-launcher) contra un FakeRconServer.
 * Reglas verificadas:
 *  - OFF → cero comandos rcon (ni lecturas).
 *  - ON → kick (tell + clientkick) SOLO a humanos sin sesión activa; bots y
 *    CNCT/conectando SIEMPRE exentos; cobertura por guid O por nick normalizado.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { registerUser, resetDb } from './helpers.js';
import { resetSharedRcon } from '../src/lib/rcon/iw4x-rcon.js';
import { runLauncherOnlyTick } from '../src/services/enforcer.service.js';
import { FakeRconServer, CONNECTING_STATUS_FIXTURE, LIVE_STATUS_FIXTURE } from './fake-rcon.js';

const PASSWORD = 'test-rcon-pass';
const HUMAN_HEX = 'AB12CD34EF567890';
const HUMAN_DEC = BigInt(`0x${HUMAN_HEX}`).toString(10);
const EXPECTED_MSG = 'Este server exige el launcher IW4x Ranking - entra desde www.tuweb (descarga en la web)';

let fake: FakeRconServer;
const SAVED_ENV: Record<string, string | undefined> = {
  RCON_HOST: process.env.RCON_HOST,
  RCON_PORT: process.env.RCON_PORT,
  RCON_PASSWORD: process.env.RCON_PASSWORD,
  RCON_SPACING_MS: process.env.RCON_SPACING_MS,
  RCON_RESPONSE_TIMEOUT_MS: process.env.RCON_RESPONSE_TIMEOUT_MS,
};

beforeAll(async () => {
  for (const [key, value] of Object.entries(SAVED_ENV)) delete process.env[key];
  await resetDb();
});

afterAll(async () => {
  await resetDb();
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(async () => {
  resetSharedRcon();
  fake = new FakeRconServer({ password: PASSWORD, statusText: LIVE_STATUS_FIXTURE });
  await fake.start();
  process.env.RCON_HOST = '127.0.0.1';
  process.env.RCON_PORT = String(fake.port);
  process.env.RCON_PASSWORD = PASSWORD;
  process.env.RCON_SPACING_MS = '15';
  process.env.RCON_RESPONSE_TIMEOUT_MS = '200';
  await prisma.playSession.deleteMany();
  await prisma.setting.deleteMany();
  await prisma.user.deleteMany();
  await prisma.user.deleteMany(); // FK cascade
});

afterEach(async () => {
  resetSharedRcon();
  await fake.stop();
});

async function createSessionWithGuid(guid: string): Promise<void> {
  const owner = await registerUser(`enf-${Math.random().toString(36).slice(2, 8)}@test.local`, 'supersecret123', `Enf ${Math.random().toString(36).slice(2, 8)}`);
  await prisma.playSession.create({
    data: { userId: owner.id, nick: owner.id.toString(), guid, lastSeen: new Date(), expiresAt: new Date(Date.now() + 5 * 60_000) },
  });
}

async function createSessionWithNick(nick: string): Promise<void> {
  const owner = await registerUser(`enf-${Math.random().toString(36).slice(2, 8)}@test.local`, 'supersecret123', nick);
  await prisma.playSession.create({
    data: { userId: owner.id, nick, guid: null, lastSeen: new Date(), expiresAt: new Date(Date.now() + 5 * 60_000) },
  });
}

describe('runLauncherOnlyTick', () => {
  it('OFF (default) → NINGÚN comando rcon (ni siquiera status)', async () => {
    const kicks = await runLauncherOnlyTick();
    expect(kicks).toBe(0);
    expect(fake.received).toHaveLength(0);
  });

  it('ON + humano SIN sesión → tell <cid> con el mensaje EXACTO + clientkick <cid>; bots exentos', async () => {
    await prisma.setting.create({ data: { key: 'launcher_only', value: JSON.stringify({ enabled: true }) } });
    // Sin ninguna PlaySession: el humano del fixture (slot 0) debe caer.
    const kicks = await runLauncherOnlyTick();
    expect(kicks).toBe(1);

    const commands = fake.received.map((entry) => entry.command);
    expect(commands).toContain('status');
    expect(commands).toContain(`tell 0 ${EXPECTED_MSG}`);
    expect(commands).toContain('clientkick 0');
    // Los bots (slots 1 y 2) NUNCA se kickean.
    expect(commands.filter((c) => c.startsWith('clientkick'))).toEqual(['clientkick 0']);
    expect(commands.filter((c) => c.startsWith('tell'))).toHaveLength(1);
  });

  it('ON + humano con sesión por GUID → sin kicks', async () => {
    await prisma.setting.create({ data: { key: 'launcher_only', value: JSON.stringify({ enabled: true }) } });
    await createSessionWithGuid(HUMAN_DEC);
    const kicks = await runLauncherOnlyTick();
    expect(kicks).toBe(0);
    expect(fake.commandsWith('clientkick')).toHaveLength(0);
    expect(fake.commandsWith('tell ')).toHaveLength(0);
  });

  it('ON + humano con sesión por NICK (match normalizado, sin guid) → sin kicks', async () => {
    await prisma.setting.create({ data: { key: 'launcher_only', value: JSON.stringify({ enabled: true }) } });
    // Nombre del fixture: '^1Toxic^7Player' → normalizado 'toxicplayer'.
    await createSessionWithNick('ToxicPlayer');
    const kicks = await runLauncherOnlyTick();
    expect(kicks).toBe(0);
    expect(fake.commandsWith('clientkick')).toHaveLength(0);
  });

  it('ON + sesión EXPIRADA → el humano SÍ se kickea', async () => {
    await prisma.setting.create({ data: { key: 'launcher_only', value: JSON.stringify({ enabled: true }) } });
    const owner = await registerUser('enf-expired@test.local', 'supersecret123', 'ToxicPlayer');
    await prisma.playSession.create({
      data: { userId: owner.id, nick: 'ToxicPlayer', guid: null, lastSeen: new Date(Date.now() - 30 * 60_000), expiresAt: new Date(Date.now() - 20 * 60_000) },
    });
    const kicks = await runLauncherOnlyTick();
    expect(kicks).toBe(1);
    expect(fake.commandsWith('clientkick 0')).toHaveLength(1);
  });

  it('CNCT/conectando → gracia: sin kicks (fila corta del fixture)', async () => {
    fake.setStatusText(CONNECTING_STATUS_FIXTURE);
    await prisma.setting.create({ data: { key: 'launcher_only', value: JSON.stringify({ enabled: true }) } });
    // Sin sesiones: el CNCT (slot 3) NO debe caer; el humano conectado slot 4 SÍ.
    const kicks = await runLauncherOnlyTick();
    expect(kicks).toBe(1);
    const kickCommands = fake.commandsWith('clientkick').map((entry) => entry.command);
    expect(kickCommands).toEqual(['clientkick 4']); // solo el humano establecido
  });

  it('Bots SIEMPRE exentos incluso sin ninguna sesión (fixture solo-bots no kickea nada)', async () => {
    const botsOnly = [
      'map: mp_rust',
      'num score ping guid                             name            lastmsg address               qport rate',
      '--- ----- ---- -------------------------------- --------------- ------- --------------------- ----- -----',
      '  1     0  999 bot15 RektInator^7         9450 00000000.000000000000:3840   16 99999',
      '',
    ].join('\n');
    fake.setStatusText(botsOnly);
    await prisma.setting.create({ data: { key: 'launcher_only', value: JSON.stringify({ enabled: true }) } });
    const kicks = await runLauncherOnlyTick();
    expect(kicks).toBe(0);
    expect(fake.commandsWith('clientkick')).toHaveLength(0);
  });

  it('sin RCON configurado + ON → no explota (0 kicks)', async () => {
    await prisma.setting.create({ data: { key: 'launcher_only', value: JSON.stringify({ enabled: true }) } });
    delete process.env.RCON_PASSWORD;
    resetSharedRcon();
    const kicks = await runLauncherOnlyTick();
    expect(kicks).toBe(0);
  });
});
