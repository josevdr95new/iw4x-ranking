import { Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { Errors } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { signToken } from '../lib/jwt.js';
import { normalizeDisplayName } from './alias.service.js';
import type { LoginInput, RegisterInput, UpdateProfileInput } from '../dto/auth.dto.js';

const userInclude = {
  accountLinks: { select: { guid: true }, orderBy: [{ id: 'asc' as const }] },
} satisfies Prisma.UserInclude;
type UserWithLinks = Prisma.UserGetPayload<{ include: typeof userInclude }>;

export interface LinkedGuidDto {
  guid: string;
  lastConnection: string | null;
  lastServer: string | null;
}

export interface PublicUser {
  id: number;
  email: string;
  displayName: string;
  role: 'USER' | 'ADMIN';
  createdAt: string;
  /** Legacy (compatibilidad launcher/web actuales): primer GUID vinculado o null. */
  linkedGuid: string | null;
  /** Multi-GUID completo (solo en GET /api/auth/me): con metadatos del Player. */
  linkedGuids?: LinkedGuidDto[];
}

export interface AuthResult {
  user: PublicUser;
  token: string;
}

export function toPublicUser(user: UserWithLinks): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role === 'ADMIN' ? 'ADMIN' : 'USER',
    createdAt: user.createdAt.toISOString(),
    linkedGuid: user.accountLinks[0]?.guid ?? null,
  };
}

/** Auto-grant: si el email está en ADMIN_EMAILS, promueve a ADMIN (idempotente). */
async function applyAdminEmailGrant(user: UserWithLinks): Promise<UserWithLinks> {
  if (!env.adminEmails.includes(user.email.toLowerCase())) return user;
  if (user.role === 'ADMIN') return user;
  return prisma.user.update({
    where: { id: user.id },
    data: { role: 'ADMIN' },
    include: userInclude,
  });
}

export async function registerUser(input: RegisterInput): Promise<AuthResult> {
  const passwordHash = await hashPassword(input.password);
  // Nick RESERVADO: cleanName(displayName) único case-insensitive entre cuentas.
  const displayNameNormalized = normalizeDisplayName(input.displayName);
  const nickClash = await prisma.user.findUnique({ where: { displayNameNormalized } });
  if (nickClash) throw Errors.nickTaken();
  try {
    let user = await prisma.user.create({
      data: {
        email: input.email,
        passwordHash,
        displayName: input.displayName,
        displayNameNormalized,
        // Auto-grant en el registro: los emails de ADMIN_EMAILS nacen ADMIN.
        role: env.adminEmails.includes(input.email.toLowerCase()) ? 'ADMIN' : 'USER',
      },
      include: userInclude,
    });
    user = await applyAdminEmailGrant(user);
    return { user: toPublicUser(user), token: signToken({ sub: user.id }) };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Carrera: decide el código según el índice que falló.
      const target = String((err.meta as { target?: unknown } | null)?.target ?? '');
      if (target.includes('displayNameNormalized')) throw Errors.nickTaken();
      throw Errors.emailTaken();
    }
    throw err;
  }
}

/**
 * LOGIN SOLO POR NICK (displayName): `identifier` es SIEMPRE un displayName y
 * se busca ÚNICAMENTE por `displayNameNormalized` (cleanName + lowercase). El
 * email NO es credencial de acceso (solo gestión/recuperación/admin): si llega
 * un email en el campo, normalizado no coincide con ningún nick → error
 * genérico. El campo legacy `email` recibe el MISMO tratamiento (compat
 * transitoria con frontend/launcher viejos). Errores SIEMPRE genéricos.
 */
export async function loginUser(input: LoginInput): Promise<AuthResult> {
  const nick = (input.identifier ?? input.email ?? '').trim();
  if (nick === '') throw Errors.invalidCredentials();

  const user = await prisma.user.findUnique({
    where: { displayNameNormalized: normalizeDisplayName(nick) },
    include: userInclude,
  });
  if (!user) throw Errors.invalidCredentials();
  const passwordOk = await verifyPassword(input.password, user.passwordHash);
  if (!passwordOk) throw Errors.invalidCredentials();
  // Auto-grant también en login: cubre cuentas creadas antes de configurar ADMIN_EMAILS.
  const granted = await applyAdminEmailGrant(user);
  return { user: toPublicUser(granted), token: signToken({ sub: granted.id }) };
}

export async function getUserPublic(userId: number): Promise<PublicUser> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: userInclude,
  });
  if (!user) throw Errors.userNotFound();
  return toPublicUser(user);
}

/** GET /api/auth/me ampliado: lista completa de GUIDs vinculados con metadatos. */
export async function getUserMe(userId: number): Promise<PublicUser> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      ...userInclude,
      accountLinks: {
        select: { guid: true, createdAt: true },
        orderBy: [{ id: 'asc' }],
      },
    },
  });
  if (!user) throw Errors.userNotFound();

  const guids = user.accountLinks.map((link) => link.guid);
  const players = guids.length > 0
    ? await prisma.player.findMany({
        where: { guid: { in: guids } },
        select: { guid: true, lastConnection: true, lastServer: true },
      })
    : [];
  const playerByGuid = new Map(players.map((player) => [player.guid, player] as const));

  const base = toPublicUser(user);
  return {
    ...base,
    linkedGuids: user.accountLinks.map((link) => {
      const player = playerByGuid.get(link.guid);
      return {
        guid: link.guid,
        lastConnection: player?.lastConnection?.toISOString() ?? null,
        lastServer: player?.lastServer ?? null,
      };
    }),
  };
}

/** PATCH /api/auth/me: cambia displayName y/o password (validando la actual). */
export async function updateProfile(userId: number, input: UpdateProfileInput): Promise<PublicUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw Errors.userNotFound();

  const data: { displayName?: string; displayNameNormalized?: string; passwordHash?: string } = {};
  if (input.displayName !== undefined) {
    // Nick reservado: si el nombre normalizado ya lo usa OTRO user → 409 (el propio no choca).
    const displayNameNormalized = normalizeDisplayName(input.displayName);
    const nickClash = await prisma.user.findUnique({ where: { displayNameNormalized } });
    if (nickClash && nickClash.id !== userId) throw Errors.nickTaken();
    data.displayName = input.displayName;
    data.displayNameNormalized = displayNameNormalized;
  }
  if (input.password !== undefined) {
    const currentOk = await verifyPassword(input.currentPassword ?? '', user.passwordHash);
    if (!currentOk) throw Errors.invalidCredentials('La contraseña actual no es correcta.');
    data.passwordHash = await hashPassword(input.password);
  }
  if (Object.keys(data).length === 0) {
    return toPublicUser(await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: userInclude }));
  }

  try {
    const updated = await prisma.user.update({ where: { id: userId }, data, include: userInclude });
    return toPublicUser(updated);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw Errors.nickTaken(); // carrera contra otra cuenta que reservó el nick
    }
    throw err;
  }
}
