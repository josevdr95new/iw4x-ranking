/**
 * ENFORCER de moderación nativa: worker por intervalo que garantiza las
 * penalidades de NUESTRA DB contra EL/LOS server(s) IW4x vía rcon.
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
 *  - MULTI-SALA (env `RCON_SALAS`): itera TODAS las salas y kickea al guid en
 *    cada sala donde esté conectado. Una sala caída no afecta a las demás.
 *    Sin RCON_SALAS: server único de siempre (COMPAT total).
 *  - Nunca reintentos ciegos: los kicks del enforcer son writes de 1 intento.
 *  - Se arranca SOLO si hay RCON (RCON_PASSWORD o RCON_SALAS) y NODE_ENV != test.
 */
import { prisma } from '../lib/prisma.js';
import { errMessage } from '../lib/errors.js';
import { statusGuidDecimal, stripColorCodes, type StatusPlayer } from '../lib/rcon/iw4x-rcon.js';
import { getRconTargets, isModerationRconConfigured } from '../lib/rcon/salas.js';
import { normalizeDisplayName } from './alias.service.js';
import { getLauncherOnly } from './setting.service.js';
import { env } from '../config/env.js';

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
    // MULTI-SALA: status + kicks por sala; una sala caída solo se loguea.
    for (const target of getRconTargets()) {
      try {
        const status = await target.client.status();
        for (const slot of status.players) {
          const guid = slotGuid(slot);
          if (guid === null) continue;
          const penalty = wanted.get(guid);
          if (!penalty) continue;
          try {
            await target.client.clientkick(slot.cid);
            kicks += 1;
            console.log(
              `[enforcer] sala=${target.id} guid=${guid} (${penalty.offenderName ?? 'unknown'}) kickeado por ${penalty.type} activo (penalty#${penalty.id}).`,
            );
          } catch (err) {
            console.warn(`[enforcer] sala=${target.id} fallo al kickear guid=${guid} slot=${slot.cid}: ${errMessage(err)}`);
          }
        }
      } catch (err) {
        console.warn(`[enforcer] sala=${target.id} (${target.host}:${target.port}) sin status: ${errMessage(err)}`);
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
 * Cada intervalo ejecuta DOS ciclos: (1) penalidades de nuestra DB (bans/
 * tempbans) y (2) enforcement launcher-only si el setting está activo.
 * Devuelve el timer (o null si no arrancó).
 */
export function startModerationEnforcer(intervalMs?: number): NodeJS.Timeout | null {
  if (process.env.NODE_ENV === 'test') return null;
  if (!isModerationRconConfigured()) {
    console.log('[enforcer] moderación nativa desactivada: falta RCON_PASSWORD/RCON_SALAS.');
    return null;
  }
  const interval = intervalMs ?? Number(process.env.RCON_ENFORCER_INTERVAL_MS ?? '30000');
  const safeInterval = Number.isFinite(interval) && interval >= 1000 ? interval : 30_000;
  console.log(`[enforcer] activo cada ${safeInterval}ms (moderación nativa por RCON).`);
  const timer = setInterval(() => {
    void (async () => {
      await runEnforcerTick();
      await runLauncherOnlyTick();
    })();
  }, safeInterval);
  // No retiene el proceso vivo solo por el enforcer.
  timer.unref?.();
  return timer;
}

export function stopModerationEnforcer(timer: NodeJS.Timeout | null): void {
  if (timer) clearInterval(timer);
}

// ── Enforcer LAUNCHER-ONLY (anti no-launcher) ──────────────────────────────

let launcherRunning = false;

/**
 * Un tick del enforcer launcher-only. Reglas EXACTAS:
 *  - Setting launcher_only = false → NADA (cero kicks, cero lecturas rcon).
 *  - Para cada HUMANO conectado (bots SIEMPRE exentos; CNCT/ZMBI = conectando,
 *    gracia: no se kickea mientras negocia):
 *      · tiene sesión activa por GUID (session.guid == su guid decimal), O
 *      · tiene sesión activa cuyo nick normalizado matchea su nick → OK.
 *      · si no → `tell <cid> <mensaje>` + `clientkick <cid>` (el mensaje NO va
 *        en el clientkick: el protocolo no lo soporta; el tell lo ve antes de
 *        ser expulsado y el log queda en consola de la API).
 *  - `now` inyectable para tests. Devuelve el nº de kicks enviados.
 */
export async function runLauncherOnlyTick(now: number = Date.now()): Promise<number> {
  if (launcherRunning) return 0;
  launcherRunning = true;
  try {
    const enabled = await getLauncherOnly();
    if (!enabled) return 0;
    if (getRconTargets().length === 0) return 0;

    const sessions = await prisma.playSession.findMany({ where: { expiresAt: { gt: new Date(now) } } });
    const byGuid = new Set(sessions.filter((s) => s.guid !== null).map((s) => s.guid as string));
    const byNick = new Set(sessions.map((s) => normalizeDisplayName(s.nick)).filter((n) => n !== ''));

    const message = env.launcherOnlyKickMsg;
    let kicks = 0;
    // MULTI-SALA: las sesiones válidas (por guid o nick) cubren TODAS las
    // salas; en cada una se kickea a los humanos sin sesión.
    for (const target of getRconTargets()) {
      let status;
      try {
        status = await target.client.status();
      } catch (err) {
        console.warn(`[enforcer] launcher-only: sala=${target.id} (${target.host}:${target.port}) sin status: ${errMessage(err)}`);
        continue;
      }
      for (const slot of status.players) {
        if (slot.connecting) continue; // gracia mientras conecta (CNCT/ZMBI)
        if (slot.isBot) continue; // bots SIEMPRE exentos
        const guid = statusGuidDecimal(slot);
        const nick = normalizeDisplayName(stripColorCodes(slot.name));
        const allowed = (guid !== null && byGuid.has(guid)) || (nick !== '' && byNick.has(nick));
        if (allowed) continue;
        try {
          await target.client.tell(slot.cid, message);
          await target.client.clientkick(slot.cid);
          kicks += 1;
          console.log(
            `[enforcer] launcher-only: sala=${target.id} slot=${slot.cid} "${stripColorCodes(slot.name)}" (guid=${guid ?? slot.guid}) kickeado: sin sesión de launcher activa.`,
          );
        } catch (err) {
          console.warn(`[enforcer] launcher-only: sala=${target.id} fallo al kickear slot=${slot.cid}: ${errMessage(err)}`);
        }
      }
    }
    return kicks;
  } catch (err) {
    console.warn(`[enforcer] launcher-only tick falló: ${errMessage(err)}`);
    return 0;
  } finally {
    launcherRunning = false;
  }
}
