/**
 * Tests MULTI-SALA (env `RCON_SALAS`): endpoint público GET /api/salas (fake
 * RCON de 2 salas), enforcer/launcher-only que cubren AMBAS salas y moderación
 * que resuelve en qué sala está el jugador. Además compat: sin RCON_SALAS todo
 * queda en modo server único (los tests legacy de moderation/launcher-enforcer
 * ya cubren ese camino).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { registerUser, req, resetDb } from './helpers.js';
import { hexGuidToDecimal, resetSharedRcon } from '../src/lib/rcon/iw4x-rcon.js';
import { resetSalasRcon } from '../src/lib/rcon/salas.js';
import { runEnforcerTick, runLauncherOnlyTick } from '../src/services/enforcer.service.js';
import { FakeRconServer, LIVE_STATUS_FIXTURE } from './fake-rcon.js';

const PASSWORD = 'test-rcon-pass';
const HUMAN1_HEX = 'AB12CD34EF567890'; // humano del fixture sala1 (slot 0)
const HUMAN1_DEC = hexGuidToDecimal(HUMAN1_HEX)!;
const HUMAN2_HEX = '0F0E0D0C0B0A0908'; // humano del fixture sala2 (slot 0)
const HUMAN2_DEC = hexGuidToDecimal(HUMAN2_HEX)!;
const EXPECTED_LAUNCHER_MSG = 'Este server exige el launcher IW4x Ranking - entra desde www.tuweb (descarga en la web)';

/** Fixture de status de sala2: humano (slot 0) + bot (slot 1), mapa distinto. */
const SALA2_STATUS_FIXTURE = [
  'map: mp_crash',
  'num score ping guid                             name            lastmsg address               qport rate',
  '--- ----- ---- -------------------------------- --------------- ------- --------------------- ----- -----',
  '  0   200   45 0F0E0D0C0B0A0908 Sala^2Dos^7Guy           42 192.168.3.60:28961    21    25000',
  '  1     0  999 bot7 RektSala2^7          9000 00000000.000000000000:3840   16 99999',
  '',
].join('\n');

const SALA1_INFOSTRING =
  '\\hostname\\^7[^1RANKING^7] ^7CTHolguin Sala 1\\gamename\\IW4\\clients\\3\\bots\\2\\sv_maxclients\\18\\gametype\\war\\mapname\\mp_terminal';
const SALA2_INFOSTRING =
  '\\hostname\\^7[^1RANKING^7] ^7CTHolguin Sala 2\\gamename\\IW4\\clients\\2\\bots\\1\\sv_maxclients\\12\\gametype\\war\\mapname\\mp_crash';

let fake1: FakeRconServer;
let fake2: FakeRconServer;
let adminToken = '';
let human1PlayerId = 0;
let human2PlayerId = 0;

const SAVED_ENV: Record<string, string | undefined> = {
  RCON_HOST: process.env.RCON_HOST,
  RCON_PORT: process.env.RCON_PORT,
  RCON_PASSWORD: process.env.RCON_PASSWORD,
  RCON_SALAS: process.env.RCON_SALAS,
  RCON_SPACING_MS: process.env.RCON_SPACING_MS,
  RCON_RESPONSE_TIMEOUT_MS: process.env.RCON_RESPONSE_TIMEOUT_MS,
};

/** Configura la env multi-sala hacia los DOS fakes (JSON con puertos efímeros). */
function useSalas(options: { address1?: string } = {}): void {
  const salas: Array<Record<string, unknown>> = [
    {
      id: 'sala1',
      name: 'CTHolguin Sala 1',
      host: '127.0.0.1',
      port: fake1.port,
      rconPassword: PASSWORD,
      ...(options.address1 !== undefined ? { address: options.address1 } : {}),
    },
    { id: 'sala2', name: 'CTHolguin Sala 2', host: '127.0.0.1', port: fake2.port, rconPassword: PASSWORD },
  ];
  process.env.RCON_SALAS = JSON.stringify(salas);
}

beforeAll(async () => {
  for (const [key, value] of Object.entries(SAVED_ENV)) delete process.env[key];
  await resetDb();

  const admin = await registerUser('salas-admin@test.local', 'supersecret123', 'Salas Admin');
  await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
  const login = await req().post('/api/auth/login').send({ identifier: 'Salas Admin', password: 'supersecret123' });
  adminToken = (login.body as { token: string }).token;

  human1PlayerId = (await prisma.player.create({ data: { guid: HUMAN1_DEC, name: '^1Toxic^7Player' } })).id;
  human2PlayerId = (await prisma.player.create({ data: { guid: HUMAN2_DEC, name: 'SalaDosGuy' } })).id;
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
  resetSalasRcon();
  fake1 = new FakeRconServer({ password: PASSWORD, statusText: LIVE_STATUS_FIXTURE, infostring: SALA1_INFOSTRING });
  fake2 = new FakeRconServer({ password: PASSWORD, statusText: SALA2_STATUS_FIXTURE, infostring: SALA2_INFOSTRING });
  await Promise.all([fake1.start(), fake2.start()]);
  useSalas();
  // El modo legacy (RCON_HOST/RCON_PORT) NO se usa en estos tests: la fuente
  // es RCON_SALAS. RCON_PASSWORD suelto queda sin definir para probar que la
  // moderación también funciona solo con los passwords por sala.
  delete process.env.RCON_PASSWORD;
  process.env.RCON_SPACING_MS = '15';
  process.env.RCON_RESPONSE_TIMEOUT_MS = '200';
  await prisma.penalty.deleteMany();
  await prisma.playSession.deleteMany();
  await prisma.setting.deleteMany();
});

afterEach(async () => {
  resetSharedRcon();
  resetSalasRcon();
  await Promise.all([fake1.stop(), fake2.stop()]);
});

// ── GET /api/salas (público, sin auth) ──────────────────────────────────────

describe('GET /api/salas (público)', () => {
  it('sin RCON_SALAS → 200 {configured:false, salas:[]} sin auth', async () => {
    delete process.env.RCON_SALAS;
    const res = await req().get('/api/salas');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: false, salas: [] });
  });

  it('RCON_SALAS con basura (no JSON) → configured:false (fallback seguro)', async () => {
    process.env.RCON_SALAS = 'no-soy-json';
    const res = await req().get('/api/salas');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: false, salas: [] });
  });

  it('combina 2 salas online en paralelo: desglose humanos/bots por sala y SIN rconPassword', async () => {
    const res = await req().get('/api/salas'); // SIN header Authorization
    expect(res.status).toBe(200);
    const body = res.body as {
      configured: boolean;
      salas: Array<{ id: string; name: string; address: string; online: boolean; hostname: string | null; map: string | null; gametype: string | null; players: number | null; bots: number | null; maxClients: number | null }>;
    };
    expect(body.configured).toBe(true);
    expect(body.salas).toHaveLength(2);

    const sala1 = body.salas.find((sala) => sala.id === 'sala1')!;
    expect(sala1.online).toBe(true);
    expect(sala1.name).toBe('CTHolguin Sala 1');
    expect(sala1.address).toBe(`127.0.0.1:${fake1.port}`);
    expect(sala1.hostname).toBe('^7[^1RANKING^7] ^7CTHolguin Sala 1');
    expect(sala1.map).toBe('mp_terminal'); // del status (getinfo manda solo en fallback)
    expect(sala1.gametype).toBe('war');
    expect(sala1.players).toBe(1); // 1 humano (ToxicPlayer)
    expect(sala1.bots).toBe(2); // bot15 + bot16
    expect(sala1.maxClients).toBe(18);

    const sala2 = body.salas.find((sala) => sala.id === 'sala2')!;
    expect(sala2.online).toBe(true);
    expect(sala2.map).toBe('mp_crash');
    expect(sala2.players).toBe(1);
    expect(sala2.bots).toBe(1);
    expect(sala2.maxClients).toBe(12);

    // Datos sensibles NUNCA en la respuesta pública.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('rconPassword');
    expect(raw).not.toContain(PASSWORD);
  });

  it('address opcional de la sala (pública) pisa el host:port de RCON', async () => {
    useSalas({ address1: '192.168.2.251:28960' });
    const res = await req().get('/api/salas');
    expect(res.status).toBe(200);
    const body = res.body as { salas: Array<{ id: string; address: string }> };
    expect(body.salas.find((sala) => sala.id === 'sala1')!.address).toBe('192.168.2.251:28960');
    expect(body.salas.find((sala) => sala.id === 'sala2')!.address).toBe(`127.0.0.1:${fake2.port}`);
  });

  it('sala sin respuesta (timeout) → online:false y el RESTO null; la otra sala intacta', async () => {
    await fake2.stop(); // sala2 caída
    const res = await req().get('/api/salas');
    expect(res.status).toBe(200);
    const body = res.body as { salas: Array<{ id: string; online: boolean; hostname: unknown; map: unknown; gametype: unknown; players: unknown; bots: unknown; maxClients: unknown }> };
    const sala1 = body.salas.find((sala) => sala.id === 'sala1')!;
    expect(sala1.online).toBe(true);
    expect(sala1.players).toBe(1);
    const sala2 = body.salas.find((sala) => sala.id === 'sala2')!;
    expect(sala2.online).toBe(false);
    expect(sala2.hostname).toBeNull();
    expect(sala2.map).toBeNull();
    expect(sala2.gametype).toBeNull();
    expect(sala2.players).toBeNull();
    expect(sala2.bots).toBeNull();
    expect(sala2.maxClients).toBeNull();
  });
});

// ── Enforcer multi-sala (bans/tempbans de la DB) ────────────────────────────

describe('enforcer multi-sala', () => {
  it('kickea al guid baneado SOLO en la sala donde está conectado', async () => {
    await prisma.penalty.create({
      data: { offenderGuid: HUMAN2_DEC, offenderName: 'SalaDosGuy', type: 'ban', reason: 'cheat', active: true },
    });
    const kicks = await runEnforcerTick();
    expect(kicks).toBe(1);
    // sala2: status + clientkick del slot 0.
    expect(fake2.commandsWith('clientkick 0')).toHaveLength(1);
    // sala1: recibió su status (el tick consulta TODAS) pero NINGÚN kick.
    expect(fake1.commandsWith('status').length).toBeGreaterThanOrEqual(1);
    expect(fake1.commandsWith('clientkick')).toHaveLength(0);
  });

  it('guid conectado en AMBAS salas → kickeado en las dos', async () => {
    // El guid de HUMAN1 aparece en sala1 (fixture) y lo metemos también en sala2.
    fake2.setStatusText(LIVE_STATUS_FIXTURE);
    await prisma.penalty.create({
      data: { offenderGuid: HUMAN1_DEC, offenderName: 'ToxicPlayer', type: 'tempban', reason: 'exploit', active: true, expiresAt: new Date(Date.now() + 60_000) },
    });
    const kicks = await runEnforcerTick();
    expect(kicks).toBe(2);
    expect(fake1.commandsWith('clientkick 0')).toHaveLength(1);
    expect(fake2.commandsWith('clientkick 0')).toHaveLength(1);
  });

  it('una sala caída no bloquea la otra: kicks de la sala viva igual se envían', async () => {
    await fake2.stop();
    await prisma.penalty.create({
      data: { offenderGuid: HUMAN1_DEC, offenderName: 'ToxicPlayer', type: 'ban', reason: 'cheat', active: true },
    });
    const kicks = await runEnforcerTick();
    expect(kicks).toBe(1);
    expect(fake1.commandsWith('clientkick 0')).toHaveLength(1);
  });
});

// ── Enforcer launcher-only multi-sala ───────────────────────────────────────

describe('launcher-only multi-sala', () => {
  it('ON sin sesiones: tell+clientkick al humano de CADA sala; bots y slots de bots exentos', async () => {
    await prisma.setting.create({ data: { key: 'launcher_only', value: JSON.stringify({ enabled: true }) } });
    const kicks = await runLauncherOnlyTick();
    expect(kicks).toBe(2); // 1 humano por sala

    const msg1 = fake1.commandsWith(`tell 0 ${EXPECTED_LAUNCHER_MSG}`);
    const msg2 = fake2.commandsWith(`tell 0 ${EXPECTED_LAUNCHER_MSG}`);
    expect(msg1).toHaveLength(1);
    expect(msg2).toHaveLength(1);
    expect(fake1.commandsWith('clientkick 0')).toHaveLength(1);
    expect(fake2.commandsWith('clientkick 0')).toHaveLength(1);
    // Solo el humano de cada sala: slots de bots (1 y 2 en sala1; 1 en sala2) intactos.
    expect(fake1.commandsWith('clientkick').map((entry) => entry.command)).toEqual(['clientkick 0']);
    expect(fake2.commandsWith('clientkick').map((entry) => entry.command)).toEqual(['clientkick 0']);
  });

  it('sesión activa por guid del jugador de sala2 → sala1 kickea, sala2 NO', async () => {
    await prisma.setting.create({ data: { key: 'launcher_only', value: JSON.stringify({ enabled: true }) } });
    const owner = await registerUser('salas-with-session@test.local', 'supersecret123', 'Sala Dos Guy');
    await prisma.playSession.create({
      data: { userId: owner.id, nick: 'SalaDosGuy', guid: HUMAN2_DEC, lastSeen: new Date(), expiresAt: new Date(Date.now() + 5 * 60_000) },
    });
    const kicks = await runLauncherOnlyTick();
    expect(kicks).toBe(1);
    expect(fake2.commandsWith('clientkick')).toHaveLength(0);
    expect(fake1.commandsWith('clientkick 0')).toHaveLength(1);
  });
});

// ── Moderación multi-sala (kick/tempban/ban resuelven la sala) ──────────────

const errorBody = (body: unknown): { code: string; message: string } =>
  (body as { error: { code: string; message: string } }).error;

describe('moderación multi-sala', () => {
  it('kick por clientId conectado SOLO en sala2 → clientkick en sala2 (jamás en sala1) + output con sala', async () => {
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: human2PlayerId, type: 'kick', reason: 'tk intencional' });
    expect(res.status).toBe(200);
    const body = res.body as { executed: boolean; output: string[] };
    expect(body.executed).toBe(true);
    expect(fake2.commandsWith('clientkick 0')).toHaveLength(1);
    expect(fake1.commandsWith('clientkick')).toHaveLength(0); // sala1 NUNCA recibe el kick
    expect(body.output.some((line) => line.includes('[sala2]') && line.includes('clientkick 0'))).toBe(true);
    const penalty = await prisma.penalty.findFirst({ where: { type: 'kick' } });
    expect(penalty!.offenderGuid).toBe(HUMAN2_DEC);
  });

  it('kick por clientName (match exacto limpio) conectado en sala1 → aplica en sala1', async () => {
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientName: 'ToxicPlayer', type: 'kick', reason: 'afk abuso' });
    expect(res.status).toBe(200);
    expect(fake1.commandsWith('clientkick 0')).toHaveLength(1);
    expect(fake2.commandsWith('clientkick')).toHaveLength(0);
  });

  it('guid conectado en AMBAS salas → la acción (warn) aplica en las dos', async () => {
    fake2.setStatusText(LIVE_STATUS_FIXTURE); // ToxicPlayer también en sala2 (slot 0)
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: human1PlayerId, type: 'warn', reason: 'cuida el lenguaje' });
    expect(res.status).toBe(200);
    const body = res.body as { output: string[] };
    expect(fake1.commandsWith('tell 0')).toHaveLength(1);
    expect(fake2.commandsWith('tell 0')).toHaveLength(1);
    expect(body.output.filter((line) => line.includes('tell 0'))).toHaveLength(2);
    expect(body.output.some((line) => line.startsWith('[sala1]'))).toBe(true);
    expect(body.output.some((line) => line.startsWith('[sala2]'))).toBe(true);
  });

  it('cid con jugador en AMBAS salas → 400 ambiguo (pide clientId/clientName)', async () => {
    fake2.setStatusText(LIVE_STATUS_FIXTURE); // slot 0 ocupado en ambas
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cid: 0, type: 'kick', reason: 'slot ambiguo' });
    expect(res.status).toBe(400);
    expect(errorBody(res.body).code).toBe('VALIDATION_ERROR');
    expect(errorBody(res.body).message).toContain('salas');
    expect(fake1.commandsWith('clientkick')).toHaveLength(0);
    expect(fake2.commandsWith('clientkick')).toHaveLength(0);
  });

  it('tempban OFFLINE (guid en ninguna sala) → sin writes + Penalty activa (el enforcer cubre ambas)', async () => {
    const offline = await prisma.player.create({ data: { guid: '77777777777777777', name: 'OfflineSala' } });
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: offline.id, type: 'tempban', durationMinutes: 15, reason: 'exploit offline' });
    expect(res.status).toBe(200);
    expect(fake1.commandsWith('clientkick')).toHaveLength(0);
    expect(fake2.commandsWith('clientkick')).toHaveLength(0);
    const penalty = await prisma.penalty.findFirst({ where: { type: 'tempban', offenderGuid: '77777777777777777' } });
    expect(penalty!.active).toBe(true);
  });

  it('unban barre TODAS las salas (cada una tiene su bans.json)', async () => {
    const res = await req()
      .post('/api/admin/iam/unban')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ guid: HUMAN2_HEX });
    expect(res.status).toBe(200);
    expect(fake1.commandsWith(`unbanClient guid ${HUMAN2_HEX}`)).toHaveLength(1);
    expect(fake2.commandsWith(`unbanClient guid ${HUMAN2_HEX}`)).toHaveLength(1);
    const body = res.body as { output: string[] };
    expect(body.output.filter((line) => line.includes('unbanClient guid'))).toHaveLength(2);
  });

  it('GET /api/admin/iam/status multi-sala → una entrada por sala (id estable por host:port)', async () => {
    const res = await req().get('/api/admin/iam/status').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      configured: boolean;
      reachable: boolean;
      servers: Array<{ id: number; name: string; players: number; maxPlayers: number }>;
    };
    expect(body.configured).toBe(true);
    expect(body.reachable).toBe(true);
    expect(body.servers).toHaveLength(2);
    const byName = new Map(body.servers.map((server) => [server.name, server]));
    expect(byName.get('^7[^1RANKING^7] ^7CTHolguin Sala 1')).toMatchObject({ players: 3, maxPlayers: 18 });
    expect(byName.get('^7[^1RANKING^7] ^7CTHolguin Sala 2')).toMatchObject({ players: 2, maxPlayers: 12 });
    // Sin RCON_PASSWORD suelto la moderación sigue configurada: viene de RCON_SALAS.
  });

  it('GET /api/admin/iam/live multi-sala → 2 servers con players y clientId resuelto', async () => {
    const res = await req().get('/api/admin/iam/live').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      servers: Array<{ id: number; name: string; online: boolean; players: Array<{ guid: string; clientId: number | null }> }>;
    };
    expect(body.servers).toHaveLength(2);
    const sala2 = body.servers.find((server) => server.name === '^7[^1RANKING^7] ^7CTHolguin Sala 2')!;
    expect(sala2.online).toBe(true);
    expect(sala2.players).toHaveLength(2);
    const human2 = sala2.players.find((player) => player.guid === HUMAN2_DEC)!;
    expect(human2.clientId).toBe(human2PlayerId);
  });

  it('todas las salas caídas → 502 MODERATION_UNREACHABLE', async () => {
    await Promise.all([fake1.stop(), fake2.stop()]);
    resetSalasRcon();
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientName: 'ToxicPlayer', type: 'kick', reason: 'salas caidas' });
    expect(res.status).toBe(502);
    expect(errorBody(res.body).code).toBe('MODERATION_UNREACHABLE');
  });

  it('503 MODERATION_NOT_CONFIGURED sin RCON_PASSWORD ni RCON_SALAS', async () => {
    delete process.env.RCON_SALAS;
    delete process.env.RCON_PASSWORD;
    resetSalasRcon();
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: human1PlayerId, type: 'warn', reason: 'sin configuracion' });
    expect(res.status).toBe(503);
    expect(errorBody(res.body).code).toBe('MODERATION_NOT_CONFIGURED');
  });
});
