/**
 * MODERACIÓN NATIVA por RCON del server dedicado IW4x (namespace /api/admin/iam/*).
 *
 * Reemplaza al bridge con el webfront de IW4MAdmin: mismos paths y shapes para
 * la web (ModerationPanel/PenaltyModal NO cambian), implementación interna
 * nueva:
 *
 *  - Upstream → rcon directo (lib/rcon/iw4x-rcon.ts): status/getinfo para leer,
 *    tell/clientkick/banClient/unbanClient para escribir (1 intento, sin retry).
 *  - Historial de penalidades → NUESTRA DB (modelo Penalty), ya NO la SQLite
 *    de IW4MAdmin.
 *  - Warn/kick aplican a players CONECTADOS (slot cid); tempban/ban funcionan
 *    ONLINE (rcon inmediato) y OFFLINE (capa DB + enforcer que re-kickea al
 *    conectar — ver enforcer.service.ts).
 *  - TempBan per-caso por minutos: el juego NO lo tiene nativo
 *    (tempbanclient usa el dvar GLOBAL sv_kickBanTime) → clientkick inmediato +
 *    Penalty con expiresAt + enforcer.
 *  - Bots: warn/tempban/ban → 403 TARGET_IS_BOT; kick SÍ (limpiar slots).
 *  - Anti-TOCTOU: antes de una escritura con slot se RE-LÉE status y se
 *    verifica que ese cid sigue teniendo el guid objetivo → 409 CID_MISMATCH.
 */
import { readFileSync } from 'node:fs';
import { AppError, Errors, errMessage } from '../lib/errors.js';
import {
  decimalGuidToHex,
  getSharedRcon,
  hexGuidToDecimal,
  isRconConfigured,
  statusGuidDecimal,
  stripColorCodes,
  type InfoString,
  type RconStatus,
  type StatusPlayer,
} from '../lib/rcon/iw4x-rcon.js';
import { prisma } from '../lib/prisma.js';
import { MAX_TEMPBAN_MINUTES, type IamClientsQuery, type IamLiveQuery, type IamPenaltiesQuery, type IamPenaltyInput, type IamPenaltyType } from '../dto/iam.dto.js';

// ── Errores → AppError (handler central) ───────────────────────────────────

export interface PunisherInfo {
  userId: number;
  name: string;
}

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err as AppError;
  const message = errMessage(err);
  if (message.includes('RCON_PASSWORD no está configurado')) {
    return new AppError(
      503,
      'MODERATION_NOT_CONFIGURED',
      'La moderación nativa no está configurada: define RCON_PASSWORD (el del server.cfg del server IW4x).',
    );
  }
  if (message.includes('RCON')) {
    return new AppError(502, 'MODERATION_UNREACHABLE', `El server IW4x no respondió por RCON: ${message}`);
  }
  return new AppError(500, 'MODERATION_INTERNAL', `Error interno de moderación: ${message}`);
}

async function withModerationErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    throw toAppError(err);
  }
}

// ── Identidad del server (id estable derivado de host:port) ────────────────

/** Id numérico estable del server (host sin puntos + puerto). Ej: 127.0.0.1:28961 → 12700128961. */
export function moderationServerId(): number {
  const host = process.env.RCON_HOST?.trim() || '127.0.0.1';
  const port = process.env.RCON_PORT?.trim() || '28961';
  const digitsOnly = host.replace(/\D+/g, '');
  const composed = Number(`${digitsOnly}${port}`);
  if (Number.isSafeInteger(composed) && composed > 0) return composed;
  // Hosts no-IP (dominios): hash estable barato sobre el string completo.
  let hash = 0;
  for (const ch of `${host}:${port}`) {
    hash = (hash * 31 + ch.charCodeAt(0)) % 2_000_000_000;
  }
  return hash + 1;
}

// ── GET /api/admin/iam/status (diagnóstico; SIEMPRE 200) ───────────────────

export interface ModerationStatus {
  configured: boolean;
  reachable: boolean;
  penaltiesDb: { configured: boolean };
  error: string | null;
  servers: Array<{
    id: number;
    name: string;
    game: string;
    map: string | null;
    gametype: string | null;
    players: number;
    maxPlayers: number;
    parser: string | null;
  }>;
}

/** Diagnóstico del server rcon. Nunca explota 502: expone el error legible. */
export async function getModerationStatus(): Promise<ModerationStatus> {
  return withModerationErrors(async () => {
    const configured = isRconConfigured();
    const status: ModerationStatus = {
      configured,
      reachable: false,
      penaltiesDb: { configured: true }, // NUESTRA DB: siempre disponible
      error: null,
      servers: [],
    };
    if (!configured) {
      status.error = 'RCON_PASSWORD no está configurado: la moderación nativa está deshabilitada.';
      return status;
    }
    try {
      const rcon = getSharedRcon();
      const [info, live] = await Promise.all([rcon.getinfo(), rcon.status()]);
      status.reachable = true;
      status.servers = [
        {
          id: moderationServerId(),
          name: info.hostname ?? '(sin hostname)',
          game: 'IW4',
          map: live.map ?? info.mapname ?? null,
          gametype: info.gametype ?? null,
          players: live.players.filter((player) => !player.connecting).length,
          maxPlayers: Number(info.sv_maxclients ?? 0),
          parser: 'IW4x RCON',
        },
      ];
    } catch (err) {
      status.error = errMessage(err);
    }
    return status;
  });
}

// ── Utilidades de targeting ────────────────────────────────────────────────

export interface ResolvedTarget {
  /** Slot (cid) si el target está conectado. */
  cid: number | null;
  /** Fila de status si está conectado. */
  slot: StatusPlayer | null;
  /** Guid normalizado (decimal, o "botN" para bots). */
  guid: string;
  /** Nombre limpio (sin color codes) del objetivo. */
  name: string;
  isBot: boolean;
}

function cleanName(raw: string): string {
  return stripColorCodes(raw).toLowerCase();
}

function findSlotByGuid(status: RconStatus, guidDecimal: string): StatusPlayer | undefined {
  return status.players.find((player) => {
    if (player.connecting) return false;
    if (player.isBot) return player.guid.toLowerCase() === guidDecimal.toLowerCase();
    return statusGuidDecimal(player) === guidDecimal;
  });
}

function findSlotByName(status: RconStatus, wantedClean: string): StatusPlayer[] {
  return status.players.filter((player) => !player.connecting && cleanName(player.name) === wantedClean);
}

function findSlotByCid(status: RconStatus, cid: number): StatusPlayer | undefined {
  return status.players.find((player) => player.cid === cid && !player.connecting);
}

/**
 * Resuelve el objetivo desde el status VIVO. Puede fallar con:
 *  - 404 MODERATION_TARGET_NOT_FOUND (clientId de Player inexistente)
 *  - 400 TARGET_NOT_ONLINE (warn/kick sin slot conectado)
 */
async function resolveTarget(input: IamPenaltyInput, status: RconStatus): Promise<ResolvedTarget> {
  if (input.clientId !== undefined) {
    const player = await prisma.player.findUnique({ where: { id: input.clientId } });
    if (!player) {
      throw new AppError(
        404,
        'MODERATION_TARGET_NOT_FOUND',
        `No existe ningún jugador conocido con clientId ${input.clientId} (no está en la base del ranking).`,
      );
    }
    const slot = findSlotByGuid(status, player.guid);
    return {
      cid: slot?.cid ?? null,
      slot: slot ?? null,
      guid: player.guid,
      name: slot ? stripColorCodes(slot.name) : player.name,
      isBot: player.isBot || (slot?.isBot ?? false),
    };
  }

  if (input.cid !== undefined) {
    const slot = findSlotByCid(status, input.cid);
    if (!slot) {
      throw Errors.validation(`El slot ${input.cid} no tiene ningún jugador conectado (o sigue conectando).`);
    }
    const guid = slot.isBot ? slot.guid.toLowerCase() : statusGuidDecimal(slot) ?? slot.guid;
    return { cid: slot.cid, slot, guid, name: stripColorCodes(slot.name), isBot: slot.isBot };
  }

  // clientName: match EXACTO (limpio) contra los players EN VIVO.
  const wanted = cleanName(input.clientName ?? '');
  const exacts = findSlotByName(status, wanted);
  if (exacts.length === 0) {
    throw new AppError(
      404,
      'MODERATION_TARGET_NOT_FOUND',
      `No hay ningún jugador conectado con nombre exacto "${input.clientName}". La moderación nativa solo busca entre los conectados: usa clientId (base del ranking) para targets offline.`,
    );
  }
  if (exacts.length > 1) {
    throw Errors.validation(
      `El nombre coincide con ${exacts.length} jugadores conectados (slots: ${exacts
        .map((slot) => slot.cid)
        .join(', ')}) — envía clientId o cid para desambiguar.`,
    );
  }
  const slot = exacts[0]!;
  const guid = slot.isBot ? slot.guid.toLowerCase() : statusGuidDecimal(slot) ?? slot.guid;
  return { cid: slot.cid, slot, guid, name: stripColorCodes(slot.name), isBot: slot.isBot };
}

/**
 * Anti-TOCTOU: ANTES de una escritura con slot, RE-LÉE status y verifica que
 * ese cid sigue teniendo el guid del objetivo. Si cambió → 409 CID_MISMATCH.
 */
async function verifySlotGuid(cid: number, expectedGuid: string): Promise<void> {
  const fresh = await getSharedRcon().status();
  const slot = findSlotByCid(fresh, cid);
  const freshGuid = slot ? (slot.isBot ? slot.guid.toLowerCase() : statusGuidDecimal(slot)) : null;
  if (!slot || freshGuid !== expectedGuid) {
    throw new AppError(
      409,
      'CID_MISMATCH',
      `El slot ${cid} ya no corresponde al objetivo (cambió el jugador en ese slot entre la lectura y la acción): ` +
        'no se envió ningún comando. Reintenta: el target se re-resuelve contra el estado nuevo.',
    );
  }
}

// ── Registro en NUESTRA DB (Penalty) ───────────────────────────────────────

/** Upsert ligero del Player del ofensor (bots: guid "botN" + isBot). */
async function ensureOffenderPlayer(guid: string, name: string, isBot: boolean): Promise<number | null> {
  const existing = await prisma.player.findUnique({ where: { guid }, select: { id: true } });
  if (existing) return existing.id;
  const created = await prisma.player.create({
    data: { guid, name: name || 'unknown', isBot },
    select: { id: true },
  });
  return created.id;
}

async function recordPenalty(params: {
  type: IamPenaltyType | 'unban';
  guid: string;
  name: string;
  isBot: boolean;
  reason: string;
  punisher?: PunisherInfo | null;
  expiresAt?: Date | null;
  source?: 'panel' | 'enforcer';
}): Promise<{ penaltyId: number; offenderPlayerId: number | null }> {
  const offenderPlayerId = await ensureOffenderPlayer(params.guid, params.name, params.isBot);
  const created = await prisma.penalty.create({
    data: {
      offenderGuid: params.guid,
      offenderPlayerId,
      offenderName: params.name || null,
      punisherUserId: params.punisher?.userId ?? null,
      punisherName: params.punisher?.name ?? null,
      type: params.type,
      reason: params.reason,
      automated: params.source === 'enforcer',
      source: params.source ?? 'panel',
      active: params.type !== 'unban' && params.type !== 'kick',
      expiresAt: params.expiresAt ?? null,
    },
    select: { id: true },
  });
  return { penaltyId: created.id, offenderPlayerId };
}

// ── POST /api/admin/iam/penalty ────────────────────────────────────────────

export interface ModerationPenaltyResult {
  executed: boolean;
  type: IamPenaltyType;
  clientId: number | null;
  serverId: number;
  /** Relé textual de los comandos rcon enviados (para el UI). */
  output: string[];
}

function assertBotsAllowed(type: IamPenaltyType, isBot: boolean): void {
  if (isBot && type !== 'kick') {
    throw new AppError(403, 'TARGET_IS_BOT', 'Los bots no admiten warn/tempban/ban: solo kick (para liberar el slot).');
  }
}

/** Duración validada del tempban (minutos). */
function tempbanExpiry(durationMinutes: number): Date {
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > MAX_TEMPBAN_MINUTES) {
    throw Errors.validation(`durationMinutes debe estar entre 1 y ${MAX_TEMPBAN_MINUTES}.`);
  }
  return new Date(Date.now() + durationMinutes * 60_000);
}

/**
 * Emite una penalidad NATIVA. Target por clientId (Player del ranking, sirve
 * offline para tempban/ban), por clientName (exacto, solo conectados) o por
 * cid (slot directo). El motivo es obligatorio (validado por zod).
 */
export async function createPenalty(input: IamPenaltyInput, punisher?: PunisherInfo): Promise<ModerationPenaltyResult> {
  return withModerationErrors(async () => {
    if (!isRconConfigured()) {
      throw new AppError(
        503,
        'MODERATION_NOT_CONFIGURED',
        'La moderación nativa no está configurada: define RCON_PASSWORD (el del server.cfg del server IW4x).',
      );
    }
    const rcon = getSharedRcon();
    const status = await rcon.status();
    const target = await resolveTarget(input, status);
    assertBotsAllowed(input.type, target.isBot);

    const reason = input.reason.replace(/[\r\n]+/g, ' ').trim();
    const output: string[] = [];
    let expiresAt: Date | null = null;

    switch (input.type) {
      case 'warn': {
        if (target.cid === null) throw targetNotOnline('warn');
        await verifySlotGuid(target.cid, target.guid);
        const reply = await rcon.tell(target.cid, reason);
        output.push(`tell ${target.cid} "${reason}"`);
        if (reply.length > 0) output.push(reply.trim());
        break;
      }
      case 'kick': {
        if (target.cid === null) throw targetNotOnline('kick');
        await verifySlotGuid(target.cid, target.guid);
        const reply = await rcon.clientkick(target.cid);
        output.push(`clientkick ${target.cid}`);
        if (reply.length > 0) output.push(reply.trim());
        break;
      }
      case 'tempban': {
        expiresAt = tempbanExpiry(input.durationMinutes ?? 60);
        if (target.cid !== null) {
          // ONLINE: kick inmediato con la razón; el enforcer re-kickea si vuelve.
          await verifySlotGuid(target.cid, target.guid);
          const reply = await rcon.clientkick(target.cid);
          output.push(`clientkick ${target.cid} (tempban ${input.durationMinutes}m)`);
          if (reply.length > 0) output.push(reply.trim());
        }
        break;
      }
      case 'ban': {
        if (target.cid !== null) {
          // ONLINE: banClient = permanente + persistente en bans.json del server.
          await verifySlotGuid(target.cid, target.guid);
          const reply = await rcon.banClient(target.cid);
          output.push(`banClient ${target.cid}`);
          if (reply.length > 0) output.push(reply.trim());
        }
        // OFFLINE: solo capa DB; el enforcer re-kickea al conectar.
        break;
      }
      default: {
        const exhaustiveness: never = input.type;
        void exhaustiveness;
        throw Errors.validation('Tipo de penalidad no soportado: los válidos son warn, kick, tempban, ban.');
      }
    }

    const { penaltyId, offenderPlayerId } = await recordPenalty({
      type: input.type,
      guid: target.guid,
      name: target.name,
      isBot: target.isBot,
      reason,
      punisher: punisher ?? null,
      expiresAt,
    });

    return {
      executed: true,
      type: input.type,
      clientId: offenderPlayerId ?? target.cid ?? null,
      serverId: moderationServerId(),
      output: [`penalty#${penaltyId}`, ...output],
    };
  });
}

function targetNotOnline(type: string): AppError {
  return Errors.validation(
    `El objetivo no está conectado: ${type} solo aplica a players en vivo. ` +
      'Para penalidad offline usa tempban/ban (clientId de la base del ranking): el enforcer lo expulsará al conectar.',
  );
}

// ── POST /api/admin/iam/unban ──────────────────────────────────────────────

export interface ModerationUnbanResult {
  executed: boolean;
  type: 'unban';
  clientId: number | null;
  serverId: number;
  output: string[];
}

/**
 * Revoca el ban permanente (rcon `unbanClient guid <HEX>` → bans.json del
 * server) y marca nuestras Penalty activas del guid como revocadas.
 * Acepta clientId (Player del ranking), guid hex/decimal o cid (slot conectado).
 */
export async function unbanPlayer(
  input: { clientId?: number; guid?: string; cid?: number },
  punisher?: PunisherInfo,
): Promise<ModerationUnbanResult> {
  return withModerationErrors(async () => {
    if (!isRconConfigured()) {
      throw new AppError(
        503,
        'MODERATION_NOT_CONFIGURED',
        'La moderación nativa no está configurada: define RCON_PASSWORD (el del server.cfg del server IW4x).',
      );
    }
    let guid: string | null = null;
    let name: string | null = null;
    let offenderPlayerId: number | null = null;

    if (input.guid !== undefined && input.guid.trim() !== '') {
      const raw = input.guid.trim();
      guid = /^[0-9a-fA-F]+$/.test(raw) && raw.length <= 16 ? (hexGuidToDecimal(raw) ?? raw) : raw;
    } else if (input.clientId !== undefined) {
      const player = await prisma.player.findUnique({ where: { id: input.clientId } });
      if (!player) {
        throw new AppError(404, 'MODERATION_TARGET_NOT_FOUND', `No existe ningún jugador con clientId ${input.clientId}.`);
      }
      guid = player.guid;
      name = player.name;
      offenderPlayerId = player.id;
    } else if (input.cid !== undefined) {
      const status = await getSharedRcon().status();
      const slot = findSlotByCid(status, input.cid);
      if (!slot) throw Errors.validation(`El slot ${input.cid} no tiene ningún jugador conectado.`);
      guid = slot.isBot ? slot.guid.toLowerCase() : statusGuidDecimal(slot) ?? slot.guid;
      name = stripColorCodes(slot.name);
    } else {
      throw Errors.validation('Debes indicar clientId, guid o cid para desbanear.');
    }

    if (guid === null || /^bot\d+$/.test(guid)) {
      throw new AppError(403, 'TARGET_IS_BOT', 'Los bots no tienen bans persistentes que revocar.');
    }

    const hex = decimalGuidToHex(guid);
    if (hex === null) {
      throw Errors.validation(`El guid "${guid}" no es convertible a HEX para unbanClient.`);
    }

    const rcon = getSharedRcon();
    const reply = await rcon.unbanClient('guid', hex);
    const output = [`unbanClient guid ${hex}`];
    if (reply.length > 0) output.push(reply.trim());

    // Marca nuestras penalidades activas (ban + tempban) como revocadas.
    const revoked = await prisma.penalty.updateMany({
      where: { offenderGuid: guid, type: { in: ['ban', 'tempban'] }, active: true },
      data: { active: false },
    });
    if (revoked.count > 0) output.push(`revocadas en DB: ${revoked.count}`);

    if (offenderPlayerId === null) {
      offenderPlayerId = await ensureOffenderPlayer(guid, name ?? 'unknown', false);
    }
    await recordPenalty({
      type: 'unban',
      guid,
      name: name ?? 'unknown',
      isBot: false,
      reason: `unban de ${hex} (revocadas: ${revoked.count})`,
      punisher: punisher ?? null,
    });

    return {
      executed: true,
      type: 'unban',
      clientId: offenderPlayerId,
      serverId: moderationServerId(),
      output,
    };
  });
}

// ── GET /api/admin/iam/bans (bans.json read-only) ──────────────────────────

export interface ServerBanEntry {
  kind: 'guid' | 'ip';
  /** HEX uppercase para guids; a.b.c.d para ips. */
  value: string;
  /** Guid decimal equivalente si es convertible (para cruzar con Player). */
  guidDecimal: string | null;
}

export interface ServerBansResult {
  /** true si RCON_BANS_FILE está configurado. */
  configured: boolean;
  exists: boolean;
  file: string | null;
  bans: ServerBanEntry[];
}

function normalizeBanEntry(raw: unknown, kind: 'guid' | 'ip'): ServerBanEntry | null {
  let value: string | null = null;
  if (typeof raw === 'string') value = raw.trim();
  else if (raw !== null && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const candidate = obj[kind] ?? obj.value ?? obj.guid ?? obj.id;
    if (typeof candidate === 'string') value = candidate.trim();
  }
  if (value === null || value === '') return null;
  return {
    kind,
    value: kind === 'guid' ? value.toUpperCase() : value,
    guidDecimal: kind === 'guid' ? hexGuidToDecimal(value) : null,
  };
}

/** Lee userraw/bans.json del server (SOLO LECTURA; la escritura es vía rcon). */
export async function getServerBans(): Promise<ServerBansResult> {
  return withModerationErrors(async () => {
    const file = process.env.RCON_BANS_FILE?.trim() || undefined;
    if (!file) {
      return { configured: false, exists: false, file: null, bans: [] };
    }
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      // Sin bans aún (el server crea bans.json al primer banClient).
      return { configured: true, exists: false, file, bans: [] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new AppError(502, 'MODERATION_BANS_FILE_CORRUPT', `El archivo de bans "${file}" no es JSON válido.`);
    }
    const container = (parsed ?? {}) as { ip?: unknown[]; id?: unknown[] };
    const bans = [
      ...(container.ip ?? []).map((entry) => normalizeBanEntry(entry, 'ip')),
      ...(container.id ?? []).map((entry) => normalizeBanEntry(entry, 'guid')),
    ].filter((entry): entry is ServerBanEntry => entry !== null);
    return { configured: true, exists: true, file, bans };
  });
}

// ── GET /api/admin/iam/penalties (NUESTRA DB) ──────────────────────────────

export type ModerationPenaltyKind = 'warn' | 'kick' | 'tempban' | 'ban' | 'unban';

export interface ModerationPenalty {
  id: number;
  type: ModerationPenaltyKind;
  reason: string | null;
  automated: boolean;
  when: string;
  expires: string | null;
  active: boolean;
  source: string;
  offender: { clientId: number | null; guid: string; name: string | null } | null;
  punisher: { clientId: number | null; name: string | null } | null;
}

export interface ModerationPenaltiesResult {
  limit: number;
  penaltiesDb: boolean;
  penalties: ModerationPenalty[];
}

function normalizePenaltyRow(row: {
  id: number;
  type: string;
  reason: string | null;
  automated: boolean;
  createdAt: Date;
  expiresAt: Date | null;
  active: boolean;
  source: string;
  offenderGuid: string;
  offenderPlayerId: number | null;
  offenderName: string | null;
  punisherUserId: number | null;
  punisherName: string | null;
}): ModerationPenalty {
  return {
    id: row.id,
    type: (['warn', 'kick', 'tempban', 'ban', 'unban'].includes(row.type) ? row.type : 'warn') as ModerationPenaltyKind,
    reason: row.reason,
    automated: row.automated,
    when: row.createdAt.toISOString(),
    expires: row.expiresAt?.toISOString() ?? null,
    active: row.active,
    source: row.source,
    offender: { clientId: row.offenderPlayerId, guid: row.offenderGuid, name: row.offenderName },
    punisher: { clientId: row.punisherUserId, name: row.punisherName },
  };
}

/** Historial de penalidades desde NUESTRA DB (más nuevas primero). */
export async function getPenaltyHistory(querySpec: IamPenaltiesQuery): Promise<ModerationPenaltiesResult> {
  return withModerationErrors(async () => {
    const rows = await prisma.penalty.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: querySpec.limit,
    });
    return {
      limit: querySpec.limit,
      penaltiesDb: true,
      penalties: rows.map(normalizePenaltyRow),
    };
  });
}

// ── GET /api/admin/iam/clients (búsqueda en NUESTRA base del ranking) ──────

export interface ModerationClient {
  clientId: number;
  name: string;
  /** Guid decimal (canónico del ranking). */
  xuid: string;
  level: string | null;
  openPenalties: ModerationPenalty[] | null;
}

export interface ModerationClientsResult {
  total: number;
  query: string;
  penaltiesDb: boolean;
  clients: ModerationClient[];
}

function isHexLike(value: string): boolean {
  return /^[0-9a-fA-F]{8,16}$/.test(value);
}

/**
 * Búsqueda de clientes en NUESTRA base (Player + PlayerAlias): nombre LIKE
 * (≥3 chars, insensible a códigos de color/case) o guid (hex o decimal).
 * level = "Banned" si tiene ban activo; null en otro caso (no hay niveles
 * nativos). openPenalties desde nuestra Penalty (siempre disponibles).
 */
export async function searchModerationClients(querySpec: IamClientsQuery): Promise<ModerationClientsResult> {
  return withModerationErrors(async () => {
    const query = querySpec.query.trim();
    let players = await prisma.player.findMany({
      where: {
        OR: [
          { name: { contains: query } },
          { aliases: { some: { name: { contains: query } } } },
        ],
      },
      include: { aliases: { orderBy: [{ lastSeenAt: 'desc' }] } },
      take: 50,
      orderBy: [{ lastConnection: 'desc' }, { id: 'asc' }],
    });

    // Match por guid: HEX (formato status) o decimal (formato ranking).
    if (isHexLike(query)) {
      const decimal = hexGuidToDecimal(query);
      if (decimal) {
        const byGuid = await prisma.player.findUnique({
          where: { guid: decimal },
          include: { aliases: { orderBy: [{ lastSeenAt: 'desc' }] } },
        });
        if (byGuid) players = [byGuid, ...players.filter((player) => player.id !== byGuid.id)];
      }
    } else if (/^\d{1,20}$/.test(query)) {
      const byGuid = await prisma.player.findUnique({
        where: { guid: query },
        include: { aliases: { orderBy: [{ lastSeenAt: 'desc' }] } },
      });
      if (byGuid) players = [byGuid, ...players.filter((player) => player.id !== byGuid.id)];
    }

    // El LIKE de SQLite no puede ignorar códigos de color (^X en medio del
    // nombre): prefiltramos por LIKE y, si el match limpio no encuentra nada,
    // escaneamos un lote amplio filtrando por cleanName en memoria.
    const wanted = query.toLowerCase();
    const wantedHex = query.toUpperCase();
    const cleanFilter = (candidates: typeof players): typeof players =>
      candidates.filter((player) => {
        // Match por guid: decimal tal cual, o HEX (formato status) convertible.
        if (player.guid === query || player.guid === wanted) return true;
        if (/^\d+$/.test(player.guid) && decimalGuidToHex(player.guid) === wantedHex) return true;
        const names = [player.name, ...player.aliases.map((alias) => alias.name)];
        return names.some((name) => stripColorCodes(name).toLowerCase().includes(wanted));
      });

    let matched = cleanFilter(players);
    if (matched.length === 0) {
      const broader = await prisma.player.findMany({
        include: { aliases: { orderBy: [{ lastSeenAt: 'desc' }] } },
        take: 500,
        orderBy: [{ lastConnection: 'desc' }, { id: 'asc' }],
      });
      matched = cleanFilter(broader);
    }

    const guids = matched.map((player) => player.guid);
    const activePenalties = guids.length > 0
      ? await prisma.penalty.findMany({
          where: { offenderGuid: { in: guids }, active: true, type: { in: ['warn', 'tempban', 'ban'] } },
          orderBy: [{ createdAt: 'desc' }],
        })
      : [];
    const now = Date.now();
    const openByGuid = new Map<string, ModerationPenalty[]>();
    for (const row of activePenalties) {
      if (row.expiresAt !== null && row.expiresAt.getTime() <= now) continue;
      const list = openByGuid.get(row.offenderGuid) ?? [];
      list.push(normalizePenaltyRow(row));
      openByGuid.set(row.offenderGuid, list);
    }
    const bannedGuids = new Set(
      activePenalties.filter((row) => row.type === 'ban').map((row) => row.offenderGuid),
    );

    return {
      total: matched.length,
      query,
      penaltiesDb: true,
      clients: matched.map((player) => {
        const latestName = player.aliases[0]?.name ?? player.name;
        return {
          clientId: player.id,
          name: latestName,
          xuid: player.guid,
          level: bannedGuids.has(player.guid) ? 'Banned' : null,
          openPenalties: openByGuid.get(player.guid) ?? [],
        };
      }),
    };
  });
}

// ── GET /api/admin/iam/live ────────────────────────────────────────────────

export interface ModerationLivePlayer {
  name: string;
  /** Player.id si el guid está en nuestra base (null si nunca vio el log). */
  clientId: number | null;
  /** Slot/cid en el server (para acciones directas; bots incluidos). */
  clientNumber: number;
  guid: string;
  isBot: boolean;
  connecting: boolean;
  level: string | null;
  ping: number | null;
  score: number | null;
  state: string;
}

export interface ModerationLiveResult {
  servers: Array<{
    id: number;
    name: string;
    online: boolean;
    map: string | null;
    gametype: string | null;
    players: ModerationLivePlayer[];
  }>;
}

function playerState(player: StatusPlayer): string {
  if (player.connecting) return 'Connecting';
  if (player.isBot) return 'Bot';
  return 'Connected';
}

/**
 * Players conectados AHORA: status() + getinfo() combinados. clientId se
 * resuelve contra nuestra base por guid (decimal); `resolve=false` lo salta
 * (compatible con el flag que ya usaba la web).
 */
export async function getLivePlayers(querySpec: IamLiveQuery): Promise<ModerationLiveResult> {
  return withModerationErrors(async () => {
    if (!isRconConfigured()) {
      throw new AppError(
        503,
        'MODERATION_NOT_CONFIGURED',
        'La moderación nativa no está configurada: define RCON_PASSWORD (el del server.cfg del server IW4x).',
      );
    }
    const rcon = getSharedRcon();
    const status = await rcon.status();
    const info: InfoString = querySpec.resolve ? await rcon.getinfo() : {};

    const guids = status.players
      .filter((player) => !player.connecting && !player.isBot)
      .map((player) => statusGuidDecimal(player))
      .filter((guid): guid is string => guid !== null);
    const known = querySpec.resolve && guids.length > 0
      ? await prisma.player.findMany({ where: { guid: { in: guids } }, select: { id: true, guid: true } })
      : [];
    const idByGuid = new Map(known.map((player) => [player.guid, player.id]));

    return {
      servers: [
        {
          id: moderationServerId(),
          name: info.hostname ?? '(sin hostname)',
          online: true,
          map: status.map ?? info.mapname ?? null,
          gametype: info.gametype ?? null,
          players: status.players.map((player) => {
            const decimal = player.isBot || player.connecting ? null : statusGuidDecimal(player);
            return {
              name: player.name,
              clientId: decimal !== null ? idByGuid.get(decimal) ?? null : null,
              clientNumber: player.cid,
              guid: player.isBot ? player.guid.toLowerCase() : decimal ?? player.guid,
              isBot: player.isBot,
              connecting: player.connecting,
              level: null,
              ping: player.connecting ? null : player.ping,
              score: player.score,
              state: playerState(player),
            };
          }),
        },
      ],
    };
  });
}

// ── Utilidad de diagnóstico: ejecuta un comando rcon crudo (admin) ─────────

/** Comando rcon crudo SOLO-LECTURA (para diagnóstico desde el panel). */
export async function rconReadCommand(command: string): Promise<string> {
  return withModerationErrors(async () => {
    if (!isRconConfigured()) {
      throw new AppError(
        503,
        'MODERATION_NOT_CONFIGURED',
        'La moderación nativa no está configurada: define RCON_PASSWORD.',
      );
    }
    const forbidden = /^(clientkick|tempbanclient|banClient|unbanClient|say|tell|map|map_rotate|fast_restart|quit|spawnBot|set)\b/i;
    if (forbidden.test(command.trim())) {
      throw Errors.validation('Solo comandos de lectura por esta vía; las escrituras van por los endpoints de moderación.');
    }
    return getSharedRcon().exec(command.trim());
  });
}
