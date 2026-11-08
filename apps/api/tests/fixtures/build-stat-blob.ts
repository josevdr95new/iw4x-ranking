/**
 * Fixture: CONSTRUYE blobs `iw4x.stat` sintéticos según el layout documentado
 * (ver src/lib/save-parser/parse-stat-blob.ts y docs/API.md).
 *
 * Los offsets provienen del MISMO módulo que usa el parser (statIndexOffset,
 * CAREER_INDEXES, CLASS_BLOCK_OFFSET): los tests de roundtrip validan la
 * fórmula índice→offset escribiendo con el builder y leyendo con el parser.
 */
import {
  CAREER_INDEXES,
  CLASS_BLOCK_OFFSET,
  CLASSES_PER_PROFILE,
  statIndexOffset,
  type StatCareerKey,
  type StatBlobVersion,
} from '../../src/lib/save-parser/parse-stat-blob.js';

export const STAT_BLOB_SIZE = 8192;
export const CLASS_SIZE = 64;
export const CLASS_NAME_SIZE = 32;

/** Una clase del builder: nombre simple, override completo de 64 bytes, o null (slot en ceros). */
export interface BuildBlobClass {
  name?: string;
  /** 64 bytes crudos que sobreescriben el slot completo (para probar basura). */
  raw?: Buffer;
}

export interface BuildStatBlobOptions {
  /** Versión del def (default 155; 159 cambia el offset del bloque de clases). */
  version?: StatBlobVersion | number;
  /** Tamaño total (default 8192; pásole otro para probar blobs corruptos). */
  size?: number;
  /** XP total (índice 2300). */
  xp?: number;
  /** Prestigio (índice 2325). */
  prestige?: number;
  /** Career stats por clave del parser. */
  career?: Partial<Record<StatCareerKey, number>>;
  /** Clases por slot (hasta 15); los slots sin entrada quedan en ceros. */
  classes?: Array<string | BuildBlobClass | null>;
}

/** Escribe `value` en el índice dado usando la MISMA fórmula que el parser (byte si i<2000, int32LE si no). */
export function writeStatIndex(buf: Buffer, index: number, value: number): void {
  const offset = statIndexOffset(index);
  if (offset === null) throw new Error(`Índice fuera del mapa: ${index}`);
  if (index <= 1999) {
    buf.writeUInt8(value & 0xff, offset);
  } else {
    buf.writeInt32LE(value, offset);
  }
}

export function buildStatBlob(options: BuildStatBlobOptions = {}): Buffer {
  const version = options.version ?? 155;
  const size = options.size ?? STAT_BLOB_SIZE;
  const buf = Buffer.alloc(size);
  if (size >= 4) buf.writeInt32LE(version, 0);

  if (options.xp !== undefined) writeStatIndex(buf, 2300, options.xp);
  if (options.prestige !== undefined) writeStatIndex(buf, 2325, options.prestige);
  for (const [key, value] of Object.entries(options.career ?? {}) as Array<[StatCareerKey, number]>) {
    const index = CAREER_INDEXES[key];
    if (index !== undefined) writeStatIndex(buf, index, value);
  }

  if (options.classes?.length) {
    // El offset del bloque solo existe para versiones soportadas; para blobs
    // "de futuro" (otras versiones) simplemente no se escriben clases.
    const blockStart = CLASS_BLOCK_OFFSET[version as StatBlobVersion];
    if (blockStart !== undefined) {
      options.classes.slice(0, CLASSES_PER_PROFILE).forEach((entry, slot) => {
        if (entry === null || entry === undefined) return;
        const start = blockStart + slot * CLASS_SIZE;
        if (typeof entry === 'string') {
          const nameBytes = Buffer.from(entry, 'latin1');
          nameBytes.subarray(0, CLASS_NAME_SIZE).copy(buf, start);
          // el resto del slot queda en ceros (null padding)
          return;
        }
        if (entry.raw) {
          entry.raw.subarray(0, CLASS_SIZE).copy(buf, start);
          return;
        }
        if (entry.name !== undefined) {
          Buffer.from(entry.name, 'latin1').subarray(0, CLASS_NAME_SIZE).copy(buf, start);
        }
      });
    }
  }

  return buf;
}
