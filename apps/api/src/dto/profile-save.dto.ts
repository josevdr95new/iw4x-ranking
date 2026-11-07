import { z } from 'zod';

/**
 * Whitelist de rutas RELATIVAS permitidas dentro del perfil de juego IW4x.
 * El binario es data opaca del juego: solo se valida la ruta y el tamaño/hash,
 * NUNCA el contenido interno.
 *
 *  - guid.dat                     → IDENTIDAD: clave ECC de la que IW4x deriva
 *                                   el GUID (%LOCALAPPDATA%\iw4x\guid.dat, ~<4KB).
 *                                   Restaurarla en otra PC conserva el GUID.
 *  - iw4x.stat                    → progresión (nivel/armas/clases, ~8.2KB)
 *  - iw4x_config.cfg              → prefs + name (~14KB)
 *  - mods/<mod>/iw4x.stat         → save de progresión por mod
 *  - mods/<mod>/iw4x_config.cfg   → config por-mod (nombre/clan editados con mod activo)
 *
 * El regex excluye por construcción path traversal (no hay "..", "/", "\",
 * absolutos ni caracteres de escape).
 */
export const SAVE_PATH_PATTERN = /^(iw4x\.stat|iw4x_config\.cfg|guid\.dat|mods\/[A-Za-z0-9_\-]+\/(?:iw4x\.stat|iw4x_config\.cfg))$/;

/** Tamaño máximo del string base64 por archivo (256 KB; iw4x.stat real es ~8 KB, guid.dat < 4 KB). */
export const MAX_FILE_BASE64_CHARS = 256 * 1024;
/** Máximo de archivos por snapshot (whitelist = 3 + 2 por mod; cap defensivo para instalaciones multi-mod). */
export const MAX_SAVE_FILES = 24;

const sha256Pattern = /^[a-f0-9]{64}$/;

export const saveFileSchema = z.object({
  path: z.string().regex(SAVE_PATH_PATTERN, 'Ruta no permitida (whitelist: guid.dat, iw4x.stat, iw4x_config.cfg, mods/<mod>/iw4x.stat, mods/<mod>/iw4x_config.cfg).'),
  dataBase64: z
    .string()
    .min(1)
    .max(MAX_FILE_BASE64_CHARS, `dataBase64 excede el máximo de ${MAX_FILE_BASE64_CHARS} caracteres.`),
  sha256: z.string().regex(sha256Pattern, 'sha256 debe ser el hash hexadecimal (64 chars) del contenido.'),
});

export const putSaveSchema = z
  .object({
    build: z.string().max(128).optional(),
    files: z.array(saveFileSchema).min(1).max(MAX_SAVE_FILES, `Máximo ${MAX_SAVE_FILES} archivos por snapshot.`),
  })
  .strict();

export type PutSaveInput = z.infer<typeof putSaveSchema>;
export type SaveFileInput = z.infer<typeof saveFileSchema>;
export type SaveFileQuery = z.infer<typeof saveFileQuerySchema>;

export const saveFileQuerySchema = z.object({
  path: z.string().regex(SAVE_PATH_PATTERN, 'Ruta no permitida (whitelist: guid.dat, iw4x.stat, iw4x_config.cfg, mods/<mod>/iw4x.stat, mods/<mod>/iw4x_config.cfg).'),
  /** Timestamp de la versión (ms epoch); si falta se sirve la latest. */
  version: z.coerce.number().int().positive().optional(),
});
