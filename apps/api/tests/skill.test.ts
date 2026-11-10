import { beforeAll, describe, expect, it, vi } from 'vitest';
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

// Escalas de BALANCE (2026-11-10, decisión del dueño — intercambio asimétrico):
// el atacante gana delta × ESCALA_A (+50% default) y la víctima pierde
// delta × ESCALA_V (−50% default), aplicadas al delta FINAL (tras mult de
// evento y decay de bots). Contra bots el decay aplica ANTES de las escalas.
const ESCALA_A = env.skillAttackGainScale; // 1.5 default
const ESCALA_V = env.skillVictimLossScale; // 0.5 default

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
    // Asimétrico: la víctima pierde delta × (0.5/1.25). Precisión 2 (no 6): el
    // motor redondea POR EVENTO cada lado del intercambio (clampRound inline),
    // así que la identidad proporcional tiene ±0.005 de jitter de redondeo.
    expect(veteranoAfterLoss).toBeCloseTo(novatoAfterWin * (ESCALA_V / ESCALA_A), 2);
    expect(novatoAfterLoss).toBeCloseTo(veteranoAfterWin * (ESCALA_V / ESCALA_A), 2);
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

    // El leaderboard es POR CUENTA (una fila por User, docs/API.md): un guid
    // sin AccountLink no rankea → vincula cada guid del duelo a su propia
    // cuenta para que ambos aparezcan (single-guid → misma skill por fila).
    const userFuerte = await prisma.user.create({ data: { email: 'lb-fuerte@test.local', passwordHash: 'test-hash', displayName: 'Fuerte' } });
    const userDebil = await prisma.user.create({ data: { email: 'lb-debil@test.local', passwordHash: 'test-hash', displayName: 'Debil' } });
    await prisma.accountLink.create({ data: { userId: userFuerte.id, guid: '200000000000000041' } });
    await prisma.accountLink.create({ data: { userId: userDebil.id, guid: '200000000000000042' } });

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
    expect(row.skillElo).toBeCloseTo(SKILL.START - 2 * SKILL.WORLD_LOSS * ESCALA_V, 6); // 2 muertes × 4 × 0.5 = −4 total
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
  it('skill 1200 vs bot: SIN decay (factor 1.0); atacante gana pleno×1.5 y la víctima bot pierde pleno×0.5', async () => {
    await seedDuel('200000000000000071', 'NovatoVsBot', BOT_1, 'BotUno');
    await prisma.player.update({ where: { guid: '200000000000000071' }, data: { skillElo: 1200, skill: 1200 } });
    await killEvent({ origin: '200000000000000071', target: BOT_1, epoch: 5001 });
    await processSkillUpdates();

    const fullDelta = killEloDelta(1200, SKILL.START, PLAIN_EVENT);
    const humano = (await skillsOf(['200000000000000071']))[0]!;
    const bot = (await skillsOf([BOT_1]))[0]!;
    expect(humano.skillElo).toBe(round2(1200 + fullDelta * ESCALA_A)); // atacante: ganancia PLENA ×1.5
    expect(bot.skillElo).toBe(round2(SKILL.START - fullDelta * ESCALA_V)); // víctima bot: ×0.5
    // Precisión 2 (no 6): el motor redondea POR EVENTO cada lado (clampRound
    // inline) → la inflación esperada lleva ±0.005 de jitter de redondeo.
    expect(humano.skillElo + bot.skillElo).toBeCloseTo(2200 + fullDelta * (ESCALA_A - ESCALA_V), 2); // inflación = delta×1.0 (aceptada)
  });

  it('skill 2000 vs bot: el delta se decae al factor del skill VIGENTE (~0.46)', async () => {
    await seedDuel('200000000000000072', 'CapitanVsBot', BOT_1, 'BotUno');
    await prisma.player.update({ where: { guid: '200000000000000072' }, data: { skillElo: 2000, skill: 2000 } });
    await killEvent({ origin: '200000000000000072', target: BOT_1, epoch: 5002 });
    await processSkillUpdates();

    const decayed = killEloDelta(2000, SKILL.START, PLAIN_EVENT) * botDecayFactor(2000, BOT_DECAY);
    const humano = (await skillsOf(['200000000000000072']))[0]!;
    const bot = (await skillsOf([BOT_1]))[0]!;
    expect(humano.skillElo).toBe(round2(2000 + decayed * ESCALA_A)); // atacante: decayado ×1.5
    expect(bot.skillElo).toBe(round2(SKILL.START - decayed * ESCALA_V)); // víctima bot: decayado ×0.5
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
    expect(humano.skillElo).toBe(round2(2450 + decayed * ESCALA_A));
    expect(humano.skillElo).toBeLessThan(2450 + 5); // claramente amortiguado
  });

  it('BOT mata a humano hábil: el BOT gana solo el 15% (los bots también decaen)', async () => {
    await seedDuel('200000000000000074', 'Victima2450', BOT_1, 'BotUno');
    await prisma.player.update({ where: { guid: '200000000000000074' }, data: { skillElo: 2450, skill: 2450 } });
    await killEvent({ origin: BOT_1, target: '200000000000000074', epoch: 5004 });
    await processSkillUpdates();

    // El factor sale del skill del HUMANO (2400+ → 0.15): la víctima hábil
    // pierde decayado ×0.5 y el bot atacante gana el decayado ×1.25.
    const decayed = killEloDelta(SKILL.START, 2450, PLAIN_EVENT) * botDecayFactor(2450, BOT_DECAY);
    const humano = (await skillsOf(['200000000000000074']))[0]!;
    const bot = (await skillsOf([BOT_1]))[0]!;
    expect(humano.skillElo).toBe(round2(2450 - decayed * ESCALA_V)); // víctima: decayado ×0.5
    expect(bot.skillElo).toBe(round2(SKILL.START + decayed * ESCALA_A)); // bot atacante: decayado ×1.5
    expect(round2(2450 - humano.skillElo)).toBe(round2((bot.skillElo - SKILL.START) * (ESCALA_V / ESCALA_A))); // la víctima pierde menos de lo que gana el bot
  });

  it('vs HUMANO el decay NUNCA aplica (ELO pleno a cualquier skill)', async () => {
    await seedDuel('200000000000000075', 'Leyenda', '200000000000000076', 'Rival');
    await prisma.player.update({ where: { guid: '200000000000000075' }, data: { skillElo: 2450, skill: 2450 } });
    await prisma.player.update({ where: { guid: '200000000000000076' }, data: { skillElo: 2450, skill: 2450 } });
    await killEvent({ origin: '200000000000000075', target: '200000000000000076', epoch: 5005 });
    await processSkillUpdates();

    const fullDelta = killEloDelta(2450, 2450, PLAIN_EVENT);
    const [leyenda, rival] = await skillsOf(['200000000000000075', '200000000000000076']);
    expect(leyenda!.skillElo).toBe(round2(2450 + fullDelta * ESCALA_A)); // sin factor: pleno ×1.5
    expect(rival!.skillElo).toBe(round2(2450 - fullDelta * ESCALA_V)); // víctima: pleno ×0.5
  });

  it('bot vs bot: sin decay (no hay humano que farmee); escalas de balance aplicadas igual', async () => {
    await resetDb();
    await player(BOT_1, 'BotUno', { skillElo: 1100 });
    await player(BOT_2, 'BotDos');
    await killEvent({ origin: BOT_1, target: BOT_2, epoch: 5006 });
    await processSkillUpdates();

    const fullDelta = killEloDelta(1100, SKILL.START, PLAIN_EVENT);
    const [bot1, bot2] = await skillsOf([BOT_1, BOT_2]);
    expect(bot1!.skillElo).toBe(round2(1100 + fullDelta * ESCALA_A)); // bot atacante ×1.5
    expect(bot2!.skillElo).toBe(round2(SKILL.START - fullDelta * ESCALA_V)); // bot víctima ×0.5
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
    // Intercambio asimétrico decayado: el bot-víctima pierde (ganancia ×1.5 del
    // humano) × (0.5/1.5) = la mitad del delta decayado. La identidad es
    // PROPORCIONAL con jitter de redondeo (el motor hace clampRound POR EVENTO
    // en cada lado) → closeTo con tolerancia, más guardas de dirección.
    const farmerGain = round2(farmer.skillElo - 1800);
    const botLoss = round2(SKILL.START - bot.skillElo);
    expect(botLoss).toBeGreaterThan(0);
    expect(botLoss).toBeLessThan(farmerGain); // asimetría: la víctima baja MENOS de lo que sube el atacante
    expect(botLoss).toBeCloseTo(farmerGain * (ESCALA_V / ESCALA_A), 1);
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

// ── REGRESIÓN 2026-11-08: la VÍCTIMA SIEMPRE pierde su delta ────────────────
// Reporte original: "40 kills → 1375.39; 1 muerte → SIGUE 1375.39". El evento
// de esa muerte concreta resultó ser world (MOD_TRIGGER_HURT, sin atacante:
// la ingesta no lo almacena como KillEvent → nada que aplicar). Estos tests
// fijan el contrato del motor para el CASO QUE SÍ llega a la DB: cualquiera
// que sea el rol del humano (atacante o víctima), la víctima del kill pierde
// el delta aplicado × SKILL_VICTIM_LOSS_SCALE (decayado contra bots, pleno
// contra humanos; ×0.5 con el default del balance 2026-11-10) y el atacante
// gana el mismo delta base × SKILL_ATTACK_GAIN_SCALE (×1.5).
describe('REGRESIÓN víctima siempre pierde |delta| × escala (kill events almacenados)', () => {
  it('bot mata a humano a skill medio-alto (~1335, el caso del reporte): la víctima PIERDE ELO decayado', async () => {
    // Réplica del escenario reportado: humano ~1335.39 muere ante un bot ~1000.
    // El decay usa el skill VIGENTE del HUMANO (aquí la VÍCTIMA) → ~0.97.
    const VICTIM_ELO = 1335.39;
    await seedDuel('200000000000000081', 'Admin', BOT_1, 'BotUno');
    await prisma.player.update({ where: { guid: '200000000000000081' }, data: { skillElo: VICTIM_ELO, skill: VICTIM_ELO } });
    await killEvent({ origin: BOT_1, target: '200000000000000081', epoch: 6001 });
    await processSkillUpdates();

    const decayed = killEloDelta(SKILL.START, VICTIM_ELO, PLAIN_EVENT) * botDecayFactor(VICTIM_ELO, BOT_DECAY);
    expect(decayed).toBeGreaterThan(20); // sanidad: la pérdida BASE es sustanciosa (NO ~0)
    const humano = (await skillsOf(['200000000000000081']))[0]!;
    const bot = (await skillsOf([BOT_1]))[0]!;
    expect(humano.skillElo).toBe(round2(VICTIM_ELO - decayed * ESCALA_V)); // la víctima SÍ baja (decayado ×0.5)
    expect(humano.skillElo).toBeLessThan(VICTIM_ELO);
    expect(bot.skillElo).toBe(round2(SKILL.START + decayed * ESCALA_A)); // bot atacante: decayado ×1.25
    expect(round2(VICTIM_ELO - humano.skillElo)).toBe(round2(decayed * ESCALA_V));
  });

  it('bot mata a humano a ELO base: la víctima pierde el delta PLENO (factor 1.0 bajo soft)', async () => {
    await seedDuel('200000000000000082', 'Novato', BOT_1, 'BotUno');
    await killEvent({ origin: BOT_1, target: '200000000000000082', epoch: 6002 });
    await processSkillUpdates();

    const fullDelta = killEloDelta(SKILL.START, SKILL.START, PLAIN_EVENT); // ~20, sin decay
    const humano = (await skillsOf(['200000000000000082']))[0]!;
    const bot = (await skillsOf([BOT_1]))[0]!;
    expect(humano.skillElo).toBe(round2(SKILL.START - fullDelta * ESCALA_V)); // víctima: pleno ×0.5
    expect(bot.skillElo).toBe(round2(SKILL.START + fullDelta * ESCALA_A)); // bot atacante: pleno ×1.25
    expect(SKILL.START - humano.skillElo).toBeCloseTo((bot.skillElo - SKILL.START) * (ESCALA_V / ESCALA_A), 6);
  });

  it('invariante en los 3 combos de roles: humano→humano, humano→bot y bot→humano — la víctima SIEMPRE baja (× escala)', async () => {
    const H1 = '200000000000000083';
    const H2 = '200000000000000084';

    // humano → humano: atacante gana pleno ×1.25; víctima pierde pleno ×0.5 (asimétrico).
    await seedDuel(H1, 'Atacante', H2, 'Víctima');
    await killEvent({ origin: H1, target: H2, epoch: 6003 });
    await processSkillUpdates();
    const [atacante, victima] = await skillsOf([H1, H2]);
    const fullDelta = killEloDelta(SKILL.START, SKILL.START, PLAIN_EVENT);
    expect(victima!.skillElo).toBe(round2(SKILL.START - fullDelta * ESCALA_V)); // la víctima BAJA (la mitad)
    expect(atacante!.skillElo).toBe(round2(SKILL.START + fullDelta * ESCALA_A)); // atacante PLENO escalado
    expect(round2(atacante!.skillElo + victima!.skillElo)).toBe(round2(2 * SKILL.START + fullDelta * (ESCALA_A - ESCALA_V))); // inflación = delta×0.75

    // humano → bot: el bot (víctima) pierde el delta decayado ×0.5 por el skill del humano.
    await seedDuel(H1, 'Grinder', BOT_1, 'BotUno');
    await prisma.player.update({ where: { guid: H1 }, data: { skillElo: 1800, skill: 1800 } });
    await killEvent({ origin: H1, target: BOT_1, epoch: 6004 });
    await processSkillUpdates();
    const decayedGrind = killEloDelta(1800, SKILL.START, PLAIN_EVENT) * botDecayFactor(1800, BOT_DECAY);
    const botVictima = (await skillsOf([BOT_1]))[0]!;
    expect(botVictima.skillElo).toBe(round2(SKILL.START - decayedGrind * ESCALA_V)); // el bot-víctima BAJA decayado escalado
    expect(botVictima.skillElo).toBeLessThan(SKILL.START);

    // bot → humano: el humano (víctima) pierde el delta decayado ×0.5 por SU skill.
    await seedDuel(H2, 'Victima1800', BOT_1, 'BotUno');
    await prisma.player.update({ where: { guid: H2 }, data: { skillElo: 1800, skill: 1800 } });
    await killEvent({ origin: BOT_1, target: H2, epoch: 6005 });
    await processSkillUpdates();
    const decayedLoss = killEloDelta(SKILL.START, 1800, PLAIN_EVENT) * botDecayFactor(1800, BOT_DECAY);
    const humanoVictima = (await skillsOf([H2]))[0]!;
    expect(humanoVictima.skillElo).toBe(round2(1800 - decayedLoss * ESCALA_V)); // la víctima BAJA decayado escalado
    expect(humanoVictima.skillElo).toBeLessThan(1800);
    // Exacto: pierde decayedLoss × escala de víctima (el decay YA mordió antes de la escala).
    expect(round2(1800 - humanoVictima.skillElo)).toBe(round2(decayedLoss * ESCALA_V));
    expect(1800 - humanoVictima.skillElo).toBeLessThan(killEloDelta(SKILL.START, 1800, PLAIN_EVENT));
  });
});

// ── BALANCE 2026-11-10: SKILL_ATTACK_GAIN_SCALE (atacante +50%) + SKILL_VICTIM_LOSS_SCALE (víctima −50%) ──
// Contrato del intercambio ASIMÉTRICO pedido por el dueño: subir premia +50%
// y bajar duele la mitad. Ambas escalas van sobre el delta FINAL (fuera del
// cap ×1.6 de eventMult); el decay de bots aplica ANTES de las escalas.
describe('escalas de balance (atacante ×1.5 / víctima ×0.5)', () => {
  it('humano→humano: atacante gana EXACTAMENTE killEloDelta×1.5 (fórmula intacta + escala) y la víctima pierde ×0.5', async () => {
    await seedDuel('200000000000000091', 'Ganador', '200000000000000092', 'Perdedor');
    await killEvent({ origin: '200000000000000091', target: '200000000000000092', epoch: 7001 });
    await processSkillUpdates();

    const fullDelta = killEloDelta(SKILL.START, SKILL.START, PLAIN_EVENT); // mult de evento = 1 dentro
    const [ganador, perdedor] = await skillsOf(['200000000000000091', '200000000000000092']);
    expect(ganador!.skillElo).toBe(round2(SKILL.START + fullDelta * ESCALA_A)); // +50%: la fórmula del atacante NO cambió
    expect(perdedor!.skillElo).toBe(round2(SKILL.START - fullDelta * ESCALA_V)); // −50%
    // Dirección del balance: antes era +20/−20 → ahora +30/−10.
    expect(ganador!.skillElo).toBeGreaterThan(SKILL.START + fullDelta);
    expect(perdedor!.skillElo).toBeGreaterThan(SKILL.START - fullDelta);
  });

  it('humano→bot: el atacante humano gana decayado×1.5 (+50% SOBRE el decayado) y el bot víctima pierde decayado×0.5', async () => {
    await seedDuel('200000000000000093', 'GrinderEscala', BOT_1, 'BotUno');
    await prisma.player.update({ where: { guid: '200000000000000093' }, data: { skillElo: 1800, skill: 1800 } });
    await killEvent({ origin: '200000000000000093', target: BOT_1, epoch: 7002 });
    await processSkillUpdates();

    const decayed = killEloDelta(1800, SKILL.START, PLAIN_EVENT) * botDecayFactor(1800, BOT_DECAY);
    const humano = (await skillsOf(['200000000000000093']))[0]!;
    const bot = (await skillsOf([BOT_1]))[0]!;
    expect(humano.skillElo).toBe(round2(1800 + decayed * ESCALA_A)); // decay del humano PRIMERO, escala DESPUÉS
    expect(bot.skillElo).toBe(round2(SKILL.START - decayed * ESCALA_V));
  });

  it('bot→humano: la escala de atacante aplica IGUAL para bots (gana decayado×1.5); la víctima pierde ×0.5', async () => {
    await seedDuel('200000000000000094', 'VictimaEscala1375', BOT_1, 'BotUno');
    await prisma.player.update({ where: { guid: '200000000000000094' }, data: { skillElo: 1375.39, skill: 1375.39 } });
    await killEvent({ origin: BOT_1, target: '200000000000000094', epoch: 7003 });
    await processSkillUpdates();

    const decayed = killEloDelta(SKILL.START, 1375.39, PLAIN_EVENT) * botDecayFactor(1375.39, BOT_DECAY);
    const humano = (await skillsOf(['200000000000000094']))[0]!;
    const bot = (await skillsOf([BOT_1]))[0]!;
    expect(bot.skillElo).toBe(round2(SKILL.START + decayed * ESCALA_A));
    expect(humano.skillElo).toBe(round2(1375.39 - decayed * ESCALA_V));
  });

  it('teamkill SIN escalas: −24 plano al atacante (ni ×1.25 ni ×0.5) y la víctima no cambia', async () => {
    await seedDuel('200000000000000095', 'TkAtacante', '200000000000000096', 'TkCompañero');
    await killEvent({ origin: '200000000000000095', target: '200000000000000096', isTeamkill: true, epoch: 7004 });
    await processSkillUpdates();

    const [atacante, companero] = await skillsOf(['200000000000000095', '200000000000000096']);
    expect(atacante!.skillElo).toBeCloseTo(SKILL.START - SKILL.TEAMKILL_PENALTY, 6); // −24 FIJO
    expect(companero!.skillElo).toBe(SKILL.START);
  });

  it('world/suicidio: SOLO escala de víctima (WORLD_LOSS 4 → −2 efectivos); sin ganancia de atacante', async () => {
    await resetDb();
    await player('200000000000000097', 'SuicidaEscala');
    await killEvent({ origin: '200000000000000097', target: null, epoch: 7005 }); // world (sin atacante)
    await killEvent({ origin: '200000000000000097', target: '200000000000000097', epoch: 7006 }); // suicidio
    await processSkillUpdates();

    const row = (await skillsOf(['200000000000000097']))[0]!;
    expect(row.skillElo).toBe(round2(SKILL.START - 2 * SKILL.WORLD_LOSS * ESCALA_V)); // 1000 − 2×(4×0.5) = 996
    expect(row.skillElo).toBe(996); // exacto con los defaults
  });

  it('env override EN CALIENTE del atacante: skillAttackGainScale=0.5 → gana delta×0.5 (la escala de víctima NO cambia)', async () => {
    const original = env.skillAttackGainScale;
    (env as { skillAttackGainScale: number }).skillAttackGainScale = 0.5;
    try {
      await seedDuel('200000000000000098', 'OverrideA', '200000000000000099', 'OverrideB');
      await killEvent({ origin: '200000000000000098', target: '200000000000000099', epoch: 7007 });
      await processSkillUpdates();

      const fullDelta = killEloDelta(SKILL.START, SKILL.START, PLAIN_EVENT);
      const [atacante, victima] = await skillsOf(['200000000000000098', '200000000000000099']);
      expect(atacante!.skillElo).toBe(round2(SKILL.START + fullDelta * 0.5)); // escala SOBRESCRITA por env
      expect(victima!.skillElo).toBe(round2(SKILL.START - fullDelta * ESCALA_V)); // víctima intacta
    } finally {
      (env as { skillAttackGainScale: number }).skillAttackGainScale = original;
    }
  });

  it('env override EN CALIENTE de la víctima: skillVictimLossScale=1 → pierde delta completo (atacante con su ×1.25 intacto)', async () => {
    const original = env.skillVictimLossScale;
    (env as { skillVictimLossScale: number }).skillVictimLossScale = 1;
    try {
      await seedDuel('200000000000000100', 'OverrideV', '200000000000000101', 'OverrideW');
      await killEvent({ origin: '200000000000000100', target: '200000000000000101', epoch: 7008 });
      await processSkillUpdates();

      const fullDelta = killEloDelta(SKILL.START, SKILL.START, PLAIN_EVENT);
      const [atacante, victima] = await skillsOf(['200000000000000100', '200000000000000101']);
      expect(victima!.skillElo).toBe(round2(SKILL.START - fullDelta)); // escala SOBRESCRITA por env
      expect(atacante!.skillElo).toBe(round2(SKILL.START + fullDelta * ESCALA_A)); // atacante intacto
    } finally {
      (env as { skillVictimLossScale: number }).skillVictimLossScale = original;
    }
  });

  it('SKILL_VICTIM_LOSS_SCALE y SKILL_ATTACK_GAIN_SCALE se PARSEAN de process.env (zod, defaults 0.5/1.25)', async () => {
    expect(env.skillVictimLossScale).toBe(0.5); // default del schema
    expect(env.skillAttackGainScale).toBe(1.5);

    process.env.SKILL_VICTIM_LOSS_SCALE = '0.25';
    process.env.SKILL_ATTACK_GAIN_SCALE = '2';
    vi.resetModules();
    try {
      const fresh = await import('../src/config/env.js');
      expect(fresh.env.skillVictimLossScale).toBe(0.25);
      expect(fresh.env.skillAttackGainScale).toBe(2);
    } finally {
      delete process.env.SKILL_VICTIM_LOSS_SCALE;
      delete process.env.SKILL_ATTACK_GAIN_SCALE;
      vi.resetModules();
    }
    // El módulo YA cargado conserva sus valores (el reset solo afecta re-imports).
    expect(env.skillVictimLossScale).toBe(0.5);
    expect(env.skillAttackGainScale).toBe(1.5);
  });
});
