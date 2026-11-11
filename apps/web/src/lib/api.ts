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
  | "skill"
  /** Nivel real del save en la nube (nulls al final en desc). API v0.4. */
  | "level";

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

/**
 * Medalla ELO (contrato cerrado backend medallas). Tiers 1–8 derivados del skill;
 * tier 8 = LEYENDA. La UI tolera que el campo no venga (deploy en curso).
 */
export interface PlayerMedal {
  /** 1 (RECLUTA) … 8 (LEYENDA). */
  tierId: number;
  /** Nombre del tier tal cual lo envía la API: "RECLUTA" … "LEYENDA" (con numeral si aplica). */
  name: string;
  /** Asset sin extensión: "medal-1-recluta" → /medals/medal-1-recluta.png. */
  assetId: string;
  /** 0–5 estrellas; null SOLO en tier 8. */
  stars: number | null;
  /** Posición global por skill; solo tier 8 (null en tiers 1–7). */
  globalRank: number | null;
  /** true si está en el top 12 élite (solo tier 8 → anillo ámbar + label TOP 12). */
  eliteTop12: boolean;
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
  /** Nivel real del save en la nube (parseado EN VIVO por GSC). Opcional: API anterior puede no enviarlo; null si no hay nivel conocido. */
  level?: number | null;
  /** Medalla ELO del jugador. Opcional: backend medallas en despliegue; si falta, el UI no la pinta. */
  medal?: PlayerMedal | null;
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
  /** Arma cruda del log (ej. "ump45_eotech_mp").Compat: igual que weaponCode. */
  weapon: string;
  /** Arma cruda del log. Opcional: APIs previas pueden no enviarla. */
  weaponCode?: string | null;
  /** Nombre display humano (ej. "UMP45 + EOTech"). Opcional: APIs previas pueden no enviarla. */
  weaponName?: string | null;
  /** Zona del impacto (head, chest, ...). Opcional: APIs previas pueden no enviarla. */
  hitloc?: string | null;
  /** true si la kill fue a la cabeza. Opcional: APIs previas pueden no enviarla. */
  headshot?: boolean;
  /** true si fue baja/muerte a cuchillo (MOD_MELEE). Opcional: APIs previas pueden no enviarla. */
  isKnife?: boolean;
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
  /** Daño total infligido. Opcional: APIs previas pueden no enviarlo. */
  damageDealt?: number;
  /** Daño total recibido. Opcional: APIs previas pueden no enviarlo. */
  damageTaken?: number;
  /** Daño medio por kill (2 dec); null si 0 kills. Opcional: APIs previas. */
  damagePerKill?: number | null;
  /** Bajas a cuchillo (MOD_MELEE). Opcional: APIs previas pueden no enviarlo. */
  knifeKills?: number;
  /** Muertes a cuchillo. Opcional: APIs previas pueden no enviarlo. */
  knifeDeaths?: number;
  /** Save en la nube parseado EN VIVO por GSC (nivel real del jugador). Opcional: API anterior puede no enviarlo; null si el jugador no tiene nivel conocido. */
  save?: PlayerLiveSave | null;
  firstConnection: string;
  lastConnection: string;
  linked: boolean;
}

/** `player.save` (API v0.4): nivel real leído del save por GSC en el server. */
export interface PlayerLiveSave {
  level: number;
  prestige: number;
  xp: number;
  /** ISO del parseo. */
  parsedAt: string;
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
  /** Medalla ELO (posición global por skill). Opcional: backend medallas en despliegue; null/ausente → sin medalla. */
  medal?: PlayerMedal | null;
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
  /** Contrato nuevo: true si la API verificó que el server volvió tras el reinicio. */
  verified?: boolean;
  /** Nota humana de la API sobre el reinicio; el panel la muestra en el banner de éxito. */
  note?: string;
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

/* Diccionario de armas (docs/API.md §Weapons, público) */

export interface WeaponDictionaryEntry {
  /** Código crudo del log (ej. "ump45_eotech_mp"). */
  code: string;
  /** Nombre display humano (ej. "UMP45 + EOTech"). */
  name: string;
}

export interface WeaponDictionaryResponse {
  total: number;
  weapons: WeaponDictionaryEntry[];
}

/* Control del server por RCON (ADMIN): mapas, bots, sesiones, launcher-only */

export interface MapCatalogEntry {
  id: string;
  name: string;
  group: "base" | "dlc";
}

/** GET /api/admin/server/maps: catálogo + mapa actual EN VIVO (502 si el server no responde). */
export interface ServerMapsResponse {
  current: string | null;
  maps: MapCatalogEntry[];
}

export interface ServerMapResult {
  sent: true;
  map: string;
  /** true cuando el cambio quedó confirmado (ACK directo o visto en status tras el polling de verificación). */
  verified: boolean;
  note: string;
}

export interface ServerRotateResult {
  sent: true;
  command: "map_rotate" | "fast_restart";
  note: string;
}

export interface BotsOverview {
  /** Nº de bots conectados ahora (del status rcon). */
  count: number;
  difficulty: {
    dvar: string;
    /** Valor actual; null (o found:false) = dvar inexistente → mod Bot Warfare NO instalado. */
    value: string | null;
    default: string | null;
    /** false → el server no tiene el mod GSC: `set bots_skill` sería inerte. */
    found: boolean;
    note: string;
  };
  dvars: Record<string, string | null>;
}

/** POST /api/admin/server/bots/difficulty: level 0–9 o contadores por equipo (modo 8). */
export type BotDifficultyRequest = {
  level: number;
} | {
  alliesHard?: number;
  alliesMed?: number;
  axisHard?: number;
  axisMed?: number;
}

export interface BotDifficultyResult {
  sent: true;
  dvar: string;
  value: string;
  commands: string[];
  note: string;
}

export interface BotCountResult {
  sent: true;
  requested: number;
  before: number;
  after: number;
  spawned: number;
  kicked: Array<{ cid: number; guid: string; name: string }>;
  note: string;
}

/** Sesión de juego activa del launcher (GET /api/admin/server/sessions). */
export interface PlaySessionInfo {
  userId: number;
  nick: string;
  guid: string | null;
  lastSeen: string;
  expiresAt: string;
}

export interface ServerSessionsResponse {
  sessions: PlaySessionInfo[];
}

export interface LauncherOnlyResponse {
  enabled: boolean;
}

/* Cuentas web — administración por el dueño (ADMIN) */

export type AccountRole = "USER" | "ADMIN";

/** Fila del listado GET /api/admin/accounts. */
export interface AdminAccount {
  id: number;
  displayName: string;
  email: string;
  role: AccountRole;
  createdAt: string;
  /** Nº de guids vinculados a la cuenta. */
  guidCount: number;
  /** Última vez que alguno de sus guids se vio en un server; null si no tiene guids. */
  lastGuidSeen: string | null;
}

export interface AdminAccountsResponse {
  accounts: AdminAccount[];
}

/** GUID vinculado (detalle de cuenta). */
export interface AdminAccountGuid {
  guid: string;
  lastSeen: string | null;
}

/** Save en la nube parseado (detalle de cuenta); null si la cuenta nunca subió un save. */
export interface AdminAccountSave {
  level: number;
  xp: number;
  parsedAt: string;
}

/** GET /api/admin/accounts/:id — cuenta + guids + save + nº de sesiones. */
export interface AdminAccountDetail extends AdminAccount {
  guids: AdminAccountGuid[];
  save: AdminAccountSave | null;
  sessions: number;
}

export interface AdminAccountDetailResponse {
  account: AdminAccountDetail;
}

/** PATCH /api/admin/accounts/:id — cualquier combinación de displayName/email/role. */
export interface AdminAccountUpdateRequest {
  displayName?: string;
  email?: string;
  role?: AccountRole;
}

export interface AdminAccountUpdateResponse {
  updated: boolean;
  account: AdminAccount;
}

/* Cloud-save propio (GET /api/profile/save, JWT del viewer) */

export interface ProfileSaveFile {
  path: string;
  sha256: string;
  size: number;
  updatedAt: string;
}

/** 200 con `{ exists: false }` (NO 404) si la cuenta nunca subió un save. */
export type ProfileSaveResponse =
  | { exists: false }
  | { exists: true; version: number; updatedAt: string; build: string; files: ProfileSaveFile[] };

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
    // Sin timeout de app a propósito: fetch espera la respuesta completa. Las escrituras de
    // mapa/rotate (verificación RCON por polling) pueden tardar hasta ~45s y NO deben cortarse.
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

  /* Cuentas web — administración por el dueño (ADMIN). */

  /** GET /admin/accounts: listado completo de cuentas web. */
  adminAccounts() {
    return request<AdminAccountsResponse>("/admin/accounts", { auth: true });
  },

  /** GET /admin/accounts/:id: detalle con guids vinculados, save parseado y nº de sesiones. */
  adminAccount(id: number | string) {
    return request<AdminAccountDetailResponse>(`/admin/accounts/${encodeURIComponent(String(id))}`, {
      auth: true,
    });
  },

  /** POST /admin/accounts/:id/password: fija una contraseña nueva (mín. 8). */
  adminSetAccountPassword(id: number | string, password: string) {
    return request<{ updated: boolean }>(`/admin/accounts/${encodeURIComponent(String(id))}/password`, {
      method: "POST",
      body: { password },
      auth: true,
    });
  },

  /** PATCH /admin/accounts/:id: renombra, cambia email y/o rol. */
  adminUpdateAccount(id: number | string, patch: AdminAccountUpdateRequest) {
    return request<AdminAccountUpdateResponse>(`/admin/accounts/${encodeURIComponent(String(id))}`, {
      method: "PATCH",
      body: patch,
      auth: true,
    });
  },

  /** DELETE /admin/accounts/:id: borra la cuenta (links, sesiones y saves; los guids quedan libres). */
  adminDeleteAccount(id: number | string) {
    return request<{ deleted: boolean }>(`/admin/accounts/${encodeURIComponent(String(id))}`, {
      method: "DELETE",
      auth: true,
    });
  },

  /** DELETE /admin/accounts/:id/guids/:guid: desvincula un GUID concreto (anti-suplantación). */
  adminUnlinkAccountGuid(id: number | string, guid: string) {
    return request<{ unlinked: boolean }>(
      `/admin/accounts/${encodeURIComponent(String(id))}/guids/${encodeURIComponent(guid)}`,
      { method: "DELETE", auth: true },
    );
  },

  /* Diccionario de armas — público. */
  weaponDictionary() {
    return request<WeaponDictionaryResponse>("/weapons/dictionary");
  },

  /* Control del server por RCON — ADMIN (errores 502/503 como la moderación). */

  /** GET /admin/server/maps: catálogo 26 mapas + mapa actual EN VIVO. 502 si el server no responde. */
  serverMaps() {
    return request<ServerMapsResponse>("/admin/server/maps", { auth: true });
  },

  /**
   * POST /admin/server/map {map}: cambia el mapa (400 si desconocido). Puede tardar HASTA ~45s:
   * si el server no responde RCON al enviar `map <id>` (normal al cerrar la partida), la API hace
   * polling de verificación antes de responder (200 `{sent, map, verified, note}`) o 502 real.
   */
  changeMap(map: string) {
    return request<ServerMapResult>("/admin/server/map", { method: "POST", body: { map }, auth: true });
  },

  /**
   * POST /admin/server/rotate: `map_rotate` — avanza al siguiente mapa de la rotación.
   * También puede tardar hasta ~45s (misma verificación por polling; 502 real si el server murió).
   */
  rotateMap() {
    return request<ServerRotateResult>("/admin/server/rotate", { method: "POST", body: {}, auth: true });
  },

  /** POST /admin/server/fast_restart: reinicia el mapa actual sin rotar. */
  fastRestart() {
    return request<ServerRotateResult>("/admin/server/fast_restart", { method: "POST", body: {}, auth: true });
  },

  /** GET /admin/server/bots: bots conectados + estado de la dvar bots_skill (found:false = sin mod Bot Warfare). */
  serverBots() {
    return request<BotsOverview>("/admin/server/bots", { auth: true });
  },

  /** POST /admin/server/bots/difficulty: `set bots_skill N` (+ contadores por equipo si objeto). */
  setBotDifficulty(input: BotDifficultyRequest) {
    return request<BotDifficultyResult>("/admin/server/bots/difficulty", {
      method: "POST",
      body: input,
      auth: true,
    });
  },

  /** POST /admin/server/bots/count: spawnBot/clientkick REAL hasta llegar al nº pedido. */
  setBotCount(count: number) {
    return request<BotCountResult>("/admin/server/bots/count", {
      method: "POST",
      body: { count },
      auth: true,
    });
  },

  /** GET /admin/server/sessions: sesiones de juego activas del launcher. */
  serverSessions() {
    return request<ServerSessionsResponse>("/admin/server/sessions", { auth: true });
  },

  /** GET/POST /admin/server/launcher-only: exigir sesión de launcher para entrar al server. */
  launcherOnly() {
    return request<LauncherOnlyResponse>("/admin/server/launcher-only", { auth: true });
  },

  setLauncherOnly(enabled: boolean) {
    return request<LauncherOnlyResponse>("/admin/server/launcher-only", {
      method: "POST",
      body: { enabled },
      auth: true,
    });
  },

  /* Cloud-save propio del viewer (JWT). 200 `{exists:false}` si nunca subió. */
  mySave() {
    return request<ProfileSaveResponse>("/profile/save", { auth: true });
  },
};
