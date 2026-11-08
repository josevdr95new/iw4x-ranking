import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { SKILL } from './skill/elo.js';

/**
 * Criterio ÚNICO de ranking global (documentado en docs/API.md):
 * kills DESC, empate por nombre ASC. Es el orden por defecto del leaderboard
 * y el que definen los campos `rank` del leaderboard y del perfil.
 * NINGÚN filtro de búsqueda ni paginación afecta la posición: es siempre global.
 *
 * POBLACIÓN ELO (para el rank por skill de las medallas): humanos (isBot=false)
 * que realmente jugaron: kills ≥ 1 (mataron a alguien) O skillElo ≠ base 1000
 * (su ELO se movió: murieron, teamkillearon o ganaron). Excluye a quienes solo
 * se conectaron y desaparecieron (skill 1000 exacto, 0 kills). El ORDEN es por
 * el skill EXPUESTO (incluye bonus de racha), el mismo número que consume
 * medalFor → medalla y posición global siempre coherentes entre sí.
 */

/** Filtro de población ELO reutilizable (documentación viva del criterio). */
function eloPopulationWhere(extra: Prisma.PlayerWhereInput = {}): Prisma.PlayerWhereInput {
  return {
    isBot: false,
    OR: [{ kills: { gte: 1 } }, { skillElo: { not: SKILL.START } }],
    ...extra,
  };
}

/** Posición global de un solo jugador: nº de jugadores que van delante + 1. */
export async function computeDefaultRank(kills: number, name: string): Promise<number> {
  const playersAhead = await prisma.player.count({
    where: {
      OR: [{ kills: { gt: kills } }, { kills: { equals: kills }, name: { lt: name } }],
    },
  });
  return playersAhead + 1;
}

/**
 * Posición global para varios GUIDs en una sola query (ROW_NUMBER con el mismo
 * criterio). Devuelve un mapa guid -> rank; todo guid existente en Player
 * estará presente en el mapa.
 */
export async function getGlobalRanksByGuid(guids: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(guids)];
  if (unique.length === 0) return new Map();

  const rows = await prisma.$queryRaw<Array<{ guid: string; rank: bigint | number }>>`
    SELECT guid, rank FROM (
      SELECT "guid" AS guid,
             ROW_NUMBER() OVER (ORDER BY "kills" DESC, "name" ASC) AS rank
      FROM "Player"
    )
    WHERE "guid" IN (${Prisma.join(unique)})`;

  const ranks = new Map<string, number>();
  for (const row of rows) {
    ranks.set(row.guid, Number(row.rank));
  }
  return ranks;
}

/**
 * Posición GLOBAL POR SKILL para varios GUIDs en una sola query (ROW_NUMBER
 * sobre la población ELO). Orden: skill DESC, empate name ASC. La usa la
 * medalla LEYENDA (globalRank / eliteTop12). Un guid fuera de la población NO
 * aparece en el mapa (el caller lo trata como null).
 */
export async function getSkillGlobalRanksByGuid(guids: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(guids)];
  if (unique.length === 0) return new Map();

  const rows = await prisma.$queryRaw<Array<{ guid: string; rank: bigint | number }>>`
    SELECT guid, rank FROM (
      SELECT "guid" AS guid,
             ROW_NUMBER() OVER (ORDER BY "skill" DESC, "name" ASC) AS rank
      FROM "Player"
      WHERE "isBot" = 0 AND ("kills" >= 1 OR "skillElo" != ${SKILL.START})
    )
    WHERE "guid" IN (${Prisma.join(unique)})`;

  const ranks = new Map<string, number>();
  for (const row of rows) {
    ranks.set(row.guid, Number(row.rank));
  }
  return ranks;
}

/**
 * Posición GLOBAL POR SKILL de UN jugador (perfil). null si no clasifica en la
 * población ELO (bot, o humano sin kills y con skillElo exactamente en la base:
 * nunca jugó de verdad). Mismo orden que getSkillGlobalRanksByGuid.
 */
export async function computeSkillGlobalRank(
  player: Pick<Prisma.PlayerWhereUniqueInput, 'guid'> & {
    skill: number;
    name: string;
    kills: number;
    skillElo: number;
    isBot: boolean;
  },
): Promise<number | null> {
  if (player.isBot) return null;
  if (player.kills < 1 && player.skillElo === SKILL.START) return null;
  const ahead = await prisma.player.count({
    where: eloPopulationWhere({
      OR: [{ skill: { gt: player.skill } }, { skill: { equals: player.skill }, name: { lt: player.name } }],
    }),
  });
  return ahead + 1;
}
