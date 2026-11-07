import { Errors, errMessage } from '../lib/errors.js';
import { AppError } from '../lib/errors.js';
import {
  DEFAULT_TIMEOUT_MS,
  IamUpstreamError,
  iamRequestJson,
  iamUpstreamConfig,
} from '../lib/iam/upstream.js';
import {
  clientLevelsById,
  isPenaltiesDbConfigured,
  levelName,
  openPenaltiesByClient,
  PenaltiesDbNotConfiguredError,
  PenaltiesDbUnavailableError,
  recentPenalties,
  type NormalizedPenalty,
} from '../lib/iam/penalties-db.js';
import {
  MAX_TEMPBAN_MINUTES,
  type IamClientsQuery,
  type IamLiveQuery,
  type IamPenaltiesQuery,
  type IamPenaltyInput,
  type IamPenaltyType,
} from '../dto/iam.dto.js';

/**
 * Bridge de MODERACIÓN con el webfront de IW4MAdmin (namespace /api/admin/iam/*).
 *
 * SOLO moderación/control: status, búsqueda de clientes (con penalidades
 * abiertas), historial de penalidades, emisión de warn/kick/tempban/ban y
 * jugadores en vivo. NADA de stats (la fuente del ranking sigue sendo el log).
 *
 * Referencias del upstream (IW4MAdmin tag 2025.12.16.1-prerelease, código WebfrontCore):
 *  - GET  /api/server              → lista de servers (Controllers/API/Server.cs).
 *  - GET  /api/Status              → servers con players en vivo (APIController.cs).
 *  - GET  /api/client/find         → búsqueda por Name (≥3) o Xuid hex (ClientController.cs).
 *  - GET  /api/client/{clientId}   → detalle de cliente (ClientController.cs).
 *  - POST /api/server/{id}/execute → comando como Console (loopback) o como el
 *    usuario del cookie (Server.cs ExecuteCommandForServer). Targeting nativo:
 *    "@dbId" (offline ok), número de slot o nombre activo (CommandProcessing.cs).
 *  - Historial de penalidades: read-only SQLite (ver lib/iam/penalties-db.ts).
 */

// ── Formas del upstream (solo los campos que el bridge consume) ───────────

interface UpstreamServer {
  id: number;
  serverName: string;
  game: string;
  clientNum?: number;
  maxClients: number;
  currentMap?: { name: string | null; alias: string | null };
  currentGameType?: { type: string | null; name: string | null };
  parser?: string;
}

interface UpstreamStatusServer {
  id: number;
  isOnline: boolean;
  name: string;
  maxPlayers: number;
  currentPlayers: number;
  map?: { name: string | null; alias: string | null };
  gameMode?: string;
  players?: Array<{
    name: string;
    score: number;
    ping: number;
    state: string;
    clientNumber: number;
    connectionTime?: number;
    level?: string;
  }>;
}

interface UpstreamFindClient {
  clientId: number;
  xuid: string;
  name: string;
}

interface UpstreamFindResponse {
  totalFoundClients: number;
  clients: UpstreamFindClient[];
}

interface UpstreamClientInfo {
  clientId: number;
  name: string;
  level?: string;
  networkId?: string;
}

interface UpstreamExecuteResult {
  executionTimeMs: number;
  output: string[];
}

// ── Mapeo de errores del bridge → AppError del handler central ────────────

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err as AppError;
  if (err instanceof IamUpstreamError) {
    return new AppError(err.statusCode, err.code, err.message, err.details);
  }
  if (err instanceof PenaltiesDbNotConfiguredError) {
    return new AppError(503, 'IAM_PENALTIES_DB_NOT_CONFIGURED', err.message);
  }
  if (err instanceof PenaltiesDbUnavailableError) {
    return new AppError(503, 'IAM_PENALTIES_DB_UNAVAILABLE', err.message);
  }
  return new AppError(500, 'IAM_INTERNAL', `Error interno del bridge de moderación: ${errMessage(err)}`);
}

async function withBridgeErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    throw toAppError(err);
  }
}

function assertWebfrontConfigured(): void {
  if (!iamUpstreamConfig.configured) {
    throw new AppError(
      503,
      'IAM_NOT_CONFIGURED',
      'Credenciales/config de IW4MAdmin no configuradas: define IW4MADMIN_WEBFRONT_URL (ej. http://127.0.0.1:1624).',
    );
  }
}

// ── Normalización de nombres (códigos de color del juego ^1..^9) ──────────

/** Quita códigos de color/control (un solo carácter tras ^) y normaliza para comparar nombres. */
export function cleanName(raw: string): string {
  return raw
    .replace(/\^[0-9a-zA-Z]/g, '')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .toLowerCase();
}

function isHexLike(value: string): boolean {
  return /^[0-9a-fA-F]{8,16}$/.test(value);
}

// ── GET /api/admin/iam/status ─────────────────────────────────────────────

export interface IamStatus {
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

/**
 * Diagnóstico rápido del upstream. A diferencia del resto de los endpoints
 * este NO explota 502 cuando el upstream no responde: expone el error legible.
 */
export async function getIamStatus(): Promise<IamStatus> {
  return withBridgeErrors(async () => {
    const status: IamStatus = {
      configured: iamUpstreamConfig.configured,
      reachable: false,
      penaltiesDb: { configured: isPenaltiesDbConfigured() },
      error: null,
      servers: [],
    };
    if (!status.configured) {
      status.error = 'IW4MADMIN_WEBFRONT_URL no está configurado.';
      return status;
    }
    try {
      const servers = await listServers();
      status.reachable = true;
      status.servers = servers.map((server) => ({
        id: server.id,
        name: server.serverName,
        game: server.game,
        map:
          server.currentMap !== undefined
            ? server.currentMap.alias ?? server.currentMap.name ?? null
            : null,
        gametype:
          server.currentGameType !== undefined
            ? server.currentGameType.name ?? server.currentGameType.type ?? null
            : null,
        players: server.clientNum ?? 0,
        maxPlayers: server.maxClients,
        parser: server.parser ?? null,
      }));
    } catch (err) {
      status.error = errMessage(err);
    }
    return status;
  });
}

async function listServers(): Promise<UpstreamServer[]> {
  return iamRequestJson<UpstreamServer[]>('/api/server', { method: 'GET', timeoutMs: DEFAULT_TIMEOUT_MS });
}

// ── GET /api/admin/iam/clients?query= ─────────────────────────────────────

export interface IamClient {
  clientId: number;
  name: string;
  xuid: string;
  level: string | null;
  /** Penalidades abiertas (warns/flags/tempi/bans vigentes). Null sin DB. */
  openPenalties: NormalizedPenalty[] | null;
}

export interface IamClientsResult {
  total: number;
  query: string;
  penaltiesDb: boolean;
  clients: IamClient[];
}

/**
 * Búsqueda de clientes con foco en PENALIDADES ABiertas (bans activos, warns).
 * `query` = nombre LIKE (≥3 chars) o GUID hex (xuid).
 */
export async function searchClients(querySpec: IamClientsQuery): Promise<IamClientsResult> {
  return withBridgeErrors(async () => {
    assertWebfrontConfigured();
    const path = isHexLike(querySpec.query)
      ? `/api/client/find?Xuid=${encodeURIComponent(querySpec.query.toLowerCase())}&Count=50&Offset=0`
      : `/api/client/find?Name=${encodeURIComponent(querySpec.query)}&Count=50&Offset=0`;
    const found = await iamRequestJson<UpstreamFindResponse>(path, {
      method: 'GET',
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    const clientsRaw = found.clients ?? [];
    const clientIds = clientsRaw.map((client) => client.clientId);
    const penaltiesConfigured = isPenaltiesDbConfigured();
    const openMap = penaltiesConfigured ? openPenaltiesByClient(clientIds) : new Map<number, NormalizedPenalty[]>();
    const levelMap = penaltiesConfigured ? clientLevelsById(clientIds) : new Map<number, number>();
    return {
      total: found.totalFoundClients,
      query: querySpec.query,
      penaltiesDb: penaltiesConfigured,
      clients: clientsRaw.map((client) => {
        const level = levelMap.get(client.clientId);
        return {
          clientId: client.clientId,
          name: client.name,
          xuid: client.xuid,
          level: level !== undefined ? levelName(level) : null,
          openPenalties: openMap.get(client.clientId) ?? (penaltiesConfigured ? [] : null),
        };
      }),
    };
  });
}

// ── GET /api/admin/iam/penalties?limit= ───────────────────────────────────

export interface IamPenaltiesResult {
  limit: number;
  penaltiesDb: boolean;
  penalties: NormalizedPenalty[];
}

/** Últimos warns/kicks/tempbans/bans/unbans (más nuevos primero). */
export async function getRecentPenalties(querySpec: IamPenaltiesQuery): Promise<IamPenaltiesResult> {
  return withBridgeErrors(async () => {
    const penalties = recentPenalties(querySpec.limit);
    return { limit: querySpec.limit, penaltiesDb: true, penalties };
  });
}

// ── GET /api/admin/iam/live ───────────────────────────────────────────────

export interface IamLivePlayer {
  name: string;
  clientId: number | null;
  clientNumber: number;
  level: string | null;
  ping: number;
  score: number;
  state: string;
}

export interface IamLiveResult {
  servers: Array<{
    id: number;
    name: string;
    online: boolean;
    players: IamLivePlayer[];
  }>;
}

/** Players conectados AHORA (GET /api/Status), con clientId resuelto. */
export async function getLivePlayers(querySpec: IamLiveQuery): Promise<IamLiveResult> {
  return withBridgeErrors(async () => {
    assertWebfrontConfigured();
    const status = await iamRequestJson<UpstreamStatusServer[]>('/api/Status', {
      method: 'GET',
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    const serversOut: IamLiveResult['servers'] = [];
    for (const server of status) {
      const playersRaw = server.players ?? [];
      let resolved = new Map<string, number>();
      if (querySpec.resolve && playersRaw.length > 0) {
        resolved = await resolveLiveClientIds(playersRaw.map((player) => player.name));
      }
      serversOut.push({
        id: server.id,
        name: server.name,
        online: server.isOnline,
        players: playersRaw.map((player) => ({
          name: player.name,
          clientId: resolved.get(cleanName(player.name)) ?? null,
          clientNumber: player.clientNumber,
          level: player.level ?? null,
          ping: player.ping,
          score: player.score,
          state: player.state,
        })),
      });
    }
    return { servers: serversOut };
  });
}

/** clientId de players en vivo: find?Name= y match EXACTO por nombre limpio. */
async function resolveLiveClientIds(names: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const uniqueNames = [...new Set(names)];
  for (const playerName of uniqueNames) {
    const cleaned = cleanName(playerName);
    if (cleaned.length < 3) continue; // regla del upstream (FindClientRequestValidator)
    try {
      const found = await iamRequestJson<UpstreamFindResponse>(
        `/api/client/find?Name=${encodeURIComponent(cleaned)}&Count=10&Offset=0`,
        { method: 'GET', timeoutMs: DEFAULT_TIMEOUT_MS },
      );
      const exact = (found.clients ?? []).find((client) => cleanName(client.name) === cleaned);
      if (exact) out.set(cleaned, exact.clientId);
    } catch {
      // best-effort: sin clientId resuelto el player queda con clientId null
    }
  }
  return out;
}

// ── POST /api/admin/iam/penalty ───────────────────────────────────────────

export interface IamPenaltyResult {
  executed: boolean;
  type: IamPenaltyType;
  clientId: number;
  serverId: number;
  /** Líneas de output del upstream (relé textual, para el UI). */
  output: string[];
}

/** warn/kick SOLO aplican al player conectado; tempban/ban también offline (@id). */
const PENALTY_REQUIRES_ONLINE: Record<IamPenaltyType, boolean> = {
  warn: true,
  kick: true,
  tempban: false,
  ban: false,
};

/**
 * Emite una penalidad vía POST /api/server/{id}/execute (comando como Console
 * del loopback, o como el usuario del cookie si hay credenciales).
 * Target SIEMPRE por @clientId (unívoco, sirve online y offline).
 * El motivo es obligatorio (ya validado por zod) y se sanitizan saltos de línea.
 */
export async function createPenalty(input: IamPenaltyInput): Promise<IamPenaltyResult> {
  return withBridgeErrors(async () => {
    assertWebfrontConfigured();
    const servers = await listServers();
    const server = servers[0];
    if (server === undefined) {
      throw new AppError(
        502,
        'IAM_UPSTREAM_ERROR',
        'IW4MAdmin no tiene ningún server monitorizado; no se puede ejecutar el comando.',
      );
    }

    const clientId = await resolveTargetClientId(input);
    if (PENALTY_REQUIRES_ONLINE[input.type] && !(await isClientOnline(server.id, clientId))) {
      throw Errors.validation(
        `El client ${clientId} no está conectado al server: warn/kick solo aplican a players en vivo. ` +
          'Para penalidad offline usa tempban/ban (aceptan clientId de cliente no conectado).',
      );
    }

    const command = buildCommand(input, clientId);
    const result = await iamRequestJson<UpstreamExecuteResult>(`/api/server/${server.id}/execute`, {
      method: 'POST',
      body: { command },
      timeoutMs: DEFAULT_TIMEOUT_MS * 2, // warn/kick hacen RCon round-trips
    });
    return {
      executed: true,
      type: input.type,
      clientId,
      serverId: server.id,
      output: result.output ?? [],
    };
  });
}

/** Duración para TempBanCommand: unidad de un solo caractère → siempre "m". */
export function tempbanDurationString(durationMinutes: number): string {
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > MAX_TEMPBAN_MINUTES) {
    throw Errors.validation(`durationMinutes debe estar entre 1 y ${MAX_TEMPBAN_MINUTES} (límite IW4MAdmin: 30 días).`);
  }
  return `${durationMinutes}m`;
}

function buildCommand(input: IamPenaltyInput, clientId: number): string {
  const reason = input.reason.replace(/[\r\n]+/g, ' ').trim();
  const target = `@${clientId}`;
  switch (input.type) {
    case 'warn':
      return `warn ${target} ${reason}`;
    case 'kick':
      return `kick ${target} ${reason}`;
    case 'tempban':
      return `tempban ${target} ${tempbanDurationString(input.durationMinutes ?? 60)} ${reason}`;
    case 'ban':
      return `ban ${target} ${reason}`;
    default: {
      const exhaustiveness: never = input.type;
      void exhaustiveness;
      throw Errors.validation(`Tipo de penalidad no soportado: los válidos son warn, kick, tempban, ban.`);
    }
  }
}

/**
 * Resuelve el clientId objetivo:
 *  - input.clientId directo (cliente existente en IW4MAdmin, online u offline → @id).
 *  - input.clientName → /api/client/find con match EXACTO por nombre limpio.
 *    Si hay >1 exacto → 400 pidiendo clientId (nunca penalidad al wrong client).
 */
async function resolveTargetClientId(input: IamPenaltyInput): Promise<number> {
  if (input.clientId !== undefined) {
    // Verifica existencia (GET /api/client/{id}) → 404 claro si no existe.
    const info = await fetchClientById(input.clientId);
    if (info === null) {
      throw new AppError(
        404,
        'IAM_CLIENT_NOT_FOUND',
        `No existe ningún cliente de IW4MAdmin con clientId ${input.clientId}.`,
      );
    }
    return info.clientId;
  }

  const searchName = input.clientName ?? '';
  const found = await iamRequestJson<UpstreamFindResponse>(
    `/api/client/find?Name=${encodeURIComponent(searchName)}&Count=50&Offset=0`,
    { method: 'GET', timeoutMs: DEFAULT_TIMEOUT_MS },
  );
  const wanted = cleanName(searchName);
  const exacts = (found.clients ?? []).filter((client) => cleanName(client.name) === wanted);
  if (exacts.length === 0) {
    throw new AppError(
      404,
      'IAM_CLIENT_NOT_FOUND',
      `No se encontró un cliente IW4MAdmin con nombre exacto "${searchName}".`,
    );
  }
  if (exacts.length > 1) {
    throw Errors.validation(
      `El nombre "${searchName}" coincide con ${exacts.length} clientes (clientIds: ${exacts
        .map((client) => client.clientId)
        .join(', ')}) - envía clientId para desambiguar.`,
    );
  }
  return exacts[0]!.clientId;
}

/** Cliente por id → GET /api/client/{clientId:int} (ClientController.cs). */
async function fetchClientById(clientId: number): Promise<UpstreamClientInfo | null> {
  try {
    return await iamRequestJson<UpstreamClientInfo>(`/api/client/${clientId}`, {
      method: 'GET',
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  } catch (err) {
    // 404 del find-by-id: el upstream acá devuelve BadRequest "Could not find client" (400).
    if (err instanceof IamUpstreamError && err.statusCode === 502) return null;
    throw err;
  }
}

/** ¿Está el clientId conectado? Matchea por NAME contra los players de /api/Status. */
async function isClientOnline(serverId: number, clientId: number): Promise<boolean> {
  const [info, status] = await Promise.all([
    fetchClientById(clientId),
    iamRequestJson<UpstreamStatusServer[]>('/api/Status', { method: 'GET', timeoutMs: DEFAULT_TIMEOUT_MS }),
  ]);
  if (info === null) return false;
  const cleaned = cleanName(info.name);
  const server = status.find((candidate) => candidate.id === serverId);
  if (server === undefined) return false;
  return (server.players ?? []).some((player) => cleanName(player.name) === cleaned);
}
