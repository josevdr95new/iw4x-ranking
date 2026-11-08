/**
 * Tests de AUTO-LINK por sesión de launcher (ingesta del games_mp.log) y de la
 * validación ANTI-BOT-LINK (los guids del rango 0xb07… jamás se vinculan).
 *
 * Reglas EXACTAS:
 *  - nick matchea displayNameNormalized de cuenta SIN guids + PlaySession
 *    ACTIVA → AccountLink automático + session.guid sellado + log.
 *  - Sin sesión activa → IdentityAlert (comportamiento previo).
 *  - Guid YA vinculado (misma u otra cuenta) → IdentityAlert (como hoy).
 *  - Guid de bot → JAMÁS se vincula (ni por sesión, ni por HTTP, ni por
 *    resolución de alertas).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ingestGameLog } from '../src/services/sync/gamelog.reader.js';
import { prisma } from '../src/lib/prisma.js';
import { registerUser, req, resetDb } from './helpers.js';
import { isBotGuid } from '../src/services/alias.service.js';

const here = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = resolve(here, 'data', 'test-autolink-games_mp.log');

const HEX_HUMAN = 'aa11bb22cc33dd01';
const HEX_HUMAN_2 = 'aa11bb22cc33dd02';
const DEC_HUMAN = BigInt(`0x${HEX_HUMAN}`).toString(10);
const DEC_HUMAN_2 = BigInt(`0x${HEX_HUMAN_2}`).toString(10);
/** Guid de BOT canónico (rango 0xb07…, 15 hex chars): bot5 → 794603859254181893. */
const BOT_GUID_DEC = BigInt('0xb07000000000005').toString(10);
const BOT_TOKEN_HEX = 'bot5';

function writeLog(lines: string[]): void {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  rmSync(LOG_PATH, { force: true });
  writeFileSync(LOG_PATH, lines.map((l) => `${l}\n`).join(''), 'utf8');
}

beforeAll(async () => {
  await resetDb();
});

beforeEach(async () => {
  await resetDb();
  rmSync(LOG_PATH, { force: true });
});

describe('auto-link por sesión (ingesta, rama connect J)', () => {
  it('cuenta SIN guids + PlaySession ACTIVA → crea AccountLink, sella session.guid y LOGUEA el formato del contrato', async () => {
    const owner = await registerUser('autolink-owner@test.local', 'supersecret123', 'Linky Owner');
    await prisma.playSession.create({
      data: { userId: owner.id, nick: 'Linky Owner', guid: null, lastSeen: new Date(), expiresAt: new Date(Date.now() + 5 * 60_000) },
    });
    writeLog([`  0:05 J;${HEX_HUMAN};0;Linky Owner^7`]);

    // Captura manual de console.log (vi.spyOn no captura fiable bajo el
    // interceptor de consola de vitest).
    const captured: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.join(' '));
    };
    let result;
    try {
      result = await ingestGameLog(LOG_PATH, null);
    } finally {
      console.log = originalLog;
    }

    expect(result.autoLinksSynced).toBe(1);
    const link = await prisma.accountLink.findUnique({ where: { guid: DEC_HUMAN } });
    expect(link).not.toBeNull();
    expect(link!.userId).toBe(owner.id);
    const session = await prisma.playSession.findUniqueOrThrow({ where: { userId: owner.id } });
    expect(session.guid).toBe(DEC_HUMAN);
    // Log EXACTO del contrato: "Auto-link por sesión: nick X (guid G) → cuenta Y"
    expect(captured.some((line) => line.includes(`Auto-link por sesión: nick Linky Owner^7 (guid ${DEC_HUMAN}) → cuenta Linky Owner (#${owner.id})`))).toBe(true);
    // Un auto-link NO debe crear alerta de identidad.
    expect(await prisma.identityAlert.findMany()).toHaveLength(0);
  });

  it('SIN sesión activa (o expirada) → IdentityAlert como siempre, sin link', async () => {
    const owner = await registerUser('autolink-nosess@test.local', 'supersecret123', 'No Session');
    // Sesión EXPIRADA: no da cobertura.
    await prisma.playSession.create({
      data: { userId: owner.id, nick: 'No Session', guid: null, lastSeen: new Date(Date.now() - 30 * 60_000), expiresAt: new Date(Date.now() - 20 * 60_000) },
    });
    writeLog([`  0:05 J;${HEX_HUMAN};0;No Session`]);

    const result = await ingestGameLog(LOG_PATH, null);
    expect(result.autoLinksSynced).toBe(0);
    expect(result.identityAlertsUpserted).toBe(1);
    expect(await prisma.accountLink.findUnique({ where: { guid: DEC_HUMAN } })).toBeNull();
    const alert = await prisma.identityAlert.findFirstOrThrow({ where: { guid: DEC_HUMAN, ownerUserId: owner.id } });
    expect(alert.status).toBe('OPEN');
  });

  it('cuenta CON guid ya vinculado (PC compartida) → SIN auto-link y CON alerta (regla previa intacta)', async () => {
    const owner = await registerUser('autolink-shared@test.local', 'supersecret123', 'Shared PC');
    await prisma.player.create({ data: { guid: DEC_HUMAN_2, name: 'Shared PC' } });
    await prisma.accountLink.create({ data: { userId: owner.id, guid: DEC_HUMAN_2 } });
    await prisma.playSession.create({
      data: { userId: owner.id, nick: 'Shared PC', guid: DEC_HUMAN_2, lastSeen: new Date(), expiresAt: new Date(Date.now() + 5 * 60_000) },
    });
    writeLog([`  0:05 J;${HEX_HUMAN};0;Shared PC`]);

    const result = await ingestGameLog(LOG_PATH, null);
    expect(result.autoLinksSynced).toBe(0); // la cuenta ya tiene guids: fuera del auto-link
    expect(result.identityAlertsUpserted).toBe(1);
    expect(await prisma.accountLink.findUnique({ where: { guid: DEC_HUMAN } })).toBeNull();
  });

  it('guid YA vinculado a OTRA cuenta → alerta (como hoy), nunca re-asignación', async () => {
    const owner = await registerUser('autolink-impostor@test.local', 'supersecret123', 'Impostor Nick');
    const legit = await registerUser('autolink-legit@test.local', 'supersecret123', 'Other Person');
    await prisma.player.create({ data: { guid: DEC_HUMAN, name: 'Other Person' } });
    await prisma.accountLink.create({ data: { userId: legit.id, guid: DEC_HUMAN } });
    await prisma.playSession.create({
      data: { userId: owner.id, nick: 'Impostor Nick', guid: null, lastSeen: new Date(), expiresAt: new Date(Date.now() + 5 * 60_000) },
    });
    writeLog([`  0:05 J;${HEX_HUMAN};0;Impostor Nick`]);

    const result = await ingestGameLog(LOG_PATH, null);
    expect(result.autoLinksSynced).toBe(0);
    expect(result.identityAlertsUpserted).toBe(1);
    const link = await prisma.accountLink.findUniqueOrThrow({ where: { guid: DEC_HUMAN } });
    expect(link.userId).toBe(legit.id); // intacto, sin re-asignar
  });

  it('guid de BOT conecta con nick registrado + sesión activa → JAMÁS se vincula', async () => {
    const owner = await registerUser('autolink-bot@test.local', 'supersecret123', 'Bot Nick Stealer');
    await prisma.playSession.create({
      data: { userId: owner.id, nick: 'Bot Nick Stealer', guid: null, lastSeen: new Date(), expiresAt: new Date(Date.now() + 5 * 60_000) },
    });
    // Un bot usa literalmente el nick reservado (los bots reusan nombres).
    writeLog([`  0:05 J;${BOT_TOKEN_HEX};0;Bot Nick Stealer`]);

    const result = await ingestGameLog(LOG_PATH, null);
    expect(result.autoLinksSynced).toBe(0);
    expect(await prisma.accountLink.count()).toBe(0); // bots: cero links por ninguna vía
    expect(isBotGuid(BOT_GUID_DEC)).toBe(true);
  });
});

describe('validación anti-bot-link en el servicio de link (HTTP)', () => {
  it('POST /api/link/complete con guid de bot → 400 BOT_GUID_NOT_LINKABLE (sin link ni Player fantasma)', async () => {
    const user = await registerUser('antibot-http@test.local');
    // El Player del bot existe en la base (la ingesta lo crea).
    await prisma.player.create({ data: { guid: BOT_GUID_DEC, name: 'RektInator', isBot: true } });

    const res = await req().post('/api/link/complete').set('Authorization', `Bearer ${user.token}`).send({ guid: BOT_GUID_DEC });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('BOT_GUID_NOT_LINKABLE');
    expect(await prisma.accountLink.count()).toBe(0);

    // También el formato botN en hex no colisiona: guid decimal del rango b07 cortito.
    const shortBot = BigInt('0xb07000000000003').toString(10);
    const res2 = await req().post('/api/link/complete').set('Authorization', `Bearer ${user.token}`).send({ guid: shortBot });
    expect(res2.status).toBe(400);
  });

  it('resolución LINK_TO_OWNER de una alerta con guid de bot → 400', async () => {
    const admin = await registerUser('antibot-admin@test.local', 'supersecret123', 'Anti Bot Admin');
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
    const login = await req().post('/api/auth/login').send({ identifier: 'Anti Bot Admin', password: 'supersecret123' });
    const adminToken = (login.body as { token: string }).token;

    const owner = await registerUser('antibot-owner@test.local', 'supersecret123', 'Alert Bot Owner');
    // Alerta DIRECTA de bot (la ingesta nunca la crea; la simulamos para el flujo manual).
    const alert = await prisma.identityAlert.create({
      data: {
        guid: BOT_GUID_DEC,
        name: 'RektInator',
        ownerUserId: owner.id,
        status: 'OPEN',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        occurrences: 1,
      },
    });
    const res = await req().post(`/api/admin/identity-alerts/${alert.id}/resolve`).set('Authorization', `Bearer ${adminToken}`).send({ action: 'LINK_TO_OWNER' });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('BOT_GUID_NOT_LINKABLE');
    expect(await prisma.accountLink.count()).toBe(0);
    expect((await prisma.identityAlert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe('OPEN');
  });
});
