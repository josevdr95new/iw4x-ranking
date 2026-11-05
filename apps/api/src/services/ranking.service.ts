import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

/**
 * Criterio ÚNICO de ranking global (documentado en docs/API.md):
 * kills DESC, empate por nombre ASC. Es el orden por defecto del leaderboard
 * y el que definen los campos `rank` del leaderboard y del perfil.
 * NINGÚN filtro de búsqueda ni paginación afecta la posición: es siempre global.
 */

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
