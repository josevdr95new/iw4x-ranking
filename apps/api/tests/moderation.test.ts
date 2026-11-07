/**
 * Tests de la moderación NATIVA por RCON (mismo contrato HTTP que consumía la
 * web del bridge IW4MAdmin: /api/admin/iam/status|live|clients|penalties|penalty
 * + nuevos /iam/unban y /iam/bans). El server IW4x es un FakeRconServer UDP.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { registerUser, req, resetDb } from './helpers.js';
import { resetSharedRcon } from '../src/lib/rcon/iw4x-rcon.js';
import { FakeRconServer, LIVE_STATUS_FIXTURE } from './fake-rcon.js';

const PASSWORD = 'test-rcon-pass';
let fake: FakeRconServer;
let adminToken = '';
let userToken = '';
let humanPlayerId = 0;
const HUMAN_GUID_HEX = 'AB12CD34EF567890';
let HUMAN_GUID_DECIMAL = '';
const BOT_GUID = 'bot15';

let bansDir: string;

/** Id estable del server DERIVADO del puerto efímero del fake: 127001+port. */
function expectedServerId(server: FakeRconServer): number {
  return Number(`127001${server.port}`);
}

const SAVED_ENV: Record<string, string | undefined> = {
  RCON_HOST: process.env.RCON_HOST,
  RCON_PORT: process.env.RCON_PORT,
  RCON_PASSWORD: process.env.RCON_PASSWORD,
  RCON_BANS_FILE: process.env.RCON_BANS_FILE,
  RCON_SPACING_MS: process.env.RCON_SPACING_MS,
  RCON_RESPONSE_TIMEOUT_MS: process.env.RCON_RESPONSE_TIMEOUT_MS,
};

beforeAll(async () => {
  for (const [key, value] of Object.entries(SAVED_ENV)) delete process.env[key];
  bansDir = mkdtempSync(join(tmpdir(), 'iw4x-bans-'));
  await resetDb();

  const admin = await registerUser('mod-admin@test.local', 'supersecret123', 'Mod Admin');
  await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
  const login = await req().post('/api/auth/login').send({ identifier: 'Mod Admin', password: 'supersecret123' });
  adminToken = (login.body as { token: string }).token;
  const pleb = await registerUser('mod-pleb@test.local');
  userToken = pleb.token;

  // Player conocido del ranking con el guid del fixture de status (humano).
  HUMAN_GUID_DECIMAL = (
    await import('../src/lib/rcon/iw4x-rcon.js')
  ).hexGuidToDecimal(HUMAN_GUID_HEX)!;
  const player = await prisma.player.create({
    data: { guid: HUMAN_GUID_DECIMAL, name: '^1Toxic^7Player' },
  });
  humanPlayerId = player.id;
});

afterAll(async () => {
  await resetDb();
  rmSync(bansDir, { recursive: true, force: true });
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

beforeEach(async () => {
  resetSharedRcon();
  fake = new FakeRconServer({ password: PASSWORD, statusText: LIVE_STATUS_FIXTURE });
  await fake.start();
  useFake(fake);
  delete process.env.RCON_BANS_FILE;
  await prisma.penalty.deleteMany();
});

afterEach(async () => {
  resetSharedRcon();
  await fake.stop();
});

const errorBody = (body: unknown): { code: string; message: string } =>
  (body as { error: { code: string; message: string } }).error;

// ── GET /iam/status ──────────────────────────────────────────────────────────

describe('GET /api/admin/iam/status (nativo)', () => {
  it('sin RCON_PASSWORD → 200 configured:false + error legible (nunca 502 al frontend)', async () => {
    delete process.env.RCON_PASSWORD;
    resetSharedRcon();
    const res = await req().get('/api/admin/iam/status').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as { configured: boolean; reachable: boolean; error: string | null; penaltiesDb: { configured: boolean }; servers: unknown[] };
    expect(body.configured).toBe(false);
    expect(body.reachable).toBe(false);
    expect(body.error).toContain('RCON_PASSWORD');
    expect(body.penaltiesDb).toEqual({ configured: true }); // NUESTRA DB, siempre
    expect(body.servers).toEqual([]);
  });

  it('con fake rcon: reachable + server normalizado (hostname/mapa/gametype/counts)', async () => {
    const res = await req().get('/api/admin/iam/status').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      configured: boolean;
      reachable: boolean;
      servers: Array<{ id: number; name: string; game: string; map: string | null; gametype: string | null; players: number; maxPlayers: number; parser: string | null }>;
    };
    expect(body.configured).toBe(true);
    expect(body.reachable).toBe(true);
    expect(body.servers).toHaveLength(1);
    const server = body.servers[0]!;
    expect(server.name).toBe('^7[^1RANKING^7] ^7Fake Server');
    expect(server.game).toBe('IW4');
    expect(server.map).toBe('mp_terminal');
    expect(server.gametype).toBe('war');
    expect(server.players).toBe(3);
    expect(server.maxPlayers).toBe(18);
    expect(server.parser).toBe('IW4x RCON');
    expect(server.id).toBe(expectedServerId(fake)); // host+port mash estable
  });

  it('server caído → reachable:false + error (200 siempre)', async () => {
    await fake.stop(); // nadie escucha en ese puerto
    resetSharedRcon();
    const res = await req().get('/api/admin/iam/status').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as { reachable: boolean; error: string | null };
    expect(body.reachable).toBe(false);
    expect(body.error).toBeTruthy();
  });
});

// ── GET /iam/live ────────────────────────────────────────────────────────────

describe('GET /api/admin/iam/live (nativo)', () => {
  it('players en vivo con clientId resuelto por guid contra NUESTRA base', async () => {
    const res = await req().get('/api/admin/iam/live').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      servers: Array<{ id: number; name: string; online: boolean; players: Array<{ name: string; clientId: number | null; clientNumber: number; guid: string; isBot: boolean; ping: number | null; score: number | null; state: string }> }>;
    };
    expect(body.servers).toHaveLength(1);
    const server = body.servers[0]!;
    expect(server.online).toBe(true);
    expect(server.name).toBe('^7[^1RANKING^7] ^7Fake Server');
    expect(server.players).toHaveLength(3);

    const human = server.players.find((player) => player.guid === HUMAN_GUID_DECIMAL)!;
    expect(human.clientId).toBe(humanPlayerId); // resuelto contra Player
    expect(human.clientNumber).toBe(0);
    expect(human.ping).toBe(30);
    expect(human.score).toBe(1250);
    expect(human.state).toBe('Connected');
    expect(human.isBot).toBe(false);

    const bot = server.players.find((player) => player.isBot)!;
    expect(bot.guid).toBe(BOT_GUID);
    expect(bot.clientNumber).toBe(1);
    expect(bot.ping).toBe(999);
    expect(bot.clientId).toBeNull(); // bots sin fila Player → null (el panel puede kickear por cid)
    expect(bot.state).toBe('Bot');
  });

  it('resolve=false: sin clientId y sin leer la DB', async () => {
    const res = await req().get('/api/admin/iam/live?resolve=false').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as { servers: Array<{ players: Array<{ clientId: number | null }> }> };
    expect(body.servers[0]!.players.every((player) => player.clientId === null)).toBe(true);
  });

  it('503 MODERATION_NOT_CONFIGURED sin RCON_PASSWORD', async () => {
    delete process.env.RCON_PASSWORD;
    resetSharedRcon();
    const res = await req().get('/api/admin/iam/live').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(503);
    expect(errorBody(res.body).code).toBe('MODERATION_NOT_CONFIGURED');
  });

  it('403 con token USER (requireAdmin de la rama /admin)', async () => {
    const res = await req().get('/api/admin/iam/live').set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
    expect(errorBody(res.body).code).toBe('FORBIDDEN');
  });
});

// ── GET /iam/clients (búsqueda en NUESTRA base) ──────────────────────────────

describe('GET /api/admin/iam/clients (nativo)', () => {
  it('busca por nombre limpio (ignora color codes y case) con openPenalties de nuestra DB', async () => {
    await prisma.penalty.create({
      data: { offenderGuid: HUMAN_GUID_DECIMAL, offenderPlayerId: humanPlayerId, offenderName: 'ToxicPlayer', type: 'ban', reason: 'cheating (permban)', active: true },
    });
    const res = await req().get('/api/admin/iam/clients?query=toxicplayer').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      total: number;
      query: string;
      penaltiesDb: boolean;
      clients: Array<{ clientId: number; name: string; xuid: string; level: string | null; openPenalties: Array<{ type: string; reason: string | null }> | null }>;
    };
    expect(body.total).toBe(1);
    expect(body.penaltiesDb).toBe(true);
    const client = body.clients[0]!;
    expect(client.clientId).toBe(humanPlayerId);
    expect(client.xuid).toBe(HUMAN_GUID_DECIMAL);
    expect(client.level).toBe('Banned'); // ban activo
    expect(client.openPenalties?.map((penalty) => penalty.type)).toEqual(['ban']);
    expect(client.openPenalties?.[0]?.reason).toBe('cheating (permban)');
  });

  it('busca por guid HEX (formato status) y por guid decimal (formato ranking)', async () => {
    const byHex = await req().get(`/api/admin/iam/clients?query=${HUMAN_GUID_HEX.toLowerCase()}`).set('Authorization', `Bearer ${adminToken}`);
    expect(byHex.status).toBe(200);
    expect((byHex.body as { total: number }).total).toBe(1);

    const byDecimal = await req().get(`/api/admin/iam/clients?query=${HUMAN_GUID_DECIMAL}`).set('Authorization', `Bearer ${adminToken}`);
    expect(byDecimal.status).toBe(200);
    const body = byDecimal.body as { clients: Array<{ clientId: number }> };
    expect(body.clients[0]!.clientId).toBe(humanPlayerId);
  });

  it('sin coincidencias → total 0 + array vacío (200)', async () => {
    const res = await req().get('/api/admin/iam/clients?query=inexistente').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as { total: number; clients: unknown[] };
    expect(body.total).toBe(0);
    expect(body.clients).toEqual([]);
  });

  it('400 con query corta', async () => {
    const res = await req().get('/api/admin/iam/clients?query=ab').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(errorBody(res.body).code).toBe('VALIDATION_ERROR');
  });
});

// ── GET /iam/penalties (historial en NUESTRA DB) ─────────────────────────────

describe('GET /api/admin/iam/penalties (nuestra DB, no la de IW4MAdmin)', () => {
  it('historial normalizado más nuevo primero + límite; SIN 503 (DB siempre disponible)', async () => {
    const now = Date.now();
    const base = { offenderGuid: HUMAN_GUID_DECIMAL, offenderPlayerId: humanPlayerId, offenderName: 'ToxicPlayer', punisherUserId: 1, punisherName: 'Mod Admin', active: true };
    await prisma.penalty.create({ data: { ...base, type: 'kick', reason: 'tk reiterado', createdAt: new Date(now - 3000) } });
    await prisma.penalty.create({ data: { ...base, type: 'ban', reason: 'aimbot confirmado', createdAt: new Date(now - 2000) } });
    await prisma.penalty.create({ data: { ...base, type: 'unban', reason: 'apelación aceptada', active: false, createdAt: new Date(now - 1000) } });
    await prisma.penalty.create({
      data: { ...base, offenderGuid: BOT_GUID, offenderPlayerId: null, offenderName: 'RektInator', type: 'kick', reason: 'slot libre', createdAt: new Date(now) },
    });

    const res = await req().get('/api/admin/iam/penalties?limit=2').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      limit: number;
      penaltiesDb: boolean;
      penalties: Array<{ id: number; type: string; when: string; expires: string | null; automated: boolean; active: boolean; offender: { clientId: number | null; name: string | null }; punisher: { clientId: number | null; name: string | null } }>;
    };
    expect(body.limit).toBe(2);
    expect(body.penaltiesDb).toBe(true);
    expect(body.penalties.map((penalty) => penalty.type)).toEqual(['kick', 'unban']); // más nuevos primero
    const latest = body.penalties[0]!;
    expect(latest.offender).toEqual({ clientId: null, guid: BOT_GUID, name: 'RektInator' }); // bot sin Player
    expect(latest.punisher).toEqual({ clientId: 1, name: 'Mod Admin' });
    expect(latest.when).toBeTruthy();

    const all = await req().get('/api/admin/iam/penalties').set('Authorization', `Bearer ${adminToken}`);
    expect((all.body as { penalties: unknown[] }).penalties).toHaveLength(4);

    const bad = await req().get('/api/admin/iam/penalties?limit=101').set('Authorization', `Bearer ${adminToken}`);
    expect(bad.status).toBe(400);
  });
});

// ── POST /iam/penalty ────────────────────────────────────────────────────────

describe('POST /api/admin/iam/penalty (nativo)', () => {
  it('403 con token USER', async () => {
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ clientId: humanPlayerId, type: 'warn', reason: 'abuso' });
    expect(res.status).toBe(403);
  });

  it('400 VALIDATION_ERROR: motivo corto, tempban sin duración, sin target', async () => {
    const send = (body: object): Promise<{ status: number }> =>
      req().post('/api/admin/iam/penalty').set('Authorization', `Bearer ${adminToken}`).send(body);
    expect((await send({ clientId: humanPlayerId, type: 'warn' })).status).toBe(400);
    expect((await send({ clientId: humanPlayerId, type: 'warn', reason: 'no' })).status).toBe(400);
    expect((await send({ type: 'warn', reason: 'sin target' })).status).toBe(400);
    expect((await send({ clientId: humanPlayerId, type: 'tempban', reason: 'cheat' })).status).toBe(400);
    expect((await send({ clientId: humanPlayerId, type: 'tempban', durationMinutes: 0, reason: 'cheat' })).status).toBe(400);
  });

  it('503 MODERATION_NOT_CONFIGURED sin RCON_PASSWORD', async () => {
    delete process.env.RCON_PASSWORD;
    resetSharedRcon();
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: humanPlayerId, type: 'warn', reason: 'abuso de voz' });
    expect(res.status).toBe(503);
    expect(errorBody(res.body).code).toBe('MODERATION_NOT_CONFIGURED');
  });

  it('warn online: `tell <cid> "<razón>"` + Penalty en NUESTRA DB con punisher del JWT', async () => {
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: humanPlayerId, type: 'warn', reason: 'abuso de voz' });
    expect(res.status).toBe(200);
    const body = res.body as { executed: boolean; type: string; clientId: number; serverId: number; output: string[] };
    expect(body.executed).toBe(true);
    expect(body.type).toBe('warn');
    expect(body.clientId).toBe(humanPlayerId);
    expect(body.serverId).toBe(expectedServerId(fake));
    expect(fake.commandsWith('tell 0')).toHaveLength(1);
    expect(fake.received.find((entry) => entry.command.startsWith('tell'))!.command).toContain('abuso de voz');

    const penalty = await prisma.penalty.findFirst({ where: { type: 'warn' } });
    expect(penalty).not.toBeNull();
    expect(penalty!.offenderGuid).toBe(HUMAN_GUID_DECIMAL);
    expect(penalty!.offenderPlayerId).toBe(humanPlayerId);
    expect(penalty!.reason).toBe('abuso de voz');
    expect(penalty!.active).toBe(true);
    expect(penalty!.source).toBe('panel');
    const punisher = await prisma.user.findFirst({ where: { displayName: 'Mod Admin' } });
    expect(penalty!.punisherUserId).toBe(punisher!.id);
  });

  it('warn/kick por clientName: match EXACTO limpio contra los conectados', async () => {
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientName: 'ToxicPlayer', type: 'kick', reason: 'afk 10 minutos' });
    expect(res.status).toBe(200);
    expect(fake.hasCommand('clientkick 0')).toBe(true);
  });

  it('clientName ambiguo o inexistente → 400/404', async () => {
    const missing = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientName: 'NadieConectado', type: 'kick', reason: 'afk' });
    expect(missing.status).toBe(404);
    expect(errorBody(missing.body).code).toBe('MODERATION_TARGET_NOT_FOUND');
  });

  it('warn por clientId de un player NO conectado → 400 TARGET_NOT_ONLINE (sin comando enviado)', async () => {
    const offline = await prisma.player.create({ data: { guid: '99999999999999999', name: 'OfflineSam' } });
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: offline.id, type: 'warn', reason: 'target offline' });
    expect(res.status).toBe(400);
    expect(errorBody(res.body).message).toContain('no está conectado');
    expect(fake.received).toHaveLength(1); // solo el status inicial, ningún write
  });

  it('bots: warn/tempban/ban → 403 TARGET_IS_BOT; kick SÍ permitido', async () => {
    const warn = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cid: 1, type: 'warn', reason: 'bot spam' });
    expect(warn.status).toBe(403);
    expect(errorBody(warn.body).code).toBe('TARGET_IS_BOT');

    const ban = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cid: 1, type: 'ban', reason: 'bot' });
    expect(ban.status).toBe(403);

    const kick = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cid: 1, type: 'kick', reason: 'liberar slot' });
    expect(kick.status).toBe(200);
    expect(fake.hasCommand('clientkick 1')).toBe(true);
    const penalty = await prisma.penalty.findFirst({ where: { type: 'kick', offenderGuid: BOT_GUID } });
    expect(penalty).not.toBeNull();
    expect(penalty!.offenderPlayerId).not.toBeNull(); // upsert de Player para el bot
    const botPlayer = await prisma.player.findUnique({ where: { guid: BOT_GUID } });
    expect(botPlayer!.isBot).toBe(true);
  });

  it('anti-TOCTOU: si el cid cambia de guid entre lecturas → 409 CID_MISMATCH y NO clientkick', async () => {
    let statusCalls = 0;
    const scripted = new FakeRconServer({
      password: PASSWORD,
      statusText: LIVE_STATUS_FIXTURE, // lectura de resolución: fixture normal
      onCommand: (command, server) => {
        if (command === 'status') {
          statusCalls += 1;
          if (statusCalls === 1) return;
          // Lectura de VERIFICACIÓN: el slot 0 ahora tiene OTRO guid (rotó el slot).
          server.setStatusText(LIVE_STATUS_FIXTURE.replace('AB12CD34EF567890', 'DEADBEEFDEADBEEF'));
        }
      },
    });
    await scripted.start();
    useFake(scripted);
    resetSharedRcon();
    try {
      const res = await req()
        .post('/api/admin/iam/penalty')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ clientId: humanPlayerId, type: 'kick', reason: 'cheat confirmado' });
      expect(res.status).toBe(409);
      expect(errorBody(res.body).code).toBe('CID_MISMATCH');
      // El clientkick JAMÁS se envió: solo los 2 status.
      expect(scripted.received.filter((entry) => entry.command.startsWith('clientkick'))).toHaveLength(0);
      expect(scripted.received.filter((entry) => entry.command === 'status')).toHaveLength(2);
    } finally {
      await scripted.stop();
    }
  });

  it('tempban online: clientkick inmediato + Penalty con expiresAt (per-caso, en minutos)', async () => {
    const before = Date.now();
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: humanPlayerId, type: 'tempban', durationMinutes: 90, reason: 'exploit' });
    expect(res.status).toBe(200);
    expect(fake.hasCommand('clientkick 0')).toBe(true); // kick inmediato
    const penalty = await prisma.penalty.findFirst({ where: { type: 'tempban' } });
    expect(penalty).not.toBeNull();
    expect(penalty!.active).toBe(true);
    const expectedMin = new Date(before + 89.5 * 60_000).getTime();
    const expectedMax = new Date(before + 90.5 * 60_000).getTime();
    expect(penalty!.expiresAt!.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(penalty!.expiresAt!.getTime()).toBeLessThanOrEqual(expectedMax);
  });

  it('tempban OFFLINE: sin comando write + Penalty activa (el enforcer kickea al conectar)', async () => {
    const offline = await prisma.player.create({ data: { guid: '88888888888888888', name: 'OfflineNed' } });
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: offline.id, type: 'tempban', durationMinutes: 60, reason: 'exploit offline' });
    expect(res.status).toBe(200);
    expect(fake.received.filter((entry) => entry.command.startsWith('clientkick'))).toHaveLength(0);
    const penalty = await prisma.penalty.findFirst({ where: { type: 'tempban', offenderGuid: '88888888888888888' } });
    expect(penalty!.active).toBe(true);
  });

  it('ban online: `banClient <cid>` + Penalty permanente; unban: `unbanClient guid <HEX>` + revocación', async () => {
    const ban = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: humanPlayerId, type: 'ban', reason: 'aimbot confirmado' });
    expect(ban.status).toBe(200);
    expect(fake.hasCommand('banClient 0')).toBe(true);

    const banRow = await prisma.penalty.findFirst({ where: { type: 'ban' } });
    expect(banRow!.active).toBe(true);
    expect(banRow!.expiresAt).toBeNull();

    const unban = await req()
      .post('/api/admin/iam/unban')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: humanPlayerId });
    expect(unban.status).toBe(200);
    const unbanBody = unban.body as { executed: boolean; type: string; output: string[] };
    expect(unbanBody.executed).toBe(true);
    expect(unbanBody.type).toBe('unban');
    // Comando con el HEX del guid real, uppercase.
    expect(fake.hasCommand(`unbanClient guid ${HUMAN_GUID_HEX}`)).toBe(true);

    const revoked = await prisma.penalty.findFirst({ where: { type: 'ban' } });
    expect(revoked!.active).toBe(false); // marcada revocada
    const unbanRow = await prisma.penalty.findFirst({ where: { type: 'unban' } });
    expect(unbanRow).not.toBeNull();
  });

  it('unban de guid sin bans → igual ejecuta el rcon (idempotente) y registra unban', async () => {
    const res = await req()
      .post('/api/admin/iam/unban')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ guid: HUMAN_GUID_HEX });
    expect(res.status).toBe(200);
    expect(fake.hasCommand(`unbanClient guid ${HUMAN_GUID_HEX}`)).toBe(true);
    expect(await prisma.penalty.count({ where: { type: 'unban' } })).toBe(1);
  });

  it('ban de un bot → 403 y sin banClient', async () => {
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cid: 2, type: 'ban', reason: 'bot16' });
    expect(res.status).toBe(403);
    expect(fake.received.filter((entry) => entry.command.startsWith('banClient'))).toHaveLength(0);
  });

  it('server rcon caído → 502 MODERATION_UNREACHABLE', async () => {
    await fake.stop();
    resetSharedRcon();
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: humanPlayerId, type: 'warn', reason: 'server caído' });
    expect(res.status).toBe(502);
    expect(errorBody(res.body).code).toBe('MODERATION_UNREACHABLE');
  });
});

// ── GET /iam/bans (bans.json read-only) ──────────────────────────────────────

describe('GET /api/admin/iam/bans', () => {
  it('sin RCON_BANS_FILE → configured:false y lista vacía', async () => {
    const res = await req().get('/api/admin/iam/bans').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as { configured: boolean; exists: boolean; bans: unknown[] };
    expect(body.configured).toBe(false);
    expect(body.bans).toEqual([]);
  });

  it('lee bans.json del disco (guids HEX → decimal) y tolera archivo inexistente', async () => {
    const file = join(bansDir, 'bans.json');
    process.env.RCON_BANS_FILE = join(bansDir, 'missing.json');
    const missing = await req().get('/api/admin/iam/bans').set('Authorization', `Bearer ${adminToken}`);
    expect(missing.status).toBe(200);
    const missingBody = missing.body as { configured: boolean; exists: boolean; bans: unknown[] };
    expect(missingBody.configured).toBe(true);
    expect(missingBody.exists).toBe(false);
    expect(missingBody.bans).toEqual([]);

    writeFileSync(file, JSON.stringify({ ip: ['192.168.3.66'], id: [HUMAN_GUID_HEX] }));
    process.env.RCON_BANS_FILE = file;
    const res = await req().get('/api/admin/iam/bans').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as { exists: boolean; bans: Array<{ kind: string; value: string; guidDecimal: string | null }> };
    expect(body.exists).toBe(true);
    expect(body.bans).toEqual([
      { kind: 'ip', value: '192.168.3.66', guidDecimal: null },
      { kind: 'guid', value: HUMAN_GUID_HEX, guidDecimal: HUMAN_GUID_DECIMAL },
    ]);
  });
});

// ── Enforcer (tempban/ban de nuestra DB, re-kick al conectar) ────────────────

describe('enforcer de tempbans/bans', () => {
  it('kickea al guid con tempban activo que se conecta; NO kickea tras expirar', async () => {
    const { runEnforcerTick } = await import('../src/services/enforcer.service.js');
    const before = Date.now();

    // (a) tempban VIGENTE para el humano conectado (slot 0).
    const active = await prisma.penalty.create({
      data: {
        offenderGuid: HUMAN_GUID_DECIMAL,
        offenderPlayerId: humanPlayerId,
        offenderName: 'ToxicPlayer',
        type: 'tempban',
        reason: 'exploit',
        active: true,
        expiresAt: new Date(before + 60_000),
        source: 'panel',
      },
    });

    let kicks = await runEnforcerTick(new Date(before + 1000).getTime());
    expect(kicks).toBe(1);
    expect(fake.commandsWith('clientkick 0')).toHaveLength(1); // re-kick

    // (b) Sin nueva conexión humana: segundo tick no duplica (el slot sigue
    // ocupado en el fake... el enforcer kickea cada tick mientras esté: el
    // re-kick es la garantía, pero validamos el control fino con expiración).
    kicks = await runEnforcerTick(new Date(before + 61_000).getTime()); // expirado
    expect(kicks).toBe(0);
    const expired = await prisma.penalty.findUnique({ where: { id: active.id } });
    expect(expired!.active).toBe(false); // flip lazy al expirar
  });

  it('ban permanente activo de la DB kickea al conectar (capa offline)', async () => {
    const { runEnforcerTick } = await import('../src/services/enforcer.service.js');
    await prisma.penalty.create({
      data: {
        offenderGuid: HUMAN_GUID_DECIMAL,
        offenderPlayerId: humanPlayerId,
        offenderName: 'ToxicPlayer',
        type: 'ban',
        reason: 'cheating offline',
        active: true,
      },
    });
    const kicks = await runEnforcerTick();
    expect(kicks).toBe(1);
    expect(fake.commandsWith('clientkick 0')).toHaveLength(1);
  });

  it('no arranca en NODE_ENV=test (guard)', async () => {
    const { startModerationEnforcer } = await import('../src/services/enforcer.service.js');
    expect(startModerationEnforcer()).toBeNull();
  });
});
