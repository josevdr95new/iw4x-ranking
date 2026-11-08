import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { Errors } from '../lib/errors.js';
import { clampInt, GUID_PATTERN } from '../lib/validation.js';
import { weaponDisplayName } from '../lib/weapons.js';
import { computeDefaultRank } from './ranking.service.js';
import { getPlayerAliases, type PlayerAliasDto } from './alias.service.js';
import { MELEE_MOD } from './sync/gamelog.reader.js';

type PlayerWithLink = Prisma.PlayerGetPayload<{ include: { accountLinks: { select: { guid: true } } } }>;

export interface PlayerDto {
  guid: string;
  name: string;
  kills: number;
  deaths: number;
  kd: number;
  /** Segundos de juego. Con fuente log: suma de Session (abiertas: en curso, cap 4h). */
  timePlayed: number;
  connections: number;
  /** skill = ELO interno (rival-relative + headshots + daño; floor 150, cap 2500, inicio 1000). Ver docs/API.md. */
  skill: number;
  headshots: number;
  /** % de kills que fueron headshot (hitloc head/helmet). */
  headshotPct: number;
  /** Ratio headshots/kills con 2 decimales; null si 0 kills (evita div/0). */
  hsRatio: number | null;
  damageDealt: number;
  damageTaken: number;
  /** Daño medio por kill (damageDealt/kills, 2 decimales); null si 0 kills. */
  damagePerKill: number | null;
  /** Bajas con cuchillo (mod MOD_MELEE del log: cuchillada o golpe con el arma en la mano — así lo cuenta el juego). Computado al vuelo sobre KillEvent. */
  knifeKills: number;
  /** Muertes a cuchillo (mod MOD_MELEE). Computado al vuelo sobre KillEvent. */
  knifeDeaths: number;
  /** Mejor racha de kills sin morir (aprox: solo eventos K almacenados). */
  bestStreak: number;
  teamkills: number;
  /** Mapas distintos con actividad (eventos + sesiones). */
  matchesPlayed: number;
  /** Arma con más kills del jugador. */
  favoriteWeapon: string | null;
  /** Mapa con más kills del jugador. */
  favoriteMap: string | null;
  firstConnection: string | null;
  lastConnection: string | null;
  linked: boolean;
}

export interface KillEventDto {
  id: number;
  time: string;
  epoch: number;
  direction: 'kill' | 'death';
  isKill: boolean;
  damage: number;
  /** Arma cruda del log (ej. "ump45_eotech_mp"). Compat: igual que weaponCode. */
  weapon: string | null;
  /** Arma cruda del log (ej. "ump45_eotech_mp"). */
  weaponCode: string | null;
  /** Nombre display humano del arma (diccionario MW2/IW4x; nunca el crudo). */
  weaponName: string | null;
  /** Zona del impacto según el log (head, chest, ...); null si no vino. */
  hitloc: string | null;
  /** Kill con headshot (hitloc head/helmet). */
  headshot: boolean;
  /** Muerte/baja a cuchillo (mod MOD_MELEE del log). */
  isKnife: boolean;
  server: string | null;
  opponentGuid: string;
  opponentName: string | null;
}

export interface PlayerProfileDto {
  player: PlayerDto;
  /**
   * Posición global en el ranking por defecto (kills desc, empate por nombre asc
   * — el mismo orden de GET /api/leaderboard con sus valores por defecto).
   * null si el jugador no clasifica en ese ranking (reservado; con los criterios
   * actuales todo jugador sincronizado tiene rank).
   */
  rank: number | null;
  recentEvents: KillEventDto[];
  byServer: Array<{ server: string; kills: number; deaths: number }>;
  /**
   * Anti-confusión: nombres HISTÓRICOS vistos para este GUID (excluye el nombre
   * actual, último visto primero, máx 10). Detecta PCs compartidas / renombres.
   */
  aliases: PlayerAliasDto[];
}

export interface PlayerHistoryDto {
  guid: string;
  name: string;
  days: number;
  series: Array<{ date: string; kills: number; deaths: number }>;
}

function toPlayerDto(
  player: PlayerWithLink,
  favoriteWeapon: string | null,
  favoriteMap: string | null,
  knifeKills: number,
  knifeDeaths: number,
): PlayerDto {
  return {
    guid: player.guid,
    name: player.name,
    kills: player.kills,
    deaths: player.deaths,
    kd: player.kd,
    timePlayed: player.timePlayed,
    connections: player.connections,
    skill: player.skill,
    headshots: player.headshots,
    headshotPct: pct(player.headshots, player.kills),
    hsRatio: player.kills > 0 ? round2(player.headshots / player.kills) : null,
    damageDealt: player.damageDealt,
    damageTaken: player.damageTaken,
    damagePerKill: player.kills > 0 ? round2(player.damageDealt / player.kills) : null,
    knifeKills,
    knifeDeaths,
    bestStreak: player.bestStreak,
    teamkills: player.teamkills,
    matchesPlayed: player.matchesPlayed,
    favoriteWeapon,
    favoriteMap,
    firstConnection: player.firstConnection?.toISOString() ?? null,
    lastConnection: player.lastConnection?.toISOString() ?? null,
    linked: player.accountLinks.length > 0,
  };
}

async function getPlayerOrThrow(guid: string): Promise<PlayerWithLink> {
  const player = await prisma.player.findUnique({
    where: { guid },
    include: { accountLinks: { select: { guid: true } } },
  });
  if (!player) throw Errors.playerNotFound(guid);
  return player;
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 10_000) / 100 : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function assertValidGuid(guidRaw: string): string {
  const guid = guidRaw.trim();
  if (!GUID_PATTERN.test(guid)) {
    throw Errors.validation('GUID inválido: debe ser el NetworkId numérico del jugador.');
  }
  return guid;
}

export async function getPlayerProfile(guidRaw: string): Promise<PlayerProfileDto> {
  const guid = assertValidGuid(guidRaw);
  const player = await getPlayerOrThrow(guid);
  const rank = await computeDefaultRank(player.kills, player.name);

  const events = await prisma.killEvent.findMany({
    where: { OR: [{ originGuid: guid }, { targetGuid: guid }] },
    orderBy: [{ timeEpoch: 'desc' }],
    take: 300,
  });

  // Favoritos del resumen + conteos de cuchillo (MOD_MELEE) computados al
  // vuelo sobre KillEvent: fuente única de verdad, sin counters derivables.
  const [weaponRows, mapRows, aliases, knifeKills, knifeDeaths] = await Promise.all([
    prisma.killEvent.groupBy({
      by: ['weapon'],
      where: { originGuid: guid, isKill: true, weapon: { not: null } },
      _count: { _all: true },
      _sum: { damage: true },
    }),
    prisma.killEvent.groupBy({
      by: ['map'],
      where: { originGuid: guid, isKill: true, map: { not: null } },
      _count: { _all: true },
      _sum: { damage: true },
    }),
    getPlayerAliases(guid, player.name),
    // Bajas a cuchillo: eventos K del jugador con mod MOD_MELEE (isKill=true,
    // mismo filtro que los favoritos). Con el histórico borrado por db:zero el
    // conteo parte de 0 y crece con el juego (decisión del dueño: el histórico
    // pre-zero NO existe).
    prisma.killEvent.count({ where: { originGuid: guid, isKill: true, mod: MELEE_MOD } }),
    // Muertes a cuchillo: el jugador como VÍCTIMA de un evento MOD_MELEE.
    prisma.killEvent.count({ where: { targetGuid: guid, mod: MELEE_MOD } }),
  ]);
  const favoriteWeapon =
    weaponRows
      .map((row) => ({ weapon: row.weapon ?? '', kills: row._count._all, damage: Number(row._sum.damage ?? 0) }))
      .sort((a, b) => b.kills - a.kills || b.damage - a.damage || a.weapon.localeCompare(b.weapon))[0]?.weapon ?? null;
  const favoriteMap =
    mapRows
      .map((row) => ({ map: row.map ?? '', kills: row._count._all, damage: Number(row._sum.damage ?? 0) }))
      .sort((a, b) => b.kills - a.kills || b.damage - a.damage || a.map.localeCompare(b.map))[0]?.map ?? null;

  const recent = events.slice(0, 20);
  const opponentGuids = [
    ...new Set(recent.map((event) => (event.originGuid === guid ? event.targetGuid : event.originGuid))),
  ];
  const opponents = await prisma.player.findMany({
    where: { guid: { in: opponentGuids } },
    select: { guid: true, name: true },
  });
  const nameByGuid = new Map(opponents.map((opponent) => [opponent.guid, opponent.name] as const));

  const recentEvents: KillEventDto[] = recent.map((event) => {
    const isOrigin = event.originGuid === guid;
    const opponentGuid = isOrigin ? event.targetGuid : event.originGuid;
    return {
      id: event.id,
      time: event.time.toISOString(),
      epoch: event.timeEpoch,
      direction: isOrigin ? 'kill' : 'death',
      isKill: event.isKill,
      damage: event.damage,
      weapon: event.weapon,
      weaponCode: event.weapon,
      weaponName: event.weapon !== null ? weaponDisplayName(event.weapon) : null,
      hitloc: event.hitloc,
      headshot: event.headshot,
      isKnife: event.mod === MELEE_MOD,
      server: event.server,
      opponentGuid,
      opponentName: nameByGuid.get(opponentGuid) ?? null,
    };
  });

  const byServer = new Map<string, { server: string; kills: number; deaths: number }>();
  for (const event of events) {
    if (event.server === null) continue;
    const entry = byServer.get(event.server) ?? { server: event.server, kills: 0, deaths: 0 };
    if (event.originGuid === guid) {
      entry.kills += 1;
    } else {
      entry.deaths += 1;
    }
    byServer.set(event.server, entry);
  }

  return {
    player: toPlayerDto(player, favoriteWeapon, favoriteMap, knifeKills, knifeDeaths),
    rank,
    recentEvents,
    byServer: [...byServer.values()].sort((a, b) => b.kills + b.deaths - (a.kills + a.deaths)),
    aliases,
  };
}

export async function getPlayerHistory(guidRaw: string, daysRaw: unknown): Promise<PlayerHistoryDto> {
  const guid = assertValidGuid(guidRaw);
  const days = clampInt(daysRaw, 1, 90, 30);
  const player = await getPlayerOrThrow(guid);

  const MS_PER_DAY = 86_400_000;
  const todayStartMs = Math.floor(Date.now() / MS_PER_DAY) * MS_PER_DAY;
  const windowStartMs = todayStartMs - (days - 1) * MS_PER_DAY;
  const windowStartEpoch = Math.floor(windowStartMs / 1000);

  const rows = await prisma.$queryRaw<Array<{ day: string; kills: number | bigint; deaths: number | bigint }>>`
    SELECT date("time") AS day,
           SUM(CASE WHEN "originGuid" = ${guid} THEN 1 ELSE 0 END) AS kills,
           SUM(CASE WHEN "targetGuid" = ${guid} THEN 1 ELSE 0 END) AS deaths
    FROM "KillEvent"
    WHERE "timeEpoch" >= ${windowStartEpoch}
    GROUP BY day
    ORDER BY day ASC`;

  const byDay = new Map<string, { kills: number; deaths: number }>();
  for (const row of rows) {
    byDay.set(row.day, { kills: Number(row.kills ?? 0), deaths: Number(row.deaths ?? 0) });
  }

  const series: PlayerHistoryDto['series'] = [];
  for (let i = 0; i < days; i += 1) {
    const date = new Date(windowStartMs + i * MS_PER_DAY).toISOString().slice(0, 10);
    const found = byDay.get(date);
    series.push({ date, kills: found?.kills ?? 0, deaths: found?.deaths ?? 0 });
  }

  return { guid, name: player.name, days, series };
}
