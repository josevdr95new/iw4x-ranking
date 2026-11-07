/**
 * Cliente HTTP para el webfront de IW4MAdmin (SOLO bridge de moderación).
 *
 * Mecanismo de auth REAL de IW4MAdmin (WebfrontCore, tag 2025.12.16.1-prerelease):
 *  - Autenticación por COOKIES de ASP.NET: `POST /api/client/{clientId}/login`
 *    con `{"password": "..."}` → `Set-Cookie: .AspNetCore.Cookies=...`
 *    (BaseController.SignInAsync, cookie persistente de 3 meses).
 *  - BONUS de despliegue same-host: `BaseController.OnActionExecuting` otorga
 *    acceso Console completo a las peticiones que llegan desde 127.0.0.1 SIN el
 *    header `X-Forwarded-For` (verificado en vivo). Si la API corre en la misma
 *    máquina que IW4MAdmin NO hace falta login ni credenciales.
 *
 * Estrategia del proxy:
 *  - Con IW4MADMIN_API_USER + IW4MADMIN_API_PASS: login por cookie con cache,
 *    resolviendo el clientId del usuario vía /api/client/find, y re-login
 *    automático (una vez) al recibir 401.
 *  - Sin credenciales: llamadas directas (confianza de loopback same-host).
 *  - NUNCA se registran ni exponen passwords/cookies/tokens en errores (censor).
 *  - Timeouts con AbortSignal + errores normalizados (IamUpstreamError).
 */

export class IamUpstreamError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'IamUpstreamError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

// ── Config leída EN CADA llamada (permite mutar env en tests) ──────────────

export const iamUpstreamConfig = {
  get baseUrl(): string | undefined {
    const url = process.env.IW4MADMIN_WEBFRONT_URL;
    return url && url.trim().length > 0 ? url.trim().replace(/\/+$/, '') : undefined;
  },
  get apiUser(): string | undefined {
    const value = process.env.IW4MADMIN_API_USER;
    return value && value.trim().length > 0 ? value.trim() : undefined;
  },
  get apiPass(): string | undefined {
    const value = process.env.IW4MADMIN_API_PASS;
    return value && value.trim().length > 0 ? value : undefined;
  },
  /** Credenciales completas únicamente cuando user y pass estén ambas presentes. */
  get hasCredentials(): boolean {
    return this.apiUser !== undefined && this.apiPass !== undefined;
  },
  get configured(): boolean {
    return this.baseUrl !== undefined;
  },
};

export const DEFAULT_TIMEOUT_MS = 8_000;

// ── Cookie cache (login persistente del usuario API) ──────────────────────

interface CookieAuthState {
  cookie: string | null;
  loginUserId: number | null;
}

let cookieState: CookieAuthState = { cookie: null, loginUserId: null };

/** Test helper: resetea el estado del login por cookie. */
export function resetIamCookieCache(): void {
  cookieState = { cookie: null, loginUserId: null };
}

export interface IamResponse {
  status: number;
  ok: boolean;
  statusText: string;
  text: string;
  /** Valor parcial (primer par cookie=value) del header Set-Cookie, si existe. */
  setCookie: string | null;
}

function assertWebfrontUrl(): string {
  const base = iamUpstreamConfig.baseUrl;
  if (!base) {
    throw new IamUpstreamError(
      503,
      'IAM_NOT_CONFIGURED',
      'Credenciales/config de IW4MAdmin no configuradas: define IW4MADMIN_WEBFRONT_URL (ej. http://127.0.0.1:1624).',
    );
  }
  return base;
}

async function rawRequest(
  path: string,
  options: { method: 'GET' | 'POST'; body?: string; cookie?: string; timeoutMs: number },
): Promise<IamResponse> {
  const url = `${assertWebfrontUrl()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: options.method,
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {}),
      },
      body: options.body,
      signal: AbortSignal.timeout(options.timeoutMs),
      // Manual: un redirect (302) ante fallo de auth del webfront NO se sigue.
      redirect: 'manual',
    });
  } catch (err) {
    const reason =
      (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError'
        ? `timeout de ${options.timeoutMs}ms`
        : (err as Error).message;
    throw new IamUpstreamError(
      502,
      'IAM_UPSTREAM_UNREACHABLE',
      `No se pudo contactar el webfront de IW4MAdmin (${reason}).`,
    );
  }

  const rawSetCookie = res.headers.get('set-cookie');
  const setCookie = rawSetCookie ? rawSetCookie.split(';')[0] ?? null : null;
  // La URL jamás incluye credenciales (van en el body del login); es seguro anexarla.
  return { status: res.status, ok: res.ok, statusText: res.statusText, text: await res.text(), setCookie };
}

/** Login del usuario API: find?Name=user → POST login {password} → cookie. */
async function loginAndGetCookie(): Promise<CookieAuthState> {
  const user = iamUpstreamConfig.apiUser;
  const pass = iamUpstreamConfig.apiPass;
  if (user === undefined || pass === undefined) {
    return { cookie: null, loginUserId: null }; // modo loopback same-host
  }

  const findPath = `/api/client/find?Name=${encodeURIComponent(user)}&Count=10&Offset=0`;
  const find = await rawRequest(findPath, { method: 'GET', timeoutMs: DEFAULT_TIMEOUT_MS });
  if (!find.ok) {
    throw new IamUpstreamError(
      502,
      'IAM_UPSTREAM_LOGIN_FAILED',
      `El webfront rechazó la búsqueda del usuario API (HTTP ${find.status}).`,
    );
  }
  const found = JSON.parse(find.text) as { totalFoundClients?: number; clients?: Array<{ clientId: number; name: string }> };
  const match = found.clients?.find((c) => c.name.toLowerCase() === user.toLowerCase());
  if (!match) {
    throw new IamUpstreamError(
      503,
      'IAM_UPSTREAM_LOGIN_USER_NOT_FOUND',
      `El usuario API fijo (IW4MADMIN_API_USER) no coincide exactamente con ningún cliente de IW4MAdmin.`,
    );
  }

  const login = await rawRequest(`/api/client/${match.clientId}/login`, {
    method: 'POST',
    body: JSON.stringify({ password: pass }),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  if (!login.ok) {
    throw new IamUpstreamError(
      503,
      'IAM_UPSTREAM_LOGIN_REJECTED',
      `El webfront rechazó el login (HTTP ${login.status}): revisa IW4MADMIN_API_USER/IW4MADMIN_API_PASS.`,
    );
  }
  if (!login.setCookie) {
    throw new IamUpstreamError(
      502,
      'IAM_UPSTREAM_LOGIN_NO_COOKIE',
      'El webfront no devolvió Set-Cookie al loguear: imposible autenticar por cookie.',
    );
  }

  cookieState = { cookie: login.setCookie, loginUserId: match.clientId };
  return cookieState;
}

/** Cookie actual: cache → re-login lazy. Null en modo loopback (sin creds). */
async function currentCookie(): Promise<string | null> {
  if (!iamUpstreamConfig.hasCredentials) return null;
  if (cookieState.cookie === null) {
    await loginAndGetCookie();
  }
  return cookieState.cookie;
}

export type IamMethod = 'GET' | 'POST';
export interface IamRequestOptions {
  method: IamMethod;
  body?: unknown;
  timeoutMs?: number;
}

/**
 * Request normalizada: maneja login lazy con credenciales y re-login único en 401.
 * Devuelve la respuesta cruda; los 4xx/5xx del upstream NO explotan acá.
 */
export async function iamRequest(path: string, options: IamRequestOptions): Promise<IamResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (let attempt = 1; ; attempt += 1) {
    const cookie = await currentCookie();
    const res = await rawRequest(path, {
      method: options.method,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      cookie: cookie ?? undefined,
      timeoutMs,
    });

    if (res.status === 401 && attempt === 1 && iamUpstreamConfig.hasCredentials) {
      cookieState = { cookie: null, loginUserId: null }; // expiró: relogin y reintenta 1 vez
      continue;
    }

    return res;
  }
}

export interface IamJsonResponse<T> {
  status: number;
  data: T;
}

/** Request + parseo JSON; errores de upstream → 502 IAM_UPSTREAM_* legibles. */
export async function iamRequestJson<T>(path: string, options: IamRequestOptions): Promise<T> {
  const res = await iamRequest(path, options);
  if (!res.ok) {
    let detail = res.statusText || `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(res.text) as { title?: string; errors?: unknown };
      if (parsed.title) detail = parsed.title;
      if (parsed.errors) {
        detail = `${detail} ${JSON.stringify(parsed.errors)}`.slice(0, 300);
      }
    } catch {
      // body no-JSON: queda el statusText
    }
    throw new IamUpstreamError(
      502,
      'IAM_UPSTREAM_ERROR',
      `El webfront de IW4MAdmin respondió ${res.status} para ${path}: ${detail}`,
    );
  }
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new IamUpstreamError(502, 'IAM_UPSTREAM_NON_JSON', `El webfront devolvió contenido no-JSON para ${path}.`);
  }
}
