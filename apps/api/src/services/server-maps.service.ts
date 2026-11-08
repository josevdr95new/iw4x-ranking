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
  note: string;
}

/**
 * POST /api/admin/server/map {map}: valida contra el catálogo (desconocido →
 * 400) y envía `map <id>` por rcon (1 intento). El cambio tarda unos segundos
 * (ShutdownGame + carga) — se documenta en la respuesta, no se espera.
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
    return {
      sent: true,
      map: mapId,
      note: 'Comando enviado. El cambio de mapa tarda unos segundos en aplicarse (el server cierra la partida y carga el nuevo mapa).',
    };
  } catch (err) {
    throw toAppError(err);
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
  try {
    await getSharedRcon().mapRotate();
    return {
      sent: true,
      command: 'map_rotate',
      note: 'Comando enviado. El server avanza al siguiente mapa de la rotación (tarda unos segundos).',
    };
  } catch (err) {
    throw toAppError(err);
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
