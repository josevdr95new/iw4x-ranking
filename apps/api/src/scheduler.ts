import { env } from './config/env.js';
import { runSync } from './services/sync/sync.service.js';
import { errMessage } from './lib/errors.js';

let running = false;

async function scheduledRun(): Promise<void> {
  if (running) return; // evita solapamientos si una corrida tarda más que el intervalo
  running = true;
  try {
    const result = await runSync();
    console.log(
      `[sync] programado: ok=${result.ok} jugadores=${result.playersSynced} killEvents=${result.killEventsSynced} warnings=${result.warnings.length}`,
    );
  } catch (err) {
    console.warn(`[sync] programado falló: ${errMessage(err)}`);
  } finally {
    running = false;
  }
}

/**
 * Activa la sincronización automática si hay intervalo configurado (>0).
 * SYNC_INTERVAL_SECONDS tiene prioridad sobre SYNC_INTERVAL_MINUTES.
 * Devuelve el timer (o null).
 */
export function startSyncScheduler(): NodeJS.Timeout | null {
  let intervalMs = 0;
  if (env.syncIntervalSeconds > 0) {
    intervalMs = env.syncIntervalSeconds * 1000;
    console.log(`[sync] sincronización automática activa cada ${env.syncIntervalSeconds} segundo(s)`);
  } else if (Number.isFinite(env.syncIntervalMinutes) && env.syncIntervalMinutes > 0) {
    intervalMs = env.syncIntervalMinutes * 60_000;
    console.log(`[sync] sincronización automática activa cada ${env.syncIntervalMinutes} minuto(s)`);
  }
  if (intervalMs <= 0) {
    console.log('[sync] sincronización automática desactivada (SYNC_INTERVAL_SECONDS=0 y SYNC_INTERVAL_MINUTES=0)');
    return null;
  }
  const timer = setInterval(() => {
    void scheduledRun();
  }, intervalMs);
  return timer;
}

export function stopSyncScheduler(timer: NodeJS.Timeout | null): void {
  if (timer) clearInterval(timer);
}
