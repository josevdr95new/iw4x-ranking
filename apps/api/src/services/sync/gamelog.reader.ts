import { open, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { prisma } from '../../lib/prisma.js';
import { errMessage } from '../../lib/errors.js';
import { isBotGuid, upsertPlayerAlias } from '../alias.service.js';
import { reportIdentityAlert } from '../identity.service.js';
import { tryAutoLinkBySession } from '../play-session.service.js';
import { awardMatchBonus, type MatchPlayerTally } from '../skill/match-bonus.js';

/**
 * Lector del games_mp.log del servidor dedicado IW4x.
 *
 * Formato real: cada línea lleva un prefijo de tiempo de juego "  m:ss " que se
 * descarta, y en K/D el team va ANTES del name en cada bloque:
 *
 *   J;<guid hex>;<clientnum>;<nombre>            → conexión (abre Session)
 *   Q;<guid hex>;<clientnum>;<nombre>            → desconexión (cierra Session)
 *   InitGame: \map\mp_rust\g_gametype\war\...    → estado de mapa/modo
 *   ShutdownGame:                                → cierra todas las Session abiertas
 *
 * ⚠️ SEMÁNTICA K/D DE ESTA BUILD (NO es el estándar IW4): el PRIMER bloque es
 * la VÍCTIMA y el SEGUNDO el KILLER (al revés que el stock IW / IW4MAdmin):
 *
 *   K;vguid;vcid;vteam;vname;kguid;kcid;kteam;kname;weapon;dmg;mod;hitloc  → kill
 *   D;... (mismo layout que K) → daño no letal (NO se almacena como evento:
 *     alimenta damageDealt/damageTaken de los Player implicados)
 *
 * EVIDENCIA que fijó este orden (2026-11-07, partida en vivo):
 *  1. El scoreboard IN-GAME del guid c103bb7531742427 ("admin") mostraba
 *     Kills 12 / Deaths 0 / score 1200 (12×100) a mitad de sesión, mientras la
 *     DB (parseada como atacante-primero, formato stock) le contaba
 *     kills≈0-1 / deaths=13. Esas 13 "muertes" stock eran en realidad sus
 *     KILLS REALES: el guid estaba en el SEGUNDO bloque de esas líneas.
 *  2. Al cierre parcial del mismo log: 31 líneas K con el guid en el 2º bloque
 *     vs solo 2 con el guid en el 1º (1 muerte contra un bot + 1 suicidio).
 *  3. En NINGUNA línea K del log va "world" en el PRIMER bloque: el caso
 *     world es víctima-primero con killer world (guid vacío, cid -1, team
 *     "world") — imposible bajo el orden stock.
 * Si algún día cambia la build y esto falla, REPETIR EL EXPERIMENTO DEL
 * SCOREBOARD: comparar kills/deaths visibles en el juego contra los bloques
 * del log antes de tocar este parser.
 *
 * Líneas reales de ese log (fixtures de tests/gamelog.test.ts):
 *   0:39 K;b94be6deca6c750c;4;axis;Mandango ProMax;;-1;world;;none;100;MOD_FALLING;none
 *   (víctima Mandango en el 1º bloque; killer world en el 2º: guid vacío, cid -1)
 *   3:04 K;bot5;4;allies;/dev/../;c103bb7531742427;5;axis;pollacaballo;sa80_grip_reflex_mp;40;MOD_RIFLE_BULLET;right_arm_lower
 *   (víctima bot5; killer pollacaballo = el dueño)
 *   3:17 K;c103bb7531742427;14;axis;admin;bot8;7;allies;/dev/full;famas_gl_mp;56;MOD_RIFLE_BULLET;right_arm_lower
 *   (víctima admin; killer bot8)
 *
 * BOTS (`+spawnBot N`): el guid llega como token literal "botN" en CUALQUIERA
 * de los dos bloques y se mapea DETERMINISTA a un guid decimal del rango
 * dedicado 0xb07… (ver botGuidToDecimal). DESDE 2026-11-11 (decisión del
 * dueño) los bots DEJAN DE EXISTIR como jugadores en la DB: NINGUNA línea con
 * bot crea/upsertea Player, alias, Session ni skill del bot. LO QUE SÍ SE
 * GUARDA: la parte HUMANA del evento — un humano que mata a un bot suma
 * kills/headshots/daño/racha/ELO decayado, y un humano que muere contra un bot
 * suma deaths/daño recibido (su KillEvent queda almacenado con los nombres
 * DENORMALIZADOS originName/targetName para que el feed muestre "mataste a
 * Lunarion" sin necesitar Player row del bot). Las kills bot-vs-bot NO
 * generan KillEvent (no hay ningún humano involucrado: cero estadística).
 *
 * Extracción por evento K (almacenado en KillEvent): weapon, mod (MOD_MELEE =
 * cuchillada), damage, hitloc, headshot (hitloc ∈ head/helmet, se acredita al
 * KILLER), isTeamkill (vteam == kteam), map y gametype (del estado InitGame
 * vigente; null si el log no lo declaró aún). En KillEvent la DB guarda la
 * semántica stock: originGuid = KILLER, targetGuid = VÍCTIMA (todo el skill
 * ELO, streaks, armas y perfiles consumen ese orden).
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
 *
 * WORLD/SUICIDIO (desde 2026-11-08): la muerte por world (killer sin guid) o
 * el suicidio (mismo guid en ambos bloques) TAMBIÉN crea KillEvent para
 * HUMANOS, con originGuid = víctima y targetGuid = '' (marcador de "sin
 * atacante"): el motor skill aplica la pérdida plana SKILL.WORLD_LOSS=4.
 * Ese evento NO cuenta como kill en ningún agregado (streak/feed/armas/mapas
 * filtran targetGuid == ''). Un BOT que muere por world/suicidio NO genera
 * nada (sin counters: desde 2026-11-11 los bots no tienen Player row).
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
  /** VÍCTIMA (quien muere): PRIMER bloque del K de esta build. Siempre tiene guid. */
  victimGuid: string;
  /** KILLER: SEGUNDO bloque del K de esta build. null = world (guid vacío). */
  killerGuid: string | null;
  /** Nombre EXACTO de la víctima (primer bloque; para historial de alias). */
  victimName: string;
  /** Nombre EXACTO del killer (segundo bloque); null si world. */
  killerName: string | null;
  weapon: string | null;
  /** Mod de la kill según el log (MOD_RIFLE_BULLET, MOD_MELEE, MOD_HEAD_SHOT...). */
  mod: string | null;
  damage: number;
  hitloc: string | null;
  /** Teamkill: víctima y killer con guid distinto y MISMO team (vteam == kteam). */
  isTeamkill: boolean;
}

export interface GameLogDamage {
  kind: 'damage';
  /** Quien RECIBE el daño (primer bloque del D de esta build). */
  receiverGuid: string;
  /** Quien INFLIGE el daño (segundo bloque); null = world (guid vacío). */
  dealerGuid: string | null;
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

/**
 * Segundos del prefijo de tiempo de juego de UNA línea ("  0:04 K;..." → 4,
 * "12:03 ..." → 723). Es el reloj DE PARTIDA del engine (resetea a 0:00 en cada
 * InitGame), no hora real: la diferencia entre el prefijo del InitGame y el del
 * ShutdownGame es la DURACIÓN DE LA PARTIDA según el log (la usa el bonus
 * top-3 para exigir partidas ≥3 min). null si la línea no trae prefijo válido.
 */
export function parseLogTimeSeconds(rawLine: string): number | null {
  const match = /^\s*(\d{1,4}):(\d{2})\s?/.exec(rawLine);
  if (match === null) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export const HEADSHOT_HITLOCS = new Set(['head', 'helmet']);

/**
 * MOD_MELEE del log = MUERTE A CUCHILLO: cubre la cuchillada del cuchillo Y el
 * golpe con el arma en la mano (el juego marca ambos como MOD_MELEE).
 */
export const MELEE_MOD = 'MOD_MELEE';

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
  // ⚠️ ESTA BUILD (verificado con scoreboard en vivo, ver cabecera): el PRIMER
  // bloque es la VÍCTIMA y el SEGUNDO el KILLER (orden INVERTIDO respecto al
  // stock IW4):
  // K;vguid;vcid;vteam;vname;kguid;kcid;kteam;kname;weapon;dmg;mod;hitloc
  if (fields.length < 12) return 'ignored';

  const victimGuid = guidHexToDecimal(fields[0] ?? '');
  if (victimGuid === null) return 'ignored'; // la víctima SIEMPRE tiene guid (es quien muere)

  const victimName = (fields[3] ?? '').trim();
  const killerRaw = (fields[4] ?? '').trim();
  const killerGuid = killerRaw === '' ? null : guidHexToDecimal(killerRaw);
  if (killerRaw !== '' && killerGuid === null) return 'ignored'; // GUID killer corrupto
  const killerName = (fields[7] ?? '').trim() || null;

  const damage = toInt(fields[9]);
  const victimTeam = (fields[2] ?? '').trim();
  const killerTeam = (fields[6] ?? '').trim();
  const hitloc = (fields[11] ?? '').trim() || null;

  if (type === 'D') {
    // D: primer bloque = quien RECIBE el daño, segundo = quien lo INFLIGE.
    return { kind: 'damage', receiverGuid: victimGuid, dealerGuid: killerGuid, damage };
  }

  const event: GameLogKill = {
    kind: 'kill',
    victimGuid,
    killerGuid,
    victimName,
    killerName,
    weapon: (fields[8] ?? '').trim() || null,
    // mod (fields[10]): MOD_MELEE distingue muertes a cuchillo (cuchillada o golpe con el arma en la mano).
    mod: (fields[10] ?? '').trim() || null,
    damage,
    hitloc,
    // Teamkill: killer y víctima reales con MISMO team (world/suicidio → false).
    isTeamkill:
      killerGuid !== null && killerGuid !== victimGuid && victimTeam !== '' && victimTeam === killerTeam,
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
  playersSynced: number; // upserts de Player HUMANOS (conexiones/kills/deaths/daño; bots: 0)
  killEventsSynced: number; // KillEvent insertados (solo eventos con ≥1 humano; bot-vs-bot: 0)
  matchBonusEventsSynced: number; // MatchBonusEvent insertados (bonus top-3 al ShutdownGame)
  aliasesUpserted: number; // apariciones de alias HUMANAS (J + K) aplicadas a PlayerAlias
  identityAlertsUpserted: number; // alertas de identidad (impersonación de nick) creadas/actualizadas
  autoLinksSynced: number; // AccountLinks creados por sesión activa del launcher (auto-link)
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
  // BOTS (2026-11-11): cero persistencia — sin Player, sin Session, sin alias.
  // La línea J del bot se cuenta como parseada y nada más.
  if (isBotGuid(ev.guid)) return { opened: false };
  const base = {
    name: ev.name || 'unknown',
    lastServer: server,
    lastConnection: now,
    isBot: false, // humano: el rango 0xb07… ya salió por el guard de arriba
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

/**
 * Incrementa un campo numérico del Player, creándolo si no existe.
 * GUARD DE BOTS (2026-11-11): un guid del rango 0xb07… NUNCA toca Player —
 * ni update ni create (cero estadística de bot). Los callsites ya filtran,
 * esto es defensa en profundidad.
 */
async function incrementPlayer(guid: string, data: Record<string, number | { increment: number }>, now: Date): Promise<void> {
  if (isBotGuid(guid)) return;
  const withBot = { ...data, isBot: false } as never;
  const existing = await existingPlayer(guid);
  if (existing) {
    await prisma.player.update({ where: { guid }, data: withBot });
    return;
  }
  const create: Record<string, unknown> = { guid, firstConnection: now };
  for (const [key, value] of Object.entries(data)) {
    // En creación, { increment: n } = el valor n (no 1): el primer kill/daño
    // de un player sin línea J previa (ej. víctima de bot sin conexión
    // registrada) debe quedar con el importe REAL del evento.
    create[key] = typeof value === 'number' ? value : value.increment;
  }
  create.isBot = false;
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
  // targetGuid != '': EXCLUYE los eventos world/suicidio (origin=víctima,
  // target=''): morir por world/suicidio NO es un kill (no suma racha) ni
  // reinicia la racha vigente (semántica previa a los eventos world).
  const events = await prisma.killEvent.findMany({
    where: { OR: [{ originGuid: guid }, { targetGuid: guid }], targetGuid: { not: '' } },
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
  // Igual que bestStreak: los eventos world/suicidio (target='') no cuentan
  // como actividad de mapa (solo kills reales y sesiones).
  const eventMaps = await prisma.killEvent.findMany({
    where: { OR: [{ originGuid: guid }, { targetGuid: guid }], map: { not: null }, targetGuid: { not: '' } },
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
    matchBonusEventsSynced: 0,
    aliasesUpserted: 0,
    identityAlertsUpserted: 0,
    autoLinksSynced: 0,
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
  /** Epoch (segundos) de TODA esta pasada: los KillEvent de la pasada lo comparten y el orden dentro del stream lo resuelve id ASC (orden de inserción). */
  const passEpoch = Math.trunc(now.getTime() / 1000);
  const touched = new Set<string>(); // guids que requieren recompute de derivados

  // ── Estado de la PARTIDA en curso (para el bonus top-3 de fin de partida) ──
  // Entre InitGame y ShutdownGame: kills/deaths/nick por HUMANO (el tally NUNCA
  // guarda bots) + el segundo de log del InitGame (duración de la partida).
  // El ShutdownGame premia (awardMatchBonus) y resetea el estado.
  let matchStartSec: number | null = null;
  let matchTally = new Map<string, MatchPlayerTally>();
  /** Registra actividad humana en la partida (J/K): crea fila y refresca el nick. */
  const noteHuman = (guid: string, name: string | null): void => {
    if (isBotGuid(guid)) return;
    const row = matchTally.get(guid) ?? { kills: 0, deaths: 0, name: name ?? '' };
    if (name) row.name = name;
    matchTally.set(guid, row);
  };

  for (const [lineIndex, line] of chunk.lines.entries()) {
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
        // Nueva partida: reset del tally y marca del segundo de log de inicio
        // (el InitGame define el origen de la duración para el bonus top-3).
        matchStartSec = parseLogTimeSeconds(line);
        matchTally = new Map();
      } else if (event.kind === 'shutdown') {
        const closed = await closeAllSessions(now);
        result.sessionsClosed += closed.length;
        for (const guid of closed) touched.add(guid); // sus derivados (timePlayed) deben recomputarse
        // BONUS TOP-3 DE FIN DE PARTIDA (ver src/services/skill/match-bonus.ts):
        // exige partida ≥3 min de LOG (InitGame visto + ShutdownGame; si el
        // reader arrancó a mitad de partida NO hay bonus) y ≥2 humanos. El
        // tally solo trae humanos con ≥5 kills para calificar; bots excluidos.
        try {
          const shutdownSec = parseLogTimeSeconds(line);
          const duration =
            matchStartSec !== null && shutdownSec !== null ? Math.max(0, shutdownSec - matchStartSec) : null;
          // FLOOR DEL EPOCH DEL BONUS (bug CI 2026-11-08, 3 pushes rojos):
          // los KillEvent de esta pasada llevan `passEpoch`; el bonus llevaba su
          // propio Date.now() → si la pasada cabía en <1s (CI rápida), bonus y
          // kills compartían segundo y el desempate (timeEpoch, id) comparaba
          // ids de tablas DISTINTAS (secuencias autoincrement independientes y
          // descompensadas: los ids de bonus van siempre por detrás) → el bonus
          // ordenaba ANTES de los kills de su propia partida y el delta real
          // era ≠ +15/+10/+5. Fix: floor estricto passEpoch+1 → el bonus ordena
          // SIEMPRE después de los kills ya insertados de su partida, con o sin
          // cambio de segundo. EXCEPCIÓN (multi-partida en la MISMA pasada):
          // si quedan líneas K después de este ShutdownGame, floor = passEpoch
          // (sin bump): el orden real lo resuelve id ASC = orden de inserción
          // (un bump aquí retrasaría el bonus de esta partida por detrás de los
          // kills de la siguiente). Residual documentado: si esa misma pasada
          // multi-partida CRUZA un segundo justo en un ShutdownGame, el bonus
          // de la partida cerrada ordena tras los kills de la siguiente (para
          // eliminarlo haría falta un cursor de orden persistido por fuente).
          const killsRemainInPass = chunk.lines
            .slice(lineIndex + 1)
            .some((raw) => raw.replace(TIME_PREFIX, '').startsWith('K;'));
          const awards = await awardMatchBonus(matchTally, {
            matchDurationSec: duration,
            map: currentMap,
            gametype: currentGametype,
            server,
            minTimeEpoch: killsRemainInPass ? passEpoch : passEpoch + 1,
          });
          if (awards.length > 0) {
            result.matchBonusEventsSynced += awards.length;
            const nickOf = (guid: string): string => matchTally.get(guid)?.name || guid;
            console.log(
              `[GameLog] Bonus top-3 partida: ${awards
                .map((award) => `${award.position}º ${nickOf(award.guid)} +${award.delta}`)
                .join(', ')}`,
            );
          }
        } catch (err) {
          result.warnings.push(`[GameLog] bonus top-3 no aplicado: ${errMessage(err)}`);
        }
        matchStartSec = null;
        matchTally = new Map();
      } else if (event.kind === 'connect') {
        // BOTS (2026-11-11): cero persistencia — sin Player/Session/alias/
        // auto-link/alertas (esos servicios ya se defienden solos; aquí ni los
        // invocamos). La línea SÍ cuenta como parseada (telemetría estable).
        if (!isBotGuid(event.guid)) {
          const { opened } = await applyConnect(event, server, currentMap, currentGametype, now);
          if (opened) result.sessionsOpened += 1;
          result.playersSynced += 1;
          noteHuman(event.guid, event.name); // participante humano de la partida (bonus top-3)
          // Historial de alias: cada J cuenta una aparición del (guid, name).
          if (await upsertPlayerAlias({ guid: event.guid, name: event.name, server, when: now })) {
            result.aliasesUpserted += 1;
          }
          // AUTO-LINK por sesión (sustituye el polling del launcher): nick
          // registrado SIN guids + PlaySession ACTIVA → AccountLink directo.
          // Sin sesión activa (o guid ya vinculado) → alerta anti-impersonación
          // como siempre. Un auto-link con éxito deja la alerta sin sentido (el
          // guid pasa a ser del dueño) → no se reporta.
          const autoLink = await tryAutoLinkBySession({ guid: event.guid, name: event.name, when: now });
          if (autoLink.outcome === 'linked') {
            result.autoLinksSynced += 1;
          } else {
            // Anti-impersonación: ¿el cleanName es un nick REGISTRADO de otro user?
            const alert = await reportIdentityAlert({ guid: event.guid, name: event.name, when: now });
            if (alert.outcome !== 'skipped') result.identityAlertsUpserted += 1;
          }
          touched.add(event.guid);
        }
      } else if (event.kind === 'disconnect') {
        // BOTS: sin Player row ni Session → nada que actualizar/cerrar.
        if (!isBotGuid(event.guid)) {
          await prisma.player.updateMany({
            where: { guid: event.guid },
            data: { lastConnection: now, ...(server !== null ? { lastServer: server } : {}) },
          });
          if (await applyDisconnect(event.guid, now)) result.sessionsClosed += 1;
          touched.add(event.guid);
        }
      } else if (event.kind === 'damage') {
        // D: no letal → solo agregados de daño (NO crea evento ni kill/death).
        // Semántica de esta build: receiver (1er bloque) recibe, dealer (2º) inflige.
        // BOTS (2026-11-11): el bot NO acumula daño (sin Player); el HUMANO del
        // evento sí (damageDealt contra bots / damageTaken recibido de bots).
        const self = event.dealerGuid === null || event.dealerGuid === event.receiverGuid;
        const dealerIsHuman = !self && !isBotGuid(event.dealerGuid!);
        const receiverIsHuman = !isBotGuid(event.receiverGuid);
        if (self) {
          if (receiverIsHuman) {
            await incrementPlayer(event.receiverGuid, { damageTaken: { increment: event.damage } }, now);
            touched.add(event.receiverGuid);
          }
        } else {
          if (dealerIsHuman) {
            await incrementPlayer(event.dealerGuid!, { damageDealt: { increment: event.damage } }, now);
            touched.add(event.dealerGuid!);
          }
          if (receiverIsHuman) {
            await incrementPlayer(event.receiverGuid, { damageTaken: { increment: event.damage } }, now);
            touched.add(event.receiverGuid);
          }
        }
        // playersSynced cuenta SOLO humanos tocados (bots: 0 por guard).
        result.playersSynced += self
          ? (receiverIsHuman ? 1 : 0)
          : (dealerIsHuman ? 1 : 0) + (receiverIsHuman ? 1 : 0);
      } else {
        // K: kill (semántica de ESTA BUILD: primer bloque = VÍCTIMA).
        //  - victimGuid (1er bloque) SIEMPRE tiene guid: es quien muere.
        //  - killerGuid (2º bloque): world (null) o == victimGuid (suicidio)
        //    → death + daño recibido de la víctima + KillEvent world/suicidio
        //    (targetGuid='') SOLO si es humano: el skill aplica WORLD_LOSS.
        // BOTS (2026-11-11): el bot NO tiene Player row (cero counters/alias);
        // el HUMANO del evento conserva TODA su progresión: kills vs bots,
        // deaths contra bots, daño, racha y ELO decayado (skill stream). El
        // KillEvent se guarda SIEMPRE que haya ≥1 humano involucrado, con los
        // nombres DENORMALIZADOS del log (originName/targetName) para que el
        // feed muestre "mataste a Lunarion" sin Player row del bot. Una kill
        // bot-vs-bot NO genera evento (no hay humano que acreditar).
        const isSuicide = event.killerGuid !== null && event.killerGuid === event.victimGuid;
        const killerGuid = isSuicide ? null : event.killerGuid;
        const victimGuid = event.victimGuid;
        const headshot = event.hitloc !== null && HEADSHOT_HITLOCS.has(event.hitloc.toLowerCase());
        const killerIsBot = killerGuid !== null && isBotGuid(killerGuid);
        const victimIsBot = isBotGuid(victimGuid);

        // Tally del bonus top-3: kills del killer humano, deaths del humano
        // que muere (los bots NUNCA entran al tally: noteHuman los filtra).
        if (killerGuid !== null) noteHuman(killerGuid, event.killerName);
        noteHuman(victimGuid, event.victimName);
        if (killerGuid !== null && !isBotGuid(killerGuid)) {
          matchTally.get(killerGuid)!.kills += 1;
        }
        if (!isBotGuid(victimGuid)) {
          matchTally.get(victimGuid)!.deaths += 1;
        }

        if (killerGuid !== null) {
          // Kill real: kills/headshot/daño para el KILLER humano; death para
          // la VÍCTIMA humana (cada side pasa por su guard de bot).
          if (!killerIsBot) {
            await incrementPlayer(killerGuid, { kills: { increment: 1 }, damageDealt: { increment: event.damage } }, now);
            if (event.isTeamkill) {
              await incrementPlayer(killerGuid, { teamkills: { increment: 1 } }, now);
            }
            if (headshot) {
              await incrementPlayer(killerGuid, { headshots: { increment: 1 } }, now);
            }
          }
          if (!victimIsBot) {
            await incrementPlayer(victimGuid, { deaths: { increment: 1 }, damageTaken: { increment: event.damage } }, now);
          }
          // KillEvent guarda la semántica stock de la DB: origin = KILLER,
          // target = VÍCTIMA (skill ELO, streaks, armas y perfiles consumen ese
          // orden). SOLO con ≥1 humano: las kills bot-vs-bot no acreditan a
          // nadie (y el skill no debe crear Player de bots para ellas).
          if (!killerIsBot || !victimIsBot) {
            await prisma.killEvent.create({
              data: {
                originGuid: killerGuid,
                targetGuid: victimGuid,
                // Nombres DENORMALIZADOS del log (siempre que el log los traiga,
                // humano o bot): el feed del perfil los usa sin Player row.
                originName: event.killerName,
                targetName: event.victimName,
                isKill: true,
                damage: event.damage,
                weapon: event.weapon,
                mod: event.mod,
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
          }
          // Alias por K: SOLO los participantes HUMANOS (bot: sin alias ni Player).
          if (!killerIsBot && (await upsertPlayerAlias({ guid: killerGuid, name: event.killerName ?? '', server, when: now }))) {
            result.aliasesUpserted += 1;
          }
          if (!victimIsBot && (await upsertPlayerAlias({ guid: victimGuid, name: event.victimName ?? '', server, when: now }))) {
            result.aliasesUpserted += 1;
          }
          if (!killerIsBot) touched.add(killerGuid);
          if (!victimIsBot) touched.add(victimGuid);
          result.playersSynced += (killerIsBot ? 0 : 1) + (victimIsBot ? 0 : 1);
        } else {
          // world / suicidio: el que muere es la VÍCTIMA (1er bloque); sin atacante.
          // BOTS: sin counters ni evento (el guard de incrementPlayer ya no crea nada).
          await incrementPlayer(victimGuid, { deaths: { increment: 1 }, damageTaken: { increment: event.damage } }, now);
          // Alias de la víctima humana; el "killer" world no tiene guid → skip.
          if (!victimIsBot && (await upsertPlayerAlias({ guid: victimGuid, name: event.victimName ?? '', server, when: now }))) {
            result.aliasesUpserted += 1;
          }
          // KILL EVENT world/suicidio (2026-11-08): originGuid = víctima y
          // targetGuid = '' (marcador canónico de "sin atacante/víctima
          // distinta"). El motor skill (skill.service) detecta targetGuid ''
          // → aplica la pérdida plana SKILL.WORLD_LOSS=4 al que muere, sin
          // tocar nada de skill/. SOLO HUMANOS: un bot que muere por
          // world/suicidio no genera NADA (desde 2026-11-11 ni counters).
          if (!victimIsBot) {
            await prisma.killEvent.create({
              data: {
                originGuid: victimGuid,
                targetGuid: '', // world/suicidio: skill aplica WORLD_LOSS plano
                // Denormalizados: en world/suicidio el que muere es el propio
                // origin (el nombre de la víctima, que el log SÍ trae).
                originName: event.victimName,
                targetName: event.victimName,
                isKill: true,
                damage: event.damage,
                weapon: event.weapon,
                mod: event.mod,
                hitloc: event.hitloc,
                headshot: false, // sin atacante no hay headshot
                isTeamkill: false, // world/suicidio nunca es teamkill
                map: currentMap,
                gametype: currentGametype,
                server,
                time: now,
                timeEpoch: Math.trunc(now.getTime() / 1000),
              },
            });
            result.killEventsSynced += 1;
            touched.add(victimGuid);
            result.playersSynced += 1;
          }
        }
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
