/**
 * INGESTA LIVE de stats del server dedicado IW4x + DETECTOR unlockstats.
 *
 * Fuente: el script GSC server-side `apps/api/gsc/iw4x-ranking.gsc` (instalado
 * en `<raíz del juego>/userraw/scripts/`) lee con `GetStat` (SV_GetClientStat,
 * mismos índices que src/lib/save-parser/parse-stat-blob.ts) las stats
 * DESCIFRADAS de cada cliente conectado y REESCRIBE cada ~60s un snapshot en
 * `userraw/scriptdata/iw4x-ranking.json` (FileWrite relativo a userraw):
 *
 *   #iw4x-ranking v1
 *   <guid>;<xp>;<prestige>;<kills>;<deaths>;<headshots>;<timePlayed>;<name>
 *
 * Este servicio:
 *  - Lee el snapshot cada LIVE_STATS_INTERVAL_MS (default 30s; archivo
 *    ausente/corrupto → silencioso, nunca lanza).
 *  - Actualiza el Player de cada guid visto: name + saveXp/saveLevel
 *    (levelFromXp)/savePrestige/saveParsedAt → el LVL EN VIVO aparece en
 *    perfil/leaderboard sin depender del blob cifrado. La fuente del "save"
 *    pasa a ser "cloud save O live del server, la más reciente" (saveParsedAt).
 *  - DETECTOR unlockstats (conservador: mejor saltarse un tramposo que
 *    acusar a un legítimo — reglas EXACTAS en detectUnlockAnomaly y en
 *    docs/SETUP.md §4H):
 *      · salto: nuevoXp - xpPrevio > LIVE_XP_JUMP_LIMIT (default 500000)
 *        dentro de LIVE_XP_JUMP_WINDOW_MS (default 10 min) → suspicious
 *        'xp-jump'. SEÑAL PRINCIPAL (temporal: nadie gana 500k XP en 10 min).
 *      · primer avistamiento SIN HISTORIAL con xp == 2516000 exacto
 *        (L70 completo) → suspicious 'max-xp-first-sighting' (solo alerta:
 *        un legacy puede estar legítimamente en max; por eso NO flag si el
 *        Player ya tenía saveParsedAt/saveXp de cloud o de un ciclo previo).
 *      · XP que BAJA → nunca suspicious (reset de prestigio legítimo).
 *      · valores fuera de sanity → línea ignorada silenciosamente (parser).
 *  - ACCIÓN: Setting `anti_unlock_autokick` (default FALSE = solo alerta).
 *    Con TRUE: tell + clientkick al guid suspicious (bots SIEMPRE exentos).
 *
 * El estado del detector (xp previo por guid) vive EN MEMORIA del proceso:
 * al reiniciar la API, la primera sighting se compara contra la columna
 * saveXp del Player si existe (historial de cloud/ciclo previo), nunca contra
 * cero. Sin commits de DB para el estado del detector.
 */
import { readFileSync } from 'node:fs';
import { env } from '../config/env.js';
import { errMessage } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { LEVEL_XP_TABLE, levelFromXp } from '../lib/save-parser/parse-stat-blob.js';
import { isBotGuid } from './alias.service.js';
import {
  getSharedRcon,
  hexGuidToDecimal,
  isRconConfigured,
  stripColorCodes,
} from '../lib/rcon/iw4x-rcon.js';
import { getAntiUnlockAutokick } from './setting.service.js';

/** XP máximo de la tabla de rangos (2516000 = L70 completo, listo para prestigio). */
export const UNLOCKSTATS_MAX_XP: number = LEVEL_XP_TABLE[LEVEL_XP_TABLE.length - 1] ?? 2_516_000;

/** Límite de XP de career por campo (cap defensivo, igual que el parser). */
const CAREER_CAP = 10_000_000;

// ── Parser del snapshot (tolerante; exportado para tests) ───────────────────

export interface LiveStatEntry {
  /** Guid normalizado en DECIMAL (formato Player.guid). Bots nunca llegan aquí. */
  guid: string;
  /** Nombre RAW (puede traer códigos de color ^X). */
  name: string;
  xp: number;
  prestige: number;
  kills: number;
  deaths: number;
  headshots: number;
  /** Minutos totales (índice 2324). */
  timePlayed: number;
}

/** Sanity por campo: TODO el campo numérico debe ser un entero en rango. */
function saneInt(raw: string, min: number, max: number): number | null {
  if (!/^-?\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) return null;
  return value;
}

/**
 * Normaliza el guid del snapshot: decimal tal cual, HEX de 8..16 → decimal.
 * "botN" se rechaza ANTES (case-insensitive), igual que el rango 0xb07….
 */
function normalizeGuid(raw: string): string | null {
  const guid = raw.trim();
  if (guid === '' || /^bot/i.test(guid)) return null;
  if (/^\d{1,20}$/.test(guid)) return guid;
  const asDecimal = hexGuidToDecimal(guid);
  if (asDecimal === null) return null;
  if (isBotGuid(asDecimal)) return null; // rango dedicado a bots (defensa en profundidad)
  return asDecimal;
}

/**
 * Parsea el contenido crudo del snapshot. Tolerante: líneas vacías y `#`
 * comentarios se ignoran; el name es TODO lo que sigue al 7mo ';' (los nicks
 * pueden contener ';'). Una línea con CUALQUIER campo fuera de sanity se
 * descarga ENTERA (conservador: nunca se actualiza a medias).
 */
export function parseLiveStatsText(text: string): LiveStatEntry[] {
  const entries: LiveStatEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(';');
    // mínimo: guid + 6 números + name (name puede venir con ';' extra)
    if (parts.length < 8) continue;

    const guid = normalizeGuid(parts[0] ?? '');
    if (guid === null) continue;

    const xp = saneInt(parts[1] ?? '', 0, UNLOCKSTATS_MAX_XP);
    const prestige = saneInt(parts[2] ?? '', 0, 10);
    const kills = saneInt(parts[3] ?? '', 0, CAREER_CAP);
    const deaths = saneInt(parts[4] ?? '', 0, CAREER_CAP);
    const headshots = saneInt(parts[5] ?? '', 0, CAREER_CAP);
    const timePlayed = saneInt(parts[6] ?? '', 0, CAREER_CAP);
    if (xp === null || prestige === null || kills === null || deaths === null || headshots === null || timePlayed === null) {
      continue; // cualquier campo insane → línea entera fuera (silencioso)
    }

    const name = parts.slice(7).join(';').trim();
    if (name === '') continue;

    entries.push({ guid, name, xp, prestige, kills, deaths, headshots, timePlayed });
  }
  return entries;
}

// ── Detector unlockstats (reglas EXACTAS; exportado para tests) ─────────────

export interface UnlockSighting {
  /** XP reportado en ESTE ciclo. */
  xp: number;
  /** Epoch ms de la sighting previa (null = primera sin historial). */
  previousXp: number | null;
  /** Delta xp - previousXp (null si no hay previo). */
  delta: number | null;
  /** true si ESTE ciclo disparó una detección nueva. */
  suspicious: boolean;
  reason: 'xp-jump' | 'max-xp-first-sighting' | null;
  /** true si el guid quedó marcado como suspicious (detección vigente). */
  flagged: boolean;
}

export interface UnlockDetectorOptions {
  now?: number;
  /** Salto mínimo (XP) para sospechar dentro de la ventana. Default env (500000). */
  jumpLimit?: number;
  /** Ventana temporal del salto en ms. Default env (600000 = 10 min). */
  windowMs?: number;
}

interface TrackState {
  xp: number;
  seenAt: number;
  flaggedAt: number | null;
  reason: 'xp-jump' | 'max-xp-first-sighting' | null;
}

/** Estado EN MEMORIA por guid (xp previo + flag vigente). */
const tracked = new Map<string, TrackState>();

/** Test helper: limpia el estado en memoria + el snapshot (determinismo). */
export function resetLiveStatsState(): void {
  tracked.clear();
  lastSnapshot = null;
  lastTickResult = null;
}

/**
 * Reglas EXACTAS para UNA sighting (prev = sighting previa si la hay):
 *  1. prev == null (primera vez SIN historial):
 *     · xp === 2516000 exacto → suspicious 'max-xp-first-sighting'
 *       (instant-max solo ALERTA: un legacy legitimo puede llegar al max
 *       entre ciclos; por eso con historial en DB NUNCA aplica).
 *  2. prev != null y elapsed = now - prev.seenAt:
 *     · delta = xp - prev.xp
 *       · delta > jumpLimit && elapsed <= windowMs → suspicious 'xp-jump'
 *         (SEÑAL PRINCIPAL: imposible ganar >500k XP legítimamente en 10 min).
 *       · delta <= 0 → NUNCA suspicious (prestige resetea XP a 0).
 *  3. Un flag NUEVO solo se dispara una vez por transición: sighting siguiente
 *     sin salto nuevo no re-acusa (evita bucles de kick contra el mismo guid).
 */
export function detectUnlockAnomaly(entry: LiveStatEntry, prev: TrackState | null, options: UnlockDetectorOptions = {}): UnlockSighting {
  const now = options.now ?? Date.now();
  const jumpLimit = options.jumpLimit ?? env.liveXpJumpLimit;
  const windowMs = options.windowMs ?? env.liveXpJumpWindowMs;

  const previousXp = prev !== null ? prev.xp : null;
  const delta = previousXp !== null ? entry.xp - previousXp : null;

  let fires = false;
  let reason: UnlockSighting['reason'] = null;
  if (prev === null) {
    if (entry.xp === UNLOCKSTATS_MAX_XP) {
      fires = true;
      reason = 'max-xp-first-sighting';
    }
  } else if (delta !== null && delta > jumpLimit && now - prev.seenAt <= windowMs) {
    fires = true;
    reason = 'xp-jump';
  }

  return { xp: entry.xp, previousXp, delta, suspicious: fires, reason, flagged: fires };
}

// ── Snapshot expuesto por el endpoint ───────────────────────────────────────

export interface LivePlayerView {
  guid: string;
  name: string;
  xp: number;
  level: number | null;
  prestige: number;
  kills: number;
  deaths: number;
  headshots: number;
  timePlayed: number;
  suspicious: boolean;
  reason: string | null;
  previousXp: number | null;
  delta: number | null;
}

export interface LiveStatsSnapshot {
  file: string;
  readAt: string;
  players: LivePlayerView[];
}

export interface LiveStatsTickResult {
  /** Ruta del archivo configurada (null = ingesta desactivada). */
  file: string | null;
  /** true si el archivo existía y se leyó. */
  read: boolean;
  /** Entradas válidas parseadas. */
  entries: number;
  /** Filas Player upsertadas (nuevas o actualizadas). */
  playersUpdated: number;
  /** Detecciones NUEVAS de este ciclo. */
  suspicious: number;
  /** Kicks enviados (solo con anti_unlock_autokick ON + rcon). */
  kicked: number;
}

let lastSnapshot: LiveStatsSnapshot | null = null;
let lastTickResult: LiveStatsTickResult | null = null;

/** Último snapshot parseado (para el panel). null = nunca se leyó un archivo. */
export function getLiveStatsSnapshot(): LiveStatsSnapshot | null {
  return lastSnapshot;
}

/** Resultado del último tick (diagnóstico). */
export function getLiveStatsLastTick(): LiveStatsTickResult | null {
  return lastTickResult;
}

/**
 * Shape del endpoint GET /api/admin/server/livestats. Sin snapshot aún
 * (ingesta desactivada o archivo nunca visto) → players vacío, no lanza.
 */
export function getLiveStatsOverview(): { file: string | null; updatedAt: string | null; players: LivePlayerView[] } {
  const snapshot = getLiveStatsSnapshot();
  if (snapshot === null) return { file: env.liveStatsFile ?? null, updatedAt: null, players: [] };
  return { file: snapshot.file, updatedAt: snapshot.readAt, players: snapshot.players };
}

// ── Kick anti-unlock (mismo patrón que el enforcer: tell + clientkick) ──────

/** Busca el cid de un guid decimal conectado (bots/conectando excluidos). */
async function findCidByGuid(guid: string): Promise<number | null> {
  const status = await getSharedRcon().status();
  for (const slot of status.players) {
    if (slot.connecting || slot.isBot) continue;
    const slotGuid = hexGuidToDecimal(slot.guid);
    if (slotGuid === guid) return slot.cid;
  }
  return null;
}

async function kickSuspicious(entry: LiveStatEntry, name: string): Promise<boolean> {
  if (!isRconConfigured()) return false;
  try {
    const cid = await findCidByGuid(entry.guid);
    if (cid === null) return false; // ya se fue: nada que kickear
    await getSharedRcon().tell(cid, env.antiUnlockKickMsg);
    await getSharedRcon().clientkick(cid);
    console.log(`[livestats] anti-unlock: "${stripColorCodes(entry.name)}" (guid=${entry.guid}, cid=${cid}, xp=${entry.xp}) kickeado: stats modificados detectados.`);
    return true;
  } catch (err) {
    console.warn(`[livestats] anti-unlock: fallo al kickear guid=${entry.guid} (${name}): ${errMessage(err)}`);
    return false;
  }
}

// ── Un ciclo de ingesta ─────────────────────────────────────────────────────

/**
 * Un tick: lee el snapshot, actualiza Players y corre el detector. NUNCA
 * lanza: cualquier error (archivo, DB, rcon) queda logueado y el tick
 * devuelve contadores en 0. `options.file` inyectable para tests; default
 * env LIVE_STATS_FILE (null → no-op).
 */
export async function runLiveStatsTick(options: { now?: number; file?: string } = {}): Promise<LiveStatsTickResult> {
  const file = options.file ?? env.liveStatsFile ?? null;
  const result: LiveStatsTickResult = { file, read: false, entries: 0, playersUpdated: 0, suspicious: 0, kicked: 0 };
  lastTickResult = result;
  if (!file) return result;

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return result; // archivo ausente/ilegible → silencioso
  }
  result.read = true;

  const now = options.now ?? Date.now();
  const entries = parseLiveStatsText(text);
  result.entries = entries.length;

  const autokick = await getAntiUnlockAutokick();
  const views: LivePlayerView[] = [];

  for (const entry of entries) {
    const prev = tracked.get(entry.guid) ?? null;

    // Historial previo: la sighting comparada contra la columna save* del
    // Player (cloud save o ciclo previo al restart) cuenta COMO historial.
    let effectivePrev = prev;
    if (effectivePrev === null) {
      const player = await prisma.player.findUnique({
        where: { guid: entry.guid },
        select: { saveXp: true, saveParsedAt: true },
      });
      if (player?.saveXp !== null && player?.saveXp !== undefined && player.saveParsedAt !== null) {
        effectivePrev = { xp: player.saveXp, seenAt: player.saveParsedAt.getTime(), flaggedAt: null, reason: null };
      }
    }

    const sighting = detectUnlockAnomaly(entry, effectivePrev, { now });

    // Persistencia: upsert ÚNICO. NUNCA se tocan kills/deaths/skill (esos son
    // agregados del ranking por log) ni timePlayed/connections: solo name +
    // progresión save*. Aplica a guids CON o SIN AccountLink (el perfil y el
    // leaderboard exponen save* de cualquier player; la fuente más reciente
    // gana por saveParsedAt).
    try {
      await prisma.player.upsert({
        where: { guid: entry.guid },
        create: {
          guid: entry.guid,
          name: entry.name,
          saveXp: entry.xp,
          saveLevel: levelFromXp(entry.xp),
          savePrestige: entry.prestige,
          saveParsedAt: new Date(now),
        },
        update: {
          name: entry.name,
          saveXp: entry.xp,
          saveLevel: levelFromXp(entry.xp),
          savePrestige: entry.prestige,
          saveParsedAt: new Date(now),
        },
      });
      result.playersUpdated += 1;
    } catch (err) {
      console.warn(`[livestats] upsert falló para guid=${entry.guid}: ${errMessage(err)}`);
    }

    if (sighting.suspicious) {
      result.suspicious += 1;
      console.warn(
        `[livestats] SUSPICIOUS guid=${entry.guid} "${stripColorCodes(entry.name)}" xp=${entry.xp} (prev=${sighting.previousXp ?? 'n/a'}, delta=${sighting.delta ?? 'n/a'}) motivo=${sighting.reason}`,
      );
      if (autokick) {
        const kicked = await kickSuspicious(entry, entry.name);
        if (kicked) result.kicked += 1;
      }
    }

    // Estado del detector SIEMPRE actualizado (sighting nueva o repetida).
    const state = tracked.get(entry.guid) ?? { xp: entry.xp, seenAt: now, flaggedAt: null, reason: null };
    state.xp = entry.xp;
    state.seenAt = now;
    if (sighting.suspicious) {
      state.flaggedAt = now;
      state.reason = sighting.reason;
    }
    tracked.set(entry.guid, state);

    views.push({
      guid: entry.guid,
      name: entry.name,
      xp: entry.xp,
      level: levelFromXp(entry.xp),
      prestige: entry.prestige,
      kills: entry.kills,
      deaths: entry.deaths,
      headshots: entry.headshots,
      timePlayed: entry.timePlayed,
      suspicious: state.flaggedAt !== null, // flag VIGENTE (no solo el de este ciclo)
      reason: state.reason,
      previousXp: sighting.previousXp,
      delta: sighting.delta,
    });
  }

  lastSnapshot = { file, readAt: new Date(now).toISOString(), players: views };
  return result;
}

// ── Scheduler propio (independiente del enforcer: no requiere RCON) ─────────

let liveRunning = false;

/**
 * Arranca el scheduler de ingesta live. Guards: NODE_ENV != test y
 * LIVE_STATS_FILE configurado. Devuelve el timer (o null si no arrancó).
 */
export function startLiveStatsScheduler(intervalMs?: number): NodeJS.Timeout | null {
  if (process.env.NODE_ENV === 'test') return null;
  if (!env.liveStatsFile) {
    console.log('[livestats] ingesta live desactivada: falta LIVE_STATS_FILE.');
    return null;
  }
  const interval = intervalMs ?? env.liveStatsIntervalMs;
  const safeInterval = Number.isFinite(interval) && interval >= 1000 ? interval : 30_000;
  console.log(`[livestats] activo cada ${safeInterval}ms sobre ${env.liveStatsFile}.`);
  const timer = setInterval(() => {
    void (async () => {
      if (liveRunning) return;
      liveRunning = true;
      try {
        await runLiveStatsTick();
      } finally {
        liveRunning = false;
      }
    })();
  }, safeInterval);
  timer.unref?.(); // no retiene el proceso vivo
  return timer;
}

export function stopLiveStatsScheduler(timer: NodeJS.Timeout | null): void {
  if (timer) clearInterval(timer);
}
