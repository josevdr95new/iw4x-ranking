/**
 * Parser del blob `iw4x.stat` (StructuredData de progresión IW4x).
 *
 * Fuentes verificadas: iw4x-client r5318 (Stats.cpp / StructuredData.cpp / Server.cpp).
 *
 * CONFIAZA DEL LAYOUT (ver docs/API.md "Parse del iw4x.stat"):
 * - ALTA: tamaño 8192, versión int32LE en [0..3] (155 normal, 159 tras migración de mods),
 *   fórmula índice→offset y bloque de clases (offset 3643 v155 / 3963 v159, 64 bytes × 15).
 * - MEDIA: índice de `experience` (2300), `prestige` (2325), career stats y los
 *   sub-offsets internos de cada clase. Todo campo MEDIA pasa por sanity checks:
 *   lo que no los pase se expone null (NUNCA se inventa un valor).
 * - Pendiente (protocolo del dueño `/dumpPlayerData`): correlacionar índices con
 *   valores reales para subir estos índices a confianza ALTA.
 */

/** Tamaño exacto del blob en las builds actuales. */
export const STAT_BLOB_SIZE = 8192;

/** Versiones del def que este parser entiende. >159 = blob del futuro → null. */
export const SUPPORTED_VERSIONS = [155, 159] as const;
export type StatBlobVersion = (typeof SUPPORTED_VERSIONS)[number];

/**
 * Fórmula índice→offset del StructuredData (confianza ALTA):
 * - índices 0..1999  → 1 byte en `4 + i`
 * - índices 2000..3497 → int32LE en `2004 + 4 * (i - 2000)`
 * Devuelve null si el índice está fuera del mapa (no inventar offsets).
 */
export function statIndexOffset(index: number): number | null {
  if (!Number.isInteger(index) || index < 0 || index > 3497) return null;
  if (index <= 1999) return 4 + index;
  return 2004 + 4 * (index - 2000);
}

/** Lee un int32LE del blob en el índice dado (solo región 2000..3497). null si fuera de rango. */
export function readStatInt32(buffer: Buffer, index: number): number | null {
  if (index < 2000 || index > 3497) return null;
  const offset = statIndexOffset(index);
  if (offset === null || offset + 4 > buffer.length) return null;
  return buffer.readInt32LE(offset);
}

/**
 * Tabla de XP ACUMULADO (confianza ALTA): TABLE[i] = XP para alcanzar el nivel
 * i+2 (umbrales L2..L70; la última entrada = L70 completo, listo para prestigio).
 * L1 arranca en 0 XP. Ver levelFromXp.
 */
export const LEVEL_XP_TABLE: readonly number[] = [
  500, 1700, 3600, 6200, 9500, 13500, 18200, 23600, 29700, 36500, 44300, 53100, 62900, 73700, 85500,
  98300, 112100, 126900, 142700, 159500, 177300, 196100, 215900, 236700, 258500, 281300, 305100,
  329900, 355700, 382700, 410900, 440300, 470900, 502700, 535700, 569900, 605300, 641900, 679700,
  718700, 758900, 800300, 842900, 886700, 931700, 977900, 1025300, 1073900, 1123700, 1175000,
  1227800, 1282100, 1337900, 1395200, 1454000, 1514300, 1576100, 1639400, 1704200, 1770500,
  1838300, 1907600, 1978400, 2050700, 2124500, 2199800, 2276600, 2354900, 2434700, 2516000,
];

const MAX_LEVEL = LEVEL_XP_TABLE.length; // 70
/** XP máximo de la tabla (2516000 = L70 completo). */
const MAX_XP: number = LEVEL_XP_TABLE[MAX_LEVEL - 1] ?? 0;

/**
 * Nivel (1..70) desde XP acumulado.
 * TABLE[i] = XP acumulado para ALCANZAR el nivel i+2 (umbrales L2..L70; la
 * última entrada, 2516000, es L70 completo / listo para prestigio). Por eso:
 * nivel = 1 + nº de umbrales ≤ xp, con cap en 70. Ejemplos de la spec:
 * xp=0 → L1, xp=500 → L2, xp=2434700 → L70, xp=2516000 → L70 (cap).
 * Fuera de rango (negativo, no entero o > MAX_XP) → null.
 */
export function levelFromXp(xp: number): number | null {
  if (!Number.isInteger(xp) || xp < 0 || xp > MAX_XP) return null;
  let thresholds = 0;
  for (let i = 0; i < MAX_LEVEL; i += 1) {
    const threshold = LEVEL_XP_TABLE[i];
    if (threshold !== undefined && threshold <= xp) thresholds += 1;
    else break;
  }
  return Math.min(thresholds + 1, MAX_LEVEL);
}

/** Progreso hacia el nivel siguiente; null en nivel máximo (L70 no tiene "next"). */
export interface StatLevelProgress {
  /** XP acumulados DENTRO del nivel actual. */
  current: number;
  /** XP necesarios DENTRO de este nivel para subir (denominador). */
  next: number;
  /** 0..100, redondeado. */
  pct: number;
}

export function levelProgressFromXp(xp: number, level: number): StatLevelProgress | null {
  if (level < 1 || level >= MAX_LEVEL) return null;
  const base = level === 1 ? 0 : (LEVEL_XP_TABLE[level - 2] ?? 0);
  const nextThreshold = LEVEL_XP_TABLE[level - 1];
  if (nextThreshold === undefined) return null;
  const current = xp - base;
  const next = nextThreshold - base;
  if (next <= 0) return null;
  const pct = Math.max(0, Math.min(100, Math.round((current / next) * 100)));
  return { current, next, pct };
}

/** Índices de career stats (confianza MEDIA — sanity checks antes de exponer). */
export const CAREER_INDEXES = {
  kills: 2305,
  deaths: 2315,
  wins: 2307,
  losses: 2308,
  ties: 2309,
  assists: 2316,
  headshots: 2321,
  /** Minutos totales de juego. */
  timePlayedTotal: 2324,
} as const;

export type StatCareerKey = keyof typeof CAREER_INDEXES;

export interface StatBlobCareer {
  kills: number | null;
  deaths: number | null;
  wins: number | null;
  losses: number | null;
  ties: number | null;
  assists: number | null;
  headshots: number | null;
  /** Minutos totales de juego. */
  timePlayedTotal: number | null;
}

/** Cap de sanity para counters de career (10M: cualquier cosa mayor es basura). */
const CAREER_CAP = 10_000_000;

export const CLASSES_PER_PROFILE = 15;
const CLASS_SIZE = 64;
const CLASS_NAME_SIZE = 32;
/** Offset del bloque de clases por versión (confianza ALTA). */
export const CLASS_BLOCK_OFFSET: Record<StatBlobVersion, number> = { 155: 3643, 159: 3963 };

export interface StatBlobClass {
  /** 0..14 */
  slot: number;
  /** Nombre decodificado (ASCII imprimible, null-padded); null si el slot no decodifica limpio. */
  name: string | null;
  /** true SOLO si el slot decodificó un nombre imprimible no vacío (criterio conservador). */
  inUse: boolean;
  /** Hex de los 64 bytes crudos, SOLO cuando el slot tiene bytes no-cero pero el nombre no decodifica limpio. */
  rawHex?: string;
}

export interface StatBlobInfo {
  version: StatBlobVersion;
  layout: 'v155-iw4x' | 'v159';
  /** XP total (índice "experience" 2300); null si no pasa sanity 0..2516000. */
  xp: number | null;
  /** 1..70, derivado de xp; null si xp es null. */
  level: number | null;
  levelProgress: StatLevelProgress | null;
  /** 0..10; null si no pasa sanity. */
  prestige: number | null;
  /** Counters con sanity individual: campo inválido → null (el objeto siempre viene). */
  career: StatBlobCareer;
  /** 15 slots (sub-offsets internos MEDIA → exposición conservadora). */
  classes: StatBlobClass[];
}

/** Sanity de xp: entero en 0..MAX_XP. */
function sanitizeXp(value: number | null): number | null {
  if (value === null || !Number.isInteger(value) || value < 0 || value > MAX_XP) return null;
  return value;
}

/** Sanity de prestigio: 0..10. */
function sanitizePrestige(value: number | null): number | null {
  if (value === null || !Number.isInteger(value) || value < 0 || value > 10) return null;
  return value;
}

/** Sanity de un counter de career: entero no negativo bajo el cap. */
function sanitizeCareer(value: number | null): number | null {
  if (value === null || !Number.isInteger(value) || value < 0 || value > CAREER_CAP) return null;
  return value;
}

/**
 * Decodifica el `name` (32 bytes null-padded) de una clase.
 * - Vacío (todo ceros hasta el padding) → null (slot libre).
 * - Bytes fuera de ASCII imprimible (0x20..0x7E) antes del primer null → null
 *   (texto basura típico de un slot libre con residuo).
 */
function decodeClassName(nameBytes: Buffer): string | null {
  let end = 0;
  while (end < nameBytes.length && nameBytes[end] !== 0) end += 1;
  if (end === 0) return null;
  for (let i = 0; i < end; i += 1) {
    const byte = nameBytes[i];
    if (byte === undefined || byte < 0x20 || byte > 0x7e) return null;
  }
  return nameBytes.subarray(0, end).toString('latin1');
}

/** Parsea UNA clase (64 bytes) de forma conservadora. */
function parseClass(buffer: Buffer, blockStart: number, slot: number): StatBlobClass {
  const start = blockStart + slot * CLASS_SIZE;
  const raw = buffer.subarray(start, start + CLASS_SIZE);
  if (raw.length < CLASS_SIZE) return { slot, name: null, inUse: false };

  const name = decodeClassName(raw.subarray(0, CLASS_NAME_SIZE));
  if (name !== null) return { slot, name, inUse: true };

  const hasBytes = raw.some((byte) => byte !== 0);
  if (hasBytes) return { slot, name: null, inUse: false, rawHex: raw.toString('hex') };
  return { slot, name: null, inUse: false };
}

/**
 * Parsea el blob `iw4x.stat`. Devuelve null si:
 * - el buffer no es un Buffer de exactamente STAT_BLOB_SIZE bytes, o
 * - la versión del def no está soportada (>159 = blob del futuro; <155 = layout desconocido).
 * Cada campo individual con MEDIA de confianza pasa sanity: si falla → null, nunca inventado.
 */
export function parseStatBlob(buffer: Buffer): StatBlobInfo | null {
  if (!Buffer.isBuffer(buffer) || buffer.length !== STAT_BLOB_SIZE) return null;

  let version: number;
  try {
    version = buffer.readInt32LE(0);
  } catch {
    return null;
  }
  const isSupported = (SUPPORTED_VERSIONS as readonly number[]).includes(version);
  if (!isSupported) return null;
  const blobVersion = version as StatBlobVersion;

  const xp = sanitizeXp(readStatInt32(buffer, 2300));
  const level = xp !== null ? levelFromXp(xp) : null;
  const levelProgress = xp !== null && level !== null ? levelProgressFromXp(xp, level) : null;
  const prestige = sanitizePrestige(readStatInt32(buffer, 2325));

  const career = {} as Record<StatCareerKey, number | null>;
  for (const [key, index] of Object.entries(CAREER_INDEXES) as Array<[StatCareerKey, number]>) {
    career[key] = sanitizeCareer(readStatInt32(buffer, index));
  }

  const blockStart = CLASS_BLOCK_OFFSET[blobVersion];
  const classes: StatBlobClass[] = [];
  for (let slot = 0; slot < CLASSES_PER_PROFILE; slot += 1) {
    classes.push(parseClass(buffer, blockStart, slot));
  }

  return {
    version: blobVersion,
    layout: blobVersion === 159 ? 'v159' : 'v155-iw4x',
    xp,
    level,
    levelProgress,
    prestige,
    career,
    classes,
  };
}
