import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { parseWith } from '../middleware/validate.js';
import { leaderboardQuerySchema } from '../dto/leaderboard.dto.js';
import type { LeaderboardQuery } from '../dto/leaderboard.dto.js';
import { getGlobalRanksByGuid, getSkillGlobalRanksByGuid } from './ranking.service.js';
import { MEDAL_LEGEND_MIN_SKILL, medalFor, type Medal } from '../lib/medals.js';

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
  /** Kills con hitloc head/helmet (acreditadas al killer; fuente log). */
  headshots: number;
  /**
   * Nivel del cloud save parseado (iw4x.stat de la cuenta vinculada); null si
   * el guid nunca tuvo un save parseado con éxito. Ordenable con sort=level
   * (SQLite: nulls al final en desc). Ver docs/API.md.
   */
  level: number | null;
  lastConnection: string | null;
  /** true si el GUID tiene una cuenta web vinculada. */
  linked: boolean;
  /** Medalla ELO derivada del skill actual (ver docs/API.md "Medallas ELO"). */
  medal: Medal;
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
    // Por defecto el ranking público es SOLO-humanos; includeBots=true trae bots.
    ...(q.includeBots ? {} : { isBot: false }),
    ...(q.minMatches > 0 ? { connections: { gte: q.minMatches } } : {}),
    // SQLite compila "contains" a LIKE: case-insensitive para ASCII.
    ...(q.search ? { name: { contains: q.search } } : {}),
  };

  // sort=level ordena por la columna saveLevel (el nombre público es "level").
  const sortField = q.sort === 'level' ? 'saveLevel' : q.sort;
  const orderBy = [{ [sortField]: q.order }, { name: 'asc' }] as Prisma.PlayerOrderByWithRelationInput[];

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

  // globalRank por SKILL solo hace falta para las LEYENDAS (tier 8, skill ≥
  // 2050): una sola query para los guids legendarios de la página (eficiente).
  const legendGuids = rows.filter((row) => row.skill >= MEDAL_LEGEND_MIN_SKILL).map((row) => row.guid);
  const skillRanks = await getSkillGlobalRanksByGuid(legendGuids);

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
      headshots: player.headshots,
      level: player.saveLevel ?? null,
      lastConnection: player.lastConnection?.toISOString() ?? null,
      linked: player.accountLinks.length > 0,
      medal: medalFor(player.skill, skillRanks.get(player.guid) ?? null),
    })),
  };
}
