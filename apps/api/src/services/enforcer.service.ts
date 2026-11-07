/**
 * ENFORCER de moderación nativa: worker por intervalo que garantiza las
 * penalidades de NUESTRA DB contra el server IW4x vía rcon.
 *
 * ¿Por qué existe? El juego NO tiene tempban per-caso por minutos (el nativo
 * `tempbanclient` usa el dvar GLOBAL sv_kickBanTime) y el ban permanente solo
 * se persiste en bans.json vía banClient (que exige al jugador conectado).
 * Este worker cierra la brecha:
 *
 *  - Cada tick: lee las Penalty activas (ban permanente o tempban NO expirado)
 *    de nuestra DB, hace `status` por rcon y clientkick a cualquier guid
 *    baneado que esté conectado (log discreto). Al expirar el tempban el
 *    jugador vuelve solo: la fila queda inactive y deja de kickearse.
 *  - Nunca reintentos ciegos: los kicks del enforcer son writes de 1 intento.
 *  - Se arranca SOLO si RCON_PASSWORD está configurado y NODE_ENV != test.
 */
import { prisma } from '../lib/prisma.js';
import { errMessage } from '../lib/errors.js';
import { getSharedRcon, isRconConfigured, statusGuidDecimal, type StatusPlayer } from '../lib/rcon/iw4x-rcon.js';

interface EnforceablePenalty {
  id: number;
  offenderGuid: string;
  offenderName: string | null;
  type: string;
}

let running = false;

/** Guid de una fila de status normalizado (decimal para humanos, botN para bots). */
function slotGuid(slot: StatusPlayer): string | null {
  if (slot.connecting) return null;
  if (slot.isBot) return slot.guid.toLowerCase();
  return statusGuidDecimal(slot);
}

/**
 * Un tick del enforcer. `now` inyectable para tests (timers fake).
 * Devuelve el nº de kicks enviados.
 */
export async function runEnforcerTick(now: number = Date.now()): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    // Limpieza lazy: tempbans ya expirados dejan de estar activos.
    await prisma.penalty.updateMany({
      where: { type: 'tempban', active: true, expiresAt: { lte: new Date(now) } },
      data: { active: false },
    });

    const active = (await prisma.penalty.findMany({
      where: {
        type: { in: ['tempban', 'ban'] },
        active: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(now) } }],
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 500,
    })) as EnforceablePenalty[];
    if (active.length === 0) return 0;

    // Dedupe por guid (un guid puede tener varias filas activas).
    const wanted = new Map<string, EnforceablePenalty>();
    for (const penalty of active) {
      if (!wanted.has(penalty.offenderGuid)) wanted.set(penalty.offenderGuid, penalty);
    }

    let kicks = 0;
    const status = await getSharedRcon().status();
    for (const slot of status.players) {
      const guid = slotGuid(slot);
      if (guid === null) continue;
      const penalty = wanted.get(guid);
      if (!penalty) continue;
      try {
        await getSharedRcon().clientkick(slot.cid);
        kicks += 1;
        console.log(
          `[enforcer] guid=${guid} (${penalty.offenderName ?? 'unknown'}) kickeado por ${penalty.type} activo (penalty#${penalty.id}).`,
        );
      } catch (err) {
        console.warn(`[enforcer] fallo al kickear guid=${guid} slot=${slot.cid}: ${errMessage(err)}`);
      }
    }
    return kicks;
  } catch (err) {
    console.warn(`[enforcer] tick falló: ${errMessage(err)}`);
    return 0;
  } finally {
    running = false;
  }
}

/**
 * Arranca el enforcer con guards: RCON_PASSWORD configurado + NODE_ENV != test.
 * Devuelve el timer (o null si no arrancó).
 */
export function startModerationEnforcer(intervalMs?: number): NodeJS.Timeout | null {
  if (process.env.NODE_ENV === 'test') return null;
  if (!isRconConfigured()) {
    console.log('[enforcer] moderación nativa desactivada: falta RCON_PASSWORD.');
    return null;
  }
  const interval = intervalMs ?? Number(process.env.RCON_ENFORCER_INTERVAL_MS ?? '30000');
  const safeInterval = Number.isFinite(interval) && interval >= 1000 ? interval : 30_000;
  console.log(`[enforcer] activo cada ${safeInterval}ms (moderación nativa por RCON).`);
  const timer = setInterval(() => {
    void runEnforcerTick();
  }, safeInterval);
  // No retiene el proceso vivo solo por el enforcer.
  timer.unref?.();
  return timer;
}

export function stopModerationEnforcer(timer: NodeJS.Timeout | null): void {
  if (timer) clearInterval(timer);
}
