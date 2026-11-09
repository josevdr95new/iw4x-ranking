import { prisma } from '../../lib/prisma.js';
import { isBotGuid } from '../alias.service.js';
import { SKILL } from './elo.js';

/**
 * BONUS ELO DE FIN DE PARTIDA (top-3 de kills entre humanos).
 *
 * La ingesta del games_mp.log acumula, POR PARTIDA (entre InitGame y
 * ShutdownGame), las kills de cada killer humano y los humanos participantes.
 * Al detectar ShutdownGame calcula el top-3 (matchTop3, puro y determinista) y
 * persiste UN MatchBonusEvent por premiado (skillProcessed=false). El motor de
 * skill (processSkillUpdates) los consume en el MISMO stream cronológico que
 * los KillEvent y aplica el delta directo sobre el ELO base. Así un
 * `npm run recompute:skill` reproduce el bonus sin pasos extra: mismo set de
 * MatchBonusEvent → mismos deltas → mismo skill (determinismo documentado en
 * docs/API.md, sección "skill").
 *
 * Condiciones anti-abuso (constantes en SKILL):
 *  - La partida duró ≥ 3 min de LOG (prefijos de tiempo m:ss del reader; evita
 *    rotaciones instantáneas farmeadas). Si el reader no vio el InitGame de la
 *    partida (log rotado a mitad), NO hay bonus (partida incompleta).
 *  - ≥ 2 humanos participantes (líneas J/K de la partida). Partidas contra
 *    puros bots no premian.
 *  - Cada premiado requiere ≥ 5 kills en la partida; los bots NUNCA califican
 *    (el tally del reader ya excluye bots; defensivo: re-filtro con isBotGuid).
 *  - Desempate determinista: kills DESC, deaths ASC, name ASC, guid ASC.
 */

export interface MatchBonusAward {
  guid: string;
  position: 1 | 2 | 3;
  delta: number;
}

/** Tally por jugador dentro de UNA partida (kills/deaths y último nick visto). */
export interface MatchPlayerTally {
  kills: number;
  deaths: number;
  name: string;
}

export const MATCH_BONUS_DELTAS = [SKILL.MATCH_BONUS_FIRST, SKILL.MATCH_BONUS_SECOND, SKILL.MATCH_BONUS_THIRD] as const;

/**
 * Top-3 de kills de una partida: PURO, determinista, sin I/O (testeable sin DB).
 *  - Solo humanos (isBotGuid); requieren ≥ SKILL.MATCH_BONUS_MIN_KILLS kills.
 *  - Requiere ≥ SKILL.MATCH_BONUS_MIN_HUMANS humanos EN LA PARTIDA (aunque el
 *    3º no llegue a 5 kills, el premio se otorga a los que sí califiquen).
 *  - Desempate: kills DESC, deaths ASC, name ASC, guid ASC.
 * Devuelve máximo 3 premios con posición y delta (+15/+10/+5).
 */
export function matchTop3(tally: Map<string, MatchPlayerTally>): MatchBonusAward[] {
  const humans = [...tally.entries()].filter(([guid]) => !isBotGuid(guid));
  if (humans.length < SKILL.MATCH_BONUS_MIN_HUMANS) return [];

  const qualified = humans
    .filter(([, row]) => row.kills >= SKILL.MATCH_BONUS_MIN_KILLS)
    .sort(([guidA, a], [guidB, b]) =>
      b.kills - a.kills ||
      a.deaths - b.deaths ||
      a.name.localeCompare(b.name) ||
      (guidA < guidB ? -1 : guidA > guidB ? 1 : 0),
    )
    .slice(0, 3);

  return qualified.map(([guid], index) => ({
    guid,
    position: (index + 1) as 1 | 2 | 3,
    delta: MATCH_BONUS_DELTAS[index]!,
  }));
}

export interface MatchBonusContext {
  /** Duración de la partida según el log (prefijos de tiempo); null si desconocida. */
  matchDurationSec: number | null;
  map: string | null;
  gametype: string | null;
  server: string | null;
  /**
   * Epoch MÍNIMO (inclusivo) para el timeEpoch de los MatchBonusEvent creados.
   * Lo fija el reader (ver gamelog.reader.ts, rama shutdown): el stream de
   * skill ordena por (timeEpoch, id) y el desempate por id NO es comparable
   * entre KillEvent y MatchBonusEvent (secuencias autoincrement INDEPENDIENTES,
   * y las de kill crean mucho más rápido) → si bonus y kills de una partida
   * comparten segundo, el orden dependería de la velocidad de la ingesta
   * (bug CI 2026-11-08: el bonus ordenaba ANTES de los kills de su propia
   * partida cuando la pasada cabía en <1s). Con el floor, el bonus queda
   * SIEMPRE estrictamente después de los kills ya insertados de su pasada.
   * `time` (DateTime) conserva el reloj real; solo se ajusta la clave de orden.
   */
  minTimeEpoch?: number;
}

/**
 * Persiste los MatchBonusEvent de UNA partida (una fila por premiado, flag
 * skillProcessed=false para que el motor de skill los aplique). Idempotente
 * de facto: solo se llama una vez por ShutdownGame procesado (el cursor del
 * log no re-lee líneas), y el recompute DELIBERADO de skill re-procesa los
 * eventos ya existentes (nunca duplica: no crea eventos nuevos).
 */
export async function awardMatchBonus(
  tally: Map<string, MatchPlayerTally>,
  context: MatchBonusContext,
): Promise<MatchBonusAward[]> {
  const duration = context.matchDurationSec ?? -1;
  if (duration < SKILL.MATCH_BONUS_MIN_DURATION_SEC) return [];

  const awards = matchTop3(tally);
  if (awards.length === 0) return [];

  const now = new Date();
  // Floor de orden (ver MatchBonusContext.minTimeEpoch): garantiza que el bonus
  // ordene DESPUÉS de los kills de su partida en el stream (timeEpoch, id) del
  // skill, INDEPENDIENTEMENTE de si la ingesta cruzó un segundo de reloj.
  const timeEpoch = Math.max(Math.trunc(now.getTime() / 1000), context.minTimeEpoch ?? 0);
  await prisma.matchBonusEvent.createMany({
    data: awards.map((award) => {
      const row = tally.get(award.guid)!;
      return {
        guid: award.guid,
        position: award.position,
        delta: award.delta,
        killsInMatch: row.kills,
        humansInMatch: humansInTally(tally),
        matchDurationSec: duration,
        map: context.map,
        gametype: context.gametype,
        server: context.server,
        time: now,
        timeEpoch,
      };
    }),
  });
  return awards;
}

/** Humanos participantes (guids del tally que no son bots). */
export function humansInTally(tally: Map<string, MatchPlayerTally>): number {
  let count = 0;
  for (const guid of tally.keys()) if (!isBotGuid(guid)) count += 1;
  return count;
}
