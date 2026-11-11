import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { Errors } from '../lib/errors.js';
import { hashPassword } from '../lib/password.js';
import { normalizeDisplayName } from './alias.service.js';
import { deleteProfileStorage } from './profile-save.service.js';
import type { AdminUpdateAccountInput } from '../dto/admin-accounts.dto.js';

/**
 * Gestión de cuentas por el ADMIN del panel (/api/admin/accounts).
 *
 * El dueño del cyber administra cuentas desde el panel: verlas, cambiar la
 * password de un user, renombrar/cambiar email/rol, desvincular un GUID
 * (anti-suplantación) y borrar cuentas completas. El borrado NO toca la
 * estadística histórica: los Players/Sessions de sus guids quedan intactos y
 * los guids quedan LIBRES para re-vincular a otra cuenta.
 */

/** Cap de la lista (cyber pequeño): suficiente y evita respuestas enormes. */
const LIST_CAP = 200;

/**
 * Regla de longitud de la password fijada por el admin: mismo mínimo que el
 * registro (8, ver registerSchema en dto/auth.dto.ts); el techo del panel es
 * 64 (contrato del endpoint) y el fallo usa el código ACCOUNT_WEAK_PASSWORD.
 */
export const MIN_ADMIN_PASSWORD_LENGTH = 8;
export const MAX_ADMIN_PASSWORD_LENGTH = 64;

export interface AdminAccountSummary {
  id: number;
  displayName: string;
  email: string;
  role: 'USER' | 'ADMIN';
  createdAt: string;
  /** Nº de GUIDs vinculados a la cuenta. */
  guidCount: number;
  /** Última conexión conocida ENTRE sus guids (Player.lastConnection), o null. */
  lastGuidSeen: string | null;
}

export interface AdminAccountGuid {
  guid: string;
  lastSeen: string | null;
}

export interface AdminAccountDetail extends AdminAccountSummary {
  guids: AdminAccountGuid[];
  /** Snapshot del cloud save parseado más reciente entre sus guids, o null. */
  save: { level: number | null; xp: number | null; parsedAt: string } | null;
  /** Nº de sesiones de juego (Session) acumuladas por sus guids. */
  sessions: number;
}

function toRole(role: string): 'USER' | 'ADMIN' {
  return role === 'ADMIN' ? 'ADMIN' : 'USER';
}

/** Metadatos de los Players de un set de guids (lastConnection/save parseado). */
async function playersByGuid(guids: string[]): Promise<Map<string, { lastConnection: Date | null; saveXp: number | null; saveLevel: number | null; saveParsedAt: Date | null }>> {
  if (guids.length === 0) return new Map();
  const players = await prisma.player.findMany({
    where: { guid: { in: guids } },
    select: { guid: true, lastConnection: true, saveXp: true, saveLevel: true, saveParsedAt: true },
  });
  return new Map(players.map((p) => [p.guid, p] as const));
}

function summarize(user: { id: number; displayName: string; email: string; role: string; createdAt: Date; accountLinks: Array<{ guid: string }> }, players: Map<string, { lastConnection: Date | null }>): AdminAccountSummary {
  const lastSeen = user.accountLinks
    .map((link) => players.get(link.guid)?.lastConnection ?? null)
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    role: toRole(user.role),
    createdAt: user.createdAt.toISOString(),
    guidCount: user.accountLinks.length,
    lastGuidSeen: lastSeen ? lastSeen.toISOString() : null,
  };
}

/** GET /api/admin/accounts: todos los users, más nuevos primero (cap 200). */
export async function listAccounts(): Promise<AdminAccountSummary[]> {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    take: LIST_CAP,
    include: { accountLinks: { select: { guid: true }, orderBy: [{ id: 'asc' }] } },
  });
  const players = await playersByGuid(users.flatMap((u) => u.accountLinks.map((l) => l.guid)));
  return users.map((user) => summarize(user, players));
}

/** GET /api/admin/accounts/:id: detalle completo de una cuenta. */
export async function getAccountDetail(accountId: number): Promise<AdminAccountDetail> {
  const user = await prisma.user.findUnique({
    where: { id: accountId },
    include: { accountLinks: { select: { guid: true }, orderBy: [{ id: 'asc' }] } },
  });
  if (!user) throw Errors.accountNotFound();

  const guids = user.accountLinks.map((link) => link.guid);
  const players = await playersByGuid(guids);

  // Save parseado más reciente entre los guids de la cuenta (el cloud save es
  // POR CUENTA: syncParsedSaveToPlayers propaga los mismos valores a todos).
  let save: AdminAccountDetail['save'] = null;
  for (const guid of guids) {
    const p = players.get(guid);
    if (!p?.saveParsedAt) continue;
    if (!save || (p.saveParsedAt?.getTime() ?? 0) > new Date(save.parsedAt).getTime()) {
      save = { level: p.saveLevel, xp: p.saveXp, parsedAt: p.saveParsedAt.toISOString() };
    }
  }

  const sessions = guids.length > 0 ? await prisma.session.count({ where: { guid: { in: guids } } }) : 0;

  return {
    ...summarize(user, players),
    guids: user.accountLinks.map((link) => ({
      guid: link.guid,
      lastSeen: players.get(link.guid)?.lastConnection?.toISOString() ?? null,
    })),
    save,
    sessions,
  };
}

/** POST /api/admin/accounts/:id/password: fija la password SIN pedir la actual (es el admin). */
export async function setAccountPassword(accountId: number, password: string): Promise<{ updated: true }> {
  const user = await prisma.user.findUnique({ where: { id: accountId }, select: { id: true } });
  if (!user) throw Errors.accountNotFound();
  // Misma regla que el registro (min 8) con techo 64; código específico del panel.
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH || password.length > MAX_ADMIN_PASSWORD_LENGTH) {
    throw Errors.accountWeakPassword();
  }
  const passwordHash = await hashPassword(password); // mismo bcrypt (10 rounds) que el registro
  await prisma.user.update({ where: { id: accountId }, data: { passwordHash } });
  return { updated: true };
}

/** PATCH /api/admin/accounts/:id: displayName (recalcula nick normalizado), email y/o role. */
export async function updateAccount(accountId: number, input: AdminUpdateAccountInput): Promise<{ updated: true; account: AdminAccountSummary }> {
  const user = await prisma.user.findUnique({
    where: { id: accountId },
    include: { accountLinks: { select: { guid: true }, orderBy: [{ id: 'asc' }] } },
  });
  if (!user) throw Errors.accountNotFound();

  const data: { displayName?: string; displayNameNormalized?: string; email?: string; role?: string } = {};

  if (input.displayName !== undefined) {
    // Nick reservado: cleanName(displayName) único case-insensitive; el propio no choca.
    const displayNameNormalized = normalizeDisplayName(input.displayName);
    const nickClash = await prisma.user.findUnique({ where: { displayNameNormalized } });
    if (nickClash && nickClash.id !== accountId) throw Errors.accountNickTaken();
    data.displayName = input.displayName;
    data.displayNameNormalized = displayNameNormalized;
  }

  if (input.email !== undefined) {
    const emailClash = await prisma.user.findUnique({ where: { email: input.email } });
    if (emailClash && emailClash.id !== accountId) throw Errors.accountEmailTaken();
    data.email = input.email;
  }

  if (input.role !== undefined && input.role !== user.role) {
    // El panel NUNCA se queda sin administradores: degradar a la última cuenta
    // ADMIN (que en la práctica es degradarse a uno mismo) está prohibido.
    if (user.role === 'ADMIN' && input.role === 'USER') {
      const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
      if (adminCount <= 1) throw Errors.accountLastAdmin(403);
    }
    data.role = input.role;
  }

  try {
    const updated = await prisma.user.update({
      where: { id: accountId },
      data,
      include: { accountLinks: { select: { guid: true }, orderBy: [{ id: 'asc' }] } },
    });
    const players = await playersByGuid(updated.accountLinks.map((l) => l.guid));
    return { updated: true, account: summarize(updated, players) };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Carrera contra otra cuenta que reservó nick/email entre el check y el update.
      const target = String((err.meta as { target?: unknown } | null)?.target ?? '');
      if (target.includes('displayNameNormalized')) throw Errors.accountNickTaken();
      throw Errors.accountEmailTaken();
    }
    throw err;
  }
}

/**
 * DELETE /api/admin/accounts/:id: borra la cuenta COMPLETA.
 * Guards: NO auto-borrado; NO borrar la última cuenta ADMIN.
 * Borra: User + AccountLinks + LinkAttempts + IdentityAlerts + PlaySession
 * (todos onDelete: Cascade en el schema) + el árbol de cloud saves en storage.
 * Los Players/Sessions de sus guids quedan INTACTOS (histórico) y los guids
 * quedan LIBRES para re-vincular a otra cuenta.
 */
export async function deleteAccount(accountId: number, requesterId: number): Promise<{ deleted: true }> {
  const user = await prisma.user.findUnique({ where: { id: accountId } });
  if (!user) throw Errors.accountNotFound();
  // El panel NUNCA se queda sin administradores (se evalúa antes que el
  // auto-borrado: borrar la última ADMIN SIEMPRE deja el panel huérfano).
  if (user.role === 'ADMIN') {
    const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
    if (adminCount <= 1) throw Errors.accountLastAdmin(400);
  }
  if (accountId === requesterId) throw Errors.accountSelfDelete();
  await prisma.user.delete({ where: { id: accountId } }); // cascade: links/attempts/alerts/playSession
  deleteProfileStorage(accountId); // árbol <storage>/<userId>/ completo (latest + versiones)
  return { deleted: true };
}

/** DELETE /api/admin/accounts/:id/guids/:guid: desvincula ESE guid (queda libre). */
export async function unlinkGuid(accountId: number, guid: string): Promise<{ unlinked: true }> {
  const user = await prisma.user.findUnique({ where: { id: accountId }, select: { id: true } });
  if (!user) throw Errors.accountNotFound();
  const deleted = await prisma.accountLink.deleteMany({ where: { userId: accountId, guid } });
  if (deleted.count === 0) throw Errors.accountGuidNotLinked(guid);
  return { unlinked: true };
}
