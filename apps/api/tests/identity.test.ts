import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ingestGameLog } from '../src/services/sync/gamelog.reader.js';
import { rebuildAliases } from '../src/services/alias.service.js';
import { seedIdentityAlerts } from '../src/services/identity.service.js';
import { prisma } from '../src/lib/prisma.js';
import { registerUser, req, resetDb } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));

const HEX_HUMAN = 'a1b2c3d4e5f60718';
const HEX_HUMAN_2 = '0f1e2d3c4b5a6978';
const DEC_HUMAN = BigInt(`0x${HEX_HUMAN}`).toString(10);
const DEC_HUMAN_2 = BigInt(`0x${HEX_HUMAN_2}`).toString(10);
const BOT_GUID = BigInt('0xb07000000000003').toString(10); // bot3
const LOG_PATH = resolve(here, 'data', 'test-identity-games_mp.log');

function writeLog(lines: string[]): void {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  rmSync(LOG_PATH, { force: true });
  writeFileSync(LOG_PATH, lines.map((l) => `${l}\n`).join(''), 'utf8');
}

async function promoteToAdmin(email: string): Promise<void> {
  await prisma.user.update({ where: { email }, data: { role: 'ADMIN' } });
}

async function getAlerts(adminToken: string): Promise<{
  alerts: Array<{ id: number; guid: string; name: string; status: string; occurrences: number; owner: { id: number; email: string; displayName: string; linkedGuids: string[] } }>;
  counts: Record<string, number>;
  total: number;
}> {
  const res = await req().get('/api/admin/identity-alerts').set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  return res.body as never;
}

beforeAll(async () => {
  await resetDb();
});

beforeEach(async () => {
  await resetDb();
  rmSync(LOG_PATH, { force: true });
});

describe('IdentityAlert: población en la ingesta (rama connect J)', () => {
  it('SÍ alerta: nick registrado usado por guid ajeno no-bot; dedupe por (guid, owner) con occurrences', async () => {
    const owner = await registerUser('owner@test.local', 'supersecret123', 'Reserved One');
    writeLog([
      '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
      `  0:04 J;${HEX_HUMAN};0;Reserved One^7\n`, // códigos ^X se limpian → mismo nick
    ]);
    const first = await ingestGameLog(LOG_PATH, 'srv:1');
    expect(first.identityAlertsUpserted).toBe(1);

    let alerts = await prisma.identityAlert.findMany();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      guid: DEC_HUMAN,
      status: 'OPEN',
      ownerUserId: owner.id,
      occurrences: 1,
    });
    expect(JSON.parse(alerts[0]?.ownerLinkedGuidsSnapshot ?? '[]')).toEqual([]);

    // Segunda aparición (log rotado): misma OPEN → occurrences+1, SIN fila nueva.
    writeLog([`  0:04 J;${HEX_HUMAN};0;Reserved One\n`]);
    const second = await ingestGameLog(LOG_PATH, 'srv:1');
    expect(second.identityAlertsUpserted).toBe(1);
    alerts = await prisma.identityAlert.findMany();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.occurrences).toBe(2);
    expect(alerts[0]?.name).toBe('Reserved One'); // nombre exacto más reciente
  });

  it('NO alerta si el guid ya está linked al dueño (PC declarada multi-GUID)', async () => {
    const owner = await registerUser('owner2@test.local', 'supersecret123', 'Linked Owner');
    // El dueño declara su segunda PC ANTES de jugar.
    const secondPlayer = await prisma.player.create({ data: { guid: DEC_HUMAN_2, name: 'Linked Owner' } });
    await prisma.accountLink.create({ data: { userId: owner.id, guid: secondPlayer.guid } });

    writeLog([`  0:04 J;${HEX_HUMAN_2};0;Linked Owner\n`]);
    const result = await ingestGameLog(LOG_PATH, null);
    expect(result.identityAlertsUpserted).toBe(0);
    expect(await prisma.identityAlert.count()).toBe(0);
  });

  it('NO alerta para guids de BOT (rango 0xb07…) aunque el nick esté registrado', async () => {
    await registerUser('owner3@test.local', 'supersecret123', 'Snake');
    writeLog(['  0:04 J;bot3;3;Snake\n']);
    const result = await ingestGameLog(LOG_PATH, null);
    expect(result.identityAlertsUpserted).toBe(0);
    expect(await prisma.identityAlert.count()).toBe(0);
  });

  it('NO alerta si el nick NO está registrado (jugador normal sin cuenta web)', async () => {
    writeLog([`  0:04 J;${HEX_HUMAN};0;P random sin cuenta\n`]);
    const result = await ingestGameLog(LOG_PATH, null);
    expect(result.identityAlertsUpserted).toBe(0);
    expect(await prisma.identityAlert.count()).toBe(0);
  });

  it('CASO BORDE: guid linked a OTRO user ≠ owner → SÍ alerta (impersonación clásica)', async () => {
    const owner = await registerUser('real-owner@test.local', 'supersecret123', 'The Real One');
    const impostor = await registerUser('impostor@test.local', 'supersecret123', 'Impostor Guy');
    const impostorPlayer = await prisma.player.create({ data: { guid: DEC_HUMAN_2, name: 'Impostor Guy' } });
    await prisma.accountLink.create({ data: { userId: impostor.id, guid: impostorPlayer.guid } });

    writeLog([`  0:04 J;${HEX_HUMAN_2};0;The Real One\n`]);
    const result = await ingestGameLog(LOG_PATH, null);
    expect(result.identityAlertsUpserted).toBe(1);

    const alert = await prisma.identityAlert.findFirst();
    expect(alert).toMatchObject({ guid: DEC_HUMAN_2, ownerUserId: owner.id, status: 'OPEN' });
    // Snapshot: guids del dueño AL detectarse (la cuenta del dueño no tiene guids).
    expect(JSON.parse(alert?.ownerLinkedGuidsSnapshot ?? '[]')).toEqual([]);
    expect(owner.id).not.toBe(impostor.id);
  });
});

describe('GET /api/admin/identity-alerts + POST .../:id/resolve', () => {
  it('gates: 401 sin token, 403 con USER', async () => {
    expect((await req().get('/api/admin/identity-alerts')).status).toBe(401);
    const user = await registerUser('noadmin@test.local');
    expect((await req().get('/api/admin/identity-alerts').set('Authorization', `Bearer ${user.token}`)).status).toBe(403);
  });

  it('lista con datos del owner (email, displayName, guids actuales), counts y filtro por status', async () => {
    const owner = await registerUser('owner4@test.local', 'supersecret123', 'Alerted Nick');
    await prisma.player.create({ data: { guid: DEC_HUMAN, name: 'Alerted Nick' } });
    await prisma.identityAlert.create({
      data: {
        guid: DEC_HUMAN,
        name: 'Alerted Nick',
        ownerUserId: owner.id,
        status: 'OPEN',
        firstSeenAt: new Date('2026-11-01T00:00:00Z'),
        lastSeenAt: new Date('2026-11-02T00:00:00Z'),
        occurrences: 3,
        ownerLinkedGuidsSnapshot: '[]',
      },
    });

    const admin = await registerUser('alerts-admin@test.local');
    await promoteToAdmin('alerts-admin@test.local');
    const body = await getAlerts(admin.token);
    expect(body.total).toBe(1);
    expect(body.counts.OPEN).toBe(1);
    expect(body.alerts[0]).toMatchObject({ guid: DEC_HUMAN, name: 'Alerted Nick', status: 'OPEN', occurrences: 3 });
    expect(body.alerts[0]?.owner).toMatchObject({ id: owner.id, email: 'owner4@test.local', displayName: 'Alerted Nick' });
    expect(body.alerts[0]?.owner.linkedGuids).toEqual([]);

    // Filtro: status DISMISSED → vacío (pero counts sigue mostrando el total).
    const res = await req()
      .get('/api/admin/identity-alerts?status=DISMISSED')
      .set('Authorization', `Bearer ${admin.token}`);
    expect((res.body as { alerts: unknown[]; counts: Record<string, number> }).alerts).toHaveLength(0);
    expect((res.body as { counts: Record<string, number> }).counts.OPEN).toBe(1);

    // status inválido → 400 VALIDATION_ERROR.
    const bad = await req()
      .get('/api/admin/identity-alerts?status=WHATEVER')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(bad.status).toBe(400);
  });

  it('resolve LINK_TO_OWNER: crea AccountLink(owner, guid) y marca RESOLVED_OWNER', async () => {
    const owner = await registerUser('link-owner@test.local', 'supersecret123', 'Reclaim Nick');
    const alert = await prisma.identityAlert.create({
      data: {
        guid: DEC_HUMAN,
        name: 'Reclaim Nick',
        ownerUserId: owner.id,
        status: 'OPEN',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        occurrences: 1,
      },
    });

    const admin = await registerUser('resolve-admin@test.local');
    await promoteToAdmin('resolve-admin@test.local');
    const res = await req()
      .post(`/api/admin/identity-alerts/${alert.id}/resolve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ action: 'LINK_TO_OWNER' });

    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe('RESOLVED_OWNER');

    const link = await prisma.accountLink.findUnique({ where: { guid: DEC_HUMAN } });
    expect(link?.userId).toBe(owner.id);

    // Tras vincular, el mismo guid jugando con el nick NO genera alerta nueva.
    writeLog([`  0:04 J;${HEX_HUMAN};0;Reclaim Nick\n`]);
    const result = await ingestGameLog(LOG_PATH, null);
    expect(result.identityAlertsUpserted).toBe(0);
    expect(await prisma.identityAlert.count({ where: { status: 'OPEN' } })).toBe(0);
  });

  it('resolve LINK_TO_OWNER con guid de OTRA cuenta → 409 con explicación', async () => {
    const owner = await registerUser('owner5@test.local', 'supersecret123', 'Stolen Nick');
    const other = await registerUser('other@test.local', 'supersecret123', 'Other Account');
    const otherPlayer = await prisma.player.create({ data: { guid: DEC_HUMAN, name: 'Stolen Nick' } });
    await prisma.accountLink.create({ data: { userId: other.id, guid: otherPlayer.guid } });

    const alert = await prisma.identityAlert.create({
      data: {
        guid: DEC_HUMAN,
        name: 'Stolen Nick',
        ownerUserId: owner.id,
        status: 'OPEN',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        occurrences: 2,
      },
    });

    const admin = await registerUser('resolve-admin2@test.local');
    await promoteToAdmin('resolve-admin2@test.local');
    const res = await req()
      .post(`/api/admin/identity-alerts/${alert.id}/resolve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ action: 'LINK_TO_OWNER' });

    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string; message: string } }).error.code).toBe('GUID_ALREADY_LINKED');
    expect((res.body as { error: { message: string } }).error.message).toContain('OTRA cuenta');
    // La alerta sigue OPEN y el link intacto.
    expect((await prisma.identityAlert.findUnique({ where: { id: alert.id } }))?.status).toBe('OPEN');
  });

  it('resolve DISMISS marca DISMISSED; un nuevo uso re-abre con alerta NUEVA; re-resolver → 409', async () => {
    const owner = await registerUser('owner6@test.local', 'supersecret123', 'Dismissed Nick');
    const alert = await prisma.identityAlert.create({
      data: {
        guid: DEC_HUMAN,
        name: 'Dismissed Nick',
        ownerUserId: owner.id,
        status: 'OPEN',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        occurrences: 1,
      },
    });

    const admin = await registerUser('resolve-admin3@test.local');
    await promoteToAdmin('resolve-admin3@test.local');
    const res = await req()
      .post(`/api/admin/identity-alerts/${alert.id}/resolve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ action: 'DISMISS' });
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe('DISMISSED');

    // Re-resolver la misma alerta → 409 (ya no está OPEN).
    const again = await req()
      .post(`/api/admin/identity-alerts/${alert.id}/resolve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ action: 'DISMISS' });
    expect(again.status).toBe(409);
    expect((again.body as { error: { code: string } }).error.code).toBe('ALERT_ALREADY_RESOLVED');

    // Falso positivo descartado; si el guid vuelve a usar el nick → alerta NUEVA.
    writeLog([`  0:04 J;${HEX_HUMAN};0;Dismissed Nick\n`]);
    const result = await ingestGameLog(LOG_PATH, null);
    expect(result.identityAlertsUpserted).toBe(1);
    const alerts = await prisma.identityAlert.findMany({ where: { status: 'OPEN' } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.id).not.toBe(alert.id);
    expect(alerts[0]?.ownerUserId).toBe(owner.id);
  });

  it('resolve con action inválida → 400; alerta inexistente → 404', async () => {
    const admin = await registerUser('resolve-admin4@test.local');
    await promoteToAdmin('resolve-admin4@test.local');

    const badAction = await req()
      .post('/api/admin/identity-alerts/1/resolve')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ action: 'BAN_EVERYONE' });
    expect(badAction.status).toBe(400);

    const missing = await req()
      .post('/api/admin/identity-alerts/999999/resolve')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ action: 'DISMISS' });
    expect(missing.status).toBe(404);
  });
});

describe('Bootstrap de identidad (seedIdentityAlerts idempotente)', () => {
  it('siembra alertas históricas desde PlayerAlias y NO duplica al re-ejecutar', async () => {
    const owner = await registerUser('seed-owner@test.local', 'supersecret123', 'Historic Nick');
    // Historial: el guid DEC_HUMAN jugó antes como "Historic Nick" (antes de la cuenta web).
    await prisma.player.create({ data: { guid: DEC_HUMAN, name: 'Historic Nick', connections: 2 } });
    await prisma.player.create({ data: { guid: BOT_GUID, name: 'Historic Nick', isBot: true } }); // FK para el alias del bot
    await prisma.player.create({ data: { guid: DEC_HUMAN_2, name: 'Unregistered Name' } }); // FK para el alias ajeno
    await prisma.playerAlias.create({
      data: {
        guid: DEC_HUMAN,
        name: 'Historic Nick',
        firstSeenAt: new Date('2026-10-01T00:00:00Z'),
        lastSeenAt: new Date('2026-10-05T00:00:00Z'),
        occurrences: 4,
      },
    });
    // Ruido que NO debe alertar: bot con el mismo nick, guid del propio dueño, nick no registrado.
    await prisma.playerAlias.create({
      data: { guid: BOT_GUID, name: 'Historic Nick', firstSeenAt: new Date(), lastSeenAt: new Date(), occurrences: 1 },
    });
    await prisma.playerAlias.create({
      data: { guid: DEC_HUMAN_2, name: 'Unregistered Name', firstSeenAt: new Date(), lastSeenAt: new Date(), occurrences: 1 },
    });

    const first = await seedIdentityAlerts();
    expect(first.usersScanned).toBe(1);
    expect(first.alertsCreated).toBe(1); // solo guid humano ajeno

    const alert = await prisma.identityAlert.findFirst();
    expect(alert).toMatchObject({ guid: DEC_HUMAN, ownerUserId: owner.id, status: 'OPEN', occurrences: 4 });

    // IDEMPOTENCIA: re-ejecutar → cero creadas y sin cambios.
    const second = await seedIdentityAlerts();
    expect(second.alertsCreated).toBe(0);
    expect(await prisma.identityAlert.count()).toBe(1);
    expect((await prisma.identityAlert.findFirst())?.occurrences).toBe(4);
  });
});

describe('Player.isBot (set por ingesta + bootstrap) y leaderboard solo-humanos', () => {
  it('la ingesta marca isBot=true para guids del rango bot y false para humanos', async () => {
    writeLog([
      '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
      '  0:04 J;bot3;3;BotName',
      `  0:05 J;${HEX_HUMAN};0;Human Name\n`,
    ]);
    await ingestGameLog(LOG_PATH, null);
    const bot = await prisma.player.findUnique({ where: { guid: BOT_GUID } });
    const human = await prisma.player.findUnique({ where: { guid: DEC_HUMAN } });
    expect(bot?.isBot).toBe(true);
    expect(human?.isBot).toBe(false);
  });

  it('rebuildAliases (bootstrap) setea isBot en players existentes, idempotente', async () => {
    await prisma.player.create({ data: { guid: BOT_GUID, name: 'Old Bot Row', isBot: false } });
    await prisma.player.create({ data: { guid: DEC_HUMAN, name: 'Old Human Row', isBot: true } }); // mal marcado

    await rebuildAliases({ logPath: null });
    let bot = await prisma.player.findUnique({ where: { guid: BOT_GUID } });
    let human = await prisma.player.findUnique({ where: { guid: DEC_HUMAN } });
    expect(bot?.isBot).toBe(true);
    expect(human?.isBot).toBe(false);

    await rebuildAliases({ logPath: null }); // segunda pasada: estable
    bot = await prisma.player.findUnique({ where: { guid: BOT_GUID } });
    human = await prisma.player.findUnique({ where: { guid: DEC_HUMAN } });
    expect(bot?.isBot).toBe(true);
    expect(human?.isBot).toBe(false);
  });

  it('leaderboard EXCLUYE bots por defecto; includeBots=true los trae; sort=skill sigue filtrando', async () => {
    await prisma.player.create({ data: { guid: DEC_HUMAN, name: 'Human Pro', kills: 10, skill: 1200, connections: 2 } });
    await prisma.player.create({ data: { guid: BOT_GUID, name: 'Bot Killer', kills: 500, skill: 2500, connections: 50, isBot: true } });

    // Default: solo humanos (aunque el bot lidere por kills y skill).
    const def = await req().get('/api/leaderboard');
    expect(def.status).toBe(200);
    let body = def.body as { total: number; players: Array<{ guid: string }> };
    expect(body.total).toBe(1);
    expect(body.players.map((p) => p.guid)).toEqual([DEC_HUMAN]);

    // includeBots=true: aparecen ambos, ordenados por kills (bot primero).
    const withBots = await req().get('/api/leaderboard?includeBots=true');
    body = withBots.body as typeof body;
    expect(body.total).toBe(2);
    expect(body.players[0]?.guid).toBe(BOT_GUID);

    // includeBots=false explícito: mismo comportamiento que el default.
    const explicit = await req().get('/api/leaderboard?includeBots=false');
    expect((explicit.body as { total: number }).total).toBe(1);

    // sort=skill con el filtro: sin bots, el humano es el #1; con bots, el bot (skill 2500).
    const skillNoBots = await req().get('/api/leaderboard?sort=skill');
    expect((skillNoBots.body as { players: Array<{ guid: string; skill: number }> }).players[0]).toMatchObject({ guid: DEC_HUMAN, skill: 1200 });
    const skillWithBots = await req().get('/api/leaderboard?sort=skill&includeBots=true');
    expect((skillWithBots.body as { players: Array<{ guid: string; skill: number }> }).players[0]).toMatchObject({ guid: BOT_GUID, skill: 2500 });
  });
});
