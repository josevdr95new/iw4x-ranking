/**
 * Medallas ELO (estilo Dota 2 / militar MW2) — DERIVADAS, sin persistencia.
 *
 * La medalla NUNCA se almacena como estado: se calcula SIEMPRE desde el skill
 * actual del jugador (medalFor). Así los descensos son automáticos: el ELO ya
 * baja con las muertes (delta simétrico), y al cruzar un umbral hacia abajo la
 * medalla baja de tier/estrella sin ninguna migración de datos.
 *
 * Escala DURA (200 puntos por tier, LEYENDA en 2400+; cap del ELO base 2500
 * NO cambia — ver SKILL.CAP en services/skill/elo.ts):
 *   1 RECLUTA 1000-1199 · 2 SOLDADO 1200-1399 · 3 CABO 1400-1599 ·
 *   4 SARGENTO 1600-1799 · 5 TENIENTE 1800-1999 · 6 CAPITÁN 2000-2199 ·
 *   7 COMANDANTE 2200-2399 · 8 LEYENDA 2400+
 * Llegar arriba contra BOTS es MUY lento (decay ELO vs bots desde 1300: a 2000
 * el kill vale ~45%, a 2400+ solo 15% — ~4-8/kill en los últimos tiers);
 * contra HUMANOS el ELO es pleno (ver "Decay contra bots" en docs/API.md).
 *
 * Estrellas (tiers 1-7): 5 por tier, progreso continuo dentro del tier:
 *   stars = min(5, floor((skill - tierMin) / 200 * 5) + 1)
 *   (skill = tierMin → 1★; skill ≥ tierMin + 160 → 5★; el min(5,…) es guard
 *   para el límite superior exacto del tier, que en la práctica ya pertenece
 *   al tier siguiente).
 *   Skill por debajo de 1000 (floor 150): tier 1 con 1★ (clamp, sin tier 0).
 *
 * LEYENDA (tier 8): SIN estrellas (stars = null). En su lugar muestra la
 * posición GLOBAL del jugador (rank por skill entre la población ELO: humanos
 * con skill calculado — ver getSkillGlobalRanksByGuid en ranking.service) y el
 * flag eliteTop12 si esa posición es ≤ 12 (el "top-12 elite" de la UI).
 *
 * La UI copia los PNG de apps/launcher/assets/medals/ y usa `assetId`
 * ("medal-N-slug"); el backend SOLO manda el id.
 */

export const MEDAL_TIER_WIDTH = 200;
export const MEDAL_ELITE_TOP = 12;
/** Skill mínimo a partir del cual un jugador es LEYENDA (tier 8). */
export const MEDAL_LEGEND_MIN_SKILL = 2400;

export interface MedalTier {
  /** 1..8. */
  tierId: number;
  /** Nombre militar (RECLUTA … LEYENDA). */
  name: string;
  /** Skill mínimo inclusive. */
  min: number;
  /** Skill máximo exclusive (null = abierto, LEYENDA). */
  max: number | null;
  /** Asset PNG sin extensión (existe en apps/launcher/assets/medals/). */
  assetId: string;
}

/** Los 8 tiers, ordenados por skill asc. Exportada: la UI consume nombres/assets. */
export const MEDAL_TIERS: readonly MedalTier[] = [
  { tierId: 1, name: 'RECLUTA', min: 1000, max: 1200, assetId: 'medal-1-recluta' },
  { tierId: 2, name: 'SOLDADO', min: 1200, max: 1400, assetId: 'medal-2-soldado' },
  { tierId: 3, name: 'CABO', min: 1400, max: 1600, assetId: 'medal-3-cabo' },
  { tierId: 4, name: 'SARGENTO', min: 1600, max: 1800, assetId: 'medal-4-sargento' },
  { tierId: 5, name: 'TENIENTE', min: 1800, max: 2000, assetId: 'medal-5-teniente' },
  { tierId: 6, name: 'CAPITÁN', min: 2000, max: 2200, assetId: 'medal-6-capitan' },
  { tierId: 7, name: 'COMANDANTE', min: 2200, max: 2400, assetId: 'medal-7-comandante' },
  { tierId: 8, name: 'LEYENDA', min: 2400, max: null, assetId: 'medal-8-leyenda' },
] as const;

export interface Medal {
  /** Nº de tier 1..8 (mismo valor que tierId; compat con la UI). */
  tier: number;
  /** 1..8. */
  tierId: number;
  /** Nombre del tier (RECLUTA … LEYENDA). */
  name: string;
  /** Asset PNG sin extensión: "medal-N-slug". */
  assetId: string;
  /** 1..5 en tiers 1-7; null en LEYENDA (ahí se muestra globalRank). */
  stars: number | null;
  /** Posición global por skill (solo LEYENDA; null en el resto o sin población). */
  globalRank: number | null;
  /** true solo en LEYENDA con globalRank ≤ MEDAL_ELITE_TOP. */
  eliteTop12: boolean;
}

/** Tier por skill: el último con min ≤ skill (clamp bajo 1000 → tier 1). */
export function tierForSkill(skill: number): MedalTier {
  let found = MEDAL_TIERS[0]!;
  for (const tier of MEDAL_TIERS) {
    if (skill >= tier.min) found = tier;
  }
  return found;
}

/** Estrellas dentro del tier (tiers 1-7): progreso continuo, clamp 1..5. */
export function starsForSkill(skill: number, tier: MedalTier): number {
  const progress = (skill - tier.min) / MEDAL_TIER_WIDTH;
  return Math.min(5, Math.max(1, Math.floor(progress * 5) + 1));
}

/**
 * Medalla derivada del skill actual. `globalRank` solo se usa en LEYENDA
 * (posición global por skill entre la población ELO; puede ser null si el
 * jugador no clasifica o la población está vacía).
 */
export function medalFor(skill: number, globalRank: number | null): Medal {
  const tier = tierForSkill(skill);
  const isLegend = tier.tierId === MEDAL_TIERS.length; // tier 8
  if (isLegend) {
    const elite = globalRank !== null && globalRank <= MEDAL_ELITE_TOP;
    return {
      tier: tier.tierId,
      tierId: tier.tierId,
      name: tier.name,
      assetId: tier.assetId,
      stars: null,
      globalRank: globalRank ?? null,
      eliteTop12: elite,
    };
  }
  return {
    tier: tier.tierId,
    tierId: tier.tierId,
    name: tier.name,
    assetId: tier.assetId,
    stars: starsForSkill(skill, tier),
    globalRank: null,
    eliteTop12: false,
  };
}
