import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import {
  MEDAL_ELITE_TOP,
  MEDAL_TIERS,
  medalFor,
  starsForSkill,
  tierForSkill,
} from '../src/lib/medals.js';
import { req, resetDb } from './helpers.js';

// ── medalFor: PURA, derivada del skill (nunca persistida) ────────────────────

describe('medalFor: fronteras de tiers (escala dura: 200/tier, LEYENDA 2400+)', () => {
  it('tier 1 RECLUTA en 1000 (1 estrella) y clamp por debajo de 1000 (sin tier 0)', () => {
    expect(medalFor(1000, null)).toMatchObject({ tier: 1, tierId: 1, name: 'RECLUTA', assetId: 'medal-1-recluta', stars: 1, globalRank: null, eliteTop12: false });
    // Floor del ELO (150) y cualquier valor < 1000: clamp a tier 1 con 1 estrella.
    expect(medalFor(150, null)).toMatchObject({ tier: 1, name: 'RECLUTA', stars: 1 });
    expect(medalFor(999, null)).toMatchObject({ tier: 1, stars: 1 });
    expect(medalFor(0, null)).toMatchObject({ tier: 1, stars: 1 });
  });

  it('frontera 1199/1200: 1199 sigue en tier 1 (5 estrellas), 1200 sube a SOLDADO', () => {
    const at1199 = medalFor(1199, null);
    expect(at1199).toMatchObject({ tier: 1, tierId: 1, name: 'RECLUTA', assetId: 'medal-1-recluta', stars: 5 });
    const at1200 = medalFor(1200, null);
    expect(at1200).toMatchObject({ tier: 2, tierId: 2, name: 'SOLDADO', assetId: 'medal-2-soldado', stars: 1 });
  });

  it('exactos de cada umbral de tier (límites inclusivos por abajo)', () => {
    expect(medalFor(1400, null)).toMatchObject({ tier: 3, name: 'CABO', stars: 1 });
    expect(medalFor(1600, null)).toMatchObject({ tier: 4, name: 'SARGENTO', stars: 1 });
    expect(medalFor(1800, null)).toMatchObject({ tier: 5, name: 'TENIENTE', stars: 1 });
    expect(medalFor(2000, null)).toMatchObject({ tier: 6, name: 'CAPITÁN', stars: 1 });
    expect(medalFor(2200, null)).toMatchObject({ tier: 7, name: 'COMANDANTE', stars: 1 });
    // 1 punto antes del siguiente tier sigue en el tier actual:
    expect(medalFor(2399, null)).toMatchObject({ tier: 7, name: 'COMANDANTE', stars: 5 });
    expect(medalFor(1599, null)).toMatchObject({ tier: 3, name: 'CABO', stars: 5 });
  });

  it('LEYENDA en 2400+ (cap 2500 incluido): SIN estrellas, expone globalRank', () => {
    expect(medalFor(2400, 1)).toMatchObject({ tier: 8, tierId: 8, name: 'LEYENDA', assetId: 'medal-8-leyenda', stars: null });
    expect(medalFor(2500, 3)).toMatchObject({ tier: 8, stars: null, globalRank: 3, eliteTop12: true });
  });
});

describe('medalFor: estrellas por progreso dentro del tier (width 200, 5 estrellas)', () => {
  it('fórmula exacta: min(5, floor((skill - min)/200*5) + 1)', () => {
    expect(starsForSkill(1000, tierForSkill(1000))).toBe(1); // 0 → 1
    expect(starsForSkill(1040, tierForSkill(1040))).toBe(2); // 1.0 → 2
    expect(starsForSkill(1120, tierForSkill(1120))).toBe(4); // 3.0 → 4
    expect(starsForSkill(1160, tierForSkill(1160))).toBe(5); // 4.0 → 5
    expect(starsForSkill(1199, tierForSkill(1199))).toBe(5); // 4.98 → 5
    expect(starsForSkill(1240, tierForSkill(1240))).toBe(2); // SOLDADO: 1.0 → 2
  });

  it('todos los tiers 1-7 con globalRank null y eliteTop12 false (el rank es cosa de LEYENDA)', () => {
    for (const skill of [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2399]) {
      const medal = medalFor(skill, 4); // rank a propósito presente: debe ignorarse
      expect(medal.globalRank).toBeNull();
      expect(medal.eliteTop12).toBe(false);
      expect(medal.stars).toBeGreaterThanOrEqual(1);
      expect(medal.stars).toBeLessThanOrEqual(5);
    }
  });
});

describe('medalFor: LEYENDA globalRank + eliteTop12', () => {
  it('eliteTop12 true en rank 1..12, false desde 13; null → false', () => {
    expect(medalFor(2500, 1)).toMatchObject({ globalRank: 1, eliteTop12: true });
    expect(medalFor(2500, MEDAL_ELITE_TOP)).toMatchObject({ globalRank: MEDAL_ELITE_TOP, eliteTop12: true });
    expect(medalFor(2500, MEDAL_ELITE_TOP + 1)).toMatchObject({ globalRank: MEDAL_ELITE_TOP + 1, eliteTop12: false });
    expect(medalFor(2500, 999)).toMatchObject({ eliteTop12: false });
    expect(medalFor(2500, null)).toMatchObject({ globalRank: null, eliteTop12: false });
  });
});

describe('MEDAL_TIERS (contrato para la UI)', () => {
  it('8 tiers, nombres militares y assetIds que existen como PNG en el launcher', () => {
    expect(MEDAL_TIERS).toHaveLength(8);
    expect(MEDAL_TIERS.map((tier) => tier.name)).toEqual([
      'RECLUTA', 'SOLDADO', 'CABO', 'SARGENTO', 'TENIENTE', 'CAPITÁN', 'COMANDANTE', 'LEYENDA',
    ]);
    expect(MEDAL_TIERS.map((tier) => tier.assetId)).toEqual([
      'medal-1-recluta', 'medal-2-soldado', 'medal-3-cabo', 'medal-4-sargento',
      'medal-5-teniente', 'medal-6-capitan', 'medal-7-comandante', 'medal-8-leyenda',
    ]);
    // Partición contigua del rango 1000..2050 y LEYENDA abierta.
    for (let i = 1; i < MEDAL_TIERS.length; i += 1) {
      expect(MEDAL_TIERS[i]!.min).toBe(MEDAL_TIERS[i - 1]!.max);
    }
    expect(MEDAL_TIERS[0]!.min).toBe(1000);
    expect(MEDAL_TIERS[7]!.max).toBeNull();
  });
});

// ── Exposición HTTP: perfil + leaderboard ────────────────────────────────────

const BASE = 30_000_000_000_000_000_000n; // guids sintéticos (≤20 dígitos)
const guidAt = (n: number): string => (BASE + BigInt(n)).toString();

/**
 * Fixture de skills exactos:
 *  - 12 leyendas (skills 2500..2445, ≥2400) → globalRank 1..12 → eliteTop12 true.
 *  - leyenda baja (2405) → rank 13 → eliteTop12 FALSE (frontera exacta del top-12).
 *  - soldado (1240) → tier 2 / 2 estrellas.
 *  - novato sin actividad (skillElo 1000, 0 kills) → NO clasifica en la
 *    población ELO (rank null), medalla tier 1/1★ igualmente derivada.
 *  - bot con skill 2500 → medalla tier 8 pero SIN globalRank (población solo-humanos).
 */
async function seedSkillFixture(): Promise<void> {
  await resetDb();
  const rows: Array<{ guid: string; name: string; skill: number; kills: number }> = [];
  for (let i = 0; i < 12; i += 1) {
    rows.push({ guid: guidAt(i + 1), name: `LegendTop${i + 1}`, skill: 2500 - i * 5, kills: 100 - i });
  }
  rows.push({ guid: guidAt(100), name: 'LegendLow', skill: 2405, kills: 30 }); // rank 13
  rows.push({ guid: guidAt(101), name: 'Soldado', skill: 1240, kills: 10 });
  rows.push({ guid: guidAt(102), name: 'Fantasma', skill: 1000, kills: 0 }); // sin actividad ELO
  for (const row of rows) {
    await prisma.player.create({
      data: { guid: row.guid, name: row.name, kills: row.kills, deaths: row.kills, skill: row.skill, skillElo: row.skill, connections: 1 },
    });
  }
  // Bot (rango 0xb07…): skill alto, NUNCA en la población del rank por skill.
  const botGuid = BigInt('0xb07000000000042').toString(10);
  await prisma.player.create({
    data: { guid: botGuid, name: 'BotFortyTwo', isBot: true, kills: 500, skill: 2500, skillElo: 2500, connections: 1 },
  });
}

beforeAll(async () => {
  await resetDb();
});

describe('medal en la superficie HTTP', () => {
  beforeEach(seedSkillFixture);

  it('perfil LEYENDA: globalRank + eliteTop12 (rank 1 y frontera rank 13)', async () => {
    const top1 = await req().get(`/api/players/${guidAt(1)}`);
    expect(top1.status).toBe(200);
    expect((top1.body as { medal: Record<string, unknown> }).medal).toEqual({
      tier: 8,
      tierId: 8,
      name: 'LEYENDA',
      assetId: 'medal-8-leyenda',
      stars: null,
      globalRank: 1,
      eliteTop12: true,
    });

    const rank13 = await req().get(`/api/players/${guidAt(100)}`);
    expect(rank13.status).toBe(200);
    expect((rank13.body as { medal: Record<string, unknown> }).medal).toEqual({
      tier: 8,
      tierId: 8,
      name: 'LEYENDA',
      assetId: 'medal-8-leyenda',
      stars: null,
      globalRank: 13, // 12 leyendas por encima → fuera del elite top-12
      eliteTop12: false,
    });
  });

  it('perfil tier intermedio (SOLDADO 1240 → 2 estrellas) y novato sin actividad (medalla base)', async () => {
    const soldado = await req().get(`/api/players/${guidAt(101)}`);
    expect(soldado.status).toBe(200);
    expect((soldado.body as { medal: Record<string, unknown> }).medal).toEqual({
      tier: 2,
      tierId: 2,
      name: 'SOLDADO',
      assetId: 'medal-2-soldado',
      stars: 2, // (1240-1200)/200*5 → floor 1 → +1
      globalRank: null,
      eliteTop12: false,
    });

    // Fantasma (skillElo=1000 exacto, 0 kills): medalla derivada del skill igual,
    // sin globalRank (no clasifica en la población ELO definida en ranking.service).
    const fantasma = await req().get(`/api/players/${guidAt(102)}`);
    expect(fantasma.status).toBe(200);
    expect((fantasma.body as { medal: Record<string, unknown> }).medal).toEqual({
      tier: 1,
      tierId: 1,
      name: 'RECLUTA',
      assetId: 'medal-1-recluta',
      stars: 1,
      globalRank: null,
      eliteTop12: false,
    });
  });

  it('leaderboard: TODAS las entradas llevan medal y las LEYENDAS traen globalRank/eliteTop12 coherentes', async () => {
    const res = await req().get('/api/leaderboard?sort=skill&order=desc&pageSize=100');
    expect(res.status).toBe(200);
    const body = res.body as { players: Array<{ guid: string; skill: number; medal: { tier: number; stars: number | null; globalRank: number | null; eliteTop12: boolean; assetId: string } }> };

    expect(body.players.length).toBeGreaterThanOrEqual(14);
    for (const player of body.players) {
      expect(player.medal).toBeDefined();
      expect(typeof player.medal.tier).toBe('number');
      expect(typeof player.medal.assetId).toBe('string');
    }

    const legend1 = body.players.find((p) => p.guid === guidAt(1))!;
    expect(legend1.medal).toMatchObject({ tier: 8, stars: null, globalRank: 1, eliteTop12: true });
    const legend12 = body.players.find((p) => p.guid === guidAt(12))!;
    expect(legend12.medal).toMatchObject({ globalRank: 12, eliteTop12: true }); // frontera inclusiva
    const legend13 = body.players.find((p) => p.guid === guidAt(100))!;
    expect(legend13.medal).toMatchObject({ globalRank: 13, eliteTop12: false });
    const soldado = body.players.find((p) => p.guid === guidAt(101))!;
    expect(soldado.medal).toMatchObject({ tier: 2, stars: 2, globalRank: null, eliteTop12: false });
  });

  it('población del rank por skill SOLO-humanos: el bot con skill 2500 NO desplaza a nadie ni tiene rank', async () => {
    const res = await req().get('/api/leaderboard?sort=skill&order=desc&pageSize=100&includeBots=true');
    expect(res.status).toBe(200);
    const body = res.body as { players: Array<{ guid: string; medal: { globalRank: number | null } }> };

    const bot = body.players.find((p) => p.guid === BigInt('0xb07000000000042').toString(10))!;
    expect(bot).toBeDefined();
    expect(bot.medal.globalRank).toBeNull(); // excluido de la población ELO (isBot)

    // Sin el bot en la población, el mejor humano SIGUE siendo globalRank 1.
    const legend1 = body.players.find((p) => p.guid === guidAt(1))!;
    expect(legend1.medal.globalRank).toBe(1);
  });
});
