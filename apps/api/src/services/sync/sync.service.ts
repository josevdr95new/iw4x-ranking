import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { Errors, errMessage } from '../../lib/errors.js';
import { IW4MAdminReader } from './iw4madmin.reader.js';
import type { KillAggregates, SourceClient } from './iw4madmin.reader.js';
import { ingestGameLog } from './gamelog.reader.js';

export interface SyncResult {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  playersSynced: number;
  killEventsSynced: number;
  warnings: string[];
}

export interface PublicSyncStatusDto {
  /** Timestamp (ISO) de la última sincronización EXITOSA; null si nunca hubo. */
  lastSyncAt: string | null;
  configured: boolean;
  intervalMinutes: number;
  windowMinutes: number;
}

const EVENT_BATCH = 2_000;
const INSERT_CHUNK = 500;
const MAX_CHUNK_LOOPS = 50_000;

/** true si hay ALGUNA fuente de stats configurada (IW4MAdmin o games_mp.log). */
export function hasSyncSource(): boolean {
  return Boolean(env.iw4madminDbPath) || Boolean(env.gameLogPath);
}

/**
 * Intervalo efectivo de sync en MINUTOS (soporta fracciones: 30s → 0.5).
 * SYNC_INTERVAL_SECONDS tiene prioridad sobre SYNC_INTERVAL_MINUTES.
 */
export function getEffectiveSyncIntervalMinutes(): number {
  if (env.syncIntervalSeconds > 0) return env.syncIntervalSeconds / 60;
  return env.syncIntervalMinutes;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function computeKd(kills: number, deaths: number): number {
  return deaths > 0 ? kills / deaths : kills;
}

/** Heurística de skill documentada: kd*10 + kills por hora jugada. */
export function computeSkill(kills: number, deaths: number, timePlayedSeconds: number): number {
  const hours = Math.max(1, timePlayedSeconds / 3_600);
  return round2(computeKd(kills, deaths) * 10 + kills / hours);
}

function toSlices<T>(rows: T[], size: number): T[][] {
  const slices: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    slices.push(rows.slice(i, i + size));
  }
  return slices;
}

/**
 * Sincroniza IW4MAdmin → Prisma:
 *  1. Lee clientes (EFClient) y upserta agregaciones por GUID.
 *  2. Calcula kills/deaths con GROUP BY sobre EFClientKill.
 *  3. Importa kill events de forma incremental (Time > último epoch sincronizado).
 *
 * DEFENSIVO: cada fase corre en try/catch; los fallos se registran como warnings
 * y el sync continúa con lo que pueda. NUNCA escribe en la DB fuente (readonly).
 */
export async function runSync(): Promise<SyncResult> {
  const startedAt = new Date();
  const warnings: string[] = [];
  let ok = true;
  let playersSynced = 0;
  let killEventsSynced = 0;
  let syncError: unknown = null;

  const run = await prisma.syncRun.create({ data: { startedAt } });

  // Fuentes combinables: se ingesta cada una si está configurada.
  const hasIw4madmin = Boolean(env.iw4madminDbPath);
  const hasGameLog = Boolean(env.gameLogPath);
  if (!hasIw4madmin && !hasGameLog) {
    await prisma.syncRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), ok: false, warnings: 'Sin fuente configurada' } }).catch(() => undefined);
    throw Errors.syncNotConfigured();
  }

  try {
    if (hasIw4madmin) {
    const sourcePath = env.iw4madminDbPath;
    if (!sourcePath) throw Errors.syncNotConfigured(); // narrows: hasIw4madmin ya lo garantiza

    const reader = new IW4MAdminReader(sourcePath);
    reader.open();
    try {
      // ── Fase 1: jugadores ──────────────────────────────────────
      let clients: SourceClient[] = [];
      try {
        clients = reader.readClients();
      } catch (err) {
        ok = false;
        warnings.push(`[EFClient] error: ${errMessage(err)}`);
      }

      // ── Fase 2: agregaciones de kills/deaths ──────────────────
      let aggregates: KillAggregates = { kills: new Map(), deaths: new Map() };
      try {
        aggregates = reader.readKillAggregates();
      } catch (err) {
        warnings.push(`[EFClientKill] agregaciones: ${errMessage(err)}`);
      }

      // Etiquetas de servidor + última conexión por cliente (defensivo).
      const serverLabels = reader.readServerLabels();
      let lastServerByClient = new Map<number, number>();
      try {
        lastServerByClient = reader.readLastServerByClient();
      } catch (err) {
        warnings.push(`[EFClientConnectionHistory] error: ${errMessage(err)}`);
      }

      // ── Fase 3: upsert de jugadores con stats agregadas ───────
      for (const client of clients) {
        try {
          const kills = aggregates.kills.get(client.clientId) ?? 0;
          const deaths = aggregates.deaths.get(client.clientId) ?? 0;
          const rawServerId = lastServerByClient.get(client.clientId);
          const serverLabel = rawServerId !== undefined ? serverLabels.get(rawServerId) : undefined;
          const stats = {
            name: client.name ?? 'unknown',
            lastServer: serverLabel ?? (rawServerId !== undefined ? `server-${rawServerId}` : null),
            kills,
            deaths,
            kd: round2(computeKd(kills, deaths)),
            skill: computeSkill(kills, deaths, client.totalConnectionTime),
            timePlayed: client.totalConnectionTime,
            connections: client.connections,
            firstConnection: client.firstConnection,
            lastConnection: client.lastConnection,
          };
          await prisma.player.upsert({
            where: { guid: client.guid },
            create: { guid: client.guid, ...stats },
            update: stats,
          });
          playersSynced += 1;
        } catch (err) {
          warnings.push(`[player ${client.guid}] ${errMessage(err)}`);
        }
      }

      // ── Fase 4: kill events incrementales ─────────────────────
      try {
        const clientGuidById = new Map<number, string>(clients.map((client) => [client.clientId, client.guid] as const));
        const sourceKey = sourcePath;
        const state = await prisma.syncState.findUnique({ where: { source: sourceKey } });
        let afterEpoch = state?.lastKillEpoch ?? 0;

        for (let loop = 0; ; loop += 1) {
          if (loop > MAX_CHUNK_LOOPS) {
            warnings.push('[KillEvents] límite de lotes alcanzado; el resto se importará en la próxima sincronización.');
            break;
          }
          const chunk = reader.readKillEvents(clientGuidById, serverLabels, afterEpoch, EVENT_BATCH);
          if (chunk.warning !== null) warnings.push(chunk.warning);

          if (chunk.rows.length > 0) {
            for (const slice of toSlices(chunk.rows, INSERT_CHUNK)) {
              await prisma.killEvent.createMany({
                data: slice.map((event) => ({
                  originGuid: event.originGuid,
                  targetGuid: event.targetGuid,
                  isKill: event.isKill,
                  damage: event.damage,
                  weapon: event.weapon,
                  server: event.server,
                  time: event.time,
                  timeEpoch: event.epoch,
                })),
              });
            }
            killEventsSynced += chunk.rows.length;
          }

          afterEpoch = Math.max(afterEpoch, chunk.lastEpoch);
          if (!chunk.hasMore) break;
        }

        await prisma.syncState.upsert({
          where: { source: sourceKey },
          create: { source: sourceKey, lastKillEpoch: afterEpoch, lastRunAt: new Date() },
          update: { lastKillEpoch: afterEpoch, lastRunAt: new Date() },
        });
      } catch (err) {
        warnings.push(`[KillEvents] error: ${errMessage(err)}`);
      }

      warnings.push(...reader.warnings);
    } finally {
      reader.close();
    }
    } // fin if (hasIw4madmin)

    // ── Fuente 2: games_mp.log del servidor dedicado IW4x ────────
    // Ingesta incremental por offset de bytes (LogIngestState). Cada línea se
    // aplica exactamente una vez; tolera escrituras a medias y truncados.
    if (hasGameLog) {
      try {
        const logResult = await ingestGameLog(env.gameLogPath!, env.gameServerAddress ?? null);
        playersSynced += logResult.playersSynced;
        killEventsSynced += logResult.killEventsSynced;
        if (!logResult.ok) ok = false;
        if (logResult.linesIgnored > 0) {
          warnings.push(`[GameLog] ${logResult.linesIgnored} líneas no reconocidas (ignoradas).`);
        }
        if (logResult.eventsSkipped > 0) {
          warnings.push(`[GameLog] ${logResult.eventsSkipped} eventos descartados por GUIDs inválidos.`);
        }
        warnings.push(...logResult.warnings);
      } catch (err) {
        ok = false;
        warnings.push(`[GameLog] error: ${errMessage(err)}`);
      }
    }
  } catch (err) {
    ok = false;
    syncError = err;
    warnings.push(errMessage(err));
  } finally {
    const finishedAt = new Date();
    await prisma.syncRun
      .update({
        where: { id: run.id },
        data: {
          finishedAt,
          ok,
          playersSynced,
          killEventsSynced,
          warnings: warnings.length > 0 ? warnings.join('\n') : null,
        },
      })
      .catch(() => undefined);
  }

  if (syncError !== null) throw syncError;

  return {
    ok,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    playersSynced,
    killEventsSynced,
    warnings,
  };
}

/** Estado público (sin auth) para el frontend: cuándo se sincronizó por última vez con éxito. */
export async function getPublicSyncStatus(): Promise<PublicSyncStatusDto> {
  const lastOk = await prisma.syncRun.findFirst({
    where: { ok: true, finishedAt: { not: null } },
    orderBy: [{ finishedAt: 'desc' }],
    select: { finishedAt: true },
  });
  return {
    lastSyncAt: lastOk?.finishedAt?.toISOString() ?? null,
    configured: hasSyncSource(),
    intervalMinutes: getEffectiveSyncIntervalMinutes(),
    windowMinutes: env.linkWindowMinutes,
  };
}
