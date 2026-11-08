import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { processSkillUpdates } from '../src/services/skill/skill.service.js';
import {
  SKILL,
  botDecayFactor,
  clampAndBonus,
  clampElo,
  expectedScore,
  killEloDelta,
  kFactor,
  round2,
  streakBonus,
} from '../src/services/skill/elo.js';
import { env } from '../src/config/env.js';
import { req, resetDb } from './helpers.js';

interface EventOpts {
  origin: string;
  target?: string | null;
  damage?: number;
  hitloc?: string | null;
  headshot?: boolean;
  isTeamkill?: boolean;
  isKill?: boolean;
  epoch: number;
}

async function player(guid: string, name: string, extra: { bestStreak?: number; skillElo?: number } = {}): Promise<void> {
  await prisma.player.create({
    data: {
      guid,
      name,
      connections: 1,
      bestStreak: extra.bestStreak ?? 0,
      ...(extra.skillElo !== undefined ? { skillElo: extra.skillElo, skill: extra.skillElo } : {}),
    },
  });
}

async function killEvent(opts: EventOpts): Promise<void> {
  await prisma.killEvent.create({
    data: {
      originGuid: opts.origin,
      // '' = sin víctima (world); el esquema NO admite null (ver skill.service).
      targetGuid: opts.target ?? '',
      isKill: opts.isKill ?? true,
      damage: opts.damage ?? 100,
      weapon: 'ak47',
      hitloc: opts.hitloc ?? 'torso_lower',
      headshot: opts.headshot ?? false,
      isTeamkill: opts.isTeamkill ?? false,
      timeEpoch: opts.epoch,
      time: new Date(opts.epoch * 1000),
    },
  });
}

async function seedDuel(a: string, aName: string, b: string, bName: string): Promise<void> {
  await resetDb();
  await player(a, aName);
  await player(b, bName);
}

async function skillsOf(guids: string[]): Promise<Array<{ guid: string; skill: number; skillElo: number }>> {
  const rows = await prisma.player.findMany({
    where: { guid: { in: guids } },
    select: { guid: true, skill: true, skillElo: true },
    orderBy: { guid: 'asc' },
  });
  return rows.map((row) => ({ guid: row.guid, skill: row.skill, skillElo: row.skillElo }));
}

beforeAll(async () => {
  await resetDb();
});

describe('ELO: math puro (elo.ts)', () => {
  it('expectedScore sigue el clásico 1/(1+10^(dR/400))', () => {
    expect(expectedScore(SKILL.START, SKILL.START)).toBe(0.5);
    expect(expectedScore(SKILL.START, SKILL.START + SKILL.SCALE)).toBeCloseTo(1 / 11, 6);
    expect(expectedScore(SKILL.START + SKILL.SCALE, SKILL.START)).toBeCloseTo(10 / 11, 6);
  });

  it('K por tier: alto para novatos, menor para veteranos', () => {
    expect(kFactor(1000)).toBe(SKILL.K_NOVATO);
    expect(kFactor(SKILL.K_NOVATO_LIMIT)).toBe(SKILL.K_MEDIO);
    expect(kFactor(SKILL.K_MEDIO_LIMIT)).toBe(SKILL.K_MEDIO);
    expect(kFactor(SKILL.K_MEDIO_LIMIT + 1)).toBe(SKILL.K_VETERANO);
  });

  it('floor y cap del ELO base + streak bonus (suave, en el compute final)', () => {
    expect(clampElo(SKILL.FLOOR - 1)).toBe(SKILL.FLOOR);
    expect(clampElo(SKILL.CAP + 500)).toBe(SKILL.CAP);
    expect(streakBonus(0)).toBe(0);
    expect(streakBonus(9)).toBe(18);
    expect(streakBonus(50)).toBe(SKILL.STREAK_CAP * SKILL.STREAK_BONUS_PER); // cap 20
    expect(clampAndBonus(SKILL.START, 10)).toBe(SKILL.START + 20);
  });

  it('killEloDelta: bonos de headshot/daño multiplicativos, combinación acotada por EVENT_MULT_CAP', () => {
    const plain = killEloDelta(SKILL.START, SKILL.START, { isKill: true, isTeamkill: false, headshot: false, hitloc: 'torso_lower', damage: 100 });
    expect(plain).toBeCloseTo((SKILL.K_NOVATO / 2) * 1, 4); // K=(40+40)/2, expected=.5 → 20
    const hs = killEloDelta(SKILL.START, SKILL.START, { isKill: true, isTeamkill: false, headshot: true, hitloc: 'head', damage: 100 });
    expect(hs).toBeCloseTo(plain * SKILL.HEADSHOT_MULT, 6);
    const dmg = killEloDelta(SKILL.START, SKILL.START, { isKill: true, isTeamkill: false, headshot: false, hitloc: null, damage: 300 });
    expect(dmg).toBeCloseTo(plain * (1 + 200 / SKILL.DAMAGE_BONUS_DIVISOR), 6);
    // Combinación máxima posible con las constantes actuales:
    // HEADSHOT_MULT (1.25) × DAMAGE_BONUS_MAX (1.25) = 1.5625 < EVENT_MULT_CAP (1.6, guard).
    const combined = killEloDelta(SKILL.START, SKILL.START, { isKill: true, isTeamkill: false, headshot: true, hitloc: null, damage: 10_000 });
    expect(combined).toBeCloseTo(plain * SKILL.HEADSHOT_MULT * (1 + SKILL.DAMAGE_BONUS_MAX), 6);
    expect(combined).toBeLessThan(plain * SKILL.EVENT_MULT_CAP);
  });
});

describe('processSkillUpdates (incremental + determinista)', () => {
  it('novato que mata a veterano gana MÁS que veterano matando novato (expected-score)', async () => {
    // Escenario 1: novato (1000) mata a veterano (1400)
    await seedDuel('200000000000000001', 'Novato', '200000000000000002', 'Veterano');
    await prisma.player.update({ where: { guid: '200000000000000002' }, data: { skillElo: 1400, skill: 1400 } });
    await killEvent({ origin: '200000000000000001', target: '200000000000000002', epoch: 1000 });
    await processSkillUpdates();
    const novatoAfterWin = (await skillsOf(['200000000000000001']))[0]!.skillElo - SKILL.START;
    const veteranoAfterLoss = 1400 - (await skillsOf(['200000000000000002']))[0]!.skillElo;

    // Escenario 2 (misma vuelta al estado base): veterano (1400) mata a novato (1000)
    await seedDuel('200000000000000001', 'Novato', '200000000000000002', 'Veterano');
    await prisma.player.update({ where: { guid: '200000000000000002' }, data: { skillElo: 1400, skill: 1400 } });
    await killEvent({ origin: '200000000000000002', target: '200000000000000001', epoch: 1000 });
    await processSkillUpdates();
    const veteranoAfterWin = (await skillsOf(['200000000000000002']))[0]!.skillElo - 1400;
    const novatoAfterLoss = SKILL.START - (await skillsOf(['200000000000000001']))[0]!.skillElo;

    expect(novatoAfterWin).toBeGreaterThan(veteranoAfterWin); // upset vale más
    expect(novatoAfterWin).toBeCloseTo(veteranoAfterLoss, 6); // zero-sum por evento
    expect(veteranoAfterWin).toBeCloseTo(novatoAfterLoss, 6);
    // Sanity: el novato sube bastante y el veterano apenas pierde al ganar
    expect(novatoAfterWin).toBeGreaterThan(20);
    expect(veteranoAfterWin).toBeLessThan(10);
  });

  it('teamkill: el atacante pierde la penalidad plana, la víctima NO cambia', async () => {
    await seedDuel('200000000000000003', 'Killer', '200000000000000004', 'Compañero');
    await killEvent({ origin: '200000000000000003', target: '200000000000000004', isTeamkill: true, epoch: 1001 });
    await processSkillUpdates();

    const [killer, mate] = await skillsOf(['200000000000000003', '200000000000000004']);
    expect(killer!.skillElo).toBeCloseTo(SKILL.START - SKILL.TEAMKILL_PENALTY, 6);
    expect(mate!.skillElo).toBe(SKILL.START); // la víctima de teamkill no gana ni pierde
  });

  it('headshot aplica el bonus: la víctima pierde más que en un kill normal', async () => {
    await seedDuel('200000000000000005', 'Sniper', '200000000000000006', 'Víctima');
    await killEvent({ origin: '200000000000000005', target: '200000000000000006', headshot: true, hitloc: 'head', epoch: 1002 });
    await processSkillUpdates();
    const lossHead = SKILL.START - (await skillsOf(['200000000000000006']))[0]!.skillElo;

    await seedDuel('200000000000000005', 'Sniper', '200000000000000006', 'Víctima');
    await killEvent({ origin: '200000000000000005', target: '200000000000000006', headshot: false, hitloc: 'torso_lower', damage: 100, epoch: 1002 });
    await processSkillUpdates();
    const lossPlain = SKILL.START - (await skillsOf(['200000000000000006']))[0]!.skillElo;

    expect(lossHead).toBeGreaterThan(lossPlain);
    expect(lossHead).toBeCloseTo(lossPlain * SKILL.HEADSHOT_MULT, 6);
  });

  it('floor: la víctima nunca baja de 150 aunque siga perdiendo kills', async () => {
    await seedDuel('200000000000000007', 'FloorGuy', '200000000000000008', 'Rival');
    await prisma.player.update({ where: { guid: '200000000000000007' }, data: { skillElo: 155, skill: 155 } });
    await prisma.player.update({ where: { guid: '200000000000000008' }, data: { skillElo: 175, skill: 175 } });
    // Kill entre iguales (delta ≈ 19): 155 - delta < 150 → el clamp lo deja EXACTO en el floor.
    await killEvent({ origin: '200000000000000008', target: '200000000000000007', epoch: 1003 });
    await processSkillUpdates();

    const row = (await skillsOf(['200000000000000007']))[0]!;
    expect(row.skillElo).toBe(SKILL.FLOOR);

    // Sigue perdiendo kills: el floor se mantiene (nunca < 150).
    await killEvent({ origin: '200000000000000008', target: '200000000000000007', epoch: 1004 });
    await killEvent({ origin: '200000000000000008', target: '200000000000000007', epoch: 1005 });
    await processSkillUpdates();
    const rowAfter = (await skillsOf(['200000000000000007']))[0]!;
    expect(rowAfter.skillElo).toBe(SKILL.FLOOR);
  });

  it('cap: farmear kills contra floor-guys NO explota el cap del atacante', async () => {
    await seedDuel('200000000000000009', 'CapGuy', '200000000000000010', 'Piñata');
    await prisma.player.update({ where: { guid: '200000000000000009' }, data: { skillElo: SKILL.CAP - 5, skill: SKILL.CAP - 5 } });
    for (let i = 0; i < 30; i += 1) {
      await killEvent({ origin: '200000000000000009', target: '200000000000000010', damage: 500, headshot: true, hitloc: 'head', epoch: 2000 + i });
    }
    await processSkillUpdates();

    const capGuy = (await skillsOf(['200000000000000009']))[0]!;
    expect(capGuy.skillElo).toBeLessThanOrEqual(SKILL.CAP);
    expect(capGuy.skill).toBeLessThanOrEqual(SKILL.CAP + SKILL.STREAK_CAP * SKILL.STREAK_BONUS_PER);
  });

  it('streak bonus suave: skill = skillElo + 2 * min(bestStreak, 20)', async () => {
    await seedDuel('200000000000000011', 'Streaker', '200000000000000012', 'Rival');
    await prisma.player.update({ where: { guid: '200000000000000011' }, data: { bestStreak: 12 } });
    await killEvent({ origin: '200000000000000011', target: '200000000000000012', epoch: 1005 });
    await processSkillUpdates();

    const [streaker] = await skillsOf(['200000000000000011']);
    expect(streaker!.skillElo).toBeGreaterThan(SKILL.START);
    expect(streaker!.skill).toBeCloseTo(streaker!.skillElo + 2 * Math.min(12, SKILL.STREAK_CAP), 6);
  });

  it('reprocess IDEMPOTENTE: segunda pasada sin eventos nuevos no re-cuenta ni mueve nada', async () => {
    await seedDuel('200000000000000021', 'A', '200000000000000022', 'B');
    await killEvent({ origin: '200000000000000021', target: '200000000000000022', headshot: true, hitloc: 'head', damage: 180, epoch: 2001 });
    await killEvent({ origin: '200000000000000022', target: '200000000000000021', epoch: 2002 });

    const first = await processSkillUpdates();
    expect(first.processed).toBe(2);
    const snapshot = await skillsOf(['200000000000000021', '200000000000000022']);

    const second = await processSkillUpdates();
    expect(second.processed).toBe(0);
    expect(await skillsOf(['200000000000000021', '200000000000000022'])).toEqual(snapshot);
  });

  it('RECOMPUTE determinista: reset completo + reproceso → exactamente el mismo skill', async () => {
    // Datos del test anterior (A/B con 2 eventos ya procesados).
    const before = await skillsOf(['200000000000000021', '200000000000000022']);

    await prisma.killEvent.updateMany({ where: {}, data: { skillProcessed: false } });
    await prisma.player.updateMany({ where: {}, data: { skillElo: 0, skill: 0 } });

    const rerun = await processSkillUpdates();
    expect(rerun.processed).toBe(2);

    const after = await skillsOf(['200000000000000021', '200000000000000022']);
    expect(after).toEqual(before); // determinista al 100% (exacto, no toBeCloseTo)
  });

  it('players SIN eventos se inicializan a 1000 (siguen muy visibles como novatos)', async () => {
    await resetDb();
    await player('200000000000000031', 'Sombra'); // conectado, 0 eventos
    const result = await processSkillUpdates();
    expect(result.initialized).toBeGreaterThanOrEqual(1);
    const sombra = (await skillsOf(['200000000000000031']))[0]!;
    expect(sombra.skillElo).toBe(SKILL.START);
    expect(sombra.skill).toBe(SKILL.START);
  });
});

describe('skill en la superficie HTTP (shape sin cambios)', () => {
  it('GET /api/leaderboard?sort=skill expone skill number y ordena desc', async () => {
    await seedDuel('200000000000000041', 'Fuerte', '200000000000000042', 'Débil');
    await killEvent({ origin: '200000000000000041', target: '200000000000000042', epoch: 3001 });
    await killEvent({ origin: '200000000000000041', target: '200000000000000042', damage: 250, epoch: 3002 });
    await killEvent({ origin: '200000000000000041', target: '200000000000000042', headshot: true, hitloc: 'head', epoch: 3003 });
    await processSkillUpdates();

    const res = await req().get('/api/leaderboard?sort=skill&order=desc&pageSize=10');
    expect(res.status).toBe(200);
    const body = res.body as {
      sort: string;
      order: string;
      players: Array<{ guid: string; skill: number }>;
    };
    expect(body.sort).toBe('skill');
    expect(body.order).toBe('desc');
    expect(body.players.every((p) => typeof p.skill === 'number')).toBe(true);

    const fuerte = body.players.find((p) => p.guid === '200000000000000041');
    const debil = body.players.find((p) => p.guid === '200000000000000042');
    expect(fuerte).toBeDefined();
    expect(debil).toBeDefined();
    expect(fuerte!.skill).toBeGreaterThan(SKILL.START);
    expect(debil!.skill).toBeLessThan(SKILL.START);
    expect(debil!.skill).toBeGreaterThanOrEqual(SKILL.FLOOR);

    // El orden desc por skill es correcto con los valores devueltos.
    const skills = body.players.map((p) => p.skill);
    expect([...skills].sort((x, y) => y - x)).toEqual(skills);
  });

  it('GET /api/players/:guid sigue devolviendo skill number para el perfil', async () => {
    const res = await req().get('/api/players/200000000000000041');
    expect(res.status).toBe(200);
    const body = res.body as { player: { skill: number; guid: string } };
    expect(body.player.guid).toBe('200000000000000041');
    expect(typeof body.player.skill).toBe('number');
    expect(body.player.skill).toBeGreaterThan(SKILL.START);
  });
});

describe('edge cases de eventos', () => {
  it('eventos isKill=false (no letales) NO mueven ELO pero quedan marcados procesados', async () => {
    await seedDuel('200000000000000051', 'NoLetal', '200000000000000052', 'Puncher');
    await killEvent({ origin: '200000000000000051', target: '200000000000000052', isKill: false, damage: 40, epoch: 4001 });
    await processSkillUpdates();

    const row = await prisma.killEvent.findFirstOrThrow({ where: { originGuid: '200000000000000051' }, select: { skillProcessed: true } });
    expect(row.skillProcessed).toBe(true);
    const [a, b] = await skillsOf(['200000000000000051', '200000000000000052']);
    expect(a!.skillElo).toBe(SKILL.START);
    expect(b!.skillElo).toBe(SKILL.START);
  });

  it('world/suicidio (defensivo, estos eventos normalmente no se almacenan): pérdida plana pequeña', async () => {
    await resetDb();
    await player('200000000000000061', 'Suicida');
    // Caso "world": target null (los mocks/fuentes pueden traerlo; el log no lo almacena)
    await killEvent({ origin: '200000000000000061', target: null, epoch: 4002 });
    // Caso suicidio: target == origin
    await killEvent({ origin: '200000000000000061', target: '200000000000000061', epoch: 4003 });
    await processSkillUpdates();

    const row = (await skillsOf(['200000000000000061']))[0]!;
    expect(row.skillElo).toBeCloseTo(SKILL.START - 2 * SKILL.WORLD_LOSS, 6);
  });
});

// ── DECAY ELO CONTRA BOTS (anti-farmeo) ──────────────────────────────────────
// Los bots son rivales fijos (~1000): sin decay, farmearlos daría ELO constante
// (~20/kill) y LEYENDA caería en pocas partidas. Contra bots el delta se escala
// por botFactor(skill VIGENTE del humano); contra HUMANOS el ELO es pleno.

const BOT_DECAY = { min: env.botEloDecayMin, soft: env.botEloDecaySoft, hard: env.botEloDecayHard };
const BOT_1 = BigInt('0xb07000000000001').toString(10); // rango dedicado 0xb07… (isBotGuid)
const BOT_2 = BigInt('0xb07000000000002').toString(10);
const PLAIN_EVENT = { isKill: true, isTeamkill: false, headshot: false, hitloc: 'torso_lower', damage: 100 } as const;

describe('botDecayFactor: math puro', () => {
  it('1.0 por debajo de soft (1300), lineal en medio, min (0.15) desde hard (2400)', () => {
    expect(botDecayFactor(1000, BOT_DECAY)).toBe(1);
    expect(botDecayFactor(1200, BOT_DECAY)).toBe(1);
    expect(botDecayFactor(env.botEloDecaySoft, BOT_DECAY)).toBe(1); // límite inclusivo
    expect(botDecayFactor(env.botEloDecaySoft + 1, BOT_DECAY)).toBeCloseTo(1 - 0.85 / 1100, 10);
    expect(botDecayFactor(1800, BOT_DECAY)).toBeCloseTo(0.6136, 4); // ~61% (~+12/kill)
    expect(botDecayFactor(2000, BOT_DECAY)).toBeCloseTo(0.4591, 4); // ~46% (~+9/kill)
    expect(botDecayFactor(env.botEloDecayHard, BOT_DECAY)).toBeCloseTo(0.15, 10); // límite inclusivo
    expect(botDecayFactor(2450, BOT_DECAY)).toBe(0.15);
    expect(botDecayFactor(2500, BOT_DECAY)).toBe(0.15);
    // Monótono decreciente (subir de skill NUNCA aumenta el rendimiento vs bots).
    for (let skill = 1300; skill < 2400; skill += 50) {
      expect(botDecayFactor(skill + 50, BOT_DECAY)).toBeLessThan(botDecayFactor(skill, BOT_DECAY));
    }
  });
});

describe('decay aplicado en processSkillUpdates (integraación)', () => {
  it('skill 1200 vs bot: SIN decay (factor 1.0) y zero-sum intacto', async () => {
    await seedDuel('200000000000000071', 'NovatoVsBot', BOT_1, 'BotUno');
    await prisma.player.update({ where: { guid: '200000000000000071' }, data: { skillElo: 1200, skill: 1200 } });
    await killEvent({ origin: '200000000000000071', target: BOT_1, epoch: 5001 });
    await processSkillUpdates();

    const fullDelta = killEloDelta(1200, SKILL.START, PLAIN_EVENT);
    const humano = (await skillsOf(['200000000000000071']))[0]!;
    const bot = (await skillsOf([BOT_1]))[0]!;
    expect(humano.skillElo).toBe(round2(1200 + fullDelta)); // ELO PLENO (factor 1)
    expect(bot.skillElo).toBe(round2(SKILL.START - fullDelta)); // el bot pierde lo mismo
    expect(humano.skillElo + bot.skillElo).toBeCloseTo(2200, 6); // zero-sum
  });

  it('skill 2000 vs bot: el delta se decae al factor del skill VIGENTE (~0.46)', async () => {
    await seedDuel('200000000000000072', 'CapitanVsBot', BOT_1, 'BotUno');
    await prisma.player.update({ where: { guid: '200000000000000072' }, data: { skillElo: 2000, skill: 2000 } });
    await killEvent({ origin: '200000000000000072', target: BOT_1, epoch: 5002 });
    await processSkillUpdates();

    const decayed = killEloDelta(2000, SKILL.START, PLAIN_EVENT) * botDecayFactor(2000, BOT_DECAY);
    const humano = (await skillsOf(['200000000000000072']))[0]!;
    const bot = (await skillsOf([BOT_1]))[0]!;
    expect(humano.skillElo).toBe(round2(2000 + decayed));
    expect(bot.skillElo).toBe(round2(SKILL.START - decayed)); // el bot TAMBIÉN decae (zero-sum)
    // Sanidad: el decay SÍ mordió (menos de la mitad del delta pleno a este skill).
    expect(humano.skillElo).toBeLessThan(2000 + killEloDelta(2000, SKILL.START, PLAIN_EVENT));
  });

  it('skill 2450 vs bot: factor mínimo 0.15 (~+3/kill)', async () => {
    await seedDuel('200000000000000073', 'LeyendaVsBot', BOT_1, 'BotUno');
    await prisma.player.update({ where: { guid: '200000000000000073' }, data: { skillElo: 2450, skill: 2450 } });
    await killEvent({ origin: '200000000000000073', target: BOT_1, epoch: 5003 });
    await processSkillUpdates();

    const decayed = killEloDelta(2450, SKILL.START, PLAIN_EVENT) * 0.15;
    const humano = (await skillsOf(['200000000000000073']))[0]!;
    expect(humano.skillElo).toBe(round2(2450 + decayed));
    expect(humano.skillElo).toBeLessThan(2450 + 5); // claramente amortiguado
  });

  it('BOT mata a humano hábil: el BOT gana solo el 15% (los bots también decaen)', async () => {
    await seedDuel('200000000000000074', 'Victima2450', BOT_1, 'BotUno');
    await prisma.player.update({ where: { guid: '200000000000000074' }, data: { skillElo: 2450, skill: 2450 } });
    await killEvent({ origin: BOT_1, target: '200000000000000074', epoch: 5004 });
    await processSkillUpdates();

    // El factor sale del skill del HUMANO (2400+ → 0.15): la víctima hábil
    // pierde poco y el bot gana ESE MISMO delta decayado.
    const decayed = killEloDelta(SKILL.START, 2450, PLAIN_EVENT) * botDecayFactor(2450, BOT_DECAY);
    const humano = (await skillsOf(['200000000000000074']))[0]!;
    const bot = (await skillsOf([BOT_1]))[0]!;
    expect(humano.skillElo).toBe(round2(2450 - decayed));
    expect(bot.skillElo).toBe(round2(SKILL.START + decayed));
    expect(2450 - humano.skillElo).toBeCloseTo(bot.skillElo - SKILL.START, 6); // zero-sum exacto
  });

  it('vs HUMANO el decay NUNCA aplica (ELO pleno a cualquier skill)', async () => {
    await seedDuel('200000000000000075', 'Leyenda', '200000000000000076', 'Rival');
    await prisma.player.update({ where: { guid: '200000000000000075' }, data: { skillElo: 2450, skill: 2450 } });
    await prisma.player.update({ where: { guid: '200000000000000076' }, data: { skillElo: 2450, skill: 2450 } });
    await killEvent({ origin: '200000000000000075', target: '200000000000000076', epoch: 5005 });
    await processSkillUpdates();

    const fullDelta = killEloDelta(2450, 2450, PLAIN_EVENT);
    const [leyenda, rival] = await skillsOf(['200000000000000075', '200000000000000076']);
    expect(leyenda!.skillElo).toBe(round2(2450 + fullDelta)); // sin factor: pleno
    expect(rival!.skillElo).toBe(round2(2450 - fullDelta));
  });

  it('bot vs bot: sin decay (no hay humano que farmee)', async () => {
    await resetDb();
    await player(BOT_1, 'BotUno', { skillElo: 1100 });
    await player(BOT_2, 'BotDos');
    await killEvent({ origin: BOT_1, target: BOT_2, epoch: 5006 });
    await processSkillUpdates();

    const fullDelta = killEloDelta(1100, SKILL.START, PLAIN_EVENT);
    const [bot1, bot2] = await skillsOf([BOT_1, BOT_2]);
    expect(bot1!.skillElo).toBe(round2(1100 + fullDelta));
    expect(bot2!.skillElo).toBe(round2(SKILL.START - fullDelta));
  });

  it('el decay usa el skill VIGENTE en cada evento: farmear bots a skill alto rinde mucho menos', async () => {
    await seedDuel('200000000000000077', 'Farmer1800', BOT_1, 'BotUno');
    await prisma.player.update({ where: { guid: '200000000000000077' }, data: { skillElo: 1800, skill: 1800 } });
    for (let i = 0; i < 6; i += 1) {
      await killEvent({ origin: '200000000000000077', target: BOT_1, epoch: 5100 + i });
    }
    await processSkillUpdates();

    const farmer = (await skillsOf(['200000000000000077']))[0]!;
    const bot = (await skillsOf([BOT_1]))[0]!;
    const fullDelta = killEloDelta(1800, SKILL.START, PLAIN_EVENT); // ~0.32/kill sin decay
    expect(farmer.skillElo).toBeGreaterThan(1800); // sigue subiendo…
    // …pero MUY amortiguado: si los 6 kills pagaran pleno llegaría más arriba.
    expect(farmer.skillElo).toBeLessThan(round2(1800 + 6 * fullDelta));
    // Zero-sum decayado: el bot perdió exactamente lo que el humano ganó.
    expect(bot.skillElo).toBe(round2(SKILL.START - (farmer.skillElo - 1800)));
  });

  it('RECOMPUTE reproduce el decay: replay desde cero (solo eventos) → mismo skill final', async () => {
    // Fixture 100% DERIVADO DE EVENTOS (el recompute reinicia skillElo=0 y
    // re-reprocesa desde la base): el humano sube SOLO con kills vs bots —
    // primeros kills a factor 1 (<1300), los últimos MUY decayados (>1300).
    await seedDuel('200000000000000078', 'DecayRecompute', BOT_1, 'BotUno');
    for (let i = 0; i < 100; i += 1) {
      await killEvent({ origin: '200000000000000078', target: BOT_1, epoch: 5200 + i });
    }
    await processSkillUpdates();
    const before = await skillsOf(['200000000000000078', BOT_1]);
    expect(before[0]!.skillElo).toBeGreaterThan(env.botEloDecaySoft); // cruzó la zona de decay

    // Flujo EXACTO de npm run recompute:skill: el reprocess secuencial
    // reconstruye los mismos skills intermedios → mismos factores → mismo final.
    await prisma.killEvent.updateMany({ where: {}, data: { skillProcessed: false } });
    await prisma.player.updateMany({ where: {}, data: { skillElo: 0, skill: 0 } });
    await processSkillUpdates();
    expect(await skillsOf(['200000000000000078', BOT_1])).toEqual(before);
  });
});
