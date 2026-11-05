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

export interface StartAttemptResult {
  attemptId: number;
  status: 'pending';
  windowMinutes: number;
  createdAt: string;
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

/**
 * Servidor conocido de un jugador:
 * 1. `Player.lastServer` (conexión real si IW4MAdmin expone EFClientConnectionHistory).
 * 2. Fallback: server del último KillEvent registrado que involucra al jugador
 *    (es lo único disponible con el mock actual).
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
 * Candidatos para vincular: GUIDs SIN cuenta vinculada cuya última conexión al
 * juego es reciente (últimos LINK_WINDOW_MINUTES minutos, reflejada por el sync).
 */
export async function findLinkCandidates(): Promise<CandidatesResult> {
  const cutoff = new Date(Date.now() - env.linkWindowMinutes * 60_000);
  const players = await prisma.player.findMany({
    where: { link: null, lastConnection: { gte: cutoff } },
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
 * Completa la vinculación:
 * - Sin `guid`: devuelve la lista de candidatos para que el usuario elija.
 * - Con `guid`: vincula esa cuenta al GUID (1 a 1, validando que no exista otra vinculación).
 */
export async function completeLink(userId: number, guid: string | undefined): Promise<CandidatesResult | LinkedResult> {
  if (guid === undefined || guid === '') {
    return findLinkCandidates();
  }

  const player = await prisma.player.findUnique({ where: { guid }, include: { link: { select: { guid: true } } } });
  if (!player) throw Errors.playerNotFound(guid);
  if (player.link) throw Errors.alreadyLinkedGuid();

  const user = await prisma.user.findUnique({ where: { id: userId }, include: { link: { select: { guid: true } } } });
  if (!user) throw Errors.userNotFound();
  if (user.link) throw Errors.alreadyLinkedUser();

  try {
    const [, link] = await prisma.$transaction([
      prisma.linkAttempt.updateMany({ where: { userId, status: 'pending' }, data: { status: 'completed' } }),
      prisma.playerLink.create({ data: { userId, guid } }),
    ]);
    return {
      status: 'linked',
      guid: link.guid,
      name: player.name,
      server: await resolveLastServer(player.guid, player.lastServer),
      linkedAt: link.linkedAt.toISOString(),
    };
  } catch (err) {
    // Carrera: otra cuenta vinculó el GUID mientras tanto (unique en guid).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const fresh = await prisma.user.findUnique({ where: { id: userId }, include: { link: { select: { guid: true } } } });
      if (fresh?.link) throw Errors.alreadyLinkedUser();
      throw Errors.alreadyLinkedGuid();
    }
    throw err;
  }
}
