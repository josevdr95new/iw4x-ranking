/**
 * Modelo ELO por-evento (estilo inginuity pragmática):
 * cada KillEvent NO teamkill mueve ELO entre atacante y víctima ponderado por la
 * fuerza relativa (expected-score clásico). Condiciones:
 *  - headshot (hitloc head/helmet) → bonus atacante.
 *  - hitloc difícil no-cabeza (neck) → bonus menor.
 *  - daño alto → bonus creciente por encima del daño letal típico (100).
 *  - teamkill → penalidad plana al atacante; la víctima NO recibe nada (no hay
 *    farming por matar compañeros).
 *  - víctima "world"/suicidio → pierde poco (no hay pool del cual robar); solo
 *    se alcanza si algún evento así llegara a almacenarse (la ingesta por log
 *    NO almacena world/suicidio, es comportamiento defensivo para mocks/fuentes).
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

/** Valor expuesto: ELO base (clampeado) + bonus de racha. */
export function clampAndBonus(eloBase: number, bestStreak: number): number {
  return clampElo(eloBase) + streakBonus(bestStreak);
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
