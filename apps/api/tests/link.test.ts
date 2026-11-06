import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { registerUser, req, resetDb } from './helpers.js';

describe('Vinculación cuenta ↔ GUID', () => {
  let tokenA = '';
  let tokenB = '';

  beforeAll(async () => {
    await resetDb();
    // El mock de global-setup ya fue sincronizado por sync.test.ts, pero este
    // archivo corre en serie después; garantizamos datos con un sync propio.
    await req().post('/api/sync').set('Authorization', `Bearer ${(await registerUser('setup@test.local')).token}`);
    tokenA = (await registerUser('user-a@test.local', 'supersecret123', 'Usuario A')).token;
    tokenB = (await registerUser('user-b@test.local', 'supersecret123', 'Usuario B')).token;
  });

  it('start guarda un intento con timestamp', async () => {
    const res = await req().post('/api/link/start').set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);

    const body = res.body as { attemptId: number; status: string; windowMinutes: number; createdAt: string };
    expect(body.status).toBe('pending');
    expect(body.windowMinutes).toBe(10);
    expect(typeof body.attemptId).toBe('number');
    expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
    expect(await prisma.linkAttempt.count({ where: { status: 'pending' } })).toBeGreaterThanOrEqual(1);
  });

  it('complete sin guid devuelve candidatos recientes sin vincular', async () => {
    const res = await req().post('/api/link/complete').set('Authorization', `Bearer ${tokenA}`).send({});
    expect(res.status).toBe(200);

    const body = res.body as {
      status: string;
      windowMinutes: number;
      candidates: Array<{ guid: string; name: string; lastConnection: string; server: string | null }>;
    };
    expect(body.status).toBe('candidates');
    expect(body.windowMinutes).toBe(10);
    // El mock genera 3 jugadores con conexión reciente; ninguno debe estar vinculado.
    expect(body.candidates.length).toBeGreaterThanOrEqual(2);
    for (const candidate of body.candidates) {
      const link = await prisma.accountLink.findUnique({ where: { guid: candidate.guid } });
      expect(link).toBeNull();
      expect(Number.isNaN(Date.parse(candidate.lastConnection))).toBe(false);
      // Campo nuevo: server (etiqueta o null si no hay datos).
      expect('server' in candidate).toBe(true);
      expect(candidate.server === null || typeof candidate.server === 'string').toBe(true);
    }
    // Con el mock (kills con ServerId), al menos un candidato debe tener server conocido.
    expect(body.candidates.some((candidate) => candidate.server !== null)).toBe(true);
  });

  it('complete con guid vincula la cuenta (uno a uno) y /me lo refleja', async () => {
    const candidates = await req().post('/api/link/complete').set('Authorization', `Bearer ${tokenA}`).send({});
    const list = (candidates.body as { candidates: Array<{ guid: string }> }).candidates;
    const guid = list[0]?.guid;
    expect(guid).toBeDefined();

    const res = await req().post('/api/link/complete').set('Authorization', `Bearer ${tokenA}`).send({ guid });
    expect(res.status).toBe(200);

    const body = res.body as { status: string; guid: string };
    expect(body.status).toBe('linked');
    expect(body.guid).toBe(guid);

    const me = await req().get('/api/auth/me').set('Authorization', `Bearer ${tokenA}`);
    expect((me.body as { user: { linkedGuid: string | null } }).user.linkedGuid).toBe(guid);
    // /me también expone la lista multi-GUID con metadatos.
    const meUser = (me.body as { user: { linkedGuids: Array<{ guid: string; lastConnection: string | null; lastServer: string | null }> } }).user;
    expect(meUser.linkedGuids).toHaveLength(1);
    expect(meUser.linkedGuids[0]?.guid).toBe(guid);

    const link = await prisma.accountLink.findUnique({ where: { guid } });
    expect(link).not.toBeNull();
  });

  it('GUID ya vinculado por otra cuenta → 409 GUID_ALREADY_LINKED', async () => {
    const linked = await prisma.accountLink.findFirst();
    expect(linked).not.toBeNull();

    const res = await req()
      .post('/api/link/complete')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ guid: linked?.guid });
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('GUID_ALREADY_LINKED');
  });

  it('MULTI-GUID: una cuenta puede vincular más GUIDs (PCs compartidas)', async () => {
    // A ya tiene un GUID; vincula un segundo (antes: 409 USER_ALREADY_LINKED).
    const candidates = await req().post('/api/link/complete').set('Authorization', `Bearer ${tokenB}`).send({});
    const list = (candidates.body as { candidates: Array<{ guid: string }> }).candidates;
    expect(list.length).toBeGreaterThanOrEqual(1);
    const secondGuid = list[0]!.guid;

    const res = await req().post('/api/link/complete').set('Authorization', `Bearer ${tokenA}`).send({ guid: secondGuid });
    expect(res.status).toBe(200);
    expect((res.body as { status: string; guid: string }).status).toBe('linked');

    const links = await prisma.accountLink.findMany({ where: { user: { email: 'user-a@test.local' } } });
    expect(links).toHaveLength(2);

    const me = await req().get('/api/auth/me').set('Authorization', `Bearer ${tokenA}`);
    const meUser = (me.body as { user: { linkedGuids: Array<{ guid: string }>; linkedGuid: string | null } }).user;
    expect(meUser.linkedGuids).toHaveLength(2);
    // Legacy: linkedGuid sigue siendo el primero (compatibilidad launcher).
    expect(meUser.linkedGuid).not.toBeNull();

    // Re-vincular un GUID propio → idempotente (200, no 409).
    const again = await req().post('/api/link/complete').set('Authorization', `Bearer ${tokenA}`).send({ guid: secondGuid });
    expect(again.status).toBe(200);
    expect(await prisma.accountLink.count({ where: { user: { email: 'user-a@test.local' } } })).toBe(2);
  });

  it('DELETE /api/link/:guid desvincula un GUID propio', async () => {
    const linksBefore = await prisma.accountLink.findMany({ where: { user: { email: 'user-a@test.local' } } });
    expect(linksBefore.length).toBeGreaterThanOrEqual(2);
    const target = linksBefore[0]!.guid;

    const res = await req().delete(`/api/link/${target}`).set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const body = res.body as { status: string; guid: string; linkedGuids: string[] };
    expect(body.status).toBe('unlinked');
    expect(body.guid).toBe(target);
    expect(body.linkedGuids).toHaveLength(linksBefore.length - 1);
    expect(await prisma.accountLink.count({ where: { guid: target } })).toBe(0);
  });

  it('DELETE /api/link/:guid con GUID ajeno o desconocido → 404', async () => {
    const own = await prisma.accountLink.findFirst({ where: { user: { email: 'user-a@test.local' } } });
    expect(own).not.toBeNull();

    // El GUID de A no pertenece a B → 404 (no revela existencia).
    const res = await req().delete(`/api/link/${own?.guid}`).set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(404);

    const res2 = await req().delete('/api/link/999999999999999999').set('Authorization', `Bearer ${tokenA}`);
    expect(res2.status).toBe(404);
  });

  it('GUID numérico desconocido → 404 PLAYER_NOT_FOUND', async () => {
    const res = await req()
      .post('/api/link/complete')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ guid: '999999999999999999' });
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('PLAYER_NOT_FOUND');
  });

  it('GUID con formato inválido → 400 VALIDATION_ERROR', async () => {
    const res = await req()
      .post('/api/link/complete')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ guid: 'no-soy-un-guid' });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('endpoints de vinculación requieren auth', async () => {
    expect((await req().post('/api/link/start')).status).toBe(401);
    expect((await req().post('/api/link/complete').send({})).status).toBe(401);
  });
});
