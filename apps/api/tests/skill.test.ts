import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { processSkillUpdates } from '../src/services/skill/skill.service.js';
import {
  SKILL,
  clampAndBonus,
  clampElo,
  expectedScore,
  killEloDelta,
  kFactor,
  streakBonus,
} from '../src/services/skill/elo.js';
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
