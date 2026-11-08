/**
 * Tests de SESIONES DE JUEGO del launcher (anti no-launcher) + launcher-only.
 * Contrato EXACTO (respeta shapes al carácter):
 *  - POST /api/play/session 🔒JWT → {ok:true, nick:<displayName>, expiresAt:<ISO>}
 *  - GET /api/admin/server/sessions 🔒ADMIN → {sessions:[{userId,nick,guid|null,lastSeen,expiresAt}]} (solo activas)
 *  - GET/POST /api/admin/server/launcher-only 🔒ADMIN → {enabled}
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { registerUser, req, resetDb } from './helpers.js';

let adminToken = '';
let adminId = 0;
let userToken = '';
let userId = 0;

const expiresOf = async (uid: number): Promise<Date> => {
  const row = await prisma.playSession.findUniqueOrThrow({ where: { userId: uid } });
  return row.expiresAt;
};

beforeAll(async () => {
  await resetDb();
  const admin = await registerUser('ps-admin@test.local', 'supersecret123', 'PS Admin');
  await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
  const login = await req().post('/api/auth/login').send({ identifier: 'PS Admin', password: 'supersecret123' });
  adminToken = (login.body as { token: string }).token;
  adminId = admin.id;
});

beforeEach(async () => {
  await prisma.playSession.deleteMany();
  await prisma.setting.deleteMany();
  const pleb = await registerUser(`ps-user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`);
  userToken = pleb.token;
  userId = pleb.id;
});

afterAll(async () => {
  await resetDb();
});

describe('POST /api/play/session (contrato del launcher)', () => {
  it('sin JWT → 401', async () => {
    const res = await req().post('/api/play/session');
    expect(res.status).toBe(401);
  });

  it('crea la sesión con el shape EXACTO {ok, nick, expiresAt} y nick = displayName', async () => {
    const res = await req().post('/api/play/session').set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; nick: string; expiresAt: string };
    expect(body.ok).toBe(true);
    expect(typeof body.nick).toBe('string');
    expect(body.nick.length).toBeGreaterThan(0);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 9 * 60_000); // TTL default 10min
    expect(new Date(body.expiresAt).toISOString()).toBe(body.expiresAt); // ISO
    const row = await prisma.playSession.findUniqueOrThrow({ where: { userId } });
    expect(row.guid).toBeNull(); // sin auto-link aún
    expect(row.nick).toBe(body.nick);
  });

  it('es IDEMPOTENTE (refresh): una sola fila por cuenta, TTL deslizante', async () => {
    const first = await req().post('/api/play/session').set('Authorization', `Bearer ${userToken}`);
    const firstExpiry = new Date((first.body as { expiresAt: string }).expiresAt);
    await new Promise((resolve) => setTimeout(resolve, 60)); // garanticemos clock avance
    const second = await req().post('/api/play/session').set('Authorization', `Bearer ${userToken}`);
    expect(second.status).toBe(200);

    const rows = await prisma.playSession.findMany({ where: { userId } });
    expect(rows).toHaveLength(1); // upsert, no duplica
    const secondExpiry = new Date((second.body as { expiresAt: string }).expiresAt);
    expect(secondExpiry.getTime()).toBeGreaterThanOrEqual(firstExpiry.getTime());
    const row = rows[0]!;
    expect(row.expiresAt.getTime()).toBe(secondExpiry.getTime()); // la fila quedó con el refresh
    expect(row.lastSeen.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('sesión expirada (TTL vencido) se refresca de nuevo (idempotente a largo plazo)', async () => {
    await req().post('/api/play/session').set('Authorization', `Bearer ${userToken}`);
    await prisma.playSession.update({
      where: { userId },
      data: { expiresAt: new Date(Date.now() - 60_000) }, // expiró hace 1 min
    });
    const res = await req().post('/api/play/session').set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(await expiresOf(userId)).toBeInstanceOf(Date);
    expect((await expiresOf(userId)).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('GET /api/admin/server/sessions (panel admin)', () => {
  it('no-admin → 403; sin auth → 401', async () => {
    const pleb = await req().get('/api/admin/server/sessions').set('Authorization', `Bearer ${userToken}`);
    expect(pleb.status).toBe(403);
    const anon = await req().get('/api/admin/server/sessions');
    expect(anon.status).toBe(401);
  });

  it('lista SOLO las activas con shape exacto (guid null hasta el auto-link)', async () => {
    await req().post('/api/play/session').set('Authorization', `Bearer ${userToken}`);
    // Segunda cuenta con sesión YA expirada → NO debe aparecer.
    const other = await registerUser('ps-expired@test.local');
    await prisma.playSession.create({
      data: {
        userId: other.id,
        nick: 'PS Expired',
        guid: null,
        lastSeen: new Date(Date.now() - 30 * 60_000),
        expiresAt: new Date(Date.now() - 20 * 60_000), // expirada
      },
    });
    // Tercera cuenta activa CON guid sellado.
    const third = await registerUser('ps-linked@test.local');
    await prisma.playSession.create({
      data: {
        userId: third.id,
        nick: 'PS Linked',
        guid: '12345',
        lastSeen: new Date(),
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });

    const res = await req().get('/api/admin/server/sessions').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as { sessions: Array<{ userId: number; nick: string; guid: string | null; lastSeen: string; expiresAt: string }> };
    expect(Array.isArray(body.sessions)).toBe(true);
    const ids = body.sessions.map((s) => s.userId);
    expect(ids).toContain(userId);
    expect(ids).toContain(third.id);
    expect(ids).not.toContain(other.id); // expirada excluida

    const mine = body.sessions.find((s) => s.userId === userId)!;
    expect(mine.guid).toBeNull();
    expect(typeof mine.lastSeen).toBe('string');
    expect(new Date(mine.lastSeen).toISOString()).toBe(mine.lastSeen);
    expect(new Date(mine.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const linked = body.sessions.find((s) => s.userId === third.id)!;
    expect(linked.guid).toBe('12345');
  });
});

describe('launcher-only (GET/POST /api/admin/server/launcher-only)', () => {
  it('default FALSE sin fila de setting (persistido en Setting)', async () => {
    const res = await req().get('/api/admin/server/launcher-only').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false });
  });

  it('POST con enabled:boolean → {enabled} y PERSISTE (sobrevive re-lectura)', async () => {
    const post = await req().post('/api/admin/server/launcher-only').set('Authorization', `Bearer ${adminToken}`).send({ enabled: true });
    expect(post.status).toBe(200);
    expect(post.body).toEqual({ enabled: true });

    const get = await req().get('/api/admin/server/launcher-only').set('Authorization', `Bearer ${adminToken}`);
    expect(get.body).toEqual({ enabled: true });

    const row = await prisma.setting.findUniqueOrThrow({ where: { key: 'launcher_only' } });
    expect(JSON.parse(row.value)).toEqual({ enabled: true });

    const off = await req().post('/api/admin/server/launcher-only').set('Authorization', `Bearer ${adminToken}`).send({ enabled: false });
    expect(off.body).toEqual({ enabled: false });
  });

  it('validación: body inválido → 400 (no boolean, falta enabled, campo extra)', async () => {
    const noEnabled = await req().post('/api/admin/server/launcher-only').set('Authorization', `Bearer ${adminToken}`).send({});
    expect(noEnabled.status).toBe(400);
    const wrongType = await req().post('/api/admin/server/launcher-only').set('Authorization', `Bearer ${adminToken}`).send({ enabled: 'yes' });
    expect(wrongType.status).toBe(400);
    const extra = await req().post('/api/admin/server/launcher-only').set('Authorization', `Bearer ${adminToken}`).send({ enabled: true, extra: 1 });
    expect(extra.status).toBe(400);
  });

  it('no-admin → 403', async () => {
    const res = await req().post('/api/admin/server/launcher-only').set('Authorization', `Bearer ${userToken}`).send({ enabled: true });
    expect(res.status).toBe(403);
  });
});
