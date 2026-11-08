import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { aliasKey, isBotGuid, normalizeDisplayName } from './alias.service.js';

/**
 * SESIONES DE JUEGO del launcher (anti no-launcher) + AUTO-LINK por sesión.
 *
 * El launcher llama POST /api/play/session (JWT de usuario) al dar JUGAR y en
 * cada heartbeat: crea/refresca la fila PlaySession de ESA cuenta con TTL
 * DESLIZANTE (env PLAY_SESSION_TTL_MIN, default 10 min). Idempotente: un
 * refresh es un upsert (una fila por cuenta, userId @unique).
 *
 * AUTO-LINK (sustituye el polling del launcher): en la ingesta del
 * games_mp.log, cuando un player conecta con un nick que matchea el
 * displayNameNormalized de una cuenta SIN guids vinculados Y esa cuenta tiene
 * sesión ACTIVA (expiresAt > now) → se crea el AccountLink automáticamente y
 * se sella session.guid. Sin sesión activa → comportamiento previo
 * (IdentityAlert anti-impersonación). Si el guid YA está vinculado a OTRA
 * cuenta → también comportamiento previo (alerta; nunca re-asignamos).
 *
 * TIGHTENING anti herencia cruzada: una cuenta CON guids vinculados ya NO
 * auto-linkea guids nuevos aunque el nick matchee y haya sesión activa (la
 * identidad por cuenta es 1 guid principal; el link adicional legítimo va por
 * /api/link o por el flujo de cuarentena POST /api/identity/claim-fresh, que
 * re-habilita el auto-link UNA sola vez para el guid nuevo que nazca).
 *
 * Los guids de BOT jamás se vinculan (los bots reusan nombres y no son
 * cuentas — mismo guard que la capa HTTP de link).
 */

export interface PlaySessionDto {
  userId: number;
  nick: string;
  guid: string | null;
  lastSeen: string;
  expiresAt: string;
}

export interface StartPlaySessionResult {
  ok: true;
  nick: string;
  expiresAt: string;
}

/** TTL en ms leído FRESCO de process.env (los tests mutan la env por caso). */
export function playSessionTtlMs(): number {
  const raw = process.env.PLAY_SESSION_TTL_MIN;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed * 60_000;
  }
  return env.playSessionTtlMin * 60_000;
}

/**
 * Crea o refresca la sesión de juego de la cuenta (TTL deslizante). Devuelve
 * el shape EXACTO del contrato del launcher: {ok, nick, expiresAt}.
 */
export async function startOrRefreshPlaySession(userId: number, now: number = Date.now()): Promise<StartPlaySessionResult> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } });
  if (!user) throw new Error(`PlaySession: la cuenta ${userId} no existe.`);

  const lastSeen = new Date(now);
  const expiresAt = new Date(now + playSessionTtlMs());
  await prisma.playSession.upsert({
    where: { userId },
    create: { userId, nick: user.displayName, guid: null, lastSeen, expiresAt },
    update: { nick: user.displayName, lastSeen, expiresAt },
  });
  return { ok: true, nick: user.displayName, expiresAt: expiresAt.toISOString() };
}

/** Lista de sesiones ACTIVAS (expiresAt > now) para el panel admin. */
export async function getActivePlaySessions(now: number = Date.now()): Promise<PlaySessionDto[]> {
  const rows = await prisma.playSession.findMany({
    where: { expiresAt: { gt: new Date(now) } },
    orderBy: [{ userId: 'asc' }],
  });
  return rows.map((row) => ({
    userId: row.userId,
    nick: row.nick,
    guid: row.guid,
    lastSeen: row.lastSeen.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }));
}

export interface AutoLinkBySessionResult {
  outcome: 'linked' | 'skipped';
  reason?: string;
}

/**
 * AUTO-LINK por sesión, llamado por la ingesta en cada línea J (connect).
 * REGLAS EXACTAS (identidad por cuenta = 1 guid principal):
 *  1. guid de bot → skip (los bots no son cuentas; isBotGuid = rango 0xb07…).
 *  2. nick sin identidad (vacío/'unknown') → skip.
 *  3. nick no registrado → skip.
 *  4. guid YA vinculado (a la misma cuenta o a otra) → skip 'guid-ya-vinculado'
 *     (la alerta de identidad sigue su curso como hoy).
 *  5. TIGHTENING anti herencia cruzada: cuenta del nick CON guids vinculados
 *     (PC compartida declarada) + guid DISTINTO de todos los suyos → skip
 *     'cuenta-con-guids' aunque haya sesión activa (antes se linkeaba si el
 *     guid entraba libre: así era como una cuenta heredaba el guid de otra en
 *     la misma PC). La alerta anti-impersonación sigue normal. La vía legítima
 *     para un guid nuevo adicional es la vinculación manual (/api/link) o el
 *     flujo de cuarentena (claim-fresh, regla 7).
 *  6. cuenta del nick SIN guids + PlaySession ACTIVA → crea AccountLink + sella
 *     session.guid + log "Auto-link por sesión: ...".
 *  7. CUARENTENA claim-fresh: cuenta CON guids y User.claimFreshAt seteado
 *     (POST /api/identity/claim-fresh) + guid NUEVO (no coincide con ninguno de
 *     los suyos) + sesión ACTIVA → SÍ linkea (el guid nuevo que nazca), sella
 *     session.guid y LIMPIA la marca (one-shot). Los guids viejos de la cuenta
 *     siguen sin matchear (claim-fresh ya desreferenció el PlaySession.guid).
 *  8. Sin sesión activa → skip 'sin-sesion-activa' (IdentityAlert como siempre).
 */
export async function tryAutoLinkBySession(input: { guid: string; name: string; when: Date }): Promise<AutoLinkBySessionResult> {
  if (isBotGuid(input.guid)) return { outcome: 'skipped', reason: 'guid-de-bot' };
  const key = aliasKey(input.name);
  if (key === '' || key === 'unknown') return { outcome: 'skipped', reason: 'nombre-sin-identidad' };

  const owner = await prisma.user.findUnique({
    where: { displayNameNormalized: key },
    select: {
      id: true,
      displayName: true,
      claimFreshAt: true,
      accountLinks: { select: { guid: true } },
      playSessions: { select: { userId: true, expiresAt: true }, take: 1 },
    },
  });
  if (!owner) return { outcome: 'skipped', reason: 'nick-no-registrado' };

  const hasGuids = owner.accountLinks.length > 0;
  const isNewGuidForAccount = !owner.accountLinks.some((link) => link.guid === input.guid);
  if (hasGuids && !owner.claimFreshAt) return { outcome: 'skipped', reason: 'cuenta-con-guids' };

  const session = owner.playSessions[0];
  if (!session || session.expiresAt.getTime() <= input.when.getTime()) {
    return { outcome: 'skipped', reason: 'sin-sesion-activa' };
  }

  const existingLink = await prisma.accountLink.findUnique({ where: { guid: input.guid }, select: { id: true } });
  if (existingLink) return { outcome: 'skipped', reason: 'guid-ya-vinculado' };

  // FK AccountLink → Player: la ingesta ya creó el Player (applyConnect corre
  // antes), pero somos defensivos ante J fuera de orden.
  const player = await prisma.player.findUnique({ where: { guid: input.guid }, select: { guid: true } });
  if (!player) {
    await prisma.player.create({ data: { guid: input.guid, name: input.name || 'unknown' } });
  }

  try {
    // claim-fresh es ONE-SHOT: la marca se limpia al materializarse el link del
    // guid nuevo (misma transacción: link + flag van juntos o no van).
    const shouldClearClaimFresh = owner.claimFreshAt !== null;
    await prisma.$transaction([
      prisma.accountLink.create({ data: { userId: owner.id, guid: input.guid } }),
      ...(shouldClearClaimFresh ? [prisma.user.update({ where: { id: owner.id }, data: { claimFreshAt: null } })] : []),
    ]);
  } catch {
    // Carrera: otro proceso vinculo el guid entre el check y el create (unique).
    return { outcome: 'skipped', reason: 'guid-ya-vinculado' };
  }
  await prisma.playSession.update({
    where: { userId: owner.id },
    data: { guid: input.guid },
  });
  console.log(`Auto-link por sesión: nick ${input.name} (guid ${input.guid}) → cuenta ${owner.displayName} (#${owner.id})`);
  return { outcome: 'linked' };
}

/** ¿Existe una sesión activa que dé cobertura a ese guid O a ese nick? (enforcer) */
export async function hasActiveSessionFor(guid: string | null, nickRaw: string, now: number = Date.now()): Promise<boolean> {
  const sessions = await prisma.playSession.findMany({ where: { expiresAt: { gt: new Date(now) } } });
  const wantedNick = normalizeDisplayName(nickRaw);
  return sessions.some((session) => {
    if (guid !== null && session.guid === guid) return true;
    return aliasKey(session.nick) === wantedNick && wantedNick !== '';
  });
}
