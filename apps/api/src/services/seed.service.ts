// Seed del ADMIN POR DEFECTO (idempotente).
//
// Contrato:
//   - nick     = ADMIN_NICK     (default "admin")          ← ÚNICA credencial de acceso
//   - email    = ADMIN_EMAIL    (default admin@admin.com)  ← SOLO gestión de cuenta
//   - password = ADMIN_PASSWORD (default "admin123")       ← hash bcrypt (mismo que el registro)
//   - role     = ADMIN (siempre)
//
// Reglas:
//   - Crea el usuario SOLO si no existe ni por nick ni por email (idempotente).
//   - Si ya existe: NO toca la contraseña (nunca se resetea por accidente);
//     solo asegura role=ADMIN.
//   - El login es SOLO por NICK (displayNameNormalized): si existieran dos
//     cuentas (una con el nick y otra con el email), se promueve la del NICK,
//     que es la que puede entrar.
//   - Auto-seed en arranque: solo si la tabla User está VACÍA (primera
//     instalación), guardado por SEED_DEFAULT_ADMIN (default true) y NUNCA en
//     NODE_ENV=test (ver runStartupSeed; los tests usan las funciones core).
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { hashPassword } from '../lib/password.js';
import { normalizeDisplayName } from './alias.service.js';

export interface SeedAdminOverrides {
  nick?: string;
  email?: string;
  password?: string;
}

export interface SeedAdminResult {
  /** true si el usuario se CREÓ en esta llamada (false = ya existía). */
  created: boolean;
  /** true si se actualizó role a ADMIN en esta llamada. */
  promoted: boolean;
  user: { id: number; nick: string; email: string; role: string };
}

/**
 * Crea (o asegura) el admin por defecto. Idempotente: re-ejecutar no duplica
 * filas ni resetea la contraseña existente.
 */
export async function seedDefaultAdmin(overrides: SeedAdminOverrides = {}): Promise<SeedAdminResult> {
  const nick = (overrides.nick ?? env.adminNick).trim();
  const email = (overrides.email ?? env.adminEmail).trim().toLowerCase();
  const password = overrides.password ?? env.adminPassword;
  const displayNameNormalized = normalizeDisplayName(nick);

  // El nick es la credencial de acceso: tiene prioridad para localizar el objetivo.
  const byNick = await prisma.user.findUnique({ where: { displayNameNormalized } });
  const byEmail = await prisma.user.findUnique({ where: { email } });

  // ── No existe: crear ADMIN con el password por defecto ────────────────────
  if (!byNick && !byEmail) {
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword(password),
        displayName: nick,
        displayNameNormalized,
        role: 'ADMIN',
      },
    });
    console.log(
      `[seed] Admin por defecto creado (${nick} / ${password}) — CAMBIA la contraseña tras el primer login.`,
    );
    return { created: true, promoted: false, user: { id: user.id, nick, email, role: user.role } };
  }

  // ── Ya existe: asegurar role=ADMIN, NUNCA tocar el passwordHash ───────────
  const target = byNick ?? byEmail;
  if (!target) {
    // Inalcanzable (guard de tipos): alguno de los dos existe.
    throw new Error('[seed] Estado inesperado buscando el admin por defecto.');
  }
  if (byNick && byEmail && byNick.id !== byEmail.id) {
    // El nick vive en una cuenta y el email en otra: manda el NICK (login).
    console.warn(
      `[seed] El nick "${nick}" y el email "${email}" pertenecen a cuentas DISTINTAS ` +
        `(ids ${byNick.id} y ${byEmail.id}). Se asegura ADMIN en la del NICK (es la que puede loguear).`,
    );
  }
  const promoted = target.role !== 'ADMIN';
  if (promoted) {
    await prisma.user.update({ where: { id: target.id }, data: { role: 'ADMIN' } });
    console.log(`[seed] Cuenta existente "${target.email}" (id ${target.id}) promovida a ADMIN.`);
  }
  return {
    created: false,
    promoted,
    user: { id: target.id, nick: target.displayName, email: target.email, role: promoted ? 'ADMIN' : target.role },
  };
}

/**
 * Auto-seed de primera instalación: SOLO ejecuta el seed si la tabla User está
 * vacía (cero usuarios). Devuelve true si creó el admin.
 * SIN guards de entorno: los guards (NODE_ENV=test, SEED_DEFAULT_ADMIN) viven
 * en runStartupSeed(), que es lo único que el server llama en el bootstrap.
 */
export async function autoSeedDefaultAdminIfEmpty(): Promise<boolean> {
  const users = await prisma.user.count();
  if (users > 0) return false;
  const result = await seedDefaultAdmin();
  return result.created;
}

/**
 * Bootstrap del server (src/index.ts). Guards explícitos:
 *   1. NUNCA en NODE_ENV=test (los tests gestionan sus propios fixtures).
 *   2. SEED_DEFAULT_ADMIN env (default true) puede desactivarlo.
 * Nunca lanza: un fallo del seed no debe tumbar la API.
 */
export async function runStartupSeed(): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  if (!env.seedDefaultAdmin) {
    console.log('[seed] SEED_DEFAULT_ADMIN desactivado: no se crea el admin por defecto.');
    return;
  }
  try {
    await autoSeedDefaultAdminIfEmpty();
  } catch (err) {
    console.error('[seed] El auto-seed del admin por defecto falló:', err);
  }
}
