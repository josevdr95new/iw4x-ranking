import { open, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { prisma } from '../../lib/prisma.js';
import { errMessage } from '../../lib/errors.js';

/**
 * Lector del games_mp.log del servidor dedicado IW4x (formato clásico IW).
 *
 * Formato real verificado (build r5318): cada línea lleva un prefijo de tiempo
 * de juego "  m:ss " que se descarta, y en K/D el team va ANTES del name para
 * atacante y víctima:
 *
 *   J;<guid hex>;<clientnum>;<nombre>            → conexión (abre Session)
 *   Q;<guid hex>;<clientnum>;<nombre>            → desconexión (cierra Session)
 *   InitGame: \map\mp_rust\g_gametype\war\...    → estado de mapa/modo
 *   ShutdownGame:                                → cierra todas las Session abiertas
 *
 *   K;aguid;acid;ateam;aname;vguid;vcid;vteam;vname;weapon;dmg;mod;hitloc  → kill
 *   D;... (mismo layout que K) → daño no letal (NO se almacena como evento:
 *     alimenta damageDealt/damageTaken de los Player implicados)
 *
 * BOTS (`+spawnBot N`): el guid llega como token literal "botN" y se mapea
 * DETERMINISTA a un guid decimal del rango dedicado 0xb07… (ver
 * botGuidToDecimal). El perfil del bot acumula stats entre reboots.
 *
 * Ejemplos REALES (de este server):
 *   0:04 J;b94be6deca6c750c;4;Mandango ProMax
 *   0:39 K;b94be6deca6c750c;4;axis;Mandango ProMax;;-1;world;;none;100;MOD_FALLING;none
 *   (en el kill "world" la víctima tiene vguid vacío, vcid=-1 y vteam="world")
 *   0:12 J;bot5;15;Laupetin
 *   0:20 K;bot5;15;axis;Laupetin;bot8;18;allies;OtroBot;ak47;120;MOD_RIFLE_BULLET;head
 *
 * Extracción por evento K (almacenado en KillEvent): weapon, damage, hitloc,
 * headshot (hitloc ∈ head/helmet), isTeamkill (ateam == vteam), map y gametype
 * (del estado InitGame vigente; null si el log no lo declaró aún).
 *
 * Defensivo por diseño:
 *  - Líneas no reconocidas → skip silencioso + contador (linesIgnored).
 *  - Línea a medias (escritura truncada) → NO avanza el offset; se procesa
 *    en el ciclo siguiente cuando llegue el resto.
 *  - Truncado/rotación del log (tamaño < offset) → reinicia el offset a 0.
 *  - GUIDs inválidos → evento descartado + contador (eventsSkipped).
 *  - Rutas UNC de red soportadas (ej. \\192.168.2.251\iw4x-logs\games_mp.log):
 *    fs de Node abre rutas UNC en Windows de forma transparente; el archivo
 *    remoto debe estar compartido (SMB) con permiso de LECTURA.
 */

export interface GameLogConnect {
  kind: 'connect';
  guid: string; // decimal (BigInt)
  name: string;
  clientNum: number;
}

export interface GameLogDisconnect {
  kind: 'disconnect';
  guid: string;
  name: string;
  clientNum: number;
}

export interface GameLogKill {
  kind: 'kill';
  originGuid: string;
  targetGuid: string | null; // null = world (vguid vacío)
  weapon: string | null;
  damage: number;
  hitloc: string | null;
  isTeamkill: boolean;
}

export interface GameLogDamage {
  kind: 'damage';
  originGuid: string;
  targetGuid: string | null;
  damage: number;
}

export interface GameLogInitGame {
  kind: 'initgame';
  map: string | null;
  gametype: string | null;
}

export interface GameLogShutdown {
  kind: 'shutdown';
}

export type GameLogEvent =
  | GameLogConnect
  | GameLogDisconnect
  | GameLogKill
  | GameLogDamage
  | GameLogInitGame
  | GameLogShutdown;

/** Prefijo de tiempo de juego al inicio de cada línea: "  0:04 ", "12:03 ", etc. */
const TIME_PREFIX = /^\s*\d{1,4}:\d{2}\s?/;

const HEADSHOT_HITLOCS = new Set(['head', 'helmet']);

/**
 * GUIDs de BOTS (server dedicado con `+spawnBot N`, build r5318): el engine
 * escribe en el log el guid literal "botN" (ej. "J;bot5;15;Laupetin",
 * "K;bot5;15;axis;Laupetin;..."). No puede colisionar con hex reales porque
 * la 'o' no es un dígito hex. Máximo 5 dígitos (cap 65535, muy por encima de
 * cualquier sv_maxclients) → números fuera de rango se tratan como corruptos.
 */
const BOT_GUID_TOKEN = /^bot(\d{1,5})$/;
/** Número máximo de bot aceptado (cap defensivo). */
const BOT_GUID_MAX = 65_535;
/** Prefijo hex del rango DEDICADO a bots: 16 hex chars "b07XXXXXXXXXXXXX". */
const BOT_GUID_HEX_PREFIX = 'b07';
/** Ancho fijo (en hex) de la parte numérica del guid de bot. */
const BOT_GUID_HEX_WIDTH = 12;

/**
 * Mapeo DETERMINISTA botN → GUID decimal del rango 0xb07…:
 *   bot5 → 0xb07 000000000005 → "794603859254181893"
 * El mismo número de bot produce SIEMPRE el mismo guid (estable entre
 * reboots): el perfil del bot acumula kills/deaths/skill partida tras partida.
 * Rango "b07..." dedicado a bots (dentro de la máscara de 64 bits / 16 hex
 * chars); cualquier guid hex explícito sigue parseándose por la rama hex.
 */
function botGuidToDecimal(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > BOT_GUID_MAX) return null;
  return BigInt(`0x${BOT_GUID_HEX_PREFIX}${n.toString(16).padStart(BOT_GUID_HEX_WIDTH, '0')}`).toString(10);
}

/**
 * Convierte un GUID hex (hasta 16 chars) del games_mp.log a decimal (BigInt)
 * para que coincida con el esquema de Player (NetworkId decimal).
 * Devuelve null si el GUID no es hex válido.
 */
export function guidHexToDecimal(hex: string): string | null {
  const trimmed = hex.trim();
  if (trimmed === '') return null;
  const bot = BOT_GUID_TOKEN.exec(trimmed);
  if (bot !== null) return botGuidToDecimal(Number(bot[1]));
  if (!/^[0-9a-fA-F]{1,16}$/.test(trimmed)) return null;
  return BigInt(`0x${trimmed}`).toString(10);
}

function toInt(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** Extrae \clave\valor de un infostring estilo Quake ("\\map\\mp_rust\\..."). */
function parseInfoString(raw: string): Map<string, string> {
  const parts = raw.split('\\');
  const info = new Map<string, string>();
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const key = parts[i]?.trim().toLowerCase();
    const value = parts[i + 1]?.trim();
    if (key) info.set(key, value ?? '');
  }
  return info;
}

/** Parsea la línea InitGame (con o sin infostring) para actualizar el estado. */
export function parseInitGameLine(line: string): GameLogInitGame {
  const idx = line.indexOf(':');
  const infostring = idx >= 0 ? line.slice(idx + 1) : '';
  const info = parseInfoString(infostring);
  return {
    kind: 'initgame',
    map: info.get('map') ?? null,
    gametype: info.get('g_gametype') ?? null,
  };
}

/**
 * Parsea UNA línea del games_mp.log. Devuelve:
 *  - GameLogEvent      → evento reconocido
 *  - null              → línea no-evento (separadores, ExitLevel, chat, ...) → ignorar
 *  - 'ignored'         → parecía evento pero tenía datos corruptos (GUID inválido, etc.)
 */
export function parseGameLogLine(rawLine: string): GameLogEvent | null | 'ignored' {
  const line = rawLine.replace(TIME_PREFIX, '').trim();
  if (line === '') return null;

  // Cambios de partida (con estado mapa/modo) y shutdown.
  if (line.startsWith('InitGame')) return parseInitGameLine(line);
  if (line.startsWith('ShutdownGame')) return { kind: 'shutdown' };

  const type = line.charAt(0);
  // Solo J/K/Q/D son eventos; el resto se ignora silenciosamente.
  if (!'JKQD'.includes(type) || line.charAt(1) !== ';') return null;

  const fields = line.split(';').slice(1); // quita el tipo
  if (type === 'J' || type === 'Q') {
    // J;guid;clientnum;nombre
    if (fields.length < 2) return 'ignored';
    const guid = guidHexToDecimal(fields[0] ?? '');
    if (guid === null) return 'ignored';
    const name = (fields[2] ?? '').trim();
    return {
      kind: type === 'J' ? 'connect' : 'disconnect',
      guid,
      name,
      clientNum: toInt(fields[1]),
    };
  }

  // K / D: al menos 12 campos tras el tipo.
  // K;aguid;acid;ateam;aname;vguid;vcid;vteam;vname;weapon;dmg;mod;hitloc
  if (fields.length < 12) return 'ignored';
  const originGuid = guidHexToDecimal(fields[0] ?? '');
  if (originGuid === null) return 'ignored';

  const targetRaw = (fields[4] ?? '').trim();
  const targetGuid = targetRaw === '' ? null : guidHexToDecimal(targetRaw);
  if (targetRaw !== '' && targetGuid === null) return 'ignored'; // GUID víctima corrupto

  const damage = toInt(fields[9]);
  const originTeam = (fields[2] ?? '').trim();
  const targetTeam = (fields[6] ?? '').trim();
  const hitloc = (fields[11] ?? '').trim() || null;

  if (type === 'D') {
    return { kind: 'damage', originGuid, targetGuid, damage };
  }

  const event: GameLogKill = {
    kind: 'kill',
    originGuid,
    targetGuid,
    weapon: (fields[8] ?? '').trim() || null,
    damage,
    hitloc,
    // Teamkill: solo tiene sentido con víctima válida y distinta del origen.
    isTeamkill: targetGuid !== null && targetGuid !== originGuid && originTeam !== '' && originTeam === targetTeam,
  };
  return event;
}

export interface LogChunk {
  lines: string[]; // líneas COMPLETAS nuevas (sin \n final)
  newOffset: bigint; // offset en bytes tras la última línea completa
  truncated: boolean; // el archivo se truncó/rotó desde la última lectura
}

/**
 * Lee desde `byteOffset` (en bytes) y devuelve solo líneas completas.
 * Si la última línea no está completa, el offset no la incluye: se releerá en
 * el próximo ciclo. Si el archivo se truncó (tamaño < offset), se resetea a 0.
 * El offset se calcula en BYTES (Buffer.byteLength) para tolerar UTF-8 multibyte.
 */
export async function readNewLogLines(path: string, byteOffset: bigint): Promise<LogChunk> {
  const info = await stat(path);
  const size = BigInt(info.size);
  let offset = byteOffset;
  let truncated = false;
  if (size < offset) {
    offset = 0n; // truncado o rotación: releer desde el principio
    truncated = true;
  }

  const length = Number(size - offset);
  if (length <= 0) return { lines: [], newOffset: offset, truncated };

  const handle = await open(path, 'r'); // lectura compartida: el juego mantiene el archivo abierto
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, Number(offset));
    const text = buffer.toString('utf8', 0, bytesRead);

    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) {
      // Solo hay una línea a medias (o nada): no consumir nada.
      return { lines: [], newOffset: offset, truncated };
    }

    const consumedText = text.slice(0, lastNewline + 1);
    const consumedBytes = Buffer.byteLength(consumedText, 'utf8');
    const lines = consumedText
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => l.replace(/\r$/, ''));
    return { lines, newOffset: offset + BigInt(consumedBytes), truncated };
  } finally {
    await handle.close();
  }
}

/** Resultado de una pasada de ingesta sobre el log. */
export interface GameLogIngestResult {
  ok: boolean;
  playersSynced: number; // upserts de Player (conexiones/kills/deaths/daño)
  killEventsSynced: number; // KillEvent insertados
  sessionsOpened: number;
  sessionsClosed: number;
  linesParsed: number;
  linesIgnored: number;
  eventsSkipped: number; // eventos válidos pero con datos corruptos
  warnings: string[];
  newOffset: bigint;
}

/** Cap de seguridad para sesiones abiertas (4h): evita inflar timePlayed si el server murió sin Q. */
const OPEN_SESSION_CAP_SECONDS = 4 * 3_600;
const KD_RATIO = (kills: number, deaths: number): number => (deaths > 0 ? kills / deaths : kills);

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Aplica un evento de conexión al modelo Player y abre sesión si no hay una abierta. */
async function applyConnect(
  ev: GameLogConnect,
  server: string | null,
  map: string | null,
  gametype: string | null,
  now: Date,
): Promise<{ opened: boolean }> {
  const base = {
    name: ev.name || 'unknown',
    lastServer: server,
    lastConnection: now,
  };
  await prisma.player.upsert({
    where: { guid: ev.guid },
    create: { guid: ev.guid, ...base, connections: 1, firstConnection: now },
    update: { ...base, connections: { increment: 1 } },
  });

  const open = await prisma.session.findFirst({ where: { guid: ev.guid, end: null }, select: { id: true } });
  if (open) return { opened: false }; // ya tiene sesión en curso (reconexión/duplicado del log)
  await prisma.session.create({ data: { guid: ev.guid, start: now, end: null, map, gametype } });
  return { opened: true };
}

/** Cierra la sesión abierta del jugador (Q). Devuelve true si cerró algo. */
async function applyDisconnect(guid: string, now: Date): Promise<boolean> {
  const open = await prisma.session.findFirst({ where: { guid, end: null }, select: { id: true, start: true } });
  if (!open) return false;
  const durationMin = Math.max(0, Math.round((now.getTime() - open.start.getTime()) / 60_000));
  await prisma.session.update({ where: { id: open.id }, data: { end: now, durationMin } });
  return true;
}

/** Cierra TODAS las sesiones abiertas (ShutdownGame: la partida terminó). Devuelve los guids afectados. */
async function closeAllSessions(now: Date): Promise<string[]> {
  const open = await prisma.session.findMany({ where: { end: null }, select: { id: true, start: true, guid: true } });
  for (const session of open) {
    const durationMin = Math.max(0, Math.round((now.getTime() - session.start.getTime()) / 60_000));
    await prisma.session.update({ where: { id: session.id }, data: { end: now, durationMin } });
  }
  return open.map((session) => session.guid);
}

/** Busca el Player por guid sin crearlo (los updates inline ya lo crean si falta). */
async function existingPlayer(guid: string) {
  return prisma.player.findUnique({ where: { guid }, select: { id: true } });
}

/** Incrementa un campo numérico del Player, creándolo si no existe. */
async function incrementPlayer(guid: string, data: Record<string, number | { increment: number }>, now: Date): Promise<void> {
  const existing = await existingPlayer(guid);
  if (existing) {
    await prisma.player.update({ where: { guid }, data });
    return;
  }
  const create: Record<string, unknown> = { guid, firstConnection: now };
  for (const [key, value] of Object.entries(data)) {
    create[key] = typeof value === 'number' ? value : 1; // { increment: n } en creación = n
  }
  await prisma.player.create({ data: create as never });
}

/**
 * Recalcula los derivados de un jugador desde sus fuentes reales:
 *  - timePlayed: suma de Session (abiertas cuentan como en curso con cap).
 *  - bestStreak: mejor racha de kills sin death intercalado (eventos K almacenados).
 *  - matchesPlayed: nº de mapas distintos con actividad (eventos + sesiones).
 *  - kd sobre esos valores. El SKILL ya NO va acá: es ELO por eventos y lo
 *    escribe exclusivamente processSkillUpdates (src/services/skill/).
 */
async function recomputeDerived(guid: string, now: Date): Promise<void> {
  const player = await prisma.player.findUnique({ where: { guid } });
  if (!player) return;

  // ── timePlayed desde sesiones ─────────────────────────────────
  const sessions = await prisma.session.findMany({ where: { guid }, select: { start: true, end: true } });
  let timePlayed = 0;
  for (const session of sessions) {
    const end = session.end ?? now;
    const seconds = Math.max(0, Math.trunc((end.getTime() - session.start.getTime()) / 1000));
    timePlayed += session.end === null ? Math.min(seconds, OPEN_SESSION_CAP_SECONDS) : seconds;
  }

  // ── bestStreak desde eventos ordenados ────────────────────────
  const events = await prisma.killEvent.findMany({
    where: { OR: [{ originGuid: guid }, { targetGuid: guid }] },
    orderBy: [{ timeEpoch: 'asc' }, { id: 'asc' }],
    select: { originGuid: true, targetGuid: true },
    take: 20_000,
  });
  let current = 0;
  let best = 0;
  for (const event of events) {
    if (event.originGuid === guid) {
      current += 1;
      if (current > best) best = current;
    } else if (event.targetGuid === guid) {
      current = 0;
    }
  }

  // ── matchesPlayed: mapas distintos (eventos + sesiones) ───────
  const eventMaps = await prisma.killEvent.findMany({
    where: { OR: [{ originGuid: guid }, { targetGuid: guid }], map: { not: null } },
    distinct: ['map'],
    select: { map: true },
  });
  const sessionMaps = await prisma.session.findMany({
    where: { guid, map: { not: null } },
    distinct: ['map'],
    select: { map: true },
  });
  const maps = new Set<string>();
  for (const row of eventMaps) if (row.map) maps.add(row.map);
  for (const row of sessionMaps) if (row.map) maps.add(row.map);

  const kd = round2(KD_RATIO(player.kills, player.deaths));

  await prisma.player.update({
    where: { guid },
    data: { timePlayed, bestStreak: best, matchesPlayed: maps.size, kd },
  });
}

/**
 * Una pasada de ingesta del games_mp.log: lee las líneas nuevas desde el
 * cursor persistido (LogIngestState), aplica eventos a Player/KillEvent/Session,
 * actualiza el estado InitGame (mapa/modo) y guarda el nuevo offset.
 * Nunca lanza por contenido del log: los errores van a warnings.
 */
export async function ingestGameLog(path: string, server: string | null): Promise<GameLogIngestResult> {
  const result: GameLogIngestResult = {
    ok: false,
    playersSynced: 0,
    killEventsSynced: 0,
    sessionsOpened: 0,
    sessionsClosed: 0,
    linesParsed: 0,
    linesIgnored: 0,
    eventsSkipped: 0,
    warnings: [],
    newOffset: 0n,
  };

  if (!existsSync(path)) {
    result.warnings.push(`[GameLog] el archivo no existe: ${path}`);
    return result;
  }

  const sourceKey = `gamelog:${path}`;
  const state = await prisma.logIngestState.findUnique({ where: { source: sourceKey } });
  let offset = state?.byteOffset ?? 0n;
  let currentMap = state?.currentMap ?? null;
  let currentGametype = state?.currentGametype ?? null;

  let chunk: LogChunk;
  try {
    chunk = await readNewLogLines(path, offset);
  } catch (err) {
    result.warnings.push(`[GameLog] no se pudo leer el archivo: ${errMessage(err)}`);
    return result;
  }
  if (chunk.truncated) {
    result.warnings.push('[GameLog] el archivo se truncó/rotó; offset reiniciado a 0 (los eventos ya ingestados no se duplican: solo se re-lee el contenido nuevo).');
  }

  result.newOffset = chunk.newOffset;
  const now = new Date();
  const touched = new Set<string>(); // guids que requieren recompute de derivados

  for (const line of chunk.lines) {
    if (line.trim() === '') continue;
    let event: GameLogEvent | null | 'ignored';
    try {
      event = parseGameLogLine(line);
    } catch {
      result.linesIgnored += 1;
      continue;
    }

    if (event === null) {
      result.linesIgnored += 1;
      continue;
    }
    if (event === 'ignored') {
      result.eventsSkipped += 1;
      continue;
    }

    try {
      if (event.kind === 'initgame') {
        currentMap = event.map;
        currentGametype = event.gametype;
      } else if (event.kind === 'shutdown') {
        const closed = await closeAllSessions(now);
        result.sessionsClosed += closed.length;
        for (const guid of closed) touched.add(guid); // sus derivados (timePlayed) deben recomputarse
      } else if (event.kind === 'connect') {
        const { opened } = await applyConnect(event, server, currentMap, currentGametype, now);
        if (opened) result.sessionsOpened += 1;
        result.playersSynced += 1;
        touched.add(event.guid);
      } else if (event.kind === 'disconnect') {
        await prisma.player.updateMany({
          where: { guid: event.guid },
          data: { lastConnection: now, ...(server !== null ? { lastServer: server } : {}) },
        });
        if (await applyDisconnect(event.guid, now)) result.sessionsClosed += 1;
        touched.add(event.guid);
      } else if (event.kind === 'damage') {
        // D: no letal → solo agregados de daño (NO crea evento ni kill/death).
        const self = event.targetGuid === null || event.targetGuid === event.originGuid;
        if (self) {
          await incrementPlayer(event.originGuid, { damageTaken: { increment: event.damage } }, now);
          touched.add(event.originGuid);
        } else {
          await incrementPlayer(event.originGuid, { damageDealt: { increment: event.damage } }, now);
          await incrementPlayer(event.targetGuid!, { damageTaken: { increment: event.damage } }, now);
          touched.add(event.originGuid);
          touched.add(event.targetGuid!);
        }
        result.playersSynced += self ? 1 : 2;
      } else {
        // K: kill. Suicidio (origin==target) y world (target null) cuentan SOLO death + daño recibido.
        const isSuicide = event.targetGuid !== null && event.targetGuid === event.originGuid;
        const victimGuid = isSuicide ? null : event.targetGuid;
        const headshot = event.hitloc !== null && HEADSHOT_HITLOCS.has(event.hitloc.toLowerCase());

        if (victimGuid !== null) {
          await incrementPlayer(event.originGuid, { kills: { increment: 1 }, damageDealt: { increment: event.damage } }, now);
          await incrementPlayer(victimGuid, { deaths: { increment: 1 }, damageTaken: { increment: event.damage } }, now);
          if (event.isTeamkill) {
            await incrementPlayer(event.originGuid, { teamkills: { increment: 1 } }, now);
          }
          if (headshot) {
            await incrementPlayer(event.originGuid, { headshots: { increment: 1 } }, now);
          }
          await prisma.killEvent.create({
            data: {
              originGuid: event.originGuid,
              targetGuid: victimGuid,
              isKill: true,
              damage: event.damage,
              weapon: event.weapon,
              hitloc: event.hitloc,
              headshot,
              isTeamkill: event.isTeamkill,
              map: currentMap,
              gametype: currentGametype,
              server,
              time: now,
              timeEpoch: Math.trunc(now.getTime() / 1000),
            },
          });
          result.killEventsSynced += 1;
          touched.add(event.originGuid);
          touched.add(victimGuid);
        } else {
          // world / suicidio: el "atacante" es quien muere o se daña.
          await incrementPlayer(event.originGuid, { deaths: { increment: 1 }, damageTaken: { increment: event.damage } }, now);
          touched.add(event.originGuid);
        }
        result.playersSynced += victimGuid !== null ? 2 : 1;
      }
      result.linesParsed += 1;
    } catch (err) {
      result.warnings.push(`[GameLog] línea no aplicada ("${line.slice(0, 80)}"): ${errMessage(err)}`);
    }
  }

  // Derivados (kd/skill/timePlayed/bestStreak/matchesPlayed) para los guids tocados.
  for (const guid of touched) {
    try {
      await recomputeDerived(guid, now);
    } catch (err) {
      result.warnings.push(`[GameLog] derivados no recalculados para ${guid}: ${errMessage(err)}`);
    }
  }

  // Persiste cursor, estado InitGame y telemetría (solo tras aplicar todo).
  await prisma.logIngestState.upsert({
    where: { source: sourceKey },
    create: {
      source: sourceKey,
      byteOffset: result.newOffset,
      linesParsed: result.linesParsed,
      linesIgnored: result.linesIgnored + result.eventsSkipped,
      currentMap,
      currentGametype,
      lastRunAt: new Date(),
    },
    update: {
      byteOffset: result.newOffset,
      linesParsed: { increment: result.linesParsed },
      linesIgnored: { increment: result.linesIgnored + result.eventsSkipped },
      currentMap,
      currentGametype,
      lastRunAt: new Date(),
    },
  });

  result.ok = true;
  return result;
}
