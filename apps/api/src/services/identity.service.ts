import { prisma } from '../lib/prisma.js';
import { Errors } from '../lib/errors.js';
import { aliasKey, isBotGuid, normalizeDisplayName, rebuildAliases } from './alias.service.js';

/**
 * Alertas de identidad (anti-impersonación de nick registrado).
 *
 * El displayName de una cuenta web es un NICK RESERVADO (User.displayNameNormalized
 * único case-insensitive). Si en el games_mp.log aparece un guid NO vinculado al
 * dueño usando ese nick, se abre/actualiza una IdentityAlert. La ingesta es
 * read-only (detección); la resolución es manual del admin vía endpoints.
 */

/** Estados soportados (RESOLVED_IMPOSTOR queda reservado para flujo manual futuro). */
export const IDENTITY_ALERT_STATUSES = ['OPEN', 'RESOLVED_OWNER', 'RESOLVED_IMPOSTOR', 'DISMISSED'] as const;
export type IdentityAlertStatus = (typeof IDENTITY_ALERT_STATUSES)[number];

export interface IdentityAlertReportResult {
  outcome: 'created' | 'updated' | 'skipped';
  reason?: 'nick-no-registrado' | 'guid-del-propio-dueño' | 'guid-de-bot' | 'nombre-sin-identidad';
}

/**
 * Regla EXACTA de alerta (rama connect "J" de la ingesta):
 *  SÍ alerta cuando:
 *   - cleanName(name) == displayNameNormalized de UN user (nick registrado), Y
 *   - el guid NO está en los AccountLink de ESE user (el guid del propio dueño —
 *     o sus PCs declaradas multi-GUID — nunca alerta), Y
 *   - el guid NO es bot (fuera del rango 0xb07…; los bots re-usan nombres de la
 *     pool constantemente y no son personas).
 *   - Caso borde: guid linked a OTRO user ≠ owner → SÍ alerta (impersonación
 *     clásica: otra cuenta jugando con el nick reservado).
 *  Dedupe: una sola fila OPEN por (guid, ownerUserId) → occurrences+1/lastSeenAt;
 *  si no hay OPEN → crea (una alerta resuelta no se reabre: se crea una nueva).
 */
export async function reportIdentityAlert(input: { guid: string; name: string; when: Date }): Promise<IdentityAlertReportResult> {
  if (isBotGuid(input.guid)) return { outcome: 'skipped', reason: 'guid-de-bot' };
  const key = aliasKey(input.name);
  if (key === '' || key === 'unknown') return { outcome: 'skipped', reason: 'nombre-sin-identidad' };

  const owner = await prisma.user.findUnique({
    where: { displayNameNormalized: key },
    select: { id: true, accountLinks: { select: { guid: true } } },
  });
  if (!owner) return { outcome: 'skipped', reason: 'nick-no-registrado' };
  if (owner.accountLinks.some((link) => link.guid === input.guid)) {
    return { outcome: 'skipped', reason: 'guid-del-propio-dueño' };
  }

  const open = await prisma.identityAlert.findFirst({
    where: { guid: input.guid, ownerUserId: owner.id, status: 'OPEN' },
  });
  if (open) {
    await prisma.identityAlert.update({
      where: { id: open.id },
      data: { lastSeenAt: input.when, occurrences: { increment: 1 }, name: input.name },
    });
    return { outcome: 'updated' };
  }
  await prisma.identityAlert.create({
    data: {
      guid: input.guid,
      name: input.name,
      ownerUserId: owner.id,
      ownerLinkedGuidsSnapshot: JSON.stringify(owner.accountLinks.map((link) => link.guid)),
      status: 'OPEN',
      firstSeenAt: input.when,
      lastSeenAt: input.when,
      occurrences: 1,
    },
  });
  return { outcome: 'created' };
}

// ── Consulta y resolución (ADMIN) ────────────────────────────────────────────

export interface IdentityAlertDto {
  id: number;
  guid: string;
  name: string;
  status: IdentityAlertStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  owner: {
    id: number;
    email: string;
    displayName: string;
    /** Guids vinculados ACTUALES del dueño (el snapshot histórico va aparte). */
    linkedGuids: string[];
  };
  /** Snapshot de los guids del dueño cuando se detectó la alerta (o null). */
  ownerLinkedGuidsSnapshot: string[] | null;
}

export interface IdentityAlertsDto {
  alerts: IdentityAlertDto[];
  counts: Record<IdentityAlertStatus, number>;
  total: number;
}

function toAlertDto(
  alert: {
    id: number;
    guid: string;
    name: string;
    status: string;
    firstSeenAt: Date;
    lastSeenAt: Date;
    occurrences: number;
    ownerLinkedGuidsSnapshot: string | null;
    owner: { id: number; email: string; displayName: string; accountLinks: Array<{ guid: string }> };
  },
): IdentityAlertDto {
  let snapshot: string[] | null = null;
  if (alert.ownerLinkedGuidsSnapshot) {
    try {
      const parsed: unknown = JSON.parse(alert.ownerLinkedGuidsSnapshot);
      if (Array.isArray(parsed)) snapshot = parsed.map((g) => String(g));
    } catch {
      snapshot = null;
    }
  }
  return {
    id: alert.id,
    guid: alert.guid,
    name: alert.name,
    status: alert.status as IdentityAlertStatus,
    firstSeenAt: alert.firstSeenAt.toISOString(),
    lastSeenAt: alert.lastSeenAt.toISOString(),
    occurrences: alert.occurrences,
    owner: {
      id: alert.owner.id,
      email: alert.owner.email,
      displayName: alert.owner.displayName,
      linkedGuids: alert.owner.accountLinks.map((link) => link.guid),
    },
    ownerLinkedGuidsSnapshot: snapshot,
  };
}

/** Lista para el panel admin (filtro opcional por status; siempre lastSeen desc). */
export async function getIdentityAlerts(query: { status?: IdentityAlertStatus; limit: number }): Promise<IdentityAlertsDto> {
  const [alerts, grouped] = await Promise.all([
    prisma.identityAlert.findMany({
      ...(query.status !== undefined ? { where: { status: query.status } } : {}),
      orderBy: [{ lastSeenAt: 'desc' }],
      take: query.limit,
      include: { owner: { include: { accountLinks: { select: { guid: true }, orderBy: [{ id: 'asc' }] } } } },
    }),
    prisma.identityAlert.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);

  const counts: Record<IdentityAlertStatus, number> = { OPEN: 0, RESOLVED_OWNER: 0, RESOLVED_IMPOSTOR: 0, DISMISSED: 0 };
  for (const row of grouped) {
    if ((IDENTITY_ALERT_STATUSES as readonly string[]).includes(row.status)) {
      counts[row.status as IdentityAlertStatus] = row._count._all;
    }
  }
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { alerts: alerts.map(toAlertDto), counts, total };
}

/**
 * Resolución manual de una alerta:
 *  - LINK_TO_OWNER: crea AccountLink(owner, guid) si el guid NO está linked a
 *    otra cuenta (si lo está → 409 con explicación) y marca RESOLVED_OWNER.
 *  - DISMISS: marca DISMISSED (falso positivo / PC compartida declarada).
 *  El "castigar al impostor" no va aquí: el frontend compone POST
 *  /api/admin/iam/penalty (bridge existente) y luego llama resolve DISMISS.
 */
export async function resolveIdentityAlert(id: number, action: 'LINK_TO_OWNER' | 'DISMISS'): Promise<IdentityAlertDto> {
  const alert = await prisma.identityAlert.findUnique({
    where: { id },
    include: { owner: { include: { accountLinks: { select: { guid: true }, orderBy: [{ id: 'asc' }] } } } },
  });
  if (!alert) throw Errors.notFound(`No existe la alerta de identidad #${id}.`);
  if (alert.status !== 'OPEN') throw Errors.alertAlreadyResolved();

  if (action === 'DISMISS') {
    const dismissed = await prisma.identityAlert.update({
      where: { id },
      data: { status: 'DISMISSED' },
      include: { owner: { include: { accountLinks: { select: { guid: true }, orderBy: [{ id: 'asc' }] } } } },
    });
    return toAlertDto(dismissed);
  }

  // LINK_TO_OWNER: el guid debe estar libre (si es de otra cuenta → 409).
  const existingLink = await prisma.accountLink.findUnique({ where: { guid: alert.guid } });
  if (existingLink && existingLink.userId !== alert.ownerUserId) {
    throw Errors.guidLinkedToOtherAccount(alert.guid);
  }
  if (!existingLink) {
    // FK: AccountLink → Player. La ingesta ya lo crea al ver la J, pero somos defensivos.
    const player = await prisma.player.findUnique({ where: { guid: alert.guid }, select: { guid: true } });
    if (!player) {
      await prisma.player.create({ data: { guid: alert.guid, name: alert.name } });
    }
    await prisma.accountLink.create({ data: { userId: alert.ownerUserId, guid: alert.guid } });
  }
  const resolved = await prisma.identityAlert.update({
    where: { id },
    data: { status: 'RESOLVED_OWNER' },
    include: { owner: { include: { accountLinks: { select: { guid: true }, orderBy: [{ id: 'asc' }] } } } },
  });
  return toAlertDto(resolved);
}

// ── Bootstrap (npm run rebuild:identity) ─────────────────────────────────────

export interface SeedIdentityAlertsResult {
  usersScanned: number;
  aliasRowsScanned: number;
  alertsCreated: number;
  alertsUpdated: number;
}

/**
 * Bootstrap IDEMPOTENTE de alertas históricas: escanea PlayerAlias (ya poblado
 * por rebuild:aliases) buscando filas cuyo cleanName == displayNameNormalized de
 * algún user, con guid no vinculado al dueño y no-bot → mismas reglas que la
 * ingesta viva (dedupe OPEN por guid+owner). Las fechas/occurrences salen de la
 * fila de alias (aproximación histórica disponible).
 */
export async function seedIdentityAlerts(): Promise<SeedIdentityAlertsResult> {
  const result: SeedIdentityAlertsResult = { usersScanned: 0, aliasRowsScanned: 0, alertsCreated: 0, alertsUpdated: 0 };
  const [users, aliases] = await Promise.all([
    prisma.user.findMany({
      where: { displayNameNormalized: { not: null } },
      select: { id: true, displayNameNormalized: true, accountLinks: { select: { guid: true } } },
    }),
    prisma.playerAlias.findMany({
      select: { guid: true, name: true, firstSeenAt: true, lastSeenAt: true, occurrences: true },
    }),
  ]);
  result.usersScanned = users.length;
  result.aliasRowsScanned = aliases.length;

  const ownerByKey = new Map(users.map((u) => [u.displayNameNormalized as string, u] as const));
  for (const alias of aliases) {
    const key = aliasKey(alias.name);
    const owner = ownerByKey.get(key);
    if (!owner) continue;
    if (isBotGuid(alias.guid)) continue;
    if (owner.accountLinks.some((link) => link.guid === alias.guid)) continue;

    const open = await prisma.identityAlert.findFirst({
      where: { guid: alias.guid, ownerUserId: owner.id, status: 'OPEN' },
    });
    if (open) {
      await prisma.identityAlert.update({
        where: { id: open.id },
        data: {
          lastSeenAt: open.lastSeenAt > alias.lastSeenAt ? open.lastSeenAt : alias.lastSeenAt,
          firstSeenAt: open.firstSeenAt < alias.firstSeenAt ? open.firstSeenAt : alias.firstSeenAt,
          occurrences: Math.max(open.occurrences, alias.occurrences),
          name: alias.name,
        },
      });
      result.alertsUpdated += 1;
    } else {
      await prisma.identityAlert.create({
        data: {
          guid: alias.guid,
          name: alias.name,
          ownerUserId: owner.id,
          ownerLinkedGuidsSnapshot: JSON.stringify(owner.accountLinks.map((link) => link.guid)),
          status: 'OPEN',
          firstSeenAt: alias.firstSeenAt,
          lastSeenAt: alias.lastSeenAt,
          occurrences: alias.occurrences,
        },
      });
      result.alertsCreated += 1;
    }
  }
  return result;
}

export interface NormalizeDisplayNamesResult {
  usersScanned: number;
  normalizedSet: number;
  renames: Array<{ userId: number; email: string; from: string; to: string }>;
}

/**
 * Siembra/normaliza User.displayNameNormalized (nick reservado) para filas
 * existentes. IDEMPOTENTE. Si dos cuentas colisionan tras normalizar, a la más
 * nueva se le añade sufijo "-2", "-3"... (reportado; el displayName visible NO
 * se toca, solo la columna técnica única).
 */
export async function normalizeDisplayNames(): Promise<NormalizeDisplayNamesResult> {
  const result: NormalizeDisplayNamesResult = { usersScanned: 0, normalizedSet: 0, renames: [] };
  const users = await prisma.user.findMany({ orderBy: [{ id: 'asc' }] });
  result.usersScanned = users.length;
  const taken = new Set<string>();
  for (const user of users) {
    if (user.displayNameNormalized !== null) taken.add(user.displayNameNormalized);
  }
  for (const user of users) {
    const base = normalizeDisplayName(user.displayName);
    if (base === '' || base === 'unknown') continue; // nick sin identidad: sin reserva
    let candidate = base;
    let suffix = 2;
    while (taken.has(candidate) && user.displayNameNormalized !== candidate) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    if (user.displayNameNormalized === candidate) continue; // ya normalizado
    await prisma.user.update({ where: { id: user.id }, data: { displayNameNormalized: candidate } });
    taken.add(candidate);
    result.normalizedSet += 1;
    if (candidate !== base) {
      result.renames.push({ userId: user.id, email: user.email, from: base, to: candidate });
    }
  }
  return result;
}

/** Pipeline completo de bootstrap de identidad (idempotente, en orden correcto). */
export async function rebuildIdentity(logPath: string | null): Promise<{
  normalize: NormalizeDisplayNamesResult;
  aliases: ReturnType<typeof rebuildAliases> extends Promise<infer T> ? T : never;
  alerts: SeedIdentityAlertsResult;
}> {
  const normalize = await normalizeDisplayNames();
  const aliases = await rebuildAliases({ logPath });
  const alerts = await seedIdentityAlerts();
  return { normalize, aliases, alerts };
}
