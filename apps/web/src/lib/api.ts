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

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: { issues?: Array<{ path: string; message: string }> };
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
    this.details = body.details;
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
  firstConnection: string;
  lastConnection: string;
  linked: boolean;
}

export interface PlayerDetail {
  player: PlayerProfile;
  /** Posición global (sort=kills desc); null si el jugador no clasifica (API v0.2). */
  rank: number | null;
  recentEvents: KillEvent[];
  byServer: Array<{ server: string; kills: number; deaths: number }>;
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

  login(input: { email: string; password: string }) {
    return request<AuthResponse>("/auth/login", { method: "POST", body: input });
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
};
