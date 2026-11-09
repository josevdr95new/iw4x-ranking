/**
 * Modelo ELO por-evento (estilo inginuity pragmática):
 * cada KillEvent NO teamkill mueve ELO entre atacante y víctima ponderado por la
 * fuerza relativa (expected-score clásico). Condiciones:
 *  - headshot (hitloc head/helmet) → bonus atacante.
 *  - hitloc difícil no-cabeza (neck) → bonus menor.
 *  - daño alto → bonus creciente por encima del daño letal típico (100).
 *  - teamkill → penalidad plana al atacante; la víctima NO recibe nada (no hay
 *    farming por matar compañeros).
 *  - víctima "world"/suicidio → pierde poco (no hay pool del cual robar).
 *    La ingesta del games_mp.log SÍ almacena estos casos desde 2026-11-08:
 *    KillEvent con originGuid = víctima y targetGuid = '' (marcador de "sin
 *    atacante", bots excluidos) → esta rama aplica WORLD_LOSS=4 al que muere.
 *  - Floor/cap del ELO base para evitar skill infinita o skill por debajo del floor.
 *  - Streak: multiplicador SUAVE aplicado en el compute final (no por evento)
 *    sobre Player.bestStreak (mantenido por la ingesta).
 *
 * Determinismo: mismo set de eventos en el mismo orden (timeEpoch ASC, id ASC)
 * produce SIEMPRE el mismo skill (sin factor de tiempo/inactividad).
 */

export const SKILL = {
  /** Skill inicial (y de todo player sin eventos procesados). */
  START: 1000,
  /** Escala clásica de ELO. */
  SCALE: 400,
  /** Floor del ELO base: nadie baja de acá (evita skill «menos infinita»). */
  FLOOR: 150,
  /** Cap del ELO base (el valor expuesto puede sumar hasta +40 por streak). */
  CAP: 2500,
  /** K por tier de skill: K alto para novatos (fast placement), menor más arriba. */
  K_NOVATO: 40, // elo < 1150
  K_MEDIO: 30, // 1150 ≤ elo ≤ 1600
  K_VETERANO: 24, // elo > 1600
  /** Umbral de tiers. */
  K_NOVATO_LIMIT: 1150,
  K_MEDIO_LIMIT: 1600,
  /** Bonus atacante por headshot (head/helmet). */
  HEADSHOT_MULT: 1.25,
  /** Bonus por hitloc difícil NO cubierto por headshot (neck). */
  HARD_HITLOC_MULT: 1.1,
  /** Hitloc difíciles además del head/helmet. */
  HARD_HITLOCS: ['neck'] as const,
  /** Daño de referencia (letal típico): por encima arranca el bonus. */
  DAMAGE_BASE: 100,
  /** Bonus por daño: +1% cada 10 dmg por encima del base, cap +25%. */
  DAMAGE_BONUS_MAX: 0.25,
  /** Divisor de escala del bonus por daño: (dmg - 100) / 1000. */
  DAMAGE_BONUS_DIVISOR: 1000,
  /** Cap del multiplicador combinado (no se alcanza con los valores actuales; guard). */
  EVENT_MULT_CAP: 1.6,
  /** Penalidad plana al atacante en teamkill. */
  TEAMKILL_PENALTY: 24,
  /** Pérdida plana del que muere por world/suicidio (sin atacante no hay pool). */
  WORLD_LOSS: 4,
  /** Streak: +N puntos por racha (suave, sobre el compute final). */
  STREAK_BONUS_PER: 2,
  /** Cap de racha que suma bonus (bestStreak ≥ 20 no sigue sumando). */
  STREAK_CAP: 20,
  /**
   * Bonus ELO de FIN DE PARTIDA (top-3 de kills entre HUMANOS). Se aplica como
   * delta directo sobre el ELO base vía MatchBonusEvent (ver skill.service).
   * Condiciones anti-abuso: partida ≥3 min de log, ≥2 humanos participantes,
   * ≥5 kills para calificar, bots excluidos.
   */
  MATCH_BONUS_MIN_KILLS: 5,
  MATCH_BONUS_MIN_HUMANS: 2,
  MATCH_BONUS_MIN_DURATION_SEC: 180,
  MATCH_BONUS_FIRST: 15,
  MATCH_BONUS_SECOND: 10,
  MATCH_BONUS_THIRD: 5,
} as const;

export function clampElo(elo: number): number {
  return Math.min(SKILL.CAP, Math.max(SKILL.FLOOR, elo));
}

/** Expected-score clásico: probabilidad de victoria de `a` contra `b`. */
export function expectedScore(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / SKILL.SCALE));
}

/** K del jugador según skill vigente (novatos aprenden rápido). */
export function kFactor(elo: number): number {
  if (elo < SKILL.K_NOVATO_LIMIT) return SKILL.K_NOVATO;
  if (elo <= SKILL.K_MEDIO_LIMIT) return SKILL.K_MEDIO;
  return SKILL.K_VETERANO;
}

/** Multiplicador del intercambio por condiciones del evento (bonus atacante). */
export function eventMultiplier(headshot: boolean, hitloc: string | null, damage: number): number {
  let mult = 1;
  if (headshot) mult *= SKILL.HEADSHOT_MULT;
  else if (hitloc !== null) {
    const loc = hitloc.trim().toLowerCase();
    if (SKILL.HARD_HITLOCS.includes(loc as (typeof SKILL.HARD_HITLOCS)[number])) mult *= SKILL.HARD_HITLOC_MULT;
  }
  const overDamage = Math.max(0, damage - SKILL.DAMAGE_BASE);
  if (overDamage > 0) mult *= 1 + Math.min(SKILL.DAMAGE_BONUS_MAX, overDamage / SKILL.DAMAGE_BONUS_DIVISOR);
  return Math.min(SKILL.EVENT_MULT_CAP, mult);
}

export interface EloEvent {
  isKill: boolean;
  isTeamkill: boolean;
  headshot: boolean;
  hitloc: string | null;
  damage: number;
}

/**
 * Puntos en juego de UN kill válido (elo de atacante y víctima al momento del
 * evento). Delta positivo = va hacia el atacante (ganancia) y la víctima pierde
 * el MISMO monto (zero-sum por evento; floor/cap lo pueden romper a favor de
 * la estabilidad, intencional).
 */
export function killEloDelta(attackerElo: number, victimElo: number, event: EloEvent): number {
  if (!event.isKill || event.isTeamkill) return 0; // el teamkill va por la penalidad plana
  const k = (kFactor(attackerElo) + kFactor(victimElo)) / 2;
  const expectation = expectedScore(attackerElo, victimElo);
  return k * eventMultiplier(event.headshot, event.hitloc, event.damage) * (1 - expectation);
}

/** Bonus suave por racha sobre el compute final (no por evento). */
export function streakBonus(bestStreak: number): number {
  const streak = Math.min(Math.max(0, Math.trunc(bestStreak)), SKILL.STREAK_CAP);
  return streak * SKILL.STREAK_BONUS_PER;
}

/**
 * FACTOR DE DECAY ELO CONTRA BOTS (anti-farmeo).
 *
 * Los bots son rivales fijos (~1000): sin decay, farmear bots daría ELO
 * constante (~20/kill) y LEYENDA caería en pocas partidas. El decay escala con
 * el skill ACTUAL del humano (el farmeo pierde valor a medida que subes):
 *
 *   botFactor(skill) = 1.0                                        si skill ≤ soft (1300)
 *                    = 1 − (1 − min) × (skill − soft)/(hard − soft)  si soft < skill < hard
 *                    = min (0.15)                                 si skill ≥ hard (2400)
 *
 * Env-configurable: BOT_ELO_DECAY_MIN / BOT_ELO_DECAY_SOFT / BOT_ELO_DECAY_HARD.
 * Ejemplos (defaults): 1200 → 1.00 (~+20/kill) · 1800 → 0.614 (~+12) ·
 * 2000 → 0.459 (~+9) · 2400 → 0.15 (~+3).
 *
 * Aplicación (skill.service): cuando el oponente del kill es un BOT, el delta
 * del evento se multiplica por botFactor(skill VIGENTE del humano) y el bot
 * gana/pierde ESE MISMO delta decayado (zero-sum). Contra HUMANOS el decay NO
 * aplica (factor 1, ELO pleno solo jugando contra personas). El recompute:skill
 * lo reproduce NATURALMENTE: el factor se calcula con el skill en memoria del
 * momento del evento, y el reprocess secuencial reconstruye los mismos skills
 * intermedios → mismos factores → mismo resultado.
 *
 * Determinista: depende solo de (skill vigente, soft, hard, min) — sin tiempo.
 */
export interface BotDecayOptions {
  min: number;
  soft: number;
  hard: number;
}

export function botDecayFactor(skill: number, options: BotDecayOptions): number {
  if (skill <= options.soft) return 1;
  if (skill >= options.hard) return options.min;
  const progress = (skill - options.soft) / (options.hard - options.soft);
  return 1 - (1 - options.min) * progress;
}

/** Valor expuesto: ELO base (clampeado) + bonus de racha. */
export function clampAndBonus(eloBase: number, bestStreak: number): number {
  return clampElo(eloBase) + streakBonus(bestStreak);
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
