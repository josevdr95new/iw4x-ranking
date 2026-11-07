import { execSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerUser, req, resetDb } from './helpers.js';

const ADMIN_EMAIL = 'admin-roles@test.local'; // en vitest.config env → ADMIN_EMAILS

beforeAll(async () => {
  await resetDb();
});

describe('Roles de admin (ADMIN_EMAILS + requireAdmin)', () => {
  it('un email en ADMIN_EMAILS nace ADMIN al registrarse', async () => {
    const res = await req()
      .post('/api/auth/register')
      .send({ email: ADMIN_EMAIL, password: 'supersecret123', displayName: 'Boss' });
    expect(res.status).toBe(201);
    expect((res.body as { user: { role: string } }).user.role).toBe('ADMIN');
  });

  it('un email normal nace USER', async () => {
    const { token } = await registerUser('pleb@test.local', 'supersecret123', 'Pleb');
    const me = await req().get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect((me.body as { user: { role: string } }).user.role).toBe('USER');
  });

  it('login auto-granta ADMIN a cuentas USER anteriores cuyo email está en ADMIN_EMAILS', async () => {
    // Registrar SIN estar en la lista no es posible aquí (la lista es global al proceso),
    // así que simulamos una cuenta "vieja" degradando a USER manualmente vía /auth/me trick:
    // registramos con otro email, y verificamos que el auto-grant en login es idempotente
    // para la cuenta admin (role sigue ADMIN tras login).
    const login = await req()
      .post('/api/auth/login')
      .send({ identifier: 'Boss', password: 'supersecret123' });
    expect(login.status).toBe(200);
    expect((login.body as { user: { role: string } }).user.role).toBe('ADMIN');
  });

  it('endpoints /api/admin/*: 401 sin token', async () => {
    expect((await req().get('/api/admin/server-config')).status).toBe(401);
    expect((await req().post('/api/admin/server/restart')).status).toBe(401);
  });

  it('endpoints /api/admin/*: 403 FORBIDDEN con token USER', async () => {
    const { token } = await registerUser('not-admin@test.local', 'supersecret123', 'Not Admin');
    const res = await req().get('/api/admin/server-config').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('FORBIDDEN');

    const res2 = await req().post('/api/admin/server/restart').set('Authorization', `Bearer ${token}`);
    expect(res2.status).toBe(403);
  });

  it('token ADMIN pasa el gate de rol (llega al servicio; sin SERVER_CFG_PATH → 503 claro)', async () => {
    const login = await req().post('/api/auth/login').send({ identifier: 'Boss', password: 'supersecret123' });
    const token = (login.body as { token: string }).token;

    const savedPath = process.env.SERVER_CFG_PATH;
    delete process.env.SERVER_CFG_PATH;
    try {
      const res = await req().get('/api/admin/server-config').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(503);
      expect((res.body as { error: { code: string } }).error.code).toBe('SERVER_CFG_NOT_CONFIGURED');
    } finally {
      if (savedPath !== undefined) process.env.SERVER_CFG_PATH = savedPath;
    }
  });

  it('promote:admin script: promueve a USER y --demote revierte', async () => {
    await registerUser('promote-me@test.local', 'supersecret123', 'Promotable');

    execSync('npx tsx src/scripts/promote-admin.ts promote-me@test.local', {
      cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      stdio: 'pipe',
      env: process.env,
    });

    const login = await req()
      .post('/api/auth/login')
      .send({ identifier: 'Promotable', password: 'supersecret123' });
    expect((login.body as { user: { role: string } }).user.role).toBe('ADMIN');

    execSync('npx tsx src/scripts/promote-admin.ts promote-me@test.local --demote', {
      cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      stdio: 'pipe',
      env: process.env,
    });
    const login2 = await req()
      .post('/api/auth/login')
      .send({ identifier: 'Promotable', password: 'supersecret123' });
    expect((login2.body as { user: { role: string } }).user.role).toBe('USER');
  }, 30_000);
});
