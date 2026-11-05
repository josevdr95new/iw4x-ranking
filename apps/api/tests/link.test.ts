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
      candidates: Array<{ guid: string; name: string; lastConnection: string }>;
    };
    expect(body.status).toBe('candidates');
    expect(body.windowMinutes).toBe(10);
    // El mock genera 3 jugadores con conexión reciente; ninguno debe estar vinculado.
    expect(body.candidates.length).toBeGreaterThanOrEqual(2);
    for (const candidate of body.candidates) {
      const link = await prisma.playerLink.findUnique({ where: { guid: candidate.guid } });
      expect(link).toBeNull();
      expect(Number.isNaN(Date.parse(candidate.lastConnection))).toBe(false);
    }
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

    const link = await prisma.playerLink.findUnique({ where: { guid } });
    expect(link).not.toBeNull();
  });

  it('GUID ya vinculado por otra cuenta → 409 GUID_ALREADY_LINKED', async () => {
    const linked = await prisma.playerLink.findFirst();
    expect(linked).not.toBeNull();

    const res = await req()
      .post('/api/link/complete')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ guid: linked?.guid });
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('GUID_ALREADY_LINKED');
  });

  it('usuario ya vinculado que intenta otro GUID → 409 USER_ALREADY_LINKED', async () => {
    const candidates = await req().post('/api/link/complete').set('Authorization', `Bearer ${tokenB}`).send({});
    const otherGuid = (candidates.body as { candidates: Array<{ guid: string }> }).candidates[0]?.guid;
    expect(otherGuid).toBeDefined();

    const res = await req().post('/api/link/complete').set('Authorization', `Bearer ${tokenA}`).send({ guid: otherGuid });
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('USER_ALREADY_LINKED');
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
