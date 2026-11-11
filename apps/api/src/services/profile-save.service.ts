import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { env } from '../config/env.js';
import { Errors } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { MAX_FILE_BASE64_CHARS, type PutSaveInput } from '../dto/profile-save.dto.js';
import { parseStatBlob } from '../lib/save-parser/parse-stat-blob.js';

/** Path raíz del save de progresión de la cuenta (FALLBACK del parse; ver MOD_STAT_PATH). */
const STAT_ROOT_PATH = 'iw4x.stat';

/**
 * Save de progresión DEL MOD mp_bots: fuente de VERDAD del saveXp/saveLevel/
 * savePrestige que exponen la web y el launcher.
 *
 * DECISIÓN DEL DUEÑO (2026-11-11): lo que el jugador ve dentro del juego en los
 * servers del cyber es la progresión del MOD (todos corren mp_bots y el save
 * por-mod vive en mods/<mod>/iw4x.stat), NO el `iw4x.stat` RAÍZ de la cuenta.
 * Caso real (Jose): raíz = 5120 XP (L4) vs mod = 2163 XP (L3 Private II, su
 * rango real in-game) → la web mostraba L4 y estaba mal.
 *
 * Reglas de propagación (ver syncParsedSaveToPlayers):
 * 1. El snapshot incluye mods/mp_bots/iw4x.stat → se parsea ESE buffer y se
 *    propagan SUS valores (xp/level/prestige), aunque también venga el raíz.
 * 2. Sin save del mod pero con raíz → raíz (comportamiento legacy).
 * 3. Sin ninguno → no-op (el save del Player queda como estaba, "como hoy").
 *
 * El árbol del snapshot se guarda y restaura INTACTO (guid.dat + raíz + mods/):
 * el restore de cloud-save NO cambia y el raíz queda intacto en storage para el
 * restore de cuenta. Solo cambia qué archivo alimenta el parse expuesto. Con
 * esto el cloud save queda CONSISTENTE con el pipeline en vivo (livestats),
 * que ya escribe saveXp con el XP del mod (GetStat lee el archivo del mod).
 */
const MOD_STAT_PATH = 'mods/mp_bots/iw4x.stat';

/**
 * Cloud save de progresión IW4x: snapshots versionados POR CUENTA en disco.
 *
 * Layout bajo env PROFILE_STORAGE_DIR (default <repo>/apps/api/storage/profiles):
 *
 *   <dir>/<userId>/latest.json                       → manifiesto del último save (escritura atómica tmp+rename)
 *   <dir>/<userId>/<versionTimestamp>-<combinedSha256>/  → snapshot versionado
 *     ├── snapshot.json                              → manifiesto embebido (para listar versiones)
 *     ├── iw4x.stat
 *     ├── iw4x_config.cfg
 *     └── mods/<mod>/iw4x.stat
 *
 * - EXCEPCIÓN de opacidad: tras cada upload nuevo se PARSEA el save de
 *   progresión DEL MOD (`mods/mp_bots/iw4x.stat`, preferente) o, si el snapshot
 *   no lo trae, el `iw4x.stat` RAÍZ (fallback) → xp/nivel/prestigio a las
 *   columnas save* del Player vinculado (ver MOD_STAT_PATH).
 *   El parse NUNCA puede fallar el upload (try/catch total + sanity por campo;
 *   ver src/lib/save-parser/parse-stat-blob.ts y docs/API.md).
 * - combinedSha256 = sha256 de la lista canónica "path:fileSha256" → dedupe de PUTs idénticos.
 * - Poda: se conservan las últimas SAVE_KEEP_VERSIONS versiones por cuenta.
 * - Escritura atómica: siempre tmp + rename (mismo volumen → atómico en Windows y POSIX).
 */

export const SAVE_KEEP_VERSIONS = 10;

export interface SaveFileInfo {
  path: string;
  sha256: string;
  size: number;
  updatedAt: string;
}

export interface SaveManifest {
  /** Timestamp ms epoch que identifica la versión. */
  version: number;
  updatedAt: string;
  build?: string;
  /** Hash combinado de todos los archivos (dedupe/identidad del snapshot). */
  combinedSha256: string;
  files: SaveFileInfo[];
}

export interface PutSaveResult {
  saved: boolean;
  /** Presente solo cuando saved=false: 'unchanged'. */
  reason?: 'unchanged';
  version: number;
  updatedAt: string;
  files: SaveFileInfo[];
  pruned: number;
}

export interface SaveVersionSummary {
  version: number;
  updatedAt: string;
  build?: string;
  files: SaveFileInfo[];
}

interface DecodedFile {
  path: string;
  declaredSha256: string;
  buf: Buffer;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function userRoot(userId: number): string {
  // resolve() aplana el path; el whitelist del DTO garantiza que nunca hay
  // segmentos ".." ni separadores raros antes de llegar aquí (defensa en profundidad).
  return resolve(env.profileStorageDir, String(userId));
}

/** Hash combinado: lista canónica ordenada por path. Identidad del snapshot completo. */
function combinedHash(files: Array<{ path: string; sha256: string }>): string {
  const canonical = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}:${f.sha256}`)
    .join('\n');
  return sha256Hex(Buffer.from(canonical, 'utf8'));
}

/** Escritura atómica en el mismo volumen: tmp + rename. */
function atomicWriteFileSync(filePath: string, data: Buffer | string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  writeFileSync(tmp, data);
  renameSync(tmp, filePath);
}

/** Serializa PUTs concurrentes del MISMO usuario (un solo launcher por cuenta). */
const userLocks = new Map<number, Promise<unknown>>();
function withUserLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  userLocks.set(
    userId,
    next.catch(() => undefined),
  );
  return next;
}

function readLatestManifest(userId: number): SaveManifest | null {
  const file = join(userRoot(userId), 'latest.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as SaveManifest;
    return typeof parsed.version === 'number' && Array.isArray(parsed.files) ? parsed : null;
  } catch {
    return null; // manifiesto corrupto → tratar como "sin save" (el próximo PUT lo regenera)
  }
}

interface VersionDir {
  version: number;
  dir: string;
}

function listVersionDirs(userId: number): VersionDir[] {
  const root = userRoot(userId);
  if (!existsSync(root)) return [];
  const dirs: VersionDir[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = /^(\d+)-[0-9a-f]{64}$/.exec(entry.name);
    if (match) dirs.push({ version: Number(match[1]), dir: join(root, entry.name) });
  }
  return dirs.sort((a, b) => b.version - a.version); // más nueva primero
}

/** Elimina versiones fuera de la ventana de retención. Devuelve cuántas podó. */
function pruneVersions(userId: number): number {
  const dirs = listVersionDirs(userId);
  const excess = dirs.slice(SAVE_KEEP_VERSIONS);
  for (const d of excess) rmSync(d.dir, { recursive: true, force: true });
  return excess.length;
}

/** Decodifica y VERIFICA cada archivo: tamaño cap + sha256 real vs declarado. */
function decodeAndVerify(files: PutSaveInput['files']): DecodedFile[] {
  const decoded: DecodedFile[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path)) throw Errors.validation(`Ruta duplicada en el snapshot: "${f.path}".`);
    seen.add(f.path);
    const buf = Buffer.from(f.dataBase64, 'base64');
    if (buf.length > MAX_FILE_BASE64_CHARS) throw Errors.validation(`El archivo "${f.path}" excede el tamaño máximo.`);
    const actual = Buffer.from(sha256Hex(buf), 'hex');
    const declared = Buffer.from(f.sha256.toLowerCase(), 'hex');
    if (actual.length !== declared.length || !timingSafeEqual(actual, declared)) {
      throw Errors.saveShaMismatch(f.path);
    }
    decoded.push({ path: f.path, declaredSha256: f.sha256.toLowerCase(), buf });
  }
  return decoded;
}

/** PUT /api/profile/save: guarda un snapshot nuevo salvo que sea idéntico al latest. */

/**
 * Propaga el parse del save de progresión del snapshot recién guardado a los
 * Players vinculados a la cuenta (el cloud save es por CUENTA: un perfil de
 * progresión compartido por todos sus guids, juegue desde la PC que juegue).
 *
 * FUENTE (decisión del dueño, ver MOD_STAT_PATH): preferencia al save DEL MOD
 * (`mods/mp_bots/iw4x.stat` — lo que el jugador ve in-game, todos los servers
 * del cyber corren mp_bots); fallback al `iw4x.stat` raíz SOLO si el snapshot
 * no trae save del mod.
 *
 * Garantías:
 * - Sin save del mod ni raíz en el snapshot → no-op ("como hoy": no se inventa
 *   ni se pisa progresión).
 * - Parse null (tamaño ≠ 8192 o versión no soportada) → campos a null ("latest
 *   wins": el estado del Player refleja SIEMPRE el último snapshot) + log debug.
 * - Sanity por campo dentro del parser: campo inválido → null individual.
 * - Cualquier error inesperado (DB, etc.) se traga con log: el upload NUNCA
 *   falla por el parse.
 */
async function syncParsedSaveToPlayers(userId: number, decoded: DecodedFile[]): Promise<void> {
  try {
    const modBuf = decoded.find((f) => f.path === MOD_STAT_PATH)?.buf;
    const rootBuf = decoded.find((f) => f.path === STAT_ROOT_PATH)?.buf;
    // Preferencia DEL MOD; el raíz solo como fallback (ver MOD_STAT_PATH).
    const statBuf = modBuf ?? rootBuf;
    if (!statBuf) return;
    const parsed = parseStatBlob(statBuf);
    if (!parsed) {
      console.debug(`[profile-save] ${modBuf ? MOD_STAT_PATH : STAT_ROOT_PATH} no parseable (tamaño/versión) → save=null para cuenta ${userId}`);
    }
    const result = await prisma.player.updateMany({
      where: { accountLinks: { some: { userId } } },
      data: parsed
        ? { saveXp: parsed.xp, saveLevel: parsed.level, savePrestige: parsed.prestige, saveParsedAt: new Date() }
        : { saveXp: null, saveLevel: null, savePrestige: null, saveParsedAt: null },
    });
    if (result.count === 0) {
      console.debug(`[profile-save] cuenta ${userId} sin GUIDs vinculados → parse de save no expuesto`);
    }
  } catch (err) {
    console.debug(`[profile-save] parse/persist del save de progresión falló (upload intacto): ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function putSave(userId: number, input: PutSaveInput): Promise<PutSaveResult> {
  return withUserLock(userId, async () => {
    const decoded = decodeAndVerify(input.files);
    const combined = combinedHash(decoded.map((f) => ({ path: f.path, sha256: f.declaredSha256 })));

    const latest = readLatestManifest(userId);
    if (latest && latest.combinedSha256 === combined) {
      return { saved: false, reason: 'unchanged' as const, version: latest.version, updatedAt: latest.updatedAt, files: latest.files, pruned: 0 };
    }

    const root = userRoot(userId);
    mkdirSync(root, { recursive: true });

    const existing = listVersionDirs(userId);
    // Versión = ms epoch, ESTRICTAMENTE creciente por cuenta (evita dos snapshots
    // con el mismo ts en el mismo ms → rollback no ambiguo).
    let version = Math.max(Date.now(), (existing[0]?.version ?? 0) + 1);
    while (existsSync(join(root, `${version}-${combined}`))) version += 1;
    const versionDir = join(root, `${version}-${combined}`);

    const updatedAt = new Date().toISOString();
    const fileInfos: SaveFileInfo[] = decoded.map((f) => ({
      path: f.path,
      sha256: f.declaredSha256,
      size: f.buf.length,
      updatedAt,
    }));

    // Archivos del snapshot. La whitelist del DTO garantiza segmentos seguros;
    // split('/') + join() nunca puede escapar del versionDir (no hay "..").
    for (const f of decoded) {
      atomicWriteFileSync(join(versionDir, ...f.path.split('/')), f.buf);
    }

    const manifest: SaveManifest = { version, updatedAt, build: input.build, combinedSha256: combined, files: fileInfos };
    // Manifiesto embebido primero, latest.json al final (la fuente de verdad del GET).
    atomicWriteFileSync(join(versionDir, 'snapshot.json'), JSON.stringify(manifest, null, 2));
    atomicWriteFileSync(join(root, 'latest.json'), JSON.stringify(manifest, null, 2));

    const pruned = pruneVersions(userId);
    // Parse de progresión (post-guardado, pre-respuesta): nunca rompe el upload.
    // Fuente: save DEL MOD preferente; raíz solo como fallback (MOD_STAT_PATH).
    await syncParsedSaveToPlayers(userId, decoded);
    return { saved: true, version, updatedAt, files: fileInfos, pruned };
  });
}

/** GET /api/profile/save: manifiesto del último save, o null si nunca subió. */
export function getLatestSave(userId: number): SaveManifest | null {
  return readLatestManifest(userId);
}

/**
 * Borra COMPLETO el árbol de cloud saves de una cuenta (<dir>/<userId>/):
 * latest.json + todas las versiones. Lo usa DELETE /api/admin/accounts/:id
 * (borrado de cuenta por el admin). Idempotente: si la cuenta nunca subió un
 * save, el dir no existe y rmSync force no falla.
 */
export function deleteProfileStorage(userId: number): void {
  rmSync(userRoot(userId), { recursive: true, force: true });
}

/** GET /api/profile/save/versions: resumen de todas las versiones retenidas (nueva primero). */
export function listSaveVersions(userId: number): SaveVersionSummary[] {
  const summaries: SaveVersionSummary[] = [];
  for (const v of listVersionDirs(userId)) {
    const snapshotFile = join(v.dir, 'snapshot.json');
    if (existsSync(snapshotFile)) {
      try {
        const snap = JSON.parse(readFileSync(snapshotFile, 'utf8')) as SaveManifest;
        summaries.push({ version: snap.version, updatedAt: snap.updatedAt, build: snap.build, files: snap.files });
        continue;
      } catch {
        // snapshot.json corrupto → fallback al FS abajo.
      }
    }
    // Fallback: reconstruye el resumen leyendo los archivos del dir.
    const files: SaveFileInfo[] = [];
    for (const name of readdirSync(v.dir, { withFileTypes: true })) {
      if (!name.isFile() || name.name === 'snapshot.json') continue;
      const data = readFileSync(join(v.dir, name.name));
      files.push({ path: name.name, sha256: sha256Hex(data), size: data.length, updatedAt: statSync(join(v.dir, name.name)).mtime.toISOString() });
    }
    summaries.push({ version: v.version, updatedAt: statSync(v.dir).mtime.toISOString(), files });
  }
  return summaries;
}

export interface SaveFileResult {
  data: Buffer;
  sha256: string;
  version: number;
}

/** GET /api/profile/save/file: binario de una ruta, de la versión dada o la latest. */
export function getSaveFile(userId: number, path: string, version?: number): SaveFileResult {
  let versionDir: VersionDir | undefined;
  if (version !== undefined) {
    versionDir = listVersionDirs(userId).find((v) => v.version === version);
    if (!versionDir) throw Errors.saveVersionNotFound(version);
  } else {
    const latest = readLatestManifest(userId);
    if (!latest) throw Errors.saveNotFound();
    versionDir = listVersionDirs(userId).find((v) => v.version === latest.version);
    if (!versionDir) throw Errors.saveNotFound();
  }

  // Defensa en profundidad: la whitelist ya excluye ".." y absolutos, pero
  // verificamos que la resolución quede DENTRO del dir de la versión.
  const target = resolve(versionDir.dir, ...path.split('/'));
  const rel = relative(versionDir.dir, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw Errors.saveFileNotFound(path);
  if (!existsSync(target) || !statSync(target).isFile()) throw Errors.saveFileNotFound(path);

  const data = readFileSync(target);
  return { data, sha256: sha256Hex(data), version: versionDir.version };
}
