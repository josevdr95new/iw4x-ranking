/**
 * Prueba de humo end-to-end contra la API corriendo.
 *
 * Requisitos: servidor levantado con IW4MADMIN_DB_PATH apuntando al mock,
 * y al menos una sincronización previa (npm run sync o POST /api/sync).
 *
 * Uso: npm run smoke          (SMOKE_BASE_URL para otra base URL)
 */
interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const checks: Check[] = [];

function record(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
}

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<ApiResponse> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    // respuesta sin cuerpo JSON
  }
  return { status: res.status, body };
}

async function waitUntilHealthy(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await call('GET', '/api/health');
      if (res.status === 200) return true;
    } catch {
      // aún no responde
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 400));
  }
  return false;
}

async function main(): Promise<void> {
  console.log(`[smoke] probando contra ${BASE} ...`);
  const healthy = await waitUntilHealthy();
  record('GET /api/health', healthy);
  if (!healthy) {
    console.error('[smoke] el servidor no responde; ¿lo levantaste?');
    report();
    return;
  }

  // ── Auth ────────────────────────────────────────────────────
  const email = `smoke-${Date.now()}@test.local`;
  const reg = await call('POST', '/api/auth/register', {
    body: { email, password: 'smoke-password-123', displayName: 'Smoke Tester' },
  });
  const token = typeof reg.body['token'] === 'string' ? reg.body['token'] : undefined;
  record('POST /api/auth/register → 201 + token', reg.status === 201 && token !== undefined, JSON.stringify(reg.body));
  if (token === undefined) {
    report();
    return;
  }

  const me = await call('GET', '/api/auth/me', { token });
  record('GET /api/auth/me (con token) → 200', me.status === 200);
  record('GET /api/auth/me (sin token) → 401', (await call('GET', '/api/auth/me')).status === 401);

  // Login SOLO por nick (el email no es credencial de acceso).
  const login = await call('POST', '/api/auth/login', {
    body: { identifier: 'Smoke Tester', password: 'smoke-password-123' },
  });
  record('POST /api/auth/login (por nick) → 200', login.status === 200);
  record(
    'POST /api/auth/login (password incorrecta) → 401',
    (await call('POST', '/api/auth/login', { body: { identifier: 'Smoke Tester', password: 'incorrecta-123' } })).status === 401,
  );
  record(
    'POST /api/auth/login (email en el campo → NO es credencial) → 401',
    (await call('POST', '/api/auth/login', { body: { identifier: email, password: 'smoke-password-123' } })).status === 401,
  );

  // ── Sync ────────────────────────────────────────────────────
  const sync = await call('POST', '/api/sync', { token });
  const syncResult = sync.body['result'] as Record<string, unknown> | undefined;
  record(
    'POST /api/sync → 200 ok',
    sync.status === 200 && syncResult !== undefined && syncResult['ok'] === true,
    JSON.stringify(sync.body),
  );

  // ── Leaderboard ─────────────────────────────────────────────
  const lb = await call('GET', '/api/leaderboard?sort=kills&order=desc&page=1&pageSize=5');
  record('GET /api/leaderboard → 200', lb.status === 200);
  const players = Array.isArray(lb.body['players']) ? (lb.body['players'] as Array<Record<string, unknown>>) : [];
  const top = players.length > 0 ? (players[0] as { guid?: unknown } | undefined) : undefined;

  // ── Perfil / historial ─────────────────────────────────────
  if (typeof top?.guid === 'string') {
    const profile = await call('GET', `/api/players/${top.guid}`);
    record('GET /api/players/:guid → 200', profile.status === 200);
    const history = await call('GET', `/api/players/${top.guid}/history?days=14`);
    record(
      'GET /api/players/:guid/history → 200 + series',
      history.status === 200 && Array.isArray(history.body['series']),
    );
  } else {
    record('perfil de jugador', false, 'leaderboard vacío — ¿corriste npm run mock:db + npm run sync?');
  }

  // ── Vinculación cuenta ↔ GUID ──────────────────────────────
  const linkStart = await call('POST', '/api/link/start', { token });
  record('POST /api/link/start → 200', linkStart.status === 200);

  const candidates = await call('POST', '/api/link/complete', { token, body: {} });
  const candidateList = Array.isArray(candidates.body['candidates'])
    ? (candidates.body['candidates'] as Array<Record<string, unknown>>)
    : [];
  record(
    'POST /api/link/complete (sin guid) → candidatos',
    candidates.status === 200 && candidateList.length > 0,
    `candidatos=${candidateList.length} — si es 0, regenera el mock y re-sincroniza (ventana de 10 min)`,
  );

  const firstCandidate = candidateList.length > 0 ? candidateList[0] : undefined;
  const firstGuid = typeof firstCandidate?.['guid'] === 'string' ? firstCandidate['guid'] : undefined;
  if (firstGuid !== undefined) {
    const done = await call('POST', '/api/link/complete', { token, body: { guid: firstGuid } });
    record('POST /api/link/complete {guid} → linked', done.status === 200, JSON.stringify(done.body));
    const meAfter = await call('GET', '/api/auth/me', { token });
    const user = typeof meAfter.body['user'] === 'object' ? (meAfter.body['user'] as Record<string, unknown>) : undefined;
    record('/me refleja el GUID vinculado', user?.['linkedGuid'] === firstGuid);
  } else {
    record('confirmación de vinculación', false, 'sin candidatos para confirmar');
  }

  report();
}

function report(): void {
  const failed = checks.filter((check) => !check.ok);
  for (const check of checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}${check.detail !== undefined && !check.ok ? ` → ${check.detail}` : ''}`);
  }
  console.log(`[smoke] ${checks.length - failed.length}/${checks.length} checks OK`);
  if (failed.length > 0) process.exitCode = 1;
}

void main();
