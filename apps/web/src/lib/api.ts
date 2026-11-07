/**
 * Cliente HTTP contra la API (docs/API.md).
 * En desarrollo Vite hace proxy de /api → http://localhost:3000.
 */

const TOKEN_KEY = "iw4x_ranking_token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // localStorage no disponible: la sesión vive solo en memoria.
  }
}

export type ApiIssue = { path: string | Array<string | number>; message: string };

export interface ApiErrorBody {
  code: string;
  message: string;
  /** docs/API.md documenta `{ issues: [...] }`; la API actual manda el array directo. Se aceptan ambas. */
  details?: { issues?: ApiIssue[] } | ApiIssue[];
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: { issues?: Array<{ path: string | Array<string | number>; message: string }> };

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    this.status = status;
    // API.md documenta `details: { issues: [...] }`, pero la API actual manda el array
    // directo (`details: [...]`). Se normaliza a la forma documentada (tolerante a ambas).
    const raw = body.details;
    this.details = Array.isArray(raw) ? { issues: raw } : raw;
  }

  /** Mapa campo → mensaje a partir de details.issues (validación zod). */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const issue of this.details?.issues ?? []) {
      const rawPath = Array.isArray(issue.path) ? issue.path.join(".") : String(issue.path ?? "");
      const field = rawPath.split(".")[0] ?? "";
      if (field && !(field in out)) out[field] = issue.message;
    }
    return out;
  }
}

export interface User {
  id: number;
  email: string;
  displayName: string;
  role: "USER" | "ADMIN";
  createdAt: string;
  linkedGuid: string | null;
  /** GUIDs vinculados con metadatos (multi-GUID, API v0.3). */
  linkedGuids: LinkedGuidInfo[];
}

export interface LinkedGuidInfo {
  guid: string;
  name?: string | null;
  lastConnection?: string | null;
  lastServer?: string | null;
}

export interface ServerInfo {
  name: string;
  address: string;
  isDefault: boolean;
}

export interface ServersResponse {
  source: "env" | "derived" | "none";
  servers: ServerInfo[];
}

export type LeaderboardSort =
  | "kills"
  | "deaths"
  | "headshots"
  | "kd"
  | "timePlayed"
  | "skill";

export type LeaderboardOrder = "desc" | "asc";

export interface LeaderboardParams {
  sort?: LeaderboardSort;
  order?: LeaderboardOrder;
  search?: string;
  page?: number;
  pageSize?: number;
  /** true → incluye bots del server (heurística GUID 0xB07…). Default: solo humanos. */
  includeBots?: boolean;
}

export interface LeaderboardPlayer {
  rank: number;
  guid: string;
  name: string;
  kills: number;
  deaths: number;
  kd: number;
  timePlayed: number;
  connections: number;
  skill: number | null;
  lastConnection: string;
  /** true si el GUID tiene una cuenta web vinculada (API v0.2). */
  linked: boolean;
  /** true si el GUID es un bot del server. Opcional: si la API aún no lo envía, el UI usa la heurística del rango 0xB07. */
  isBot?: boolean;
  /** Tiros a la cabeza acumulados. Opcional: API anterior puede no enviarlo. */
  headshots?: number;
}

export interface LeaderboardResponse {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  sort: string;
  order: string;
  players: LeaderboardPlayer[];
}

export interface KillEvent {
  id: number;
  time: string;
  epoch: number;
  direction: "kill" | "death";
  isKill: boolean;
  damage: number;
  weapon: string;
  server: string | null;
  opponentGuid: string | null;
  opponentName: string | null;
}

export interface PlayerProfile {
  guid: string;
  name: string;
  kills: number;
  deaths: number;
  kd: number;
  timePlayed: number;
  connections: number;
  skill: number | null;
  /** Tiros a la cabeza acumulados. Opcional: API anterior puede no enviarlo. */
  headshots?: number;
  /** Headshots como % de kills (ej. 6.45). Tolerado: usar `hsRatio` (más nuevo). */
  headshotPct?: number | null;
  /** headshots / kills, 2 decimales (0.06); null si 0 kills. Preferido sobre headshotPct. */
  hsRatio?: number | null;
  firstConnection: string;
  lastConnection: string;
  linked: boolean;
}

/** Alias histórico del GUID (docs/API.md §Perfil — anti-confusión de identidades). */
export interface PlayerAlias {
  name: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
}

export interface PlayerDetail {
  player: PlayerProfile;
  /** Posición global (sort=kills desc); null si el jugador no clasifica (API v0.2). */
  rank: number | null;
  recentEvents: KillEvent[];
  byServer: Array<{ server: string; kills: number; deaths: number }>;
  /** Nombres históricos ≠ nombre actual, lastSeenAt desc, máx 10. Vacío → siempre usó el mismo nombre. */
  aliases?: PlayerAlias[];
}

export interface AuthResponse {
  user: User;
  token: string;
}

export interface UnlinkResponse {
  status: "unlinked";
  guid: string;
  linkedGuids: string[];
}

/** GET /api/sync/status — público desde API v0.2. */
export interface SyncStatusResponse {
  lastSyncAt: string | null;
  configured: boolean;
  intervalMinutes: number;
  windowMinutes: number;
}

export type GameGametype =
  | "war"
  | "dm"
  | "dom"
  | "koth"
  | "sab"
  | "sd"
  | "ctf"
  | "oneflag"
  | "gtnw"
  | "arena"
  | "dd"
  | "vip";

export interface RotationEntry {
  map: string;
  gametype: GameGametype | string;
}

export interface ServerConfig {
  hostname: string;
  motd: string;
  gametype: string;
  maxclients: number;
  logfile: number;
  g_log: string;
  /** Valor ENMASCARADO (contiene •); el eco enmascarado = "sin cambio". */
  rcon: string | null;
  rconSet: boolean;
  bots: number;
  /** Valor ENMASCARADO o null si está vacío. */
  password: string | null;
  passwordSet: boolean;
  rotation: RotationEntry[];
  unknownLines: string[];
  metadata: { path: string; lastModified: string; sizeBytes: number };
}

export interface ServerConfigResponse {
  config: ServerConfig;
}

export interface ServerConfigSaveRequest {
  hostname?: string;
  motd?: string;
  gametype?: string;
  maxclients?: number;
  logfile?: number;
  g_log?: string;
  /** Texto nuevo para reemplazar; el eco enmascarado se interpreta como sin cambio. */
  rcon?: string;
  bots?: number;
  password?: string | null;
  /** Siempre completa. */
  rotation?: RotationEntry[];
}

export interface ServerConfigSaveResponse {
  saved: boolean;
  restarted: boolean;
  backupPath: string;
  warnings: string[];
}

export interface RestartServerResponse {
  restarted: boolean;
  command: string;
}

/* Moderación bridge IW4MAdmin (docs/API.md §Moderación) */

export interface IamStatusServer {
  id: number;
  name: string;
  game: string;
  map: string | null;
  gametype: string | null;
  players: number;
  maxPlayers: number;
  parser: string;
}

/** GET /api/admin/iam/status — siempre 200; diagnóstico en `error`. */
export interface IamStatusResponse {
  configured: boolean;
  reachable: boolean;
  penaltiesDb: { configured: boolean };
  error: string | null;
  servers: IamStatusServer[];
}

export type IamPenaltyType = "warn" | "kick" | "tempban" | "ban";
/** El historial además registra unban. */
export type IamPenaltyRecordType = IamPenaltyType | "unban";

export interface IamPenaltyParty {
  clientId: number;
  name: string;
  /** GUID del ranking (decimal). NUEVO aditivo: base para POST /unban. */
  guid?: string | null;
}

/** Shape único usado por /clients (openPenalties) y /penalties. Campos tolerantes: la DB upstream puede traer null. */
export interface IamPenalty {
  id: number;
  type: IamPenaltyRecordType;
  reason?: string | null;
  automated?: boolean;
  when: string;
  expires?: string | null;
  /** NUEVO aditivo: true si la penalidad sigue vigente (ban/tempban no revocados ni expirados). */
  active?: boolean;
  /** NUEVO aditivo: origen del registro ("panel" | "enforcer" | "juego"…). */
  source?: string | null;
  offender?: IamPenaltyParty | null;
  punisher?: IamPenaltyParty | null;
}

export interface IamClient {
  clientId: number;
  name: string;
  xuid: string | null;
  /** null si la DB de penalidades no está configurada. */
  level: string | null;
  /** null si la DB de penalidades no está configurada. */
  openPenalties: IamPenalty[] | null;
}

export interface IamClientsResponse {
  total: number;
  query: string;
  penaltiesDb: boolean;
  clients: IamClient[];
}

export interface IamPenaltiesResponse {
  limit: number;
  penaltiesDb: boolean;
  penalties: IamPenalty[];
}

export interface IamLivePlayer {
  name: string;
  /** Player.id del ranking si el guid está en nuestra base; null si aún no (tolerar). */
  clientId: number | null;
  /** Slot/cid del server. SIEMPRE presente para conectados (acciones directas, bots incluidos). */
  clientNumber: number | null;
  /** GUID decimal del ranking, o "botN" para bots. Opcional: tolera APIs previas. */
  guid?: string | null;
  /** true si es un bot del server (sin Player en la base → clientId null, se actúa por cid). */
  isBot?: boolean;
  /** true mientras el jugador está aún conectándose. */
  connecting?: boolean;
  level: string | null;
  ping: number | null;
  score: number | null;
  state: string;
}

export interface IamLiveServer {
  id: number;
  name: string;
  online: boolean;
  /** NUEVO aditivo: mapa actual (ej. "mp_terminal"). */
  map?: string | null;
  /** NUEVO aditivo: modo de juego actual (ej. "war"). */
  gametype?: string | null;
  players: IamLivePlayer[];
}

export interface IamLiveResponse {
  servers: IamLiveServer[];
}

export interface IamPenaltyRequest {
  type: IamPenaltyType;
  /** Obligatorio: 3–200 chars. */
  reason: string;
  /** Player.id del ranking (preferente: permite ban offline). Enviar clientId O cid O clientName. */
  clientId?: number;
  /** Slot directo del server (status): imprescindible para bots (sin Player en la base). */
  cid?: number;
  /** Match EXACTO limpio contra los conectados; ambiguo → 400 pidiendo clientId/cid. */
  clientName?: string;
  /** Solo tempban: 1..43200 minutos. */
  durationMinutes?: number;
}

/** POST /iam/unban: exactamente una clave (clientId | guid | cid). */
export interface IamUnbanRequest {
  clientId?: number;
  /** HEX (formato status/bans.json) o decimal del ranking. */
  guid?: string;
  /** Slot conectado. */
  cid?: number;
}

/** Entrada de bans.json del server (GET /iam/bans, solo lectura). */
export interface IamBanEntry {
  kind: "ip" | "guid";
  value: string;
  /** Solo kind "guid": el mismo ban en decimal del ranking. */
  guidDecimal: string | null;
}

/** GET /iam/bans — bans.json del server. Sin env → configured:false y lista vacía; sin archivo → exists:false. */
export interface IamBansResponse {
  configured: boolean;
  exists: boolean;
  file: string | null;
  bans: IamBanEntry[];
}

export interface IamPenaltyResponse {
  executed: boolean;
  type: string;
  clientId: number;
  serverId: number;
  /** Relé textual del upstream, para feedback en el UI. */
  output: string[];
}

/* Identidad (docs/API.md §Admin: identity-alerts + alias-conflicts) */

/** Colisión de nombre: un mismo displayName usado por ≥2 GUIDs distintos. */
export interface AliasConflictGuid {
  guid: string;
  /** Nombre EXACTO más reciente del guid para esa clave. */
  name: string;
  linked: boolean;
  linkedAccountId: number | null;
  /** Solo en este endpoint ADMIN. */
  linkedEmail: string | null;
  isBot: boolean;
  lastSeenAt: string;
  /** Suma de todas las variantes del nombre para ese guid. */
  occurrences: number;
}

export interface NameCollision {
  /** Clave normalizada (nombre limpio sin ^X, lowercase). */
  nameKey: string;
  /** Nombre exacto más reciente del grupo, para pintar. */
  displayName: string;
  distinctAccounts: number;
  /** high = ≥2 guids linked a cuentas DISTINTAS. */
  severity: "high" | "low";
  guids: AliasConflictGuid[];
}

export interface SharedGuid {
  guid: string;
  name: string;
  linked: boolean;
  isBot: boolean;
  /** Claves limpias distintas (puede exceder aliases.length). */
  aliasCount: number;
  /** Máx 10, lastSeenAt desc. */
  aliases: PlayerAlias[];
}

export interface AliasConflictsResponse {
  nameCollisions: NameCollision[];
  sharedGuids: SharedGuid[];
  generatedAt: string;
}

export type IdentityAlertAction = "LINK_TO_OWNER" | "DISMISS";

export type IdentityAlertStatus = "OPEN" | "RESOLVED_OWNER" | "RESOLVED_IMPOSTOR" | "DISMISSED";

export interface IdentityAlertOwner {
  id: number;
  email: string;
  displayName: string;
  /** GUIDs ya vinculados a la cuenta del dueño. */
  linkedGuids: string[];
}

/** Alerta de identidad: alguien usa en el juego el nick reservado de una cuenta web. */
export interface IdentityAlert {
  id: number;
  /** Nick reclamado (nombre visto en el server; puede traer códigos ^X). */
  name: string;
  guid: string;
  status: IdentityAlertStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  owner: IdentityAlertOwner;
  /** GUIDs del dueño al momento de crear la alerta (null si no tenía ninguno). */
  ownerLinkedGuidsSnapshot: string[] | null;
}

export interface IdentityAlertsResponse {
  alerts: IdentityAlert[];
  counts: Record<IdentityAlertStatus, number>;
  total: number;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  auth?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, auth = false } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (auth && token) headers["Authorization"] = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, {
      code: "NETWORK_ERROR",
      message: "No hay conexión con el servidor.",
    });
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const errorBody = (payload as { error?: ApiErrorBody } | null)?.error;
    throw new ApiError(
      response.status,
      errorBody ?? { code: "INTERNAL", message: "Error inesperado del servidor." },
    );
  }

  return payload as T;
}

export const api = {
  register(input: { email: string; password: string; displayName: string }) {
    return request<AuthResponse>("/auth/register", { method: "POST", body: input });
  },

  /**
   * Login con nick O email (`identifier`). Fallback legacy: si el backend aún no acepta
   * `identifier` (VALIDATION_ERROR por clave desconocida), reintenta con el campo `email`.
   */
  async login(input: { identifier: string; password: string }) {
    try {
      return await request<AuthResponse>("/auth/login", {
        method: "POST",
        body: { identifier: input.identifier, password: input.password },
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "VALIDATION_ERROR") {
        return request<AuthResponse>("/auth/login", {
          method: "POST",
          body: { email: input.identifier, password: input.password },
        });
      }
      throw error;
    }
  },

  me() {
    return request<{ user: User }>("/auth/me", { auth: true });
  },

  /** PATCH /auth/me: displayName y/o password (con currentPassword). */
  updateMe(input: { displayName?: string; currentPassword?: string; password?: string }) {
    return request<{ user: User }>("/auth/me", { method: "PATCH", body: input, auth: true });
  },

  leaderboard(params: LeaderboardParams) {
    const qs = new URLSearchParams();
    if (params.sort) qs.set("sort", params.sort);
    if (params.order) qs.set("order", params.order);
    if (params.search) qs.set("search", params.search);
    if (params.page !== undefined) qs.set("page", String(params.page));
    if (params.pageSize !== undefined) qs.set("pageSize", String(params.pageSize));
    // Siempre explícito: el server rotó includeBots entre opcional y requerido durante el deploy.
    qs.set("includeBots", params.includeBots ? "true" : "false");
    const query = qs.toString();
    return request<LeaderboardResponse>(`/leaderboard${query ? `?${query}` : ""}`);
  },

  player(guid: string) {
    return request<PlayerDetail>(`/players/${encodeURIComponent(guid)}`);
  },

  /** DELETE /link/:guid → desvincula un GUID propio (la vinculación se hace desde el launcher). */
  unlinkGuid(guid: string) {
    return request<UnlinkResponse>(`/link/${encodeURIComponent(guid)}`, { method: "DELETE", auth: true });
  },

  /** GET /servers — lista pública de servers conocidos. */
  servers() {
    return request<ServersResponse>("/servers");
  },

  getServerConfig() {
    return request<ServerConfigResponse>("/admin/server-config", { auth: true });
  },

  putServerConfig(patch: ServerConfigSaveRequest) {
    return request<ServerConfigSaveResponse>("/admin/server-config", { method: "PUT", body: patch, auth: true });
  },

  restartServer() {
    return request<RestartServerResponse>("/admin/server/restart", { method: "POST", body: {}, auth: true });
  },

  syncStatus() {
    return request<SyncStatusResponse>("/sync/status");
  },

  /* Moderación — bridge IW4MAdmin (docs/API.md §Moderación, ADMIN). */

  iamStatus() {
    return request<IamStatusResponse>("/admin/iam/status", { auth: true });
  },

  iamLive() {
    return request<IamLiveResponse>("/admin/iam/live", { auth: true });
  },

  iamClients(query: string) {
    return request<IamClientsResponse>(`/admin/iam/clients?query=${encodeURIComponent(query)}`, {
      auth: true,
    });
  },

  iamPenalties(limit = 30) {
    return request<IamPenaltiesResponse>(`/admin/iam/penalties?limit=${limit}`, { auth: true });
  },

  iamPenalty(input: IamPenaltyRequest) {
    return request<IamPenaltyResponse>("/admin/iam/penalty", {
      method: "POST",
      body: input,
      auth: true,
    });
  },

  /** POST /iam/unban: revoca el ban permanente del server (bans.json) y marca nuestras penalidades como revocadas. */
  iamUnban(input: IamUnbanRequest) {
    return request<IamPenaltyResponse>("/admin/iam/unban", {
      method: "POST",
      body: input,
      auth: true,
    });
  },

  /** GET /iam/bans: lectura de bans.json del server (los bans permanentes viven allí y sobreviven reinicios). */
  iamBans() {
    return request<IamBansResponse>("/admin/iam/bans", { auth: true });
  },

  /* Identidad — ADMIN (docs/API.md §Admin). */

  /** Alertas de identidad. `status` opcional: sin param = todas. 404 si el backend aún no lo despliega. */
  identityAlerts(status?: string) {
    const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
    return request<IdentityAlertsResponse>(`/admin/identity-alerts${suffix}`, { auth: true });
  },

  /** Resuelve una alerta: LINK_TO_OWNER (nick→dueño) o DISMISS (descartar/castigado). Devuelve la alerta actualizada. */
  resolveIdentityAlert(id: number | string, action: IdentityAlertAction) {
    return request<IdentityAlert>(`/admin/identity-alerts/${encodeURIComponent(String(id))}/resolve`, {
      method: "POST",
      body: { action },
      auth: true,
    });
  },

  /** Conflictos de alias (read-only): colisiones de nombre + guids multi-alias. */
  aliasConflicts() {
    return request<AliasConflictsResponse>("/admin/alias-conflicts", { auth: true });
  },
};
