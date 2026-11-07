import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword, verifyPassword } from '../src/lib/password.js';
import { autoSeedDefaultAdminIfEmpty, seedDefaultAdmin } from '../src/services/seed.service.js';
import { req, resetDb } from './helpers.js';

beforeAll(async () => {
  await resetDb();
});

describe('seed del admin por defecto', () => {
  it('auto-seed con DB vacía: crea el admin (admin/admin123, role ADMIN) y ese usuario puede LOGUEAR por nick', async () => {
    // resetDb dejó la tabla User vacía → el auto-seed de primera instalación procede.
    const created = await autoSeedDefaultAdminIfEmpty();
    expect(created).toBe(true);

    const admin = await prisma.user.findUnique({ where: { email: 'admin@admin.com' } });
    expect(admin).not.toBeNull();
    expect(admin?.displayName).toBe('admin');
    expect(admin?.displayNameNormalized).toBe('admin');
    expect(admin?.role).toBe('ADMIN');

    // El login es SOLO por nick: identifier "admin" + password del seed → 200.
    const login = await req()
      .post('/api/auth/login')
      .send({ identifier: 'admin', password: 'admin123' });
    expect(login.status).toBe(200);
    const body = login.body as { token: string; user: { displayName: string; role: string } };
    expect(typeof body.token).toBe('string');
    expect(body.user.displayName).toBe('admin');
    expect(body.user.role).toBe('ADMIN');

    // El email NO es credencial: intentar entrar con admin@admin.com → 401.
    const emailLogin = await req()
      .post('/api/auth/login')
      .send({ identifier: 'admin@admin.com', password: 'admin123' });
    expect(emailLogin.status).toBe(401);
  });

  it('seed idempotente: re-ejecutar NO duplica filas NI resetea la contraseña (solo asegura role ADMIN)', async () => {
    // Simular que el dueño ya cambió su contraseña tras el primer login.
    const customHash = await hashPassword('custom-pass-123');
    const before = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@admin.com' } });
    await prisma.user.update({ where: { id: before.id }, data: { passwordHash: customHash } });

    const result = await seedDefaultAdmin();
    expect(result.created).toBe(false);
    expect(result.promoted).toBe(false); // ya era ADMIN

    const count = await prisma.user.count({ where: { email: 'admin@admin.com' } });
    expect(count).toBe(1);

    const after = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@admin.com' } });
    expect(after.id).toBe(before.id);
    expect(after.passwordHash).toBe(customHash); // intacto
    expect(await verifyPassword('custom-pass-123', after.passwordHash)).toBe(true);
    expect(await verifyPassword('admin123', after.passwordHash)).toBe(false);
    expect(after.role).toBe('ADMIN');
  });

  it('auto-seed SOLO con DB vacía: con usuarios existentes (sin admin) NO crea nada; el seed manual sí promueve', async () => {
    // DB no vacía pero SIN admin: el auto-seed de arranque no debe actuar.
    await prisma.user.delete({ where: { email: 'admin@admin.com' } });
    await prisma.user.create({
      data: {
        email: 'solo-user@test.local',
        passwordHash: await hashPassword('supersecret123'),
        displayName: 'Solo User',
        displayNameNormalized: 'solo user',
        role: 'USER',
      },
    });

    const autoSeeded = await autoSeedDefaultAdminIfEmpty();
    expect(autoSeeded).toBe(false);
    const adminAfterAuto = await prisma.user.findUnique({ where: { email: 'admin@admin.com' } });
    expect(adminAfterAuto).toBeNull(); // nada creado

    // El seed MANUAL (npm run seed:admin) sí crea/promueve cuando se invoca.
    const manual = await seedDefaultAdmin();
    expect(manual.created).toBe(true);
    expect(manual.user.role).toBe('ADMIN');
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@admin.com' } });
    expect(admin.role).toBe('ADMIN');
    expect(await verifyPassword('admin123', admin.passwordHash)).toBe(true);
  });
});
