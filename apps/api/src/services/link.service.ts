import { Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { Errors } from '../lib/errors.js';

export interface LinkCandidate {
  guid: string;
  name: string;
  lastConnection: string;
  /** Último servidor conocido: conexión (si la fuente la expone) o último evento registrado; null si no hay dato. */
  server: string | null;
}

export interface CandidatesResult {
  status: 'candidates';
  windowMinutes: number;
  candidates: LinkCandidate[];
}

export interface LinkedResult {
  status: 'linked';
  guid: string;
  name: string;
  /** Último servidor conocido del jugador (misma resolución que los candidatos). */
  server: string | null;
  linkedAt: string;
}

export interface UnlinkResult {
  status: 'unlinked';
  guid: string;
  /** GUIDs que siguen vinculados a la cuenta tras el unlink. */
  linkedGuids: string[];
}

export interface LinkedGuidInfo {
  guid: string;
  lastConnection: string | null;
  lastServer: string | null;
}

export async function startLinkAttempt(userId: number): Promise<StartAttemptResult> {
  const attempt = await prisma.linkAttempt.create({ data: { userId, status: 'pending' } });
  return {
    attemptId: attempt.id,
    status: 'pending',
    windowMinutes: env.linkWindowMinutes,
    createdAt: attempt.createdAt.toISOString(),
  };
}

interface StartAttemptResult {
  attemptId: number;
  status: 'pending';
  windowMinutes: number;
  createdAt: string;
}

/**
 * Servidor conocido de un jugador:
 * 1. `Player.lastServer` (conexión real si IW4MAdmin expone EFClientConnectionHistory).
 * 2. Fallback: server del último KillEvent registrado que involucra al jugador.
 * 3. null si no hay ningún dato.
 */
async function resolveLastServer(guid: string, lastServer: string | null): Promise<string | null> {
  if (lastServer !== null) return lastServer;
  const lastEvent = await prisma.killEvent.findFirst({
    where: { OR: [{ originGuid: guid }, { targetGuid: guid }] },
    orderBy: [{ timeEpoch: 'desc' }],
    select: { server: true },
  });
  return lastEvent?.server ?? null;
}

/**
 * Candidatos para vincular: GUIDs SIN ninguna cuenta vinculada (AccountLink)
 * cuya última conexión al juego es reciente (últimos LINK_WINDOW_MINUTES minutos).
 */
export async function findLinkCandidates(): Promise<CandidatesResult> {
  const cutoff = new Date(Date.now() - env.linkWindowMinutes * 60_000);
  const players = await prisma.player.findMany({
    where: { accountLinks: { none: {} }, lastConnection: { gte: cutoff } },
    orderBy: [{ lastConnection: 'desc' }, { name: 'asc' }],
    take: 25,
    select: { guid: true, name: true, lastConnection: true, lastServer: true },
  });
  const candidates: LinkCandidate[] = await Promise.all(
    players.map(async (player) => ({
      guid: player.guid,
      name: player.name,
      lastConnection: player.lastConnection?.toISOString() ?? new Date(0).toISOString(),
      server: await resolveLastServer(player.guid, player.lastServer),
    })),
  );
  return {
    status: 'candidates',
    windowMinutes: env.linkWindowMinutes,
    candidates,
  };
}

/**
 * Completa la vinculación MULTI-GUID:
 * - Sin `guid`: devuelve la lista de candidatos para que el usuario elija.
 * - Con `guid`: vincula ese GUID a la cuenta (una cuenta puede tener N GUIDs,
 *   pensado para PCs compartidas). El mismo usuario re-vinculando un GUID que
 *   ya posee → éxito idempotente. Si el GUID pertenece a OTRA cuenta → 409
 *   GUID_ALREADY_LINKED (el 409 USER_ALREADY_LINKED ya no existe para GUIDs nuevos).
 */
export async function completeLink(userId: number, guid: string | undefined): Promise<CandidatesResult | LinkedResult> {
  if (guid === undefined || guid === '') {
    return findLinkCandidates();
  }

  const player = await prisma.player.findUnique({
    where: { guid },
    include: { accountLinks: { select: { guid: true, userId: true, createdAt: true } } },
  });
  if (!player) throw Errors.playerNotFound(guid);

  const existingLink = player.accountLinks[0];
  if (existingLink && existingLink.userId !== userId) {
    throw Errors.alreadyLinkedGuid();
  }
  if (existingLink && existingLink.userId === userId) {
    // Idempotente: la cuenta ya tiene este GUID (p. ej. el launcher reintenta).
    return {
      status: 'linked',
      guid,
      name: player.name,
      server: await resolveLastServer(player.guid, player.lastServer),
      linkedAt: existingLink.createdAt.toISOString(),
    };
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw Errors.userNotFound();

  try {
    const [, link] = await prisma.$transaction([
      prisma.linkAttempt.updateMany({ where: { userId, status: 'pending' }, data: { status: 'completed' } }),
      prisma.accountLink.create({ data: { userId, guid } }),
    ]);
    return {
      status: 'linked',
      guid: link.guid,
      name: player.name,
      server: await resolveLastServer(player.guid, player.lastServer),
      linkedAt: link.createdAt.toISOString(),
    };
  } catch (err) {
    // Carrera: otra cuenta vinculó el GUID mientras tanto (unique en guid).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw Errors.alreadyLinkedGuid();
    }
    throw err;
  }
}

/**
 * Desvincula un GUID de la cuenta autenticada (PCs compartidas: cambiar de
 * cuenta o liberar el GUID para otra persona). Solo actúa sobre vínculos
 * PROPIOS; 404 si la cuenta no tiene ese GUID.
 */
export async function unlinkGuid(userId: number, guid: string): Promise<UnlinkResult> {
  const link = await prisma.accountLink.findUnique({ where: { guid } });
  if (!link || link.userId !== userId) {
    throw Errors.notFound(`Tu cuenta no tiene vinculado el GUID ${guid}.`);
  }
  await prisma.accountLink.delete({ where: { guid } });
  const remaining = await prisma.accountLink.findMany({
    where: { userId },
    select: { guid: true },
    orderBy: [{ id: 'asc' }],
  });
  return { status: 'unlinked', guid, linkedGuids: remaining.map((row) => row.guid) };
}

/** Lista completa de GUIDs vinculados de una cuenta (para /api/auth/me). */
export async function listLinkedGuids(userId: number): Promise<LinkedGuidInfo[]> {
  const links = await prisma.accountLink.findMany({
    where: { userId },
    select: { guid: true },
    orderBy: [{ id: 'asc' }],
  });
  if (links.length === 0) return [];
  const players = await prisma.player.findMany({
    where: { guid: { in: links.map((link) => link.guid) } },
    select: { guid: true, lastConnection: true, lastServer: true },
  });
  const byGuid = new Map(players.map((player) => [player.guid, player] as const));
  return links.map((link) => ({
    guid: link.guid,
    lastConnection: byGuid.get(link.guid)?.lastConnection?.toISOString() ?? null,
    lastServer: byGuid.get(link.guid)?.lastServer ?? null,
  }));
}
