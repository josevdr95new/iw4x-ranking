/**
 * Tests de BOTS (lectura de dvars por rcon, dificultad y conteo) contra
 * FakeRconServer. Wire-format EXACTO: `set <dvar> <valor>`, `spawnBot <n>`,
 * `clientkick <cid>` de bots sobrantes; parseo del formato REAL de lectura
 * (verificado en vivo: `"dvar" is: "valor^7" default: "def^7"`).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { registerUser, req, resetDb } from './helpers.js';
import { resetSharedRcon } from '../src/lib/rcon/iw4x-rcon.js';
import { parseDvarReply } from '../src/services/server-bots.service.js';
import { FakeRconServer, LIVE_STATUS_FIXTURE } from './fake-rcon.js';

const PASSWORD = 'test-rcon-pass';
let fake: FakeRconServer;
let adminToken = '';

/** Fixture con 3 bots (cids 1,2,3) y 1 humano (cid 0). */
const STATUS_3_BOTS = [
  'map: mp_rust',
  'num score ping guid                             name            lastmsg address               qport rate',
  '--- ----- ---- -------------------------------- --------------- ------- --------------------- ----- -----',
  '  0  1250   30 AB12CD34EF567890 ^1Toxic^7Player            15 192.168.3.50:28960    20    25000',
  '  1     0  999 bot15 RektInator^7         9450 00000000.000000000000:3840   16 99999',
  '  2     0  999 bot16 Diamante^7           8950 00000000.000000000000:4096   17 99999',
  '  3     0  999 bot17 Laupetin^7            8900 00000000.000000000000:4100   18 99999',
  '',
].join('\n');

/** Fixture solo humanos (0 bots). */
const STATUS_0_BOTS = [
  'map: mp_crash',
  'num score ping guid                             name            lastmsg address               qport rate',
  '--- ----- ---- -------------------------------- --------------- ------- --------------------- ----- -----',
  '  0  1250   30 AB12CD34EF567890 ^1Toxic^7Player            15 192.168.3.50:28960    20    25000',
  '',
].join('\n');

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
  const admin = await registerUser('bots-admin@test.local', 'supersecret123', 'Bots Admin');
  await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
  const login = await req().post('/api/auth/login').send({ identifier: 'Bots Admin', password: 'supersecret123' });
  adminToken = (login.body as { token: string }).token;
});

afterAll(async () => {
  await resetDb();
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function useFake(server: FakeRconServer): void {
  process.env.RCON_HOST = '127.0.0.1';
  process.env.RCON_PORT = String(server.port);
  process.env.RCON_PASSWORD = PASSWORD;
  process.env.RCON_SPACING_MS = '15';
  process.env.RCON_RESPONSE_TIMEOUT_MS = '200';
}

/** Respuestas canned CON el formato real capturado en vivo (valor con ^7 + Domain). */
const DVAR_RESPONSES: Record<string, string> = {
  bots_skill: '"bots_skill" is: "2^7" default: "0^7"\n',
  bots_skill_min: '"bots_skill_min" is: "1^7" default: "1^7"\n',
  bots_skill_max: '"bots_skill_max" is: "7^7" default: "7^7"\n',
  sv_randomBotNames: '"sv_randomBotNames" is: "1^7" default: "0^7"\n  Domain is 0 or 1\n',
  sv_replaceBots: '"sv_replaceBots" is: "1^7" default: "0^7"\n  Domain is 0 or 1\n',
};

beforeEach(async () => {
  resetSharedRcon();
  fake = new FakeRconServer({ password: PASSWORD, statusText: LIVE_STATUS_FIXTURE, dvarResponses: { ...DVAR_RESPONSES } });
  await fake.start();
  useFake(fake);
});

afterEach(async () => {
  resetSharedRcon();
  await fake.stop();
});

describe('parseDvarReply (formato wire real)', () => {
  it('parsea `"x" is: "v^7" default: "d^7"` limpiando códigos de color y tolerando línea Domain', () => {
    const parsed = parseDvarReply('"sv_randomBotNames" is: "1^7" default: "0^7"\n  Domain is 0 or 1\n');
    expect(parsed).toEqual({ name: 'sv_randomBotNames', value: '1', default: '0' });
  });

  it('dvar inexistente (`Unknown command "x"`) → null', () => {
    expect(parseDvarReply('Unknown command "bots_skill"\n')).toBeNull();
    expect(parseDvarReply('')).toBeNull();
  });
});

describe('GET /api/admin/server/bots', () => {
  it('shape {count, difficulty, dvars}: count del status + dvar parseada + dvars leídas', async () => {
    const res = await req().get('/api/admin/server/bots').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      count: number;
      difficulty: { dvar: string; value: string | null; default: string | null; found: boolean; note: string };
      dvars: Record<string, string | null>;
    };
    expect(body.count).toBe(2); // bot15 y bot16 del fixture
    expect(body.difficulty.dvar).toBe('bots_skill');
    expect(body.difficulty.value).toBe('2');
    expect(body.difficulty.default).toBe('0');
    expect(body.difficulty.found).toBe(true);
    expect(body.dvars.bots_skill).toBe('2');
    expect(body.dvars.sv_randomBotNames).toBe('1');
    // Dvars sin respuesta canned (Bot Warfare absent en el fake) → null, NO error.
    expect(body.dvars.bots_manage_fill).toBeNull();
    // El wire NO debe usar comandos prohibidos para leer: solo el nombre de la dvar.
    const commands = fake.received.map((entry) => entry.command);
    expect(commands).toContain('bots_skill');
    expect(commands).toContain('sv_randomBotNames');
  });

  it('server SIN el mod Bot Warfare (dvars desconocidas) → difficulty.found:false + value:null', async () => {
    fake.setDvarResponses({}); // todas las dvars → ACK vacío (Unknown command real)
    const res = await req().get('/api/admin/server/bots').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as { count: number; difficulty: { value: string | null; found: boolean; note: string }; dvars: Record<string, string | null> };
    expect(body.count).toBe(2);
    expect(body.difficulty.value).toBeNull();
    expect(body.difficulty.found).toBe(false);
    expect(body.difficulty.note).toContain('Bot Warfare');
    expect(Object.values(body.dvars).every((value) => value === null)).toBe(true);
  });

  it('503 sin RCON_PASSWORD; 403 no-admin', async () => {
    delete process.env.RCON_PASSWORD;
    resetSharedRcon();
    expect((await req().get('/api/admin/server/bots').set('Authorization', `Bearer ${adminToken}`)).status).toBe(503);
    resetSharedRcon();
    const pleb = await registerUser('bots-pleb@test.local');
    expect((await req().get('/api/admin/server/bots').set('Authorization', `Bearer ${pleb.token}`)).status).toBe(403);
  });
});

describe('POST /api/admin/server/bots/difficulty', () => {
  it('level entero → `set bots_skill <n>` EXACTO + note de semántica', async () => {
    const res = await req().post('/api/admin/server/bots/difficulty').set('Authorization', `Bearer ${adminToken}`).send({ level: 5 });
    expect(res.status).toBe(200);
    const body = res.body as { sent: boolean; dvar: string; commands: string[]; note: string };
    expect(body.sent).toBe(true);
    expect(body.dvar).toBe('bots_skill');
    expect(body.commands).toEqual(['set bots_skill 5']); // wire-format exacto
    expect(fake.commandsWith('set bots_skill 5')).toHaveLength(1);
    expect(body.note).toContain('1.5s'); // semántica del loop diffBots documentada
  });

  it('level per-team → `set bots_skill 8` + contadores `set bots_skill_<team>_<nivel> <k>`', async () => {
    const res = await req().post('/api/admin/server/bots/difficulty').set('Authorization', `Bearer ${adminToken}`).send({ level: { alliesHard: 2, axisMed: 1 } });
    expect(res.status).toBe(200);
    const body = res.body as { commands: string[] };
    expect(body.commands).toEqual([
      'set bots_skill 8',
      'set bots_skill_allies_hard 2',
      'set bots_skill_axis_med 1',
    ]);
    for (const command of body.commands) {
      expect(fake.commandsWith(command)).toHaveLength(1);
    }
  });

  it('validación: level 12 → 400; level -1 → 400; campo extra en per-team → 400; sin level → 400', async () => {
    expect((await req().post('/api/admin/server/bots/difficulty').set('Authorization', `Bearer ${adminToken}`).send({ level: 12 })).status).toBe(400);
    expect((await req().post('/api/admin/server/bots/difficulty').set('Authorization', `Bearer ${adminToken}`).send({ level: -1 })).status).toBe(400);
    expect((await req().post('/api/admin/server/bots/difficulty').set('Authorization', `Bearer ${adminToken}`).send({ level: { alliefsHard: 1 } })).status).toBe(400);
    expect((await req().post('/api/admin/server/bots/difficulty').set('Authorization', `Bearer ${adminToken}`).send({})).status).toBe(400);
    expect(fake.commandsWith('set ')).toHaveLength(0); // nada escrito
  });
});

describe('POST /api/admin/server/bots/count', () => {
  it('reducir (3 → 2): clientkick por cid EXACTO de bots SOLO (nunca humanos) + verificación con status', async () => {
    fake.setStatusText(STATUS_3_BOTS);
    fake.setOnCommand((command, server) => {
      if (command.startsWith('clientkick 3')) server.setStatusText(STATUS_3_BOTS.replace(/ *3 +0 +999 bot17[^\n]*\n/, '\n'));
    });
    const res = await req().post('/api/admin/server/bots/count').set('Authorization', `Bearer ${adminToken}`).send({ count: 2 });
    expect(res.status).toBe(200);
    const body = res.body as { sent: boolean; requested: number; before: number; after: number; spawned: number; kicked: Array<{ cid: number; guid: string; name: string }> };
    expect(body.sent).toBe(true);
    expect(body.requested).toBe(2);
    expect(body.before).toBe(3);
    expect(body.spawned).toBe(0);
    expect(body.kicked).toEqual([{ cid: 3, guid: 'bot17', name: 'Laupetin' }]); // el ÚLTIMO bot del status
    const kickCommands = fake.commandsWith('clientkick').map((entry) => entry.command);
    expect(kickCommands).toEqual(['clientkick 3']); // wire-format exacto, 1 solo kick
    expect(fake.commandsWith('spawnBot')).toHaveLength(0);
    expect(body.after).toBe(2); // re-verificado con status tras el kick
  });

  it('aumentar (0 → 2): `spawnBot 2` EXACTO, sin clientkick; los CNCT aún no cuentan', async () => {
    fake.setStatusText(STATUS_0_BOTS);
    fake.setOnCommand((command, server) => {
      if (command === 'spawnBot 2') {
        server.setStatusText(
          STATUS_0_BOTS.replace(
            '^1Toxic^7Player            15',
            '^1Toxic^7Player            15\n  1     0 CNCT      bot18      0\n  2     0 CNCT      bot19      0',
          ),
        );
      }
    });
    const res = await req().post('/api/admin/server/bots/count').set('Authorization', `Bearer ${adminToken}`).send({ count: 2 });
    expect(res.status).toBe(200);
    const body = res.body as { sent: boolean; before: number; spawned: number; kicked: unknown[]; after: number };
    expect(body.before).toBe(0);
    expect(body.spawned).toBe(2);
    expect(body.kicked).toEqual([]);
    expect(fake.commandsWith('spawnBot 2')).toHaveLength(1); // wire-format exacto
    expect(fake.commandsWith('clientkick')).toHaveLength(0);
    expect(body.after).toBe(0); // los bots siguen CNCT (aún no cuentan: verificado)
  });

  it('count igual al actual → sin escrituras', async () => {
    fake.setStatusText(STATUS_3_BOTS);
    const res = await req().post('/api/admin/server/bots/count').set('Authorization', `Bearer ${adminToken}`).send({ count: 3 });
    expect(res.status).toBe(200);
    const body = res.body as { before: number; after: number; spawned: number; kicked: unknown[] };
    expect(body.before).toBe(3);
    expect(body.after).toBe(3);
    expect(body.spawned).toBe(0);
    expect(body.kicked).toEqual([]);
    expect(fake.commandsWith('clientkick')).toHaveLength(0);
    expect(fake.commandsWith('spawnBot')).toHaveLength(0);
  });

  it('validación: count negativo → 400; count 12.5 → 400; sin count → 400', async () => {
    expect((await req().post('/api/admin/server/bots/count').set('Authorization', `Bearer ${adminToken}`).send({ count: -1 })).status).toBe(400);
    expect((await req().post('/api/admin/server/bots/count').set('Authorization', `Bearer ${adminToken}`).send({ count: 12.5 })).status).toBe(400);
    expect((await req().post('/api/admin/server/bots/count').set('Authorization', `Bearer ${adminToken}`).send({})).status).toBe(400);
    expect(fake.commandsWith('clientkick')).toHaveLength(0);
  });

  it('503 sin RCON_PASSWORD', async () => {
    delete process.env.RCON_PASSWORD;
    resetSharedRcon();
    const res = await req().post('/api/admin/server/bots/count').set('Authorization', `Bearer ${adminToken}`).send({ count: 1 });
    expect(res.status).toBe(503);
  });
});
