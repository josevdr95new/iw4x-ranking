import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { env } from '../src/config/env.js';
import { verifyPassword } from '../src/lib/password.js';
import { registerUser, req, resetDb } from './helpers.js';

/**
 * Gestión de cuentas por el ADMIN del panel (/api/admin/accounts):
 * lista, detalle, cambio de password, PATCH (nick/email/rol), borrado
 * (links+storage+auth) y desvinculación de guids.
 */

const ADMIN_EMAIL = 'admin-roles@test.local'; // en vitest.config env → ADMIN_EMAILS

let adminToken = '';
let adminId = 0;

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/** Crea un user directo en DB con createdAt FIJO (para probar el orden de la lista). */
async function seedUser(email: string, displayName: string, createdAt: Date) {
  return prisma.user.create({
    data: {
      email,
      passwordHash: 'seeded-not-a-real-hash',
      displayName,
      displayNameNormalized: displayName.toLowerCase(),
      createdAt,
    },
  });
}

beforeAll(async () => {
  await resetDb();
  const reg = await req()
    .post('/api/auth/register')
    .send({ email: ADMIN_EMAIL, password: 'supersecret123', displayName: 'Boss' });
  expect(reg.status).toBe(201);
  adminToken = (reg.body as { token: string }).token;
  adminId = (reg.body as { user: { id: number } }).user.id;
});

describe('GET /api/admin/accounts (gates)', () => {
  it('401 sin token y 403 FORBIDDEN con token USER', async () => {
    expect((await req().get('/api/admin/accounts')).status).toBe(401);

    const { token } = await registerUser('pleb-accounts@test.local', 'supersecret123', 'PlebAccounts');
    const res = await req().get('/api/admin/accounts').set(auth(token));
    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });
});

describe('GET /api/admin/accounts (lista)', () => {
  it('devuelve todas las cuentas ordenadas por createdAt desc con la shape del contrato', async () => {
    const older = await seedUser('lista-vieja@test.local', 'ListaVieja', new Date('2026-01-01T00:00:00Z'));
    const newer = await seedUser('lista-nueva@test.local', 'ListaNueva', new Date('2026-01-02T00:00:00Z'));

    const res = await req().get('/api/admin/accounts').set(auth(adminToken));
    expect(res.status).toBe(200);
    const body = res.body as { accounts: Array<{ id: number; displayName: string; email: string; role: string; createdAt: string; guidCount: number; lastGuidSeen: string | null }> };
    expect(Array.isArray(body.accounts)).toBe(true);

    const ids = body.accounts.map((a) => a.id);
    expect(ids).toContain(older.id);
    expect(ids).toContain(newer.id);
    expect(ids).toContain(adminId);
    // createdAt desc: la más nueva SIEMPRE antes que la vieja.
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));

    const newerDto = body.accounts.find((a) => a.id === newer.id)!;
    expect(newerDto.displayName).toBe('ListaNueva');
    expect(newerDto.email).toBe('lista-nueva@test.local');
    expect(newerDto.role).toBe('USER');
    expect(newerDto.createdAt).toBe('2026-01-02T00:00:00.000Z');
    expect(newerDto.guidCount).toBe(0);
    expect(newerDto.lastGuidSeen).toBeNull();

    const adminDto = body.accounts.find((a) => a.id === adminId)!;
    expect(adminDto.role).toBe('ADMIN');
  });
});

describe('GET /api/admin/accounts/:id (detalle)', () => {
  it('devuelve guids con lastSeen, save parseado y nº de sesiones', async () => {
    const { id } = await registerUser('pepe@test.local', 'supersecret123', 'Pepe');
    const base = new Date('2026-02-01T10:00:00Z');
    await prisma.player.create({
      data: {
        guid: '11111111111111111',
        name: 'PepeGuid',
        lastConnection: new Date(base.getTime() + 2 * 3600_000),
        saveXp: 2163,
        saveLevel: 3,
        savePrestige: 1,
        saveParsedAt: new Date(base.getTime() + 2 * 3600_000), // el MÁS reciente
      },
    });
    await prisma.player.create({
      data: {
        guid: '22222222222222222',
        name: 'PepePC2',
        lastConnection: base,
        saveXp: 999, // parse más VIEJO: no debe ganar
        saveLevel: 2,
        saveParsedAt: base,
      },
    });
    await prisma.accountLink.create({ data: { userId: id, guid: '11111111111111111' } });
    await prisma.accountLink.create({ data: { userId: id, guid: '22222222222222222' } });
    await prisma.session.create({ data: { guid: '11111111111111111', start: base, durationMin: 5 } });
    await prisma.session.create({ data: { guid: '11111111111111111', start: new Date(base.getTime() + 3600_000), durationMin: 7 } });
    await prisma.session.create({ data: { guid: '22222222222222222', start: base, durationMin: 3 } });

    const res = await req().get(`/api/admin/accounts/${id}`).set(auth(adminToken));
    expect(res.status).toBe(200);
    const { account } = res.body as {
      account: {
        id: number; displayName: string; email: string; role: string; createdAt: string;
        guidCount: number; lastGuidSeen: string | null;
        guids: Array<{ guid: string; lastSeen: string | null }>;
        save: { level: number | null; xp: number | null; parsedAt: string } | null;
        sessions: number;
      };
    };
    expect(account.id).toBe(id);
    expect(account.displayName).toBe('Pepe');
    expect(account.guidCount).toBe(2);
    expect(account.lastGuidSeen).toBe(new Date(base.getTime() + 2 * 3600_000).toISOString());
    expect(account.guids).toEqual([
      { guid: '11111111111111111', lastSeen: new Date(base.getTime() + 2 * 3600_000).toISOString() },
      { guid: '22222222222222222', lastSeen: base.toISOString() },
    ]);
    // Save del parse MÁS reciente (guid 111: xp 2163), no el viejo (999).
    expect(account.save).toEqual({ level: 3, xp: 2163, parsedAt: new Date(base.getTime() + 2 * 3600_000).toISOString() });
    expect(account.sessions).toBe(3);
  });

  it('404 ACCOUNT_NOT_FOUND si la cuenta no existe; 400 si el id no es numérico', async () => {
    const missing = await req().get('/api/admin/accounts/424242').set(auth(adminToken));
    expect(missing.status).toBe(404);
    expect((missing.body as { error: { code: string } }).error.code).toBe('ACCOUNT_NOT_FOUND');

    const bad = await req().get('/api/admin/accounts/abc').set(auth(adminToken));
    expect(bad.status).toBe(400);
  });
});

describe('POST /api/admin/accounts/:id/password', () => {
  it('cambia la password: hash distinto, la nueva verifica y la vieja no', async () => {
    const { id } = await registerUser('carla@test.local', 'supersecret123', 'Carla');
    const before = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(await verifyPassword('supersecret123', before.passwordHash)).toBe(true);

    const res = await req().post(`/api/admin/accounts/${id}/password`).set(auth(adminToken)).send({ password: 'lanuevapassword1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: true });

    const after = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(after.passwordHash).not.toBe(before.passwordHash); // hash nuevo (mismo bcrypt, otros bytes)
    expect(await verifyPassword('lanuevapassword1', after.passwordHash)).toBe(true);
    expect(await verifyPassword('supersecret123', after.passwordHash)).toBe(false);

    // La cuenta puede loguear con la password fijada por el admin (login por nick).
    const login = await req().post('/api/auth/login').send({ identifier: 'Carla', password: 'lanuevapassword1' });
    expect(login.status).toBe(200);
  });

  it('400 ACCOUNT_WEAK_PASSWORD con password corta o demasiado larga', async () => {
    const { id } = await registerUser('debil@test.local', 'supersecret123', 'Debil');

    const short = await req().post(`/api/admin/accounts/${id}/password`).set(auth(adminToken)).send({ password: 'corta12' }); // 7 chars
    expect(short.status).toBe(400);
    expect((short.body as { error: { code: string } }).error.code).toBe('ACCOUNT_WEAK_PASSWORD');

    const long = await req().post(`/api/admin/accounts/${id}/password`).set(auth(adminToken)).send({ password: 'a'.repeat(65) }); // > 64
    expect(long.status).toBe(400);
    expect((long.body as { error: { code: string } }).error.code).toBe('ACCOUNT_WEAK_PASSWORD');

    // La hash no cambió tras los fallos.
    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(await verifyPassword('supersecret123', user.passwordHash)).toBe(true);
  });

  it('400 VALIDATION_ERROR sin password o con campos extra (.strict); 404 cuenta inexistente', async () => {
    const empty = await req().post(`/api/admin/accounts/1/password`).set(auth(adminToken)).send({});
    expect(empty.status).toBe(400);
    expect((empty.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');

    const missing = await req().post('/api/admin/accounts/424242/password').set(auth(adminToken)).send({ password: 'validapass1' });
    expect(missing.status).toBe(404);
    expect((missing.body as { error: { code: string } }).error.code).toBe('ACCOUNT_NOT_FOUND');
  });
});

describe('PATCH /api/admin/accounts/:id (displayName/email/role)', () => {
  it('cambia displayName recalculando el nick normalizado SIN borrar alertas ni links', async () => {
    const { id } = await registerUser('renombre@test.local', 'supersecret123', 'Renombre');
    await prisma.player.create({ data: { guid: '33333333333333333', name: 'RenombreGuid' } });
    await prisma.accountLink.create({ data: { userId: id, guid: '33333333333333333' } });
    await prisma.identityAlert.create({
      data: {
        guid: '44444444444444444',
        name: 'Renombre^7',
        ownerUserId: id,
        firstSeenAt: new Date('2026-02-01T00:00:00Z'),
        lastSeenAt: new Date('2026-02-02T00:00:00Z'),
      },
    });

    const res = await req().patch(`/api/admin/accounts/${id}`).set(auth(adminToken)).send({ displayName: '  RenombreNuevo  ' });
    expect(res.status).toBe(200);
    const body = res.body as { updated: true; account: { id: number; displayName: string; role: string; guidCount: number } };
    expect(body.updated).toBe(true);
    expect(body.account.displayName).toBe('RenombreNuevo'); // trimmed
    expect(body.account.guidCount).toBe(1); // links intactos

    const db = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(db.displayNameNormalized).toBe('renombrenuevo'); // cleanName + lowercase
    expect(await prisma.identityAlert.count({ where: { ownerUserId: id } })).toBe(1); // histórico intacto
    expect(await prisma.accountLink.count({ where: { userId: id } })).toBe(1);
  });

  it('400 ACCOUNT_NICK_TAKEN si el displayName colisiona (case-insensitive) con OTRA cuenta', async () => {
    const { id } = await registerUser('victima@test.local', 'supersecret123', 'VictimaNick');
    const clash = await req().patch(`/api/admin/accounts/${id}`).set(auth(adminToken)).send({ displayName: 'renombrenuevo' });
    expect(clash.status).toBe(400);
    expect((clash.body as { error: { code: string } }).error.code).toBe('ACCOUNT_NICK_TAKEN');
    // El propio nick (sin cambiar) NO choca consigo mismo:
    const self = await req().patch(`/api/admin/accounts/${id}`).set(auth(adminToken)).send({ displayName: 'VictimaNick' });
    expect(self.status).toBe(200);
    // Nick demasiado corto → 400 de validación (misma regla que el registro).
    const short = await req().patch(`/api/admin/accounts/${id}`).set(auth(adminToken)).send({ displayName: 'ab' });
    expect(short.status).toBe(400);
    expect((short.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('cambia email y 400 ACCOUNT_EMAIL_TAKEN en colisión con otra cuenta', async () => {
    const { id } = await registerUser('mailman@test.local', 'supersecret123', 'Mailman');

    const clash = await req().patch(`/api/admin/accounts/${id}`).set(auth(adminToken)).send({ email: 'carla@test.local' });
    expect(clash.status).toBe(400);
    expect((clash.body as { error: { code: string } }).error.code).toBe('ACCOUNT_EMAIL_TAKEN');

    const ok = await req().patch(`/api/admin/accounts/${id}`).set(auth(adminToken)).send({ email: 'MailMan-Nuevo@Test.local' });
    expect(ok.status).toBe(200);
    const db = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(db.email).toBe('mailman-nuevo@test.local'); // trim + lowercase como el registro

    const selfEmail = await req().patch(`/api/admin/accounts/${id}`).set(auth(adminToken)).send({ email: 'mailman-nuevo@test.local' });
    expect(selfEmail.status).toBe(200); // su propio email no choca
  });

  it('promueve y degrada role; 403 ACCOUNT_LAST_ADMIN al degradar a la última ADMIN', async () => {
    const { id } = await registerUser('ascendible@test.local', 'supersecret123', 'Ascendible');

    const promote = await req().patch(`/api/admin/accounts/${id}`).set(auth(adminToken)).send({ role: 'ADMIN' });
    expect(promote.status).toBe(200);
    expect((promote.body as { account: { role: string } }).account.role).toBe('ADMIN');

    // Hay 2 admins → degradar a la otra cuenta SÍ se puede.
    const demoteOther = await req().patch(`/api/admin/accounts/${id}`).set(auth(adminToken)).send({ role: 'USER' });
    expect(demoteOther.status).toBe(200);
    expect((demoteOther.body as { account: { role: string } }).account.role).toBe('USER');

    // Boss vuelve a ser la ÚNICA admin → auto-degradarse está prohibido.
    const demoteSelf = await req().patch(`/api/admin/accounts/${adminId}`).set(auth(adminToken)).send({ role: 'USER' });
    expect(demoteSelf.status).toBe(403);
    expect((demoteSelf.body as { error: { code: string } }).error.code).toBe('ACCOUNT_LAST_ADMIN');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: adminId } })).role).toBe('ADMIN');

    const badRole = await req().patch(`/api/admin/accounts/${id}`).set(auth(adminToken)).send({ role: 'SUPERADMIN' });
    expect(badRole.status).toBe(400);
  });

  it('400 VALIDATION_ERROR con body vacío o campos extra (.strict)', async () => {
    const empty = await req().patch(`/api/admin/accounts/${adminId}`).set(auth(adminToken)).send({});
    expect(empty.status).toBe(400);
    expect((empty.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');

    const extra = await req().patch(`/api/admin/accounts/${adminId}`).set(auth(adminToken)).send({ hacker: true });
    expect(extra.status).toBe(400);
  });
});

describe('DELETE /api/admin/accounts/:id', () => {
  it('400 ACCOUNT_SELF_DELETE al intentar borrarse a sí mismo (con otra ADMIN activa)', async () => {
    const { id, token } = await registerUser('delegada@test.local', 'supersecret123', 'Delegada');
    const promote = await req().patch(`/api/admin/accounts/${id}`).set(auth(adminToken)).send({ role: 'ADMIN' });
    expect(promote.status).toBe(200);

    // Delegada (ADMIN #2) intenta borrarse a sí misma → self (no es la última admin).
    const res = await req().delete(`/api/admin/accounts/${id}`).set(auth(token));
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('ACCOUNT_SELF_DELETE');
    expect(await prisma.user.findUnique({ where: { id } })).not.toBeNull();
  });

  it('400 ACCOUNT_LAST_ADMIN al intentar borrar la última cuenta ADMIN', async () => {
    // Vuelve a USER: Boss queda como ÚNICA admin del panel.
    const delegada = await prisma.user.findUniqueOrThrow({ where: { email: 'delegada@test.local' } });
    const demoteDelegada = await req().patch(`/api/admin/accounts/${delegada.id}`).set(auth(adminToken)).send({ role: 'USER' });
    expect(demoteDelegada.status).toBe(200);

    const res = await req().delete(`/api/admin/accounts/${adminId}`).set(auth(adminToken));
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('ACCOUNT_LAST_ADMIN');
    expect(await prisma.user.findUnique({ where: { id: adminId } })).not.toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: adminId } })).role).toBe('ADMIN');
  });

  it('DELETE completo: borra user+links+playSession+saves de storage; el guid/Player queda LIBRE', async () => {
    const { id } = await registerUser('condenada@test.local', 'supersecret123', 'Condenada');
    await prisma.player.create({ data: { guid: '55555555555555555', name: 'CondenadaGuid', kills: 10 } });
    await prisma.accountLink.create({ data: { userId: id, guid: '55555555555555555' } });
    await prisma.playSession.create({
      data: { userId: id, nick: 'Condenada', guid: '55555555555555555', lastSeen: new Date(), expiresAt: new Date(Date.now() + 60_000) },
    });

    // Árbol de cloud saves en storage: <dir>/<userId>/latest.json + una versión.
    const root = join(env.profileStorageDir, String(id));
    mkdirSync(join(root, '1700000000000-abc'), { recursive: true });
    writeFileSync(join(root, 'latest.json'), '{"version":1700000000000}');
    writeFileSync(join(root, '1700000000000-abc', 'iw4x.stat'), 'x');
    expect(existsSync(root)).toBe(true);

    const res = await req().delete(`/api/admin/accounts/${id}`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });

    expect(await prisma.user.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.accountLink.count({ where: { userId: id } })).toBe(0); // links borrados
    expect(await prisma.playSession.findUnique({ where: { userId: id } })).toBeNull(); // sesión/auth borrada
    expect(await prisma.player.findUnique({ where: { guid: '55555555555555555' } })).not.toBeNull(); // históricos intactos
    expect(existsSync(root)).toBe(false); // árbol de saves eliminado

    rmSync(join(env.profileStorageDir, 'nope'), { recursive: true, force: true }); // no-op defensivo

    const missing = await req().delete('/api/admin/accounts/424242').set(auth(adminToken));
    expect(missing.status).toBe(404);
    expect((missing.body as { error: { code: string } }).error.code).toBe('ACCOUNT_NOT_FOUND');
  });
});

describe('DELETE /api/admin/accounts/:id/guids/:guid (desvincular)', () => {
  it('desvincula el guid (queda libre) y 404 si no estaba vinculado', async () => {
    const { id } = await registerUser('desvio@test.local', 'supersecret123', 'Desvio');
    await prisma.player.create({ data: { guid: '66666666666666666', name: 'DesvioGuid' } });
    await prisma.accountLink.create({ data: { userId: id, guid: '66666666666666666' } });

    const res = await req().delete(`/api/admin/accounts/${id}/guids/66666666666666666`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unlinked: true });
    expect(await prisma.accountLink.count({ where: { userId: id } })).toBe(0);
    // El guid queda LIBRE (su Player sigue existiendo para re-vincular/histórico).
    expect(await prisma.player.findUnique({ where: { guid: '66666666666666666' } })).not.toBeNull();

    const again = await req().delete(`/api/admin/accounts/${id}/guids/66666666666666666`).set(auth(adminToken));
    expect(again.status).toBe(404);
    expect((again.body as { error: { code: string } }).error.code).toBe('ACCOUNT_GUID_NOT_LINKED');

    const neverLinked = await req().delete(`/api/admin/accounts/${id}/guids/77777777777777777`).set(auth(adminToken));
    expect(neverLinked.status).toBe(404);

    const missingAccount = await req().delete('/api/admin/accounts/424242/guids/66666666666666666').set(auth(adminToken));
    expect(missingAccount.status).toBe(404);
    expect((missingAccount.body as { error: { code: string } }).error.code).toBe('ACCOUNT_NOT_FOUND');
  });
});
