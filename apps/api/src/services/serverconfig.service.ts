import { copyFile, rename, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { Errors, errMessage } from '../lib/errors.js';
import { AppError } from '../lib/errors.js';
import { parseWith } from '../middleware/validate.js';
import { serverConfigUpdateSchema } from '../dto/serverconfig.dto.js';
import type { ServerConfigUpdate } from '../dto/serverconfig.dto.js';

/**
 * API admin sobre el server.cfg REAL del server dedicado IW4x (estilo AlterWare):
 *  - GET: parsea el archivo a estructura tipada; las líneas que no mapean a
 *    campos conocidos se devuelven INTACTAS en `unknownLines`.
 *  - PUT: regenera el archivo sustituyendo SOLO los valores de los campos que
 *    llegan en el body (preservando set/seta, comentarios y líneas desconocidas
 *    TOMADAS DEL DISCO — el cliente nunca envía líneas crudas, solo estructura,
 *    para que no pueda inyectar comandos en el cfg).
 *  - Backup automático `server.cfg.bak-<timestamp>` + escritura atómica (tmp + rename).
 *  - Con ALLOW_SERVER_CONTROL=1 reinicia el server tras guardar vía SERVER_RESTART_COMMAND.
 */

// ── Tipos ──────────────────────────────────────────────────────────────────

export interface RotationEntry {
  map: string;
  gametype: string | null;
}

export interface ServerConfigDto {
  hostname: string | null;
  motd: string | null;
  /** Modo por defecto (g_gametype). */
  gametype: string | null;
  maxclients: number | null;
  logfile: number | null;
  g_log: string | null;
  /** RCON enmascarado (nunca sale el valor real). */
  rcon: string | null;
  rconSet: boolean;
  /** Bots (scr_testclients). */
  bots: number | null;
  /** Contraseña del server enmascarada (g_password/sv_password). */
  password: string | null;
  passwordSet: boolean;
  rotation: RotationEntry[];
  /** Líneas no reconocidas, intactas (solo lectura; el PUT no las acepta). */
  unknownLines: string[];
  metadata: { path: string; lastModified: string; sizeBytes: number };
}

export interface ServerConfigSaveResult {
  saved: boolean;
  restarted: boolean;
  backupPath: string;
  warnings: string[];
}
interface ParsedLine {
  raw: string;
  kind: 'blank' | 'comment' | 'dvar' | 'rotation' | 'other';
  cmd?: string; // set | seta
  dvar?: string;
  value?: string; // valor SIN comillas
  quoted?: boolean;
  trailingComment?: string;
  rotationType?: 'addGametype' | 'addMap';
  rotationValue?: string;
}

/** Dvars editables por el panel (dvar → campo del DTO). */
const EDITABLE_DVARS: Record<string, keyof ServerConfigUpdate> = {
  sv_hostname: 'hostname',
  sv_motd: 'motd',
  g_gametype: 'gametype',
  sv_maxclients: 'maxclients',
  logfile: 'logfile',
  g_log: 'g_log',
  rcon_password: 'rcon',
  scr_testclients: 'bots',
  g_password: 'password',
  sv_password: 'password',
};

// ── Utilidades ─────────────────────────────────────────────────────────────

/**
 * Envs de control del server, leídos EN CADA LLAMADA (dotenv ya cargó el .env):
 * permite mutarlos en tests sin tocar el archivo .env real.
 */
const cfgEnv = {
  get path(): string | undefined {
    return process.env.SERVER_CFG_PATH;
  },
  get allowControl(): boolean {
    const value = process.env.ALLOW_SERVER_CONTROL;
    return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  },
  get restartCommand(): string | undefined {
    return process.env.SERVER_RESTART_COMMAND;
  },
};

function maskSecret(value: string): string {
  if (value.length <= 4) return '••••';
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

/** Quita comillas y saltos de línea de valores que van entre quotes en el cfg. */
function sanitizeQuoted(value: string): string {
  return value.replace(/["\r\n]/g, '').trim();
}

function assertCfgConfigured(): string {
  const path = cfgEnv.path;
  if (!path) {
    throw new AppError(503, 'SERVER_CFG_NOT_CONFIGURED', 'SERVER_CFG_PATH no está configurado; no se puede acceder al server.cfg.');
  }
  if (!existsSync(path)) {
    throw new AppError(503, 'SERVER_CFG_NOT_FOUND', `No existe el archivo de configuración: ${path}`);
  }
  return path;
}

// ── Parseo ─────────────────────────────────────────────────────────────────

/** Separa "valor" // comentario respetando comillas. */
function splitValueAndComment(rest: string): { value: string; quoted: boolean; comment: string } {
  const trimmed = rest.trimStart();
  if (trimmed.startsWith('"')) {
    const closing = trimmed.indexOf('"', 1);
    if (closing !== -1) {
      return { value: trimmed.slice(1, closing), quoted: true, comment: trimmed.slice(closing + 1).trim() };
    }
    // comilla sin cerrar (cfg corrupto): toma todo como valor
    return { value: trimmed.slice(1), quoted: true, comment: '' };
  }
  const commentIdx = trimmed.indexOf('//');
  if (commentIdx === -1) {
    return { value: trimmed.trim(), quoted: false, comment: '' };
  }
  return { value: trimmed.slice(0, commentIdx).trim(), quoted: false, comment: trimmed.slice(commentIdx).trim() };
}

export function parseCfgLine(raw: string): ParsedLine {
  const trimmed = raw.trim();
  if (trimmed === '') return { raw, kind: 'blank' };
  if (trimmed.startsWith('//')) return { raw, kind: 'comment' };

  const rotationMatch = trimmed.match(/^(addGametype|addMap)\s+(\S+)/i);
  if (rotationMatch) {
    const type = (rotationMatch[1] ?? '').toLowerCase();
    return {
      raw,
      kind: 'rotation',
      rotationType: type === 'addgametype' ? 'addGametype' : 'addMap',
      rotationValue: rotationMatch[2] ?? '',
    };
  }

  const dvarMatch = trimmed.match(/^(seta|set)\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.*)$/);
  if (dvarMatch) {
    const { value, quoted, comment } = splitValueAndComment(dvarMatch[3] ?? '');
    return {
      raw,
      kind: 'dvar',
      cmd: dvarMatch[1],
      dvar: dvarMatch[2],
      value,
      quoted,
      trailingComment: comment,
    };
  }

  // sv_mapRotation inline (estilo antiguo): seta sv_mapRotation "gametype war map mp_rust ..."
  const mapRotationMatch = trimmed.match(/^(seta|set)\s+sv_mapRotation\s+(.*)$/);
  if (mapRotationMatch) {
    const { value } = splitValueAndComment(mapRotationMatch[2] ?? '');
    return { raw, kind: 'rotation', dvar: 'sv_mapRotation', value, rotationType: 'addMap', rotationValue: value };
  }

  return { raw, kind: 'other' };
}

function parseFile(path: string): { lines: ParsedLine[]; raw: string } {
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split(/\r?\n/).map((line) => parseCfgLine(line));
  return { lines, raw };
}

/** Extrae la rotación (array {map, gametype}) de las líneas addGametype/addMap/sv_mapRotation. */
function extractRotation(lines: ParsedLine[]): RotationEntry[] {
  const rotation: RotationEntry[] = [];
  let currentGt: string | null = null;

  // Estilo sv_mapRotation inline: "gametype war map mp_rust gametype war map mp_terminal"
  const inline = lines.find((line) => line.kind === 'rotation' && line.dvar === 'sv_mapRotation');
  if (inline) {
    const tokens = (inline.value ?? '').split(/\s+/).filter((token) => token !== '');
    let gt: string | null = null;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!.toLowerCase();
      if (token === 'gametype') {
        gt = tokens[i + 1] ?? null;
        i += 1;
      } else if (token === 'map') {
        const map = tokens[i + 1];
        if (map) rotation.push({ map, gametype: gt });
        i += 1;
      }
    }
    if (rotation.length > 0) return rotation;
  }

  for (const line of lines) {
    if (line.kind !== 'rotation' || line.rotationType === undefined) continue;
    if (line.rotationType === 'addGametype') {
      currentGt = line.rotationValue ?? null;
    } else {
      rotation.push({ map: line.rotationValue ?? '', gametype: currentGt });
    }
  }
  return rotation.filter((entry) => entry.map !== '');
}

function firstDvarValue(lines: ParsedLine[], dvar: string): string | null {
  const line = lines.find((candidate) => candidate.kind === 'dvar' && candidate.dvar === dvar);
  return line?.value ?? null;
}

/** Convierte el valor textual de una dvar numérica (null si no es entero). */
function toIntOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// ── GET ────────────────────────────────────────────────────────────────────

export async function getServerConfig(): Promise<ServerConfigDto> {
  const path = assertCfgConfigured();
  const { lines, raw } = parseFile(path);
  const info = await stat(path);

  // Líneas "desconocidas": las que no son eventos del cfg reconocibles por el
  // panel — dvars NO editables (verbatim) y líneas libres como map_rotate.
  const unknownLines = lines
    .filter((line) => line.kind === 'other' || (line.kind === 'dvar' && line.dvar !== undefined && !(line.dvar in EDITABLE_DVARS)))
    .map((line) => line.raw.trim())
    .filter((line) => line !== '');

  const rcon = firstDvarValue(lines, 'rcon_password');
  const password = firstDvarValue(lines, 'g_password') ?? firstDvarValue(lines, 'sv_password');

  return {
    hostname: firstDvarValue(lines, 'sv_hostname'),
    motd: firstDvarValue(lines, 'sv_motd'),
    gametype: firstDvarValue(lines, 'g_gametype'),
    maxclients: toIntOrNull(firstDvarValue(lines, 'sv_maxclients')),
    logfile: toIntOrNull(firstDvarValue(lines, 'logfile')),
    g_log: firstDvarValue(lines, 'g_log'),
    rcon: rcon ? maskSecret(rcon) : null,
    rconSet: Boolean(rcon && rcon.trim() !== ''),
    bots: toIntOrNull(firstDvarValue(lines, 'scr_testclients')),
    password: password ? maskSecret(password) : null,
    passwordSet: Boolean(password && password.trim() !== ''),
    rotation: extractRotation(lines),
    unknownLines,
    metadata: { path: resolve(path), lastModified: info.mtime.toISOString(), sizeBytes: info.size },
  };
}

// ── Regeneración ───────────────────────────────────────────────────────────

/** Reconstruye una línea dvar preservando cmd y comentario trailing. */
function renderDvarLine(line: ParsedLine, newValue: string): string {
  const cmd = line.cmd ?? 'set';
  const indent = line.raw.match(/^\s*/)?.[0] ?? '';
  const comment = line.trailingComment ? `        ${line.trailingComment}` : '';
  const value = line.quoted === false && /^-?\d+$/.test(newValue) ? newValue : `"${sanitizeQuoted(newValue)}"`;
  return `${indent}${cmd} ${line.dvar} ${value}${comment}`;
}

/** Genera el bloque de rotación desde el array {map, gametype}. */
function renderRotationBlock(rotation: Array<{ map: string; gametype?: string | null }>): string[] {
  const out: string[] = [];
  let currentGt: string | null = null;
  for (const entry of rotation) {
    const gametype = entry.gametype ?? null;
    if (gametype && gametype !== currentGt) {
      out.push(`addGametype ${gametype}`);
      currentGt = gametype;
    }
    out.push(`addMap ${entry.map}`);
  }
  return out;
}

/**
 * Regenera el contenido del cfg:
 *  - Sustituye el VALOR de las dvars editables presentes cuando el body las trae.
 *  - Regenera el bloque de rotación si el body trae rotation.
 *  - Añade al final (sección "PANEL") dvars editables solicitadas que no existían.
 *  - Conserva verbatim comentarios, blanks, líneas desconocidas y dvars no tocadas.
 */
export function renderCfg(original: string, update: ServerConfigUpdate): string {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/).map((line) => parseCfgLine(line));

  // campo del DTO → valor nuevo (solo los presentes en el body)
  const updatesByDvar = new Map<string, string>();
  const assign = (dvar: string, value: string): void => {
    updatesByDvar.set(dvar, value);
  };
  if (update.hostname !== undefined) assign('sv_hostname', update.hostname);
  if (update.motd !== undefined) assign('sv_motd', update.motd);
  if (update.gametype !== undefined) assign('g_gametype', update.gametype);
  if (update.maxclients !== undefined) assign('sv_maxclients', String(update.maxclients));
  if (update.logfile !== undefined) assign('logfile', String(update.logfile));
  if (update.g_log !== undefined) assign('g_log', update.g_log);
  if (update.rcon !== undefined && (update.rcon === null || !update.rcon.includes('•'))) {
    assign('rcon_password', update.rcon === null ? '' : update.rcon);
  } // eco enmascarado (contiene '•') = sin cambio
  if (update.bots !== undefined) assign('scr_testclients', String(update.bots));
  if (update.password !== undefined && (update.password === null || !update.password.includes('•'))) {
    assign('g_password', update.password === null ? '' : update.password);
  }

  const output: string[] = [];
  let rotationBlockInjected = false;

  for (const line of lines) {
    // Rotación: se sustituye COMPLETA por el bloque nuevo (una sola vez, en la
    // posición de la primera línea de rotación original).
    if (line.kind === 'rotation' && update.rotation !== undefined) {
      if (!rotationBlockInjected) {
        output.push(...renderRotationBlock(update.rotation));
        rotationBlockInjected = true;
      }
      continue; // el resto de líneas de rotación originales se eliminan
    }

    if (line.kind === 'dvar' && line.dvar !== undefined && updatesByDvar.has(line.dvar)) {
      output.push(renderDvarLine(line, updatesByDvar.get(line.dvar)!));
      updatesByDvar.delete(line.dvar);
      continue;
    }

    output.push(line.raw); // verbatim
  }

  // Dvars pedidas que NO estaban en el archivo → sección nueva al final.
  if (updatesByDvar.size > 0) {
    if (output.length > 0 && output[output.length - 1]?.trim() !== '') output.push('');
    output.push('// ==== CONFIG EDITADA DESDE EL PANEL (iw4x-ranking) ====');
    for (const [dvar, value] of updatesByDvar) {
      output.push(`set ${dvar} "${sanitizeQuoted(value)}"`);
    }
  }

  // Rotación nueva sin bloque previo en el archivo → apéndice al final.
  if (update.rotation !== undefined && !rotationBlockInjected) {
    if (output.length > 0 && output[output.length - 1]?.trim() !== '') output.push('');
    output.push(...renderRotationBlock(update.rotation));
  }

  return output.join(eol);
}

// ── PUT ────────────────────────────────────────────────────────────────────

async function restartDedicatedServerInternal(commandOverride?: string): Promise<{ restarted: boolean; warning?: string }> {
  if (!cfgEnv.allowControl) {
    return { restarted: false, warning: 'ALLOW_SERVER_CONTROL!=1: el server NO se reinició automáticamente.' };
  }
  const command = commandOverride ?? cfgEnv.restartCommand;
  if (!command) {
    return { restarted: false, warning: 'SERVER_RESTART_COMMAND no está configurado: el server NO se reinició automáticamente.' };
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    exec(command, { timeout: 20_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        rejectPromise(new Error(`restart falló: ${err.message} ${stderr}`.trim()));
        return;
      }
      void stdout;
      resolvePromise();
    });
  });
  return { restarted: true };
}

export async function updateServerConfig(updateRaw: unknown): Promise<ServerConfigSaveResult> {
  const path = assertCfgConfigured();
  const update = parseWith(serverConfigUpdateSchema, updateRaw);
  if (Object.keys(update).length === 0) {
    throw Errors.validation('El body no incluye ningún campo a actualizar.');
  }

  // Validación cruzada: los bots no pueden superar los slots del server
  // (se compara contra maxclients del body y, si falta, contra el del archivo).
  if (update.bots !== undefined) {
    const current = await getServerConfig();
    const effectiveMax = update.maxclients ?? current.maxclients;
    if (effectiveMax !== null && update.bots > effectiveMax) {
      throw Errors.validation(`scr_testclients (${update.bots}) no puede superar sv_maxclients (${effectiveMax}).`);
    }
  }

  const original = readFileSync(path, 'utf8');
  const regenerated = renderCfg(original, update);

  // Backup con timestamp antes de tocar nada.
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${path}.bak-${timestamp}`;
  await copyFile(path, backupPath);

  // Escritura ATÓMICA: tmp en el mismo directorio + rename (nunca cfg a medias).
  const tmpPath = resolve(dirname(path), `.server.cfg.tmp-${randomBytes(6).toString('hex')}`);
  await writeFile(tmpPath, regenerated, 'utf8');
  try {
    await rename(tmpPath, path);
  } catch (err) {
    await writeFile(path, original, 'utf8').catch(() => undefined); // rollback defensivo
    throw new AppError(500, 'SERVER_CFG_WRITE_FAILED', `No se pudo escribir el cfg: ${errMessage(err)}`);
  }

  // Restart post-guardado SOLO con ALLOW_SERVER_CONTROL=1 (nunca ejecuta nada sin el flag).
  let restarted = false;
  const warnings: string[] = [];
  try {
    const result = await restartDedicatedServerInternal();
    restarted = result.restarted;
    if (result.warning) warnings.push(result.warning);
  } catch (err) {
    warnings.push(errMessage(err));
  }

  return { saved: true, restarted, backupPath, warnings };
}

// ── POST /api/admin/server/restart ─────────────────────────────────────────

/** Reinicia el server dedicado. Requiere ALLOW_SERVER_CONTROL=1 + SERVER_RESTART_COMMAND. */
export async function restartServer(commandOverride?: string): Promise<{ restarted: boolean; command: string }> {
  if (!cfgEnv.allowControl) {
    throw Errors.forbidden('Control del server deshabilitado: define ALLOW_SERVER_CONTROL=1 para permitir reinicios.');
  }
  const command = commandOverride ?? cfgEnv.restartCommand;
  if (!command) {
    throw Errors.forbidden('SERVER_RESTART_COMMAND no está configurado: no hay comando de reinicio.');
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    exec(command, { timeout: 20_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        rejectPromise(new Error(`restart falló: ${err.message} ${stderr}`.trim()));
        return;
      }
      void stdout;
      resolvePromise();
    });
  });
  return { restarted: true, command };
}
