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
  readonly details?: ApiErrorBody["details"];

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
      const field = issue.path.split(".")[0] ?? "";
      if (field && !(field in out)) out[field] = issue.message;
    }
    return out;
  }
}

export interface User {
  id: number;
  email: string;
  displayName: string;
  createdAt: string;
  linkedGuid: string | null;
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

export interface LinkStartResponse {
  attemptId: number;
  status: string;
  windowMinutes: number;
  createdAt: string;
}

export interface LinkCandidate {
  guid: string;
  name: string;
  lastConnection: string;
  /** Último servidor donde se detectó (IP), o null si la fuente no lo expone (API v0.2). */
  server: string | null;
}

export interface LinkCandidatesResponse {
  status: string;
  windowMinutes: number;
  candidates: LinkCandidate[];
}

export interface LinkConfirmResponse {
  status: "linked";
  guid: string;
  name: string;
  linkedAt: string;
}

/** GET /api/sync/status — público desde API v0.2. */
export interface SyncStatusResponse {
  lastSyncAt: string | null;
  configured: boolean;
  intervalMinutes: number;
  windowMinutes: number;
}

interface RequestOptions {
  method?: "GET" | "POST";
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

  linkStart() {
    return request<LinkStartResponse>("/link/start", { method: "POST", body: {}, auth: true });
  },

  /** POST /link/complete sin guid → candidatos. */
  linkCandidates() {
    return request<LinkCandidatesResponse>("/link/complete", { method: "POST", body: {}, auth: true });
  },

  /** POST /link/complete con guid → vincula. */
  linkConfirm(guid: string) {
    return request<LinkConfirmResponse>("/link/complete", { method: "POST", body: { guid }, auth: true });
  },

  syncStatus() {
    return request<SyncStatusResponse>("/sync/status");
  },
};
