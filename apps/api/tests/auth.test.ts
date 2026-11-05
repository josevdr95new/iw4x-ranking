import { beforeAll, describe, expect, it } from 'vitest';
import { registerUser, req, resetDb } from './helpers.js';

beforeAll(async () => {
  await resetDb();
});

describe('POST /api/auth/register', () => {
  it('registra un usuario y devuelve token + user', async () => {
    const res = await req()
      .post('/api/auth/register')
      .send({ email: 'player1@test.local', password: 'supersecret123', displayName: 'Player One' });

    expect(res.status).toBe(201);
    const body = res.body as { token: string; user: { email: string; displayName: string; linkedGuid: string | null } };
    expect(typeof body.token).toBe('string');
    expect(body.user.email).toBe('player1@test.local');
    expect(body.user.displayName).toBe('Player One');
    expect(body.user.linkedGuid).toBeNull();
  });

  it('normaliza el email a minúsculas', async () => {
    const res = await req()
      .post('/api/auth/register')
      .send({ email: 'MiXeD@Case.Test', password: 'supersecret123', displayName: 'Mixed Case' });

    expect(res.status).toBe(201);
    expect((res.body as { user: { email: string } }).user.email).toBe('mixed@case.test');
  });

  it('rechaza emails duplicados con 409 EMAIL_TAKEN', async () => {
    const res = await req()
      .post('/api/auth/register')
      .send({ email: 'player1@test.local', password: 'supersecret123', displayName: 'Duplicado' });

    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('EMAIL_TAKEN');
  });

  it('rechaza password corta con 400 VALIDATION_ERROR', async () => {
    const res = await req()
      .post('/api/auth/register')
      .send({ email: 'short@test.local', password: 'corta', displayName: 'Shorty' });

    expect(res.status).toBe(400);
    const body = res.body as { error: { code: string; details?: { issues: unknown[] } } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details).toBeDefined();
  });

  it('rechaza displayName corto con 400', async () => {
    const res = await req()
      .post('/api/auth/register')
      .send({ email: 'tiny@test.local', password: 'supersecret123', displayName: 'ab' });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  it('devuelve token con credenciales válidas', async () => {
    const res = await req()
      .post('/api/auth/login')
      .send({ email: 'player1@test.local', password: 'supersecret123' });

    expect(res.status).toBe(200);
    expect(typeof (res.body as { token: string }).token).toBe('string');
  });

  it('rechaza password incorrecta con 401 INVALID_CREDENTIALS', async () => {
    const res = await req()
      .post('/api/auth/login')
      .send({ email: 'player1@test.local', password: 'incorrecta-123' });

    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rechaza email inexistente con 401 (sin filtrar existencia)', async () => {
    const res = await req()
      .post('/api/auth/login')
      .send({ email: 'fantasma@test.local', password: 'supersecret123' });

    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('GET /api/auth/me', () => {
  it('devuelve el usuario del token con linkedGuid nulo', async () => {
    const { token } = await registerUser('me-user@test.local', 'supersecret123', 'Me User');
    const res = await req().get('/api/auth/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const body = res.body as { user: { email: string; displayName: string; linkedGuid: string | null } };
    expect(body.user.email).toBe('me-user@test.local');
    expect(body.user.linkedGuid).toBeNull();
  });

  it('responde 401 sin token', async () => {
    const res = await req().get('/api/auth/me');
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });

  it('responde 401 con token malformado', async () => {
    const res = await req().get('/api/auth/me').set('Authorization', 'Bearer no-es-un-jwt');
    expect(res.status).toBe(401);
  });
});
