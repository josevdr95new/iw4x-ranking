import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { getWeaponsRanking, getPlayerMaps, getPlayerWeapons } from '../src/services/weapons.service.js';
import { getPlayerProfile } from '../src/services/players.service.js';
import { resetDb } from './helpers.js';

/**
 * Fixture directo en Prisma (las líneas del log sintético se cubren en
 * gamelog.test.ts): 2 armas, 3 jugadores, 5 eventos con hitloc/mapa/modo.
 */
const G_A = '111111111111111111';
const G_B = '222222222222222222';
const G_C = '333333333333333333';

async function seed(): Promise<void> {
  await prisma.player.createMany({
    data: [
      // Columnas derivadas (las escribe recomputeDerived durante la ingesta real;
      // aquí se fijan para probar el mapeo del DTO de perfil).
      { guid: G_A, name: 'Alpha', kills: 3, deaths: 1, headshots: 1, damageDealt: 350, damageTaken: 95, bestStreak: 3, teamkills: 1, matchesPlayed: 2, timePlayed: 720 },
      { guid: G_B, name: 'Bravo', kills: 2 },
      { guid: G_C, name: 'Charlie' },
    ],
  });
  const t = new Date();
  const epoch = Math.trunc(t.getTime() / 1000);
  await prisma.killEvent.createMany({
    data: [
      // ak47: Alpha mata 2 veces a Bravo (1 headshot)
      { originGuid: G_A, targetGuid: G_B, isKill: true, damage: 120, weapon: 'ak47', hitloc: 'head', headshot: true, isTeamkill: false, map: 'mp_rust', gametype: 'war', time: t, timeEpoch: epoch },
      { originGuid: G_A, targetGuid: G_B, isKill: true, damage: 80, weapon: 'ak47', hitloc: 'chest', headshot: false, isTeamkill: false, map: 'mp_rust', gametype: 'war', time: t, timeEpoch: epoch },
      // m1014: Bravo mata a Charlie y a Alpha (0 headshots)
      { originGuid: G_B, targetGuid: G_C, isKill: true, damage: 90, weapon: 'm1014', hitloc: 'torso_lower', headshot: false, isTeamkill: false, map: 'mp_terminal', gametype: 'war', time: t, timeEpoch: epoch },
      { originGuid: G_B, targetGuid: G_A, isKill: true, damage: 95, weapon: 'm1014', hitloc: 'helmet', headshot: true, isTeamkill: false, map: 'mp_terminal', gametype: 'war', time: t, timeEpoch: epoch },
      // clan_tag: Alpha mata a Charlie (teamkill)
      { originGuid: G_A, targetGuid: G_C, isKill: true, damage: 150, weapon: 'ak47', hitloc: 'chest', headshot: false, isTeamkill: true, map: 'mp_rust', gametype: 'war', time: t, timeEpoch: epoch },
    ],
  });
  await prisma.session.createMany({
    data: [
      { guid: G_A, start: t, end: t, durationMin: 12, map: 'mp_rust', gametype: 'war' },
      { guid: G_B, start: t, end: t, durationMin: 7, map: 'mp_terminal', gametype: 'war' },
    ],
  });
}

beforeAll(async () => {
  await resetDb();
});

beforeEach(async () => {
  await resetDb();
  await seed();
});

describe('GET /api/weapons (getWeaponsRanking)', () => {
  it('agrega kills, daño, víctimas distintas, % de kills y headshots por arma', async () => {
    const res = await getWeaponsRanking({});
    expect(res.totalKills).toBe(5);
    expect(res.total).toBe(2);
    expect(res.page).toBe(1);
    expect(res.sort).toBe('kills');
    expect(res.totalPages).toBe(1);

    const ak47 = res.weapons.find((w) => w.weapon === 'ak47');
    const m1014 = res.weapons.find((w) => w.weapon === 'm1014');
    expect(ak47).toMatchObject({ kills: 3, damage: 350, victims: 2, headshots: 1, headshotPct: 33.33, killShare: 60 });
    expect(m1014).toMatchObject({ kills: 2, damage: 185, victims: 2, headshots: 1, headshotPct: 50, killShare: 40 });

    // rank global por kills desc, arma asc (independiente del sort elegido).
    expect(res.weapons[0]?.rank).toBe(1);
    expect(res.weapons[0]?.weapon).toBe('ak47');
    expect(res.weapons[1]?.rank).toBe(2);
  });

  it('ordena por damage/headshots y pagina', async () => {
    const byDamage = await getWeaponsRanking({ sort: 'damage', order: 'desc' });
    expect(byDamage.weapons[0]?.weapon).toBe('ak47'); // 350 > 185

    const byHeadshots = await getWeaponsRanking({ sort: 'headshots', order: 'asc' });
    // empate 1-1 → sin garantía de orden interno; solo verificar que ambos están
    expect(byHeadshots.weapons).toHaveLength(2);

    const paged = await getWeaponsRanking({ page: 2, pageSize: 1 });
    expect(paged.totalPages).toBe(2);
    expect(paged.weapons).toHaveLength(1);
    expect(paged.weapons[0]?.weapon).toBe('m1014'); // 2º por kills
  });
});

describe('GET /api/players/:guid/weapons (getPlayerWeapons)', () => {
  it('desglose por arma con favorito, headshots y muertes por arma', async () => {
    const res = await getPlayerWeapons(G_A);
    expect(res.guid).toBe(G_A);
    expect(res.name).toBe('Alpha');
    expect(res.favoriteWeapon).toBe('ak47');
    expect(res.totalKills).toBe(3);
    // Union: ak47 (3 kills) + m1014 (solo la muerte de Alpha por esa arma).
    expect(res.weapons).toHaveLength(2);
    expect(res.weapons[0]).toMatchObject({ weapon: 'ak47', kills: 3, damage: 350, headshots: 1, headshotPct: 33.33, deaths: 0 }); // Alpha murió por m1014, no por ak47
    expect(res.weapons[1]).toMatchObject({ weapon: 'm1014', kills: 0, deaths: 1 });

    const bravo = await getPlayerWeapons(G_B);
    expect(bravo.favoriteWeapon).toBe('m1014');
    // La union incluye armas con las que solo recibió muertes:
    expect(bravo.weapons.find((w) => w.weapon === 'ak47')).toMatchObject({ kills: 0, deaths: 2 });
    expect(bravo.weapons.find((w) => w.weapon === 'm1014')).toMatchObject({ kills: 2, deaths: 0 });
  });

  it('favoriteWeapon es null para un jugador sin kills con arma conocida', async () => {
    await prisma.killEvent.deleteMany({ where: { originGuid: G_C } });
    const res = await getPlayerWeapons(G_C);
    expect(res.favoriteWeapon).toBeNull();
    expect(res.totalKills).toBe(0);
    // Solo aparecen como armas con las que murió (kills=0), nunca como favorita.
    expect(res.weapons).toHaveLength(2);
    expect(res.weapons.find((w) => w.weapon === 'ak47')).toMatchObject({ kills: 0, deaths: 1 });
    expect(res.weapons.find((w) => w.weapon === 'm1014')).toMatchObject({ kills: 0, deaths: 1 });
  });

  it('404 PLAYER_NOT_FOUND para GUID desconocido', async () => {
    await expect(getPlayerWeapons('999999999999999999')).rejects.toMatchObject({ code: 'PLAYER_NOT_FOUND' });
  });
});

describe('GET /api/players/:guid/maps (getPlayerMaps)', () => {
  it('desglose kills/deaths/headshots/daño por mapa con gametypes', async () => {
    const res = await getPlayerMaps(G_A);
    expect(res.favoriteMap).toBe('mp_rust'); // 3 kills vs 0
    expect(res.maps).toHaveLength(2);

    const rust = res.maps.find((m) => m.map === 'mp_rust');
    const terminal = res.maps.find((m) => m.map === 'mp_terminal');
    expect(rust).toMatchObject({ kills: 3, deaths: 0, headshots: 1, damageDealt: 350, gametypes: ['war'] });
    expect(terminal).toMatchObject({ kills: 0, deaths: 1, headshots: 0, damageDealt: 0, gametypes: ['war'] });
  });

  it('404 PLAYER_NOT_FOUND para GUID desconocido', async () => {
    await expect(getPlayerMaps('999999999999999999')).rejects.toMatchObject({ code: 'PLAYER_NOT_FOUND' });
  });
});

describe('Perfil ampliado (getPlayerProfile)', () => {
  it('incluye headshots/%, daño, streak, teamkills, matchesPlayed y favoritos', async () => {
    const profile = await getPlayerProfile(G_A);
    const p = profile.player;
    expect(p.headshots).toBe(1);
    expect(p.headshotPct).toBe(33.33);
    expect(p.damageDealt).toBe(350);
    expect(p.damageTaken).toBe(95);
    expect(p.bestStreak).toBe(3); // 3 kills seguidas sin morir (los eventos ordenados por epoch/id)
    expect(p.teamkills).toBe(1);
    expect(p.matchesPlayed).toBe(2); // mp_rust + mp_terminal
    expect(p.favoriteWeapon).toBe('ak47');
    expect(p.favoriteMap).toBe('mp_rust');
    // timePlayed viene de Session: Alpha tiene 1 cerrada de 12 min.
    expect(p.timePlayed).toBe(720);
  });
});
