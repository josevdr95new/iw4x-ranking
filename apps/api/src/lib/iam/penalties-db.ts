import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/**
 * Accesor SOLO-LECTURA a la DB SQLite de IW4MAdmin para el HISTORIAL de
 * penalidades (EFPenalties) y estados abiertos (warns/flags/bans vigentes).
 *
 * IMPORTANTE (docs/SETUP.md 4G): esta DB es de IW4MAdmin y NUNCA se usa como
 * fuente de stats del ranking (la fuente es games_mp.log). Solo se leen
 * `EFPenalties` + `EFAlias` + `EFClients`, en readonly (WAL: el lector no
 * interfiere con el writer), para el bridge de moderación.
 *
 * Los tipos de penalidad (Data/Models/EFPenalty.cs, PenaltyType):
 * Report=0, Warning=1, Flag=2, Kick=3, TempBan=4, Ban=5, Unban=6, ...
 */

export const PENALTY_TYPE = {
  Report: 0,
  Warning: 1,
  Flag: 2,
  Kick: 3,
  TempBan: 4,
  Ban: 5,
  Unban: 6,
} as const;

/** Tipos incluidos en el historial (scope: warn/kick/tempban/ban + unban). */
const HISTORY_TYPES = [PENALTY_TYPE.Warning, PENALTY_TYPE.Kick, PENALTY_TYPE.TempBan, PENALTY_TYPE.Ban, PENALTY_TYPE.Unban];
/** Tipos que pueden seguir abiertos (con o sin expiración). */
const OPEN_TYPES = [PENALTY_TYPE.Warning, PENALTY_TYPE.Flag, PENALTY_TYPE.TempBan, PENALTY_TYPE.Ban];

const requireSqlite = createRequire(import.meta.url); // better-sqlite3 es CJS

export interface RawPenaltyRow {
  PenaltyId: number;
  OffenderId: number;
  PunisherId: number;
  Offense: string | null;
  AutomatedOffense: string | null;
  WhenText: string;
  Expires: string | null;
  Type: number;
  OffenderName: string | null;
  PunisherName: string | null;
}

export class PenaltiesDbUnavailableError extends Error {
  constructor(message: string) {
    super(`Historial de penalidades no disponible (DB de IW4MAdmin): ${message}`);
    this.name = 'PenaltiesDbUnavailableError';
  }
}

export class PenaltiesDbNotConfiguredError extends Error {
  constructor() {
    super('Historial de penalidades no disponible: define IW4MADMIN_PENALTIES_DB_PATH (ruta a Database.db de IW4MAdmin).');
    this.name = 'PenaltiesDbNotConfiguredError';
  }
}

interface Statement {
  history: (limit: number) => RawPenaltyRow[];
  openByClientIds: (clientIds: number[]) => RawPenaltyRow[];
  clientLevels: (clientIds: number[]) => Array<{ ClientId: number; Level: number }>;
  close: () => void;
}

const PENALTY_SELECT = `
  SELECT p.PenaltyId, p.OffenderId, p.PunisherId, p.Offense, p.AutomatedOffense,
         p."When" AS WhenText, p.Expires, p.Type,
         off.Name AS OffenderName, pun.Name AS PunisherName
    FROM EFPenalties p
    LEFT JOIN EFClients offc ON offc.ClientId = p.OffenderId
    LEFT JOIN EFAlias  off   ON off.AliasId = offc.CurrentAliasId
    LEFT JOIN EFClients func ON func.ClientId = p.PunisherId
    LEFT JOIN EFAlias  pun   ON pun.AliasId = func.CurrentAliasId
`;

interface SqliteDatabase {
  prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] };
  close: () => void;
}

type SqliteDatabaseCtor = new (path: string, options: { readonly: boolean; fileMustExist: boolean }) => SqliteDatabase;

function buildStatements(path: string): Statement {
  const Database = requireSqlite('better-sqlite3') as unknown as SqliteDatabaseCtor;
  let db: SqliteDatabase | null = null;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const historyQuery = db.prepare(
      `${PENALTY_SELECT}
        WHERE p.Type IN (${HISTORY_TYPES.join(',')})
        ORDER BY WhenText DESC
        LIMIT ?`,
    );
    const openQuery = db.prepare(
      `${PENALTY_SELECT}
        WHERE p.Type IN (${OPEN_TYPES.join(',')}) AND p.OffenderId IN (SELECT value FROM json_each(?))
        ORDER BY WhenText DESC`,
    );
    const levelQuery = db.prepare(
      `SELECT ClientId, Level FROM EFClients WHERE ClientId IN (SELECT value FROM json_each(?))`,
    );
    return {
      history: (limit) => historyQuery.all(limit) as RawPenaltyRow[],
      openByClientIds: (clientIds) =>
        clientIds.length === 0 ? [] : (openQuery.all(JSON.stringify(clientIds)) as RawPenaltyRow[]),
      clientLevels: (clientIds) =>
        clientIds.length === 0
          ? []
          : (levelQuery.all(JSON.stringify(clientIds)) as Array<{ ClientId: number; Level: number }>),
      close: () => {
        try {
          db?.close();
        } catch {
          void 0;
        }
      },
    };
  } catch (err) {
    try {
      db?.close();
    } catch {
      void 0;
    }
    throw new PenaltiesDbUnavailableError((err as Error).message);
  }
}

// ── Cache del handle readonly (clave: ruta absoluta) ──────────────────────

const handles = new Map<string, Statement>();

/** Test helper: cierra y descarta handles abiertos. */
export function resetPenaltiesDbCache(): void {
  for (const stmt of handles.values()) stmt.close();
  handles.clear();
}

/** Env config leída EN CADA llamada (permite mutarla en tests). */
export function penaltiesDbPath(): string | undefined {
  const value = process.env.IW4MADMIN_PENALTIES_DB_PATH;
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

export function isPenaltiesDbConfigured(): boolean {
  return penaltiesDbPath() !== undefined;
}

function boundStatements(): Statement {
  const path = penaltiesDbPath();
  if (path === undefined) throw new PenaltiesDbNotConfiguredError();
  const key = resolve(path).toLowerCase();
  const cached = handles.get(key);
  if (cached) return cached;
  const statements = buildStatements(resolve(path));
  handles.set(key, statements);
  return statements;
}

// ── Normalización ─────────────────────────────────────────────────────────

export type PenaltyKind = 'warn' | 'flag' | 'kick' | 'tempban' | 'ban' | 'unban' | 'report';

export const PENALTY_TYPE_NAMES: Record<number, PenaltyKind> = {
  [PENALTY_TYPE.Report]: 'report',
  [PENALTY_TYPE.Warning]: 'warn',
  [PENALTY_TYPE.Flag]: 'flag',
  [PENALTY_TYPE.Kick]: 'kick',
  [PENALTY_TYPE.TempBan]: 'tempban',
  [PENALTY_TYPE.Ban]: 'ban',
  [PENALTY_TYPE.Unban]: 'unban',
};

/** Permission enum de EFClient (Data/Models/Client/EFClient.cs), Banned=-1 … Console=8. */
export const LEVEL_NAMES: Record<number, string> = {
  [-1]: 'Banned',
  0: 'User',
  1: 'Flagged',
  2: 'Trusted',
  3: 'Moderator',
  4: 'Administrator',
  5: 'SeniorAdmin',
  6: 'Owner',
  7: 'Creator',
  8: 'Console',
};

export function levelName(level: number): string {
  return LEVEL_NAMES[level] ?? `Unknown(${level})`;
}

export interface NormalizedPenalty {
  id: number;
  type: PenaltyKind;
  reason: string | null;
  automated: boolean;
  when: string | null;
  expires: string | null;
  offender: { clientId: number; name: string | null };
  punisher: { clientId: number; name: string | null };
}

function normalizeRow(row: RawPenaltyRow): NormalizedPenalty {
  return {
    id: row.PenaltyId,
    type: PENALTY_TYPE_NAMES[row.Type] ?? 'report',
    // El motivo de una automatizada (ej. ranking/xlan cheaters) está en AutomatedOffense.
    reason:
      row.AutomatedOffense !== null && row.AutomatedOffense.length > 0 ? row.AutomatedOffense : row.Offense,
    automated: row.AutomatedOffense !== null && row.AutomatedOffense.length > 0,
    when: parseSqliteDate(row.WhenText),
    expires: parseSqliteDate(row.Expires),
    offender: { clientId: row.OffenderId, name: row.OffenderName },
    punisher: { clientId: row.PunisherId, name: row.PunisherName },
  };
}

/**
 * Parsea las fechas de EF Core/SQLite (`"2025-12-01 10:00:00"`, ISO o epoch) a
 * ISO-8601. Null si no interpretable.
 */
export function parseSqliteDate(value: string | null): string | null {
  if (value === null || value.trim() === '') return null;
  const trimmed = value.trim();
  let candidate = trimmed.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(candidate)) {
    candidate += 'Z'; // EF Core guarda UTC sin offset
  }
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** ¿Está abierta (vigente) al momento de la consulta?  */
export function isPunishmentOpen(row: { Type: number; Expires: string | null }, now = Date.now()): boolean {
  const openType =
    row.Type === PENALTY_TYPE.Warning || row.Type === PENALTY_TYPE.Flag ||
    row.Type === PENALTY_TYPE.TempBan || row.Type === PENALTY_TYPE.Ban;
  if (!openType) return false;
  if (row.Expires === null || row.Expires.trim() === '') {
    return true; // warns/perbans sin expiración definida
  }
  const expiresIso = parseSqliteDate(row.Expires);
  if (expiresIso === null) return true;
  return new Date(expiresIso).getTime() > now;
}

// ── Operaciones de alto nivel ──────────────────────────────────────────────

/** Historial reciente (warn/kick/tempban/ban/unban) más nuevos primero. */
export function recentPenalties(limit: number): NormalizedPenalty[] {
  return boundStatements().history(limit).map(normalizeRow);
}

/** Penalidades abiertas por clientId. Map vacío si la DB no está configurada. */
export function openPenaltiesByClient(clientIds: number[]): Map<number, NormalizedPenalty[]> {
  const db = boundStatements();
  const rows = db.openByClientIds(clientIds);
  const out = new Map<number, NormalizedPenalty[]>();
  for (const row of rows) {
    if (!isPunishmentOpen(row)) continue;
    const list = out.get(row.OffenderId) ?? [];
    list.push(normalizeRow(row));
    out.set(row.OffenderId, list);
  }
  return out;
}

/** Nivel (Permission enum) por clientId; Map vacío si sin DB. */
export function clientLevelsById(clientIds: number[]): Map<number, number> {
  const db = boundStatements();
  const out = new Map<number, number>();
  for (const row of db.clientLevels(clientIds)) {
    out.set(row.ClientId, row.Level);
  }
  return out;
}

export interface PenaltiesDbStatus {
  configured: boolean;
  error: string | null;
}
