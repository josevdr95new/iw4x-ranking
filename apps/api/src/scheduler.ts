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

/** Activa la sincronización automática si SYNC_INTERVAL_MINUTES > 0. Devuelve el timer (o null). */
export function startSyncScheduler(): NodeJS.Timeout | null {
  const minutes = env.syncIntervalMinutes;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.log('[sync] sincronización automática desactivada (SYNC_INTERVAL_MINUTES=0)');
    return null;
  }
  const timer = setInterval(() => {
    void scheduledRun();
  }, minutes * 60_000);
  console.log(`[sync] sincronización automática activa cada ${minutes} minuto(s)`);
  return timer;
}

export function stopSyncScheduler(timer: NodeJS.Timeout | null): void {
  if (timer) clearInterval(timer);
}
