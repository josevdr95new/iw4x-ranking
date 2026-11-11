/**
 * CONTROL DE MAPAS del server dedicado IW4x por RCON (panel admin).
 *
 *  - Catálogo ESTÁTICO de MW2/IW4x: los 16 mapas base + 10 DLC (Stimulus +
 *    Resurgence). Ids mp_ verificados contra:
 *      · el módulo bots del cliente (waypoints de iw4_bot_warfare, 24/26),
 *      · rotaciones reales de servers IW4x (ids mp_brecourt=Wasteland,
 *        mp_checkpoint=Karachi, mp_abandon=Bailout, mp_fuel2=Fuel, etc.),
 *      · los fixtures capturados EN VIVO del server del ranking (mp_strike,
 *        mp_terminal, mp_rust, mp_crash).
 *  - `current` sale SIEMPRE del status EN VIVO (línea `map:`).
 *  - Escrituras (map/map_rotate/fast_restart): UN intento, sin retry (mismo
 *    criterio que la moderación: un cambio de mapa duplicado es real).
 *  - VERIFICACIÓN POST-FALLO (fix 502 falso negativo): al ejecutar `map <id>`
 *    el server cierra la partida (ShutdownGame) y puede NO responder RCON a
 *    tiempo aunque el cambio SÍ aplique (verificado en producción: el dueño
 *    cambió Terminal→Rust, la API tiró 502 "no respondió" y el mapa CAMBIO).
 *    Si la escritura falla, se hace polling de `status` (ignorando polls que
 *    fallen: durante la carga el server puede seguir mudo) durante
 *    RCON_MAP_VERIFY_TIMEOUT_MS (default 45s, cada RCON_MAP_VERIFY_INTERVAL_MS,
 *    default 4s). Confirma el mapa pedido (o, en map_rotate, un mapa DISTINTO
 *    al anterior) → cambio VERIFICADO; si el plazo vence → AHORA SÍ error
 *    original (toAppError → 502 MODERATION_UNREACHABLE).
 *  - MULTI-SALA: los comandos de mapas van por getSharedRcon() (server único
 *    legacy, RCON_HOST/RCON_PORT — este servicio NO itera RCON_SALAS), así que
 *    la verificación hace polling del MISMO cliente que recibió el comando:
 *    es exacto por construcción (1 comando → 1 target → 1 status).
 *  - Errores rcon → mismo manejo que la moderación: 503 MODERATION_NOT_CONFIGURED
 *    si falta RCON_PASSWORD, 502 MODERATION_UNREACHABLE si el server no responde.
 */
import { AppError, Errors } from '../lib/errors.js';
import { getSharedRcon, isRconConfigured } from '../lib/rcon/iw4x-rcon.js';
import { toAppError } from './moderation.service.js';

export type MapGroup = 'base' | 'dlc';

export interface MapCatalogEntry {
  id: string;
  name: string;
  group: MapGroup;
}

/** Catálogo MW2/IW4x: 16 base + 10 DLC (26 en total). Display en español/neutro. */
export const MW2_MAP_CATALOG: MapCatalogEntry[] = [
  // ── Base (16) ──────────────────────────────────────────────────────────────
  { id: 'mp_afghan', name: 'Afganistán', group: 'base' },
  { id: 'mp_derail', name: 'Derail', group: 'base' },
  { id: 'mp_estate', name: 'Estate', group: 'base' },
  { id: 'mp_favela', name: 'Favela', group: 'base' },
  { id: 'mp_highrise', name: 'Highrise', group: 'base' },
  { id: 'mp_invasion', name: 'Invasion', group: 'base' },
  { id: 'mp_checkpoint', name: 'Karachi', group: 'base' }, // = mp_checkpoint (no wasteland)
  { id: 'mp_quarry', name: 'Quarry', group: 'base' },
  { id: 'mp_rundown', name: 'Rundown', group: 'base' },
  { id: 'mp_rust', name: 'Rust', group: 'base' },
  { id: 'mp_subbase', name: 'Sub Base', group: 'base' },
  { id: 'mp_terminal', name: 'Terminal', group: 'base' },
  { id: 'mp_underpass', name: 'Underpass', group: 'base' },
  { id: 'mp_brecourt', name: 'Wasteland', group: 'base' }, // Wasteland = mp_brecourt (verificado)
  { id: 'mp_compact', name: 'Scrapyard', group: 'base' },
  { id: 'mp_nightshift', name: 'Skidrow', group: 'base' },
  // ── DLC (10): Stimulus (5) + Resurgence (5) ────────────────────────────────
  { id: 'mp_abandon', name: 'Bailout', group: 'dlc' }, // Bailout = mp_abandon
  { id: 'mp_crash', name: 'Crash', group: 'dlc' },
  { id: 'mp_salvage', name: 'Salvage', group: 'dlc' },
  { id: 'mp_overgrown', name: 'Overgrown', group: 'dlc' },
  { id: 'mp_storm', name: 'Storm', group: 'dlc' },
  { id: 'mp_carnival', name: 'Carnival', group: 'dlc' },
  { id: 'mp_trailerpark', name: 'Trailer Park', group: 'dlc' },
  { id: 'mp_fuel2', name: 'Fuel', group: 'dlc' }, // Fuel = mp_fuel2 (no mp_fuel)
  { id: 'mp_strike', name: 'Strike', group: 'dlc' },
  { id: 'mp_vacant', name: 'Vacant', group: 'dlc' },
];

const CATALOG_BY_ID = new Map(MW2_MAP_CATALOG.map((entry) => [entry.id, entry] as const));

/** true si el id está en el catálogo (normaliza lowercase). */
export function isKnownMap(mapId: string): boolean {
  return CATALOG_BY_ID.has(mapId.trim().toLowerCase());
}

export interface MapsOverview {
  /** Mapa EN VIVO del server (status `map:`); null si el server no lo reporta. */
  current: string | null;
  maps: MapCatalogEntry[];
}

/** GET /api/admin/server/maps: catálogo + mapa actual EN VIVO. */
export async function getMapsOverview(): Promise<MapsOverview> {
  if (!isRconConfigured()) {
    throw new AppError(
      503,
      'MODERATION_NOT_CONFIGURED',
      'La moderación nativa no está configurada: define RCON_PASSWORD.',
    );
  }
  try {
    const status = await getSharedRcon().status();
    return { current: status.map, maps: MW2_MAP_CATALOG };
  } catch (err) {
    throw toAppError(err);
  }
}

export interface MapChangeResult {
  sent: true;
  map: string;
  /** true cuando el cambio quedó confirmado (ACK directo o visto en status). */
  verified: boolean;
  note: string;
}

// ── Verificación post-fallo (polling de status) ─────────────────────────────

/** Lee un entero ms de la env (se lee EN CADA llamada, patrón del proyecto). */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Ventana total de verificación tras un write fallido (default 45s). */
function verifyTimeoutMs(): number {
  return envMs('RCON_MAP_VERIFY_TIMEOUT_MS', 45_000);
}

/** Intervalo entre polls de status (default 4s). */
function verifyIntervalMs(): number {
  return envMs('RCON_MAP_VERIFY_INTERVAL_MS', 4_000);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polling de `status` hasta que el server reporte `map: <mapId>` (o venza el
 * plazo). Los polls que fallen se IGNORAN (durante el cambio de mapa el server
 * también puede no responder RCON) — la única señal de éxito es el mapname
 * pedido apareciendo EN VIVO. true = verificado.
 */
async function pollUntilMap(mapId: string): Promise<boolean> {
  const deadline = Date.now() + verifyTimeoutMs();
  while (Date.now() < deadline) {
    await sleep(Math.max(0, Math.min(verifyIntervalMs(), deadline - Date.now())));
    try {
      const status = await getSharedRcon().status();
      if (status.map !== null && status.map.trim().toLowerCase() === mapId) return true;
    } catch {
      // Poll fallido: el server sigue cargando (o mudo). Se ignora y se sigue.
    }
  }
  return false;
}

/** Mapa actual EN VIVO (null si el status falla o no reporta `map:`). */
async function currentMapOrNull(): Promise<string | null> {
  try {
    return (await getSharedRcon().status()).map;
  } catch {
    return null;
  }
}

/**
 * Polling de `status` hasta que el mapa actual sea DISTINTO al anterior
 * (para map_rotate, cuyo destino no se conoce de antemano). Misma tolerancia
 * a polls fallidos que pollUntilMap.
 */
async function pollUntilMapChanged(previousMap: string): Promise<boolean> {
  const deadline = Date.now() + verifyTimeoutMs();
  const previous = previousMap.trim().toLowerCase();
  while (Date.now() < deadline) {
    await sleep(Math.max(0, Math.min(verifyIntervalMs(), deadline - Date.now())));
    try {
      const status = await getSharedRcon().status();
      if (status.map !== null && status.map.trim().toLowerCase() !== previous) return true;
    } catch {
      // Poll fallido: se ignora y se sigue hasta el plazo.
    }
  }
  return false;
}

/**
 * POST /api/admin/server/map {map}: valida contra el catálogo (desconocido →
 * 400) y envía `map <id>` por rcon (1 intento). El server cierra la partida
 * para cargar el mapa y puede NO responder RCON a tiempo aunque el cambio SÍ
 * aplique (502 falso negativo visto en producción): si el write falla se
 * verifica con polling de `status` (hasta 45s) antes de tirar el error.
 */
export async function changeMap(mapIdRaw: string): Promise<MapChangeResult> {
  const mapId = mapIdRaw.trim().toLowerCase();
  if (!isKnownMap(mapId)) {
    throw Errors.validation(
      `Mapa desconocido "${mapIdRaw}": no está en el catálogo MW2/IW4x (${MW2_MAP_CATALOG.length} mapas soportados).`,
    );
  }
  if (!isRconConfigured()) {
    throw new AppError(
      503,
      'MODERATION_NOT_CONFIGURED',
      'La moderación nativa no está configurada: define RCON_PASSWORD.',
    );
  }
  try {
    await getSharedRcon().map(mapId);
    // ACK directo: el server aceptó el comando y está cargando el mapa.
    return {
      sent: true,
      map: mapId,
      verified: true,
      note: 'Comando enviado y verificado. El server está cargando el mapa (el cambio tarda unos segundos en aplicarse: cierra la partida y carga el nuevo).',
    };
  } catch (sendErr) {
    // FALLO del write (típico: RconTimeoutError durante ShutdownGame). Antes
    // de dar 502 falso negativo: ¿el mapa pedido aparece EN VIVO?
    if (await pollUntilMap(mapId)) {
      return {
        sent: true,
        map: mapId,
        verified: true,
        note: 'Comando enviado y verificado por status: el server ya reporta el mapa nuevo y está cargando la partida (tarda unos segundos en completarse).',
      };
    }
    // Sin confirmación en el plazo: el error original manda (502/503 real).
    throw toAppError(sendErr);
  }
}

export interface RotateResult {
  sent: true;
  command: 'map_rotate' | 'fast_restart';
  note: string;
}

/** POST /api/admin/server/rotate → `map_rotate`. */
export async function rotateMap(): Promise<RotateResult> {
  if (!isRconConfigured()) {
    throw new AppError(
      503,
      'MODERATION_NOT_CONFIGURED',
      'La moderación nativa no está configurada: define RCON_PASSWORD.',
    );
  }
  // Mapa ANTERIOR al comando (best-effort): si el write falla, la verificación
  // compara el status EN VIVO contra este.
  const previous = await currentMapOrNull();
  try {
    await getSharedRcon().mapRotate();
    return {
      sent: true,
      command: 'map_rotate',
      note: 'Comando enviado. El server avanza al siguiente mapa de la rotación (tarda unos segundos).',
    };
  } catch (sendErr) {
    // Mismo patrón que changeMap: map_rotate cierra la partida y puede dejar
    // el RCON mudo aunque la rotación aplique. Sin mapa anterior capturado no
    // hay comparación posible → error original directo.
    if (previous !== null && (await pollUntilMapChanged(previous))) {
      return {
        sent: true,
        command: 'map_rotate',
        note: 'Comando enviado y verificado por status: el server reporta un mapa distinto al anterior (rotación aplicada, tarda unos segundos).',
      };
    }
    throw toAppError(sendErr);
  }
}

/** POST /api/admin/server/fast_restart → `fast_restart` (recarga el mapa actual sin cambio). */
export async function fastRestart(): Promise<RotateResult> {
  if (!isRconConfigured()) {
    throw new AppError(
      503,
      'MODERATION_NOT_CONFIGURED',
      'La moderación nativa no está configurada: define RCON_PASSWORD.',
    );
  }
  try {
    await getSharedRcon().fastRestart();
    return {
      sent: true,
      command: 'fast_restart',
      note: 'Comando enviado. El mapa actual se reinicia en segundos (mismo mapa, sin rotar).',
    };
  } catch (err) {
    throw toAppError(err);
  }
}
