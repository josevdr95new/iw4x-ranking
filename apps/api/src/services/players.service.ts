import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { Errors } from '../lib/errors.js';
import { clampInt, GUID_PATTERN } from '../lib/validation.js';
import { computeDefaultRank } from './ranking.service.js';

type PlayerWithLink = Prisma.PlayerGetPayload<{ include: { link: { select: { guid: true } } } }>;

export interface PlayerDto {
  guid: string;
  name: string;
  kills: number;
  deaths: number;
  kd: number;
  /** Segundos de juego. */
  timePlayed: number;
  connections: number;
  skill: number;
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
  weapon: string | null;
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
}

export interface PlayerHistoryDto {
  guid: string;
  name: string;
  days: number;
  series: Array<{ date: string; kills: number; deaths: number }>;
}

function toPlayerDto(player: PlayerWithLink): PlayerDto {
  return {
    guid: player.guid,
    name: player.name,
    kills: player.kills,
    deaths: player.deaths,
    kd: player.kd,
    timePlayed: player.timePlayed,
    connections: player.connections,
    skill: player.skill,
    firstConnection: player.firstConnection?.toISOString() ?? null,
    lastConnection: player.lastConnection?.toISOString() ?? null,
    linked: player.link !== null,
  };
}

async function getPlayerOrThrow(guid: string): Promise<PlayerWithLink> {
  const player = await prisma.player.findUnique({
    where: { guid },
    include: { link: { select: { guid: true } } },
  });
  if (!player) throw Errors.playerNotFound(guid);
  return player;
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
    player: toPlayerDto(player),
    rank,
    recentEvents,
    byServer: [...byServer.values()].sort((a, b) => b.kills + b.deaths - (a.kills + a.deaths)),
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
