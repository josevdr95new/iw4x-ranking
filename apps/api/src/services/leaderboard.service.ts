import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { parseWith } from '../middleware/validate.js';
import { leaderboardQuerySchema } from '../dto/leaderboard.dto.js';
import type { LeaderboardQuery } from '../dto/leaderboard.dto.js';
import { getGlobalRanksByGuid } from './ranking.service.js';

export interface LeaderboardEntry {
  /** Posición GLOBAL (kills desc, empate name asc) — independiente de búsqueda/filtros/paginación. */
  rank: number;
  guid: string;
  name: string;
  kills: number;
  deaths: number;
  kd: number;
  /** Segundos de juego (TotalConnectionTime). */
  timePlayed: number;
  connections: number;
  skill: number;
  lastConnection: string | null;
  /** true si el GUID tiene una cuenta web vinculada. */
  linked: boolean;
}

export interface LeaderboardResponse {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  sort: LeaderboardQuery['sort'];
  order: LeaderboardQuery['order'];
  players: LeaderboardEntry[];
}

export async function getLeaderboard(query: unknown): Promise<LeaderboardResponse> {
  const q = parseWith(leaderboardQuerySchema, query ?? {});

  const where: Prisma.PlayerWhereInput = {
    ...(q.minMatches > 0 ? { connections: { gte: q.minMatches } } : {}),
    // SQLite compila "contains" a LIKE: case-insensitive para ASCII.
    ...(q.search ? { name: { contains: q.search } } : {}),
  };

  const orderBy = [{ [q.sort]: q.order }, { name: 'asc' }] as Prisma.PlayerOrderByWithRelationInput[];

  const [total, rows] = await Promise.all([
    prisma.player.count({ where }),
    prisma.player.findMany({
      where,
      orderBy,
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: { accountLinks: { select: { guid: true } } },
    }),
  ]);

  const offset = (q.page - 1) * q.pageSize;
  // rank es SIEMPRE la posición global (kills desc, name asc), aunque la
  // búsqueda/filtros reduzcan el resultado o se esté en una página intermedia.
  const globalRanks = await getGlobalRanksByGuid(rows.map((row) => row.guid));

  return {
    page: q.page,
    pageSize: q.pageSize,
    total,
    totalPages: total === 0 ? 1 : Math.ceil(total / q.pageSize),
    sort: q.sort,
    order: q.order,
    players: rows.map((player, index) => ({
      rank: globalRanks.get(player.guid) ?? offset + index + 1,
      guid: player.guid,
      name: player.name,
      kills: player.kills,
      deaths: player.deaths,
      kd: player.kd,
      timePlayed: player.timePlayed,
      connections: player.connections,
      skill: player.skill,
      lastConnection: player.lastConnection?.toISOString() ?? null,
      linked: player.accountLinks.length > 0,
    })),
  };
}
