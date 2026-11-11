import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { req, resetDb } from './helpers.js';

/**
 * LEADERBOARD POR CUENTA (refactor de correctividad multi-PC).
 *
 * ROOT CAUSE (caso del dueño, cyber-café): un usuario juega desde VARIAS PCs;
 * cada PC genera su propio guid que se auto-vincula (por sesión) a la MISMA
 * cuenta. Con el ranking por GUID el mismo jugador aparecía VARIAS VECES en
 * el leaderboard ("admin" con 14 kills + "admin" con 40 kills). La identidad
 * es la CUENTA: el leaderboard agrupa por User y NUNCA borra links ni players.
 *
 * Contrato:
 *  - UNA fila por cuenta con ≥1 guid humano vinculado; cuentas sin guids y
 *    guids sin cuenta NO rankean.
 *  - name = displayName de la cuenta; stats (kills/deaths/headshots/
 *    timePlayed/connections) SUMADAS; skill = MAX; level = MAX saveLevel;
 *    lastConnection = la más reciente; guid = primario (mayor skill).
 *  - rank/medal derivados del skill de la cuenta (no del guid).
 */

const GUID_A = '400000000000000001'; // PC 1 del dueño
const GUID_B = '400000000000000002'; // PC 2 del dueño (más hábil)
const GUID_C = '400000000000000003'; // PC 1 de "Gamer"
const GUID_D = '400000000000000004'; // PC 2 de "Gamer"
const GUID_SOLO = '400000000000000005'; // cuenta de un solo guid
const GUID_LONER = '400000000000000006'; // humano SIN cuenta (no rankea)
const BOT_GUID = BigInt('0xb07000000000077').toString(10);
// BUG 1 (deploy 2026-11-10, "167 JUGADORES" con SOLO-humanos): en producción
// hay MUCHOS bots (166), no uno. La regresión exige poblar varios para
// verificar que includeBots ausente/"false" textual los excluye TODOS.
const BOT_GUID_2 = BigInt('0xb07000000000078').toString(10);
const BOT_GUID_3 = BigInt('0xb07000000000079').toString(10);

const T1 = new Date('2026-11-01T10:00:00Z');
const T2 = new Date('2026-11-02T10:00:00Z');

async function createUser(email: string, displayName: string): Promise<number> {
  const user = await prisma.user.create({
    data: { email, passwordHash: 'test-hash', displayName },
  });
  return user.id;
}

/** Semilla del escenario multi-PC completo (leída por TODOS los tests del archivo). */
async function seed(): Promise<void> {
  await resetDb();

  // "Admin Duo": la CUENTA del dueño con 2 PCs (guids A y B vinculados).
  await prisma.player.create({
    data: {
      guid: GUID_A, name: 'IG-A', kills: 20, deaths: 5, headshots: 4, timePlayed: 100,
      connections: 3, skill: 1800, skillElo: 1800, saveLevel: 30, saveXp: 300_000,
      lastServer: 'srv-1', lastConnection: T1,
    },
  });
  await prisma.player.create({
    data: {
      guid: GUID_B, name: 'IG-B', kills: 20, deaths: 10, headshots: 6, timePlayed: 50,
      connections: 2, skill: 2100, skillElo: 2100, saveLevel: 35, saveXp: 502_700,
      lastServer: 'srv-2', lastConnection: T2,
    },
  });
  const duo = await createUser('duo@test.local', 'Admin Duo');
  await prisma.accountLink.create({ data: { userId: duo, guid: GUID_A } });
  await prisma.accountLink.create({ data: { userId: duo, guid: GUID_B } });

  // "Gamer": segunda cuenta multi-PC, kills sumadas ganan, skill (max) pierde.
  await prisma.player.create({
    data: {
      guid: GUID_C, name: 'IG-C', kills: 30, deaths: 30, headshots: 2, timePlayed: 200,
      connections: 4, skill: 1000, skillElo: 1000, saveLevel: 10, lastServer: 'srv-1', lastConnection: T1,
    },
  });
  await prisma.player.create({
    data: {
      guid: GUID_D, name: 'IG-D', kills: 5, deaths: 20, headshots: 1, timePlayed: 20,
      connections: 1, skill: 1600, skillElo: 1600, saveLevel: 20, lastServer: 'srv-3', lastConnection: T1,
    },
  });
  const gamer = await createUser('gamer@test.local', 'The Gamer');
  await prisma.accountLink.create({ data: { userId: gamer, guid: GUID_C } });
  await prisma.accountLink.create({ data: { userId: gamer, guid: GUID_D } });

  // Cuenta de un solo guid (skill MÁS alto de todas: gana sort=skill sin ganar kills).
  await prisma.player.create({
    data: {
      guid: GUID_SOLO, name: 'IG-Solo', kills: 10, deaths: 2, headshots: 8, timePlayed: 30,
      connections: 2, skill: 2200, skillElo: 2200, saveLevel: 5, lastServer: 'srv-1', lastConnection: T1,
    },
  });
  const solo = await createUser('solo@test.local', 'Solo Player');
  await prisma.accountLink.create({ data: { userId: solo, guid: GUID_SOLO } });

  // Humano SIN cuenta: existe como Player pero NO rankea (ranked = con cuenta).
  await prisma.player.create({
    data: { guid: GUID_LONER, name: 'LonerIG', kills: 999, deaths: 1, skill: 2500, skillElo: 2500, connections: 9 },
  });

  // Cuenta SIN guids: no puede aparecer (no tiene ni una fila de leaderboard).
  await createUser('empty@test.local', 'Empty Account');

  // Bots sembrados A PROPÓSITO (2026-11-11 ya NO existen en producción: la
  // ingesta no los crea y cleanup:bots los borró). Quedan aquí como REGRESIÓN:
  // aunque una fila de bot existiera (DB vieja/stray), el leaderboard jamás la
  // muestra — con o sin includeBots.
  await prisma.player.create({
    data: { guid: BOT_GUID, name: 'BotBot', isBot: true, kills: 100, deaths: 5, skill: 2400, skillElo: 2400, connections: 10 },
  });
  await prisma.player.create({
    data: { guid: BOT_GUID_2, name: 'RektInator', isBot: true, kills: 62, deaths: 20, skill: 1900, skillElo: 1900, connections: 4 },
  });
  await prisma.player.create({
    data: { guid: BOT_GUID_3, name: 'Louvenarde', isBot: true, kills: 55, deaths: 18, skill: 1750, skillElo: 1750, connections: 3 },
  });
}

beforeAll(async () => {
  await seed();
});

interface Row {
  rank: number;
  guid: string;
  name: string;
  kills: number;
  deaths: number;
  kd: number;
  timePlayed: number;
  connections: number;
  skill: number;
  headshots: number;
  level: number | null;
  lastConnection: string | null;
  linked: boolean;
  medal: { tier: number; tierId: number; name: string; stars: number | null; globalRank: number | null; eliteTop12: boolean };
}

async function leaderboard(query = ''): Promise<{ total: number; players: Row[] }> {
  const res = await req().get(`/api/leaderboard?pageSize=100${query}`);
  expect(res.status).toBe(200);
  return res.body as never;
}

describe('leaderboard POR CUENTA: una fila por cuenta con N guids', () => {
  it('cuenta con 2 guids (20+20 kills) → UNA fila con 40 kills, skill = MAX, UNA medalla, name = displayName', async () => {
    const body = await leaderboard();

    // NO duplicados: el dueño multi-PC aparece UNA sola vez.
    const duoRows = body.players.filter((row) => row.name === 'Admin Duo');
    expect(duoRows).toHaveLength(1);

    const duo = duoRows[0]!;
    // Stats SUMADAS entre sus guids.
    expect(duo.kills).toBe(40); // 20 + 20
    expect(duo.deaths).toBe(15); // 5 + 10
    expect(duo.kd).toBeCloseTo(40 / 15, 2);
    expect(duo.headshots).toBe(10); // 4 + 6
    expect(duo.timePlayed).toBe(150); // 100 + 50
    expect(duo.connections).toBe(5); // 3 + 2
    // skill = el MÁXIMO de sus guids (2100 de la PC 2, no el promedio 1950).
    expect(duo.skill).toBe(2100);
    // level = el MAX saveLevel (35 de la PC 2); lastConnection = la más reciente (T2).
    expect(duo.level).toBe(35);
    expect(duo.lastConnection).toBe(T2.toISOString());
    // guid primario = el de mayor skill (GUID_B).
    expect(duo.guid).toBe(GUID_B);
    // El nombre es el displayName de la CUENTA (nunca el nick del juego "IG-B").
    expect(duo.name).toBe('Admin Duo');
    expect(duo.linked).toBe(true);
    // UNA sola medalla, derivada del skill de la cuenta: 2100 → CAPITÁN (tier 6).
    expect(duo.medal).toMatchObject({ tier: 6, tierId: 6, name: 'CAPITÁN', stars: 3, globalRank: null, eliteTop12: false });
  });

  it('cuenta sin guids vinculados NO aparece; guid humano SIN cuenta NO rankea', async () => {
    const body = await leaderboard();

    // Solo rankean las 3 cuentas CON guids (los bots fuera por defecto).
    expect(body.total).toBe(3);
    const names = body.players.map((row) => row.name).sort();
    expect(names).toEqual(['Admin Duo', 'Solo Player', 'The Gamer']);

    // El "Empty Account" (cuenta sin guids) no está.
    expect(body.players.some((row) => row.name === 'Empty Account')).toBe(false);
    // El loner (999 kills, skill 2500, sin cuenta) NO rankea aunque dominaría.
    expect(body.players.some((row) => row.guid === GUID_LONER)).toBe(false);
    expect(body.players.some((row) => row.name === 'LonerIG')).toBe(false);
    // El bot tampoco (toggle SOLO-humanos por defecto).
    expect(body.players.some((row) => row.guid === BOT_GUID)).toBe(false);
  });

  it('sort=kills / sort=skill / sort=level operan sobre los AGREGADOS de la cuenta', async () => {
    // kills desc: las cuentas suman (Duo 40 > Gamer 35 > Solo 10) aunque por
    // guid individual el loner/bot dominarían.
    const byKills = await leaderboard('&sort=kills&order=desc');
    expect(byKills.players.map((row) => [row.name, row.kills])).toEqual([
      ['Admin Duo', 40],
      ['The Gamer', 35],
      ['Solo Player', 10],
    ]);
    expect(byKills.players.map((row) => row.rank)).toEqual([1, 2, 3]);

    // skill desc: usa el MAX de la cuenta (Solo 2200 > Duo 2100 > Gamer 1600).
    const bySkill = await leaderboard('&sort=skill&order=desc');
    expect(bySkill.players.map((row) => [row.name, row.skill])).toEqual([
      ['Solo Player', 2200],
      ['Admin Duo', 2100],
      ['The Gamer', 1600],
    ]);

    // level desc: MAX saveLevel de la cuenta (Duo 35 = max(30,35) > Gamer 20 =
    // max(10,20) > Solo 5).
    const byLevel = await leaderboard('&sort=level&order=desc');
    expect(byLevel.players.map((row) => [row.name, row.level])).toEqual([
      ['Admin Duo', 35],
      ['The Gamer', 20],
      ['Solo Player', 5],
    ]);

    // headshots desc: SUMA de la cuenta (Duo 10 = 4+6 > Solo 8 > Gamer 3 = 2+1).
    const byHs = await leaderboard('&sort=headshots&order=desc');
    expect(byHs.players.map((row) => [row.name, row.headshots])).toEqual([
      ['Admin Duo', 10],
      ['Solo Player', 8],
      ['The Gamer', 3],
    ]);
  });

  it('rank global de CUENTA: independiente de búsqueda; minMatches sobre conexiones SUMADAS', async () => {
    // Búsqueda por el nick de UN guid (IG-B): encuentra la cuenta (no el guid),
    // y el rank sigue siendo el GLOBAL de la cuenta (1º, no 1º-del-filtro).
    const search = await leaderboard(`&search=${encodeURIComponent('IG-B')}`);
    expect(search.total).toBe(1);
    expect(search.players[0]).toMatchObject({ name: 'Admin Duo', rank: 1, guid: GUID_B });

    // Búsqueda por displayName de cuenta también funciona.
    const byName = await leaderboard(`&search=${encodeURIComponent('gamer')}`);
    expect(byName.total).toBe(1);
    expect(byName.players[0]?.name).toBe('The Gamer');

    // minMatches=4: Solo el Duo suma ≥4 conexiones (3+2=5; Gamer 4+1=5 también).
    const minMatches = await leaderboard('&minMatches=5');
    expect(minMatches.total).toBe(2);
    expect(minMatches.players.map((row) => row.name).sort()).toEqual(['Admin Duo', 'The Gamer']);
  });

  it('BOTS IMPOSIBLES (2026-11-11): includeBots ausente, "false" textual o "true" → CERO bots SIEMPRE', async () => {
    const botGuids = [BOT_GUID, BOT_GUID_2, BOT_GUID_3];

    // 1) Sin el param (lo que manda la web).
    const absent = await leaderboard();
    expect(absent.total).toBe(3); // solo las 3 cuentas
    expect(absent.players.filter((row) => botGuids.includes(row.guid))).toHaveLength(0);
    expect(absent.players.every((row) => row.linked)).toBe(true);

    // 2) "false" TEXTO explícito (lo que la web envía con el toggle SOLO-humanos).
    const explicitFalse = await leaderboard('&includeBots=false');
    expect(explicitFalse.total).toBe(3);
    expect(explicitFalse.players.filter((row) => botGuids.includes(row.guid))).toHaveLength(0);

    // 3) "true" textual: el param se ACEPTA por compat pero se IGNORA — los
    // bots ya NO tienen Player row y aunque una huérfana existiera (seed de
    // arriba), la query jamás los trae. Ranks de las cuentas intactos.
    const explicitTrue = await leaderboard('&includeBots=true');
    expect(explicitTrue.total).toBe(3); // SOLO las 3 cuentas
    expect(explicitTrue.players.filter((row) => botGuids.includes(row.guid))).toHaveLength(0);
    expect(explicitTrue.players.every((row) => row.linked)).toBe(true);
    expect(explicitTrue.players.map((row) => row.name)).toEqual(['Admin Duo', 'The Gamer', 'Solo Player']);
    expect(explicitTrue.players.map((row) => row.rank)).toEqual([1, 2, 3]);
  });

  it('los bots no desplazan ranks ni medallas: población rankeada = solo cuentas', async () => {
    // El bot sembrado (100 kills, skill 2400) NO afecta: sin él, Duo (40
    // kills) es rank 1 y el sort=skill pone a Solo (2200) arriba.
    const body = await leaderboard('&includeBots=true'); // param ignorado
    expect(body.players.find((row) => row.name === 'Admin Duo')?.rank).toBe(1);
    expect(body.players.find((row) => row.guid === BOT_GUID)).toBeUndefined();

    const bySkill = await leaderboard('&sort=skill&order=desc&includeBots=true');
    expect(bySkill.players[0]).toMatchObject({ name: 'Solo Player', skill: 2200 });
  });
});

describe('perfil per-guid + resumen de CUENTA (multi-PC)', () => {
  it('GET /api/players/:guid sigue siendo per-guid y añade account (displayName + totals + otras PCs)', async () => {
    const res = await req().get(`/api/players/${GUID_A}`);
    expect(res.status).toBe(200);

    const body = res.body as {
      player: { guid: string; name: string; kills: number; linked: boolean };
      account: {
        displayName: string;
        totalKills: number;
        totalDeaths: number;
        totalHeadshots: number;
        guids: Array<{ guid: string; lastServer: string | null; lastConnection: string | null }>;
      } | null;
    };

    // El detalle del guid NO cambia (stats de ESA identidad).
    expect(body.player.guid).toBe(GUID_A);
    expect(body.player.kills).toBe(20); // SOLO los de la PC 1
    expect(body.player.linked).toBe(true);

    // La cuenta agrupa SIN borrar: displayName + stats sumadas de TODOS sus guids.
    expect(body.account).not.toBeNull();
    expect(body.account!.displayName).toBe('Admin Duo');
    expect(body.account!.totalKills).toBe(40); // 20 (A) + 20 (B)
    expect(body.account!.totalDeaths).toBe(15);
    expect(body.account!.totalHeadshots).toBe(10);
    // Todos los guids de la cuenta (incluido el actual), con su última PC/conexión.
    expect(body.account!.guids).toEqual([
      { guid: GUID_A, lastServer: 'srv-1', lastConnection: T1.toISOString() },
      { guid: GUID_B, lastServer: 'srv-2', lastConnection: T2.toISOString() },
    ]);
  });

  it('guid SIN cuenta → account null (perfil per-guid intacto para anónimos)', async () => {
    const res = await req().get(`/api/players/${GUID_LONER}`);
    expect(res.status).toBe(200);
    const body = res.body as { player: { guid: string; linked: boolean }; account: unknown };
    expect(body.player.guid).toBe(GUID_LONER);
    expect(body.player.linked).toBe(false);
    expect(body.account).toBeNull();
  });
});
