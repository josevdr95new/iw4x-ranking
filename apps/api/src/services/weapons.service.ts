import { prisma } from '../lib/prisma.js';
import { Errors } from '../lib/errors.js';
import { parseWith } from '../middleware/validate.js';
import { weaponsQuerySchema } from '../dto/weapons.dto.js';
import type { WeaponsQuery } from '../dto/weapons.dto.js';
import { GUID_PATTERN } from '../lib/validation.js';

/**
 * Agregaciones por arma y por mapa sobre KillEvent.
 * Solo cuentan los eventos K almacenados (isKill=true, víctima válida):
 * los world/suicide y los D no generan evento (ver gamelog.reader).
 */

export interface WeaponRankingEntry {
  /** Posición GLOBAL por kills (desc, arma asc), independiente de sort/paginación. */
  rank: number;
  weapon: string;
  kills: number;
  damage: number;
  /** Víctimas distintas. */
  victims: number;
  /** % sobre el total de kills con arma conocida. */
  killShare: number;
  headshots: number;
  /** % de headshots sobre las kills de esta arma. */
  headshotPct: number;
}

export interface WeaponsRankingResponse {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  sort: WeaponsQuery['sort'];
  order: WeaponsQuery['order'];
  /** Total de kills con arma conocida (denominador de killShare). */
  totalKills: number;
  weapons: WeaponRankingEntry[];
}

export async function getWeaponsRanking(query: unknown): Promise<WeaponsRankingResponse> {
  const q = parseWith(weaponsQuerySchema, query ?? {});

  const rows = await prisma.killEvent.groupBy({
    by: ['weapon'],
    // targetGuid != '': excluye world/suicidio (sin arma real; el log trae
    // "none" y no es una kill contra nadie).
    where: { isKill: true, weapon: { not: null }, targetGuid: { not: '' } },
    _count: { _all: true, targetGuid: true },
    _sum: { damage: true },
  });

  // groupBy no puede contar DISTINCT directamente: víctimas distintas con query aparte.
  const victimRows = await prisma.$queryRaw<Array<{ weapon: string | null; victims: number | bigint }>>`
    SELECT "weapon", COUNT(DISTINCT "targetGuid") AS victims
    FROM "KillEvent"
    WHERE "isKill" = 1 AND "weapon" IS NOT NULL AND "targetGuid" != ''
    GROUP BY "weapon"`;
  const victimsByWeapon = new Map(
    victimRows.map((row) => [row.weapon ?? '', Number(row.victims ?? 0)] as const),
  );

  // Headshots por arma (columna persistida en cada evento).
  const headshotRows = await prisma.killEvent.groupBy({
    by: ['weapon'],
    where: { isKill: true, weapon: { not: null }, headshot: true },
    _count: { _all: true },
  });
  const headshotsByWeapon = new Map(
    headshotRows.map((row) => [row.weapon ?? '', row._count._all] as const),
  );

  const totalKills = rows.reduce((acc, row) => acc + row._count._all, 0);

  const entries: WeaponRankingEntry[] = rows.map((row) => {
    const weapon = row.weapon ?? '';
    const kills = row._count._all;
    const headshots = headshotsByWeapon.get(weapon) ?? 0;
    return {
      rank: 0, // se asigna tras ordenar
      weapon,
      kills,
      damage: Number(row._sum.damage ?? 0),
      victims: victimsByWeapon.get(weapon) ?? 0,
      killShare: totalKills > 0 ? Math.round((kills / totalKills) * 10_000) / 100 : 0,
      headshots,
      headshotPct: kills > 0 ? Math.round((headshots / kills) * 10_000) / 100 : 0,
    };
  });

  // rank = posición global SIEMPRE por kills desc, arma asc (independiente del sort elegido).
  entries.sort((a, b) => b.kills - a.kills || a.weapon.localeCompare(b.weapon));
  entries.forEach((entry, index) => {
    entry.rank = index + 1;
  });

  const sortKey = q.sort as 'kills' | 'damage' | 'victims' | 'headshots';
  entries.sort((a, b) => (q.order === 'desc' ? b[sortKey] - a[sortKey] : a[sortKey] - b[sortKey]));

  const total = entries.length;
  const start = (q.page - 1) * q.pageSize;
  return {
    page: q.page,
    pageSize: q.pageSize,
    total,
    totalPages: total === 0 ? 1 : Math.ceil(total / q.pageSize),
    sort: q.sort,
    order: q.order,
    totalKills,
    weapons: entries.slice(start, start + q.pageSize),
  };
}

export interface PlayerWeaponBreakdown {
  guid: string;
  name: string;
  /** Arma con más kills (empate: más daño, luego nombre). null si no hay kills con arma conocida. */
  favoriteWeapon: string | null;
  totalKills: number;
  weapons: Array<{
    weapon: string;
    kills: number;
    damage: number;
    headshots: number;
    headshotPct: number;
    /** Muertes causadas por esta arma (el jugador como víctima). */
    deaths: number;
  }>;
}

export async function getPlayerWeapons(guidRaw: string): Promise<PlayerWeaponBreakdown> {
  const guid = assertValidGuid(guidRaw);
  const player = await prisma.player.findUnique({ where: { guid }, select: { guid: true, name: true } });
  if (!player) throw Errors.playerNotFound(guid);

  const [killRows, deathRows] = await Promise.all([
    prisma.killEvent.groupBy({
      by: ['weapon'],
      // targetGuid != '': excluye world/suicidio (son muertes propias, no kills
      // con arma; evita la pseudo-arma "none" del log en el ranking).
      where: { isKill: true, originGuid: guid, weapon: { not: null }, targetGuid: { not: '' } },
      _count: { _all: true },
      _sum: { damage: true },
    }),
    prisma.killEvent.groupBy({
      by: ['weapon'],
      where: { isKill: true, targetGuid: guid, weapon: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const headshotRows = await prisma.killEvent.groupBy({
    by: ['weapon'],
    where: { isKill: true, originGuid: guid, weapon: { not: null }, headshot: true },
    _count: { _all: true },
  });
  const headshotsByWeapon = new Map(headshotRows.map((row) => [row.weapon ?? '', row._count._all] as const));
  const deathsByWeapon = new Map(deathRows.map((row) => [row.weapon ?? '', row._count._all] as const));
  const killsByWeapon = new Map(killRows.map((row) => [row.weapon ?? '', { kills: row._count._all, damage: Number(row._sum.damage ?? 0) }] as const));

  // Union de armas: puede haber muertes por armas con las que el jugador nunca mató.
  const allWeapons = new Set<string>([...killsByWeapon.keys(), ...deathsByWeapon.keys()]);
  const weapons = [...allWeapons].map((weapon) => {
    const kills = killsByWeapon.get(weapon)?.kills ?? 0;
    const damage = killsByWeapon.get(weapon)?.damage ?? 0;
    const headshots = headshotsByWeapon.get(weapon) ?? 0;
    return {
      weapon,
      kills,
      damage,
      headshots,
      headshotPct: kills > 0 ? Math.round((headshots / kills) * 10_000) / 100 : 0,
      deaths: deathsByWeapon.get(weapon) ?? 0,
    };
  });

  // Favorito solo entre armas con kills (empate: más daño, luego nombre).
  const favorite = [...weapons]
    .filter((row) => row.kills > 0)
    .sort((a, b) => b.kills - a.kills || b.damage - a.damage || a.weapon.localeCompare(b.weapon))[0];

  return {
    guid: player.guid,
    name: player.name,
    favoriteWeapon: favorite?.weapon ?? null,
    totalKills: weapons.reduce((acc, row) => acc + row.kills, 0),
    weapons: weapons.sort((a, b) => b.kills - a.kills || a.weapon.localeCompare(b.weapon)),
  };
}

export interface PlayerMapsBreakdown {
  guid: string;
  name: string;
  /** Mapa con más kills (empate: más daño). null si no hay actividad en mapas conocidos. */
  favoriteMap: string | null;
  maps: Array<{
    map: string;
    kills: number;
    deaths: number;
    headshots: number;
    damageDealt: number;
    /** Modos registrados en ese mapa (de InitGame; null agrupa en "unknown"). */
    gametypes: string[];
  }>;
}

export async function getPlayerMaps(guidRaw: string): Promise<PlayerMapsBreakdown> {
  const guid = assertValidGuid(guidRaw);
  const player = await prisma.player.findUnique({ where: { guid }, select: { guid: true, name: true } });
  if (!player) throw Errors.playerNotFound(guid);

  const events = await prisma.killEvent.findMany({
    // targetGuid != '': los world/suicidio no son kills de mapa (evita inflar
    // kills/damageDealt del mapa con muertes propias).
    where: { OR: [{ originGuid: guid }, { targetGuid: guid }], map: { not: null }, targetGuid: { not: '' } },
    select: { map: true, gametype: true, originGuid: true, headshot: true, damage: true },
  });

  const byMap = new Map<string, { kills: number; deaths: number; headshots: number; damage: number; gametypes: Set<string> }>();
  for (const event of events) {
    const map = event.map ?? 'unknown';
    const entry = byMap.get(map) ?? { kills: 0, deaths: 0, headshots: 0, damage: 0, gametypes: new Set<string>() };
    if (event.originGuid === guid) {
      entry.kills += 1;
      entry.damage += event.damage;
      if (event.headshot) entry.headshots += 1;
    } else {
      entry.deaths += 1;
    }
    entry.gametypes.add(event.gametype ?? 'unknown');
    byMap.set(map, entry);
  }

  const maps = [...byMap.entries()].map(([map, entry]) => ({
    map,
    kills: entry.kills,
    deaths: entry.deaths,
    headshots: entry.headshots,
    damageDealt: entry.damage,
    gametypes: [...entry.gametypes].sort(),
  }));
  maps.sort((a, b) => b.kills - a.kills || b.damageDealt - a.damageDealt || a.map.localeCompare(b.map));
  const favorite = maps[0]?.map ?? null;

  return {
    guid: player.guid,
    name: player.name,
    favoriteMap: favorite,
    maps,
  };
}

function assertValidGuid(guidRaw: string): string {
  const guid = guidRaw.trim();
  if (!GUID_PATTERN.test(guid)) {
    throw Errors.validation('GUID inválido: debe ser el NetworkId numérico del jugador.');
  }
  return guid;
}
