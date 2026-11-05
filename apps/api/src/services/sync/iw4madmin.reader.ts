import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { Errors, errMessage } from '../../lib/errors.js';

export interface SourceClient {
  clientId: number;
  /** NetworkId como string decimal (puede superar Number.MAX_SAFE_INTEGER). */
  guid: string;
  name: string | null;
  totalConnectionTime: number;
  connections: number;
  firstConnection: Date | null;
  lastConnection: Date | null;
}

export interface KillAggregates {
  kills: Map<number, number>; // ClientId -> kills (IsKill = 1 como origen)
  deaths: Map<number, number>; // ClientId -> deaths (IsKill = 1 como objetivo)
}

export interface SourceKillEvent {
  originGuid: string;
  targetGuid: string;
  isKill: boolean;
  damage: number;
  weapon: string | null;
  server: string | null;
  time: Date;
  epoch: number;
}

export interface KillEventChunk {
  rows: SourceKillEvent[];
  hasMore: boolean;
  /** Epoch máximo LEÍDO (incluye filas descartadas) para avanzar el cursor sin estancarse. */
  lastEpoch: number;
  skippedUnknownClients: number;
  warning: string | null;
}

type Row = Record<string, unknown>;

function toNumber(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function fromEpoch(value: number): Date | null {
  const ms = value > 1e11 ? value : value * 1000; // segundos vs milisegundos
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Acepta los formatos que usan las distintas versiones de IW4MAdmin:
 * TEXT ISO-8601 ('2024-05-01T12:00:00Z', '2024-05-01 12:00:00'), o epoch numérico.
 */
export function parseSourceDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return fromEpoch(value);
  if (typeof value === 'bigint') return fromEpoch(Number(value));
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    let ms = Date.parse(trimmed);
    if (Number.isNaN(ms)) {
      const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
      const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
      ms = Date.parse(withZone);
    }
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  return null;
}

/**
 * Lector READ-ONLY de la base SQLite de IW4MAdmin.
 *
 * Defensivo por diseño:
 * - Abre la DB con `readonly: true` (nunca escribe en la fuente).
 * - Lee nombres de columnas reales con PRAGMA table_info antes de consultar.
 * - Construye los SELECT solo con columnas presentes; si falta algo esencial,
 *   lo reporta en `warnings` y devuelve datos parciales/vacíos en vez de romper.
 */
export class IW4MAdminReader {
  private db: Database.Database | null = null;
  readonly warnings: string[] = [];

  constructor(private readonly path: string) {}

  open(): void {
    if (!existsSync(this.path)) {
      throw Errors.syncSourceUnavailable(`no existe el archivo: ${this.path}`);
    }
    try {
      this.db = new Database(this.path, {
        readonly: true,
        fileMustExist: true,
        safeIntegers: true,
      } as Database.Options);
    } catch (err) {
      throw Errors.syncSourceUnavailable(errMessage(err));
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // ignore: cierre defensivo
    } finally {
      this.db = null;
    }
  }

  private assertOpen(): Database.Database {
    if (!this.db) throw new Error('El reader está cerrado; llama a open() primero.');
    return this.db;
  }

  /** Nombres de columnas reales de una tabla (PRAGMA table_info). Vacío si la tabla no existe. */
  getColumns(table: string): string[] {
    try {
      const rows = this.assertOpen().pragma(`table_info('${table}')`) as Array<Row>;
      const names = rows.map((row) => (typeof row['name'] === 'string' ? row['name'] : ''));
      return names.filter((name) => name.length > 0);
    } catch (err) {
      this.warnings.push(`[${table}] no se pudo leer el esquema: ${errMessage(err)}`);
      return [];
    }
  }

  /** Jugadores desde EFClient (adaptándose a las columnas presentes). */
  readClients(): SourceClient[] {
    const table = 'EFClient';
    const cols = this.getColumns(table);
    if (cols.length === 0) return [];

    const missing = ['ClientId', 'NetworkId'].filter((col) => !cols.includes(col));
    if (missing.length > 0) {
      this.warnings.push(`[EFClient] faltan columnas obligatorias (${missing.join(', ')}): no se sincronizan jugadores.`);
      return [];
    }

    const nameExpr = cols.includes('CurrentName') ? 'CurrentName' : cols.includes('Name') ? 'Name' : null;
    const parts = ['"ClientId"', '"NetworkId"'];
    if (nameExpr !== null) parts.push(`"${nameExpr}" AS clientName`);
    if (cols.includes('TotalConnectionTime')) parts.push('"TotalConnectionTime" AS totalConnectionTime');
    if (cols.includes('Connections')) parts.push('"Connections" AS connections');
    if (cols.includes('FirstConnection')) parts.push('"FirstConnection" AS firstConnection');
    if (cols.includes('LastConnection')) parts.push('"LastConnection" AS lastConnection');

    let rows: Array<Row>;
    try {
      rows = this.assertOpen()
        .prepare(`SELECT ${parts.join(', ')} FROM "${table}"`)
        .all() as Array<Row>;
    } catch (err) {
      this.warnings.push(`[EFClient] lectura falló: ${errMessage(err)}`);
      return [];
    }

    const clients: SourceClient[] = [];
    let skipped = 0;
    for (const row of rows) {
      const guid = toText(row['NetworkId']);
      if (guid === null || guid === '') {
        skipped += 1;
        continue;
      }
      clients.push({
        clientId: toNumber(row['ClientId']),
        guid,
        name: toText(row['clientName']),
        totalConnectionTime: toNumber(row['totalConnectionTime']),
        connections: toNumber(row['connections']),
        firstConnection: parseSourceDate(row['firstConnection']),
        lastConnection: parseSourceDate(row['lastConnection']),
      });
    }
    if (skipped > 0) {
      this.warnings.push(`[EFClient] ${skipped} filas descartadas sin NetworkId válido.`);
    }
    return clients;
  }

  /** Agregaciones kills/deaths por ClientId desde EFClientKill (GROUP BY, sin leer fila a fila). */
  readKillAggregates(): KillAggregates {
    const empty: KillAggregates = { kills: new Map(), deaths: new Map() };
    const cols = this.getColumns('EFClientKill');
    if (cols.length === 0) return empty;

    const missing = ['OriginClientId', 'TargetClientId'].filter((col) => !cols.includes(col));
    if (missing.length > 0) {
      this.warnings.push(`[EFClientKill] faltan columnas (${missing.join(', ')}): sin agregaciones de kills/deaths.`);
      return empty;
    }

    const where = cols.includes('IsKill') ? 'WHERE "IsKill" = 1' : '';
    const db = this.assertOpen();
    const aggregates: KillAggregates = { kills: new Map(), deaths: new Map() };

    const load = (sql: string, target: Map<number, number>): void => {
      const rows = db.prepare(sql).all() as Array<Row>;
      for (const row of rows) {
        target.set(toNumber(row['clientId']), toNumber(row['total']));
      }
    };

    try {
      load(
        `SELECT "OriginClientId" AS clientId, COUNT(*) AS total FROM "EFClientKill" ${where} GROUP BY "OriginClientId"`,
        aggregates.kills,
      );
      load(
        `SELECT "TargetClientId" AS clientId, COUNT(*) AS total FROM "EFClientKill" ${where} GROUP BY "TargetClientId"`,
        aggregates.deaths,
      );
    } catch (err) {
      this.warnings.push(`[EFClientKill] agregación falló: ${errMessage(err)}`);
      return empty;
    }
    return aggregates;
  }

  /** Etiquetas de servidor (EFServer) si la fuente las expone; si no, mapa vacío. */
  readServerLabels(): Map<number, string> {
    const labels = new Map<number, string>();
    const cols = this.getColumns('EFServer');
    if (cols.length === 0 || !cols.includes('ServerId')) return labels;
    const labelCol = cols.includes('ServerEndPoint') ? 'ServerEndPoint' : cols.includes('Name') ? 'Name' : null;
    if (labelCol === null) return labels;
    try {
      const rows = this.assertOpen()
        .prepare(`SELECT "ServerId", "${labelCol}" AS serverLabel FROM "EFServer"`)
        .all() as Array<Row>;
      for (const row of rows) {
        const id = toNumber(row['ServerId']);
        const label = toText(row['serverLabel']);
        if (label !== null && label.trim() !== '') labels.set(id, label.trim());
      }
    } catch (err) {
      this.warnings.push(`[EFServer] no se pudieron leer etiquetas de servidor: ${errMessage(err)}`);
    }
    return labels;
  }

  /**
   * Kill events de forma incremental (Time > afterEpoch), ordenados por tiempo.
   * Devuelve como mucho `limit` filas; `hasMore` indica si hay más que leer.
   */
  readKillEvents(
    clientGuidById: ReadonlyMap<number, string>,
    serverLabels: ReadonlyMap<number, string>,
    afterEpoch: number,
    limit: number,
  ): KillEventChunk {
    const base: KillEventChunk = { rows: [], hasMore: false, lastEpoch: afterEpoch, skippedUnknownClients: 0, warning: null };

    const cols = this.getColumns('EFClientKill');
    if (cols.length === 0) {
      return { ...base, warning: '[EFClientKill] tabla ausente o ilegible: no se importan kill events.' };
    }
    const missing = ['OriginClientId', 'TargetClientId', 'Time'].filter((col) => !cols.includes(col));
    if (missing.length > 0) {
      return {
        ...base,
        warning: `[EFClientKill] faltan columnas (${missing.join(', ')}): no se importan kill events.`,
      };
    }

    const parts = ['"OriginClientId"', '"TargetClientId"', '"Time"'];
    const hasIsKill = cols.includes('IsKill');
    if (hasIsKill) parts.push('"IsKill"');
    if (cols.includes('Damage')) parts.push('"Damage"');
    if (cols.includes('Weapon')) parts.push('"Weapon"');
    const hasServerId = cols.includes('ServerId');
    if (hasServerId) parts.push('"ServerId"');

    const sql = `SELECT ${parts.join(', ')} FROM "EFClientKill" WHERE "Time" IS NOT NULL AND "Time" > ? ORDER BY "Time" ASC LIMIT ?`;

    let rows: Array<Row>;
    try {
      rows = this.assertOpen().prepare(sql).all(afterEpoch, limit) as Array<Row>;
    } catch (err) {
      return { ...base, warning: `[EFClientKill] lectura de eventos falló: ${errMessage(err)}` };
    }

    const out: SourceKillEvent[] = [];
    let skipped = 0;
    let rawMaxEpoch = afterEpoch;

    for (const row of rows) {
      const epoch = toNumber(row['Time']);
      if (epoch > rawMaxEpoch) rawMaxEpoch = epoch;

      const originGuid = clientGuidById.get(toNumber(row['OriginClientId']));
      const targetGuid = clientGuidById.get(toNumber(row['TargetClientId']));
      if (originGuid === undefined || targetGuid === undefined) {
        skipped += 1;
        continue;
      }

      let server: string | null = null;
      if (hasServerId && row['ServerId'] !== null && row['ServerId'] !== undefined) {
        const serverId = toNumber(row['ServerId']);
        server = serverLabels.get(serverId) ?? `server-${serverId}`;
      }

      out.push({
        originGuid,
        targetGuid,
        isKill: hasIsKill ? toNumber(row['IsKill']) === 1 : true,
        damage: toNumber(row['Damage']),
        weapon: toText(row['Weapon']),
        server,
        time: new Date(epoch * 1000),
        epoch,
      });
    }

    if (skipped > 0) {
      this.warnings.push(`[EFClientKill] ${skipped} eventos descartados por ClientIds desconocidos.`);
    }

    return {
      rows: out,
      hasMore: rows.length === limit,
      lastEpoch: rawMaxEpoch,
      skippedUnknownClients: skipped,
      warning: null,
    };
  }
}
