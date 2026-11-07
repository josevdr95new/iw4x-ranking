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

describe('Nick reservado (displayName único case-insensitive → 409 NICK_TAKEN)', () => {
  it('rechaza registro con nick EXACTO ya reservado → 409 NICK_TAKEN', async () => {
    const res = await req()
      .post('/api/auth/register')
      .send({ email: 'otro@test.local', password: 'supersecret123', displayName: 'Player One' });

    expect(res.status).toBe(409);
    const body = res.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('NICK_TAKEN');
    expect(body.error.message).toContain('reservado');
  });

  it('rechaza el nick con CASE distinto y con códigos de color ^X (misma clave limpia)', async () => {
    const caseDiff = await req()
      .post('/api/auth/register')
      .send({ email: 'case@test.local', password: 'supersecret123', displayName: 'PLAYER ONE' });
    expect(caseDiff.status).toBe(409);
    expect((caseDiff.body as { error: { code: string } }).error.code).toBe('NICK_TAKEN');

    const withCodes = await req()
      .post('/api/auth/register')
      .send({ email: 'codes@test.local', password: 'supersecret123', displayName: 'Player One^7' });
    expect(withCodes.status).toBe(409);
  });

  it('trim: espacios alrededor no evitan la colisión (y el nombre se guarda trimado)', async () => {
    const trimmed = await req()
      .post('/api/auth/register')
      .send({ email: 'trim@test.local', password: 'supersecret123', displayName: '  Trim Test  ' });
    expect(trimmed.status).toBe(201);
    expect((trimmed.body as { user: { displayName: string } }).user.displayName).toBe('Trim Test');

    const clash = await req()
      .post('/api/auth/register')
      .send({ email: 'trim2@test.local', password: 'supersecret123', displayName: '  trim test ' });
    expect(clash.status).toBe(409);
    expect((clash.body as { error: { code: string } }).error.code).toBe('NICK_TAKEN');
  });

  it('PATCH: cambiar al nick de OTRO user → 409; conservar el propio → 200', async () => {
    const mine = await registerUser('nick-own@test.local', 'supersecret123', 'My Own Nick');

    const taken = await req()
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${mine.token}`)
      .send({ displayName: 'Player One' });
    expect(taken.status).toBe(409);
    expect((taken.body as { error: { code: string } }).error.code).toBe('NICK_TAKEN');

    const self = await req()
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${mine.token}`)
      .send({ displayName: 'My Own Nick' }); // el propio no choca consigo
    expect(self.status).toBe(200);
    expect((self.body as { user: { displayName: string } }).user.displayName).toBe('My Own Nick');

    // Con códigos de color alrededor también es "el propio" (misma clave limpia).
    const selfCodes = await req()
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${mine.token}`)
      .send({ displayName: 'My^7 Own^3 Nick^1' });
    expect(selfCodes.status).toBe(200);
  });
});

describe('POST /api/auth/login (SOLO por nick: el email NO es credencial)', () => {
  it('devuelve token con nick + password correctos (identifier)', async () => {
    const res = await req()
      .post('/api/auth/login')
      .send({ identifier: 'Player One', password: 'supersecret123' });

    expect(res.status).toBe(200);
    expect(typeof (res.body as { token: string }).token).toBe('string');
  });

  it('login por nick es case-insensitive (normalización cleanName+lower)', async () => {
    const res = await req()
      .post('/api/auth/login')
      .send({ identifier: 'player ONE', password: 'supersecret123' });
    expect(res.status).toBe(200);

    const withCodes = await req()
      .post('/api/auth/login')
      .send({ identifier: 'Player One^7', password: 'supersecret123' }); // códigos ^X se limpian
    expect(withCodes.status).toBe(200);
  });

  it('campo legacy `email` con un NICK sigue funcionando (compat transitoria)', async () => {
    const res = await req()
      .post('/api/auth/login')
      .send({ email: 'Player One', password: 'supersecret123' });
    expect(res.status).toBe(200);
  });

  it('un EMAIL en el campo NO es credencial → 401 genérico (solo gestiona, no accede)', async () => {
    const res = await req()
      .post('/api/auth/login')
      .send({ identifier: 'player1@test.local', password: 'supersecret123' });
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rechaza password incorrecta con 401 INVALID_CREDENTIALS', async () => {
    const res = await req()
      .post('/api/auth/login')
      .send({ identifier: 'Player One', password: 'incorrecta-123' });

    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rechaza nick inexistente con 401 (sin filtrar existencia)', async () => {
    const res = await req()
      .post('/api/auth/login')
      .send({ identifier: 'Fantasma Que No Existe', password: 'supersecret123' });

    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rechaza body sin identifier con 400', async () => {
    const res = await req().post('/api/auth/login').send({ password: 'supersecret123' });
    expect(res.status).toBe(400);
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

describe('PATCH /api/auth/me (perfil de usuario)', () => {
  it('cambia displayName', async () => {
    const { token } = await registerUser('profile@test.local', 'supersecret123', 'Original Name');
    const res = await req().patch('/api/auth/me').set('Authorization', `Bearer ${token}`).send({ displayName: 'Nuevo Nombre' });
    expect(res.status).toBe(200);
    const body = res.body as { user: { displayName: string; email: string } };
    expect(body.user.displayName).toBe('Nuevo Nombre');
    expect(body.user.email).toBe('profile@test.local');

    const me = await req().get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect((me.body as { user: { displayName: string } }).user.displayName).toBe('Nuevo Nombre');
  });

  it('cambia password validando la actual (y la nueva funciona al loguear)', async () => {
    const { token } = await registerUser('pwchange@test.local', 'supersecret123', 'PW Change');

    const bad = await req().patch('/api/auth/me').set('Authorization', `Bearer ${token}`).send({ currentPassword: 'incorrecta', password: 'nuevapassword1' });
    expect(bad.status).toBe(401);
    expect((bad.body as { error: { code: string } }).error.code).toBe('INVALID_CREDENTIALS');

    const ok = await req().patch('/api/auth/me').set('Authorization', `Bearer ${token}`).send({ currentPassword: 'supersecret123', password: 'nuevapassword1' });
    expect(ok.status).toBe(200);

    // La vieja ya no sirve; la nueva sí (login por NICK 'PW Change').
    const oldLogin = await req().post('/api/auth/login').send({ identifier: 'PW Change', password: 'supersecret123' });
    expect(oldLogin.status).toBe(401);
    const newLogin = await req().post('/api/auth/login').send({ identifier: 'PW Change', password: 'nuevapassword1' });
    expect(newLogin.status).toBe(200);
  });

  it('validaciones: displayName corto, password sin currentPassword, body vacío', async () => {
    const { token } = await registerUser('profileval@test.local', 'supersecret123', 'Valid Name');

    const shortName = await req().patch('/api/auth/me').set('Authorization', `Bearer ${token}`).send({ displayName: 'ab' });
    expect(shortName.status).toBe(400);

    const noCurrent = await req().patch('/api/auth/me').set('Authorization', `Bearer ${token}`).send({ password: 'nuevapassword1' });
    expect(noCurrent.status).toBe(400);

    const empty = await req().patch('/api/auth/me').set('Authorization', `Bearer ${token}`).send({});
    expect(empty.status).toBe(400);

    const noAuth = await req().patch('/api/auth/me').send({ displayName: 'Sin Token' });
    expect(noAuth.status).toBe(401);
  });
});