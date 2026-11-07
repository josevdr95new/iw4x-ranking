import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { registerUser, req, resetDb } from './helpers.js';
import { resetIamCookieCache } from '../src/lib/iam/upstream.js';
import { resetPenaltiesDbCache } from '../src/lib/iam/penalties-db.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DB = resolve(here, 'data', 'iam-penalties.sqlite');
const SERVER_ID = 12700128961;

// ── Env del bridge: aislada para que el .env real no se cuele en los tests ──

const SAVED_ENV: Record<string, string | undefined> = {
  IW4MADMIN_WEBFRONT_URL: process.env.IW4MADMIN_WEBFRONT_URL,
  IW4MADMIN_API_USER: process.env.IW4MADMIN_API_USER,
  IW4MADMIN_API_PASS: process.env.IW4MADMIN_API_PASS,
  IW4MADMIN_PENALTIES_DB_PATH: process.env.IW4MADMIN_PENALTIES_DB_PATH,
};

// ── Fake del webfront de IW4MAdmin (rutas deterministas + registro de calls) ──

interface FakeResponseSpec {
  status?: number;
  body?: unknown;
  statusText?: string;
  headers?: Record<string, string>;
}

interface Call {
  method: string;
  url: URL;
  body: string | undefined;
  headers: Record<string, string>;
}

type Route = {
  method: 'GET' | 'POST';
  path: RegExp;
  handler: (call: Call) => FakeResponseSpec;
};

const calls: Call[] = [];
let routes: Route[] = [];

const state = {
  serverRequiresCookie: false,
  loginAlways: false,
  server401Once: false,
};

function fakeResponse(spec: FakeResponseSpec): Response {
  const status = spec.status ?? 200;
  const headers = spec.headers ?? {};
  const body = spec.body === undefined ? '' : JSON.stringify(spec.body);
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: spec.statusText ?? '',
    headers: {
      get: (name: string): string | null => (name.toLowerCase() === 'set-cookie' ? headers['set-cookie'] ?? null : null),
    },
    text: async () => body,
  } as unknown as Response;
}

/** LIKE limpio: igual que cleanName del servicio (códigos de color fuera). */
const cleanNameLike = (raw: string): string => raw.replace(/\^[0-9a-zA-Z]/g, '').trim().toLowerCase();

const CLIENT_CATALOG = [
  { clientId: 5, name: 'Player5', xuid: 'AB12CD34' },
  { clientId: 15, name: '^1Dup', xuid: 'EF567890' },
  { clientId: 16, name: 'Dup', xuid: 'EF901234' },
  { clientId: 8, name: 'Color^2Gamer', xuid: 'AABBCCDD' },
  { clientId: 9, name: 'OfflineSam', xuid: 'ABCDEF12' },
  { clientId: 42, name: 'apiadmin', xuid: 'DEADBEEF' },
];

function baseRoutes(): Route[] {
  return [
    {
      method: 'GET',
      path: /\/api\/server$/,
      handler: () => {
        if (state.server401Once) {
          state.server401Once = false;
          return { status: 401 };
        }
        if (state.serverRequiresCookie && !callsHeaderCookie()) {
          return { status: 401 };
        }
        return {
          body: [
            {
              id: SERVER_ID,
              serverName: '^7[^1RANKING^7] ^7Test',
              listenAddress: '127.0.0.1',
              listenPort: 28961,
              game: 'IW4',
              clientNum: 1,
              maxClients: 18,
              currentMap: { name: 'mp_rust', alias: 'Rust' },
              currentGameType: { type: 'war', name: 'Team Deathmatch' },
              parser: 'Call of Duty',
            },
          ],
        };
      },
    },
    {
      method: 'GET',
      path: /\/api\/Status$/,
      handler: () => ({
        body: [
          {
            id: SERVER_ID,
            isOnline: true,
            name: 'Test',
            maxPlayers: 18,
            currentPlayers: 2,
            players: [
              { name: 'Player5', score: 3, ping: 50, state: 'Connected', clientNumber: 0, level: 'User' },
              { name: 'Color^2Gamer', score: 0, ping: 0, state: 'Connecting', clientNumber: 1, level: 'User' },
            ],
          },
        ],
      }),
    },
    {
      method: 'GET',
      path: /\/api\/client\/find$/,
      handler: (call) => {
        const name = call.url.searchParams.get('Name')?.toLowerCase();
        const xuid = call.url.searchParams.get('Xuid')?.toLowerCase();
        let found = CLIENT_CATALOG;
        // El upstream real resuelve el LIKE sobre nombres que SÍ pueden llevar
        // códigos de color: modelamos la comparación limpia (cleanName) para que
        // la búsqueda por nombre-color-insensible sea factible en el bridge.
        if (name) {
          found = found.filter((client) => cleanNameLike(client.name).includes(name));
        } else if (xuid) found = found.filter((client) => client.xuid.toLowerCase() === xuid);
        return { body: { totalFoundClients: found.length, clients: found } };
      },
    },
    {
      method: 'GET',
      path: /\/api\/client\/\d+$/,
      handler: (call) => {
        const id = Number(call.url.pathname.slice('/api/client/'.length));
        const client = CLIENT_CATALOG.find((entry) => entry.clientId === id);
        if (client === undefined) return { status: 400, body: 'Could not find client' };
        return { body: { clientId: id, name: client.name, level: 'User' } };
      },
    },
    {
      method: 'POST',
      path: /\/api\/server\/\d+\/execute$/,
      handler: (call) => {
        const parsed = JSON.parse(call.body ?? '{}') as { command?: string };
        if (!parsed.command) return { status: 400, body: { title: 'Command cannot be empty' } };
        return { body: { executionTimeMs: 12, output: [`Ejecutado: ${parsed.command}`] } };
      },
    },
    {
      method: 'POST',
      path: /\/api\/client\/\d+\/login$/,
      handler: () => {
        if (state.loginAlways) return { status: 401 };
        return {
          status: 200,
          headers: { 'set-cookie': '.AspNetCore.Cookies=CfDJ8-TOKEN-42; expires=Sat, 07 Nov 2029 00:00:00 GMT; path=/' },
        };
      },
    },
  ];
}

/** Último cookie header registrado (para que la DB de rutas vea el esatdo del fetch). */
function callsHeaderCookie(): string | undefined {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const cookie = calls[index]!.headers.cookie;
    if (cookie !== undefined) return cookie;
  }
  return undefined;
}

function stubFetch(): void {
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const call: Call = { method, url, body, headers };
    calls.push(call);
    for (const route of routes) {
      if (route.method !== method) continue;
      if (route.path.test(url.pathname)) return fakeResponse(route.handler(call));
    }
    return fakeResponse({ status: 404, body: { title: `Not Found: ${url.pathname}` } });
  };
  vi.stubGlobal('fetch', fetchImpl as unknown as typeof fetch);
}

function resetState(): void {
  routes = baseRoutes();
  state.serverRequiresCookie = false;
  state.loginAlways = false;
  state.server401Once = false;
  calls.length = 0;
}

// ── Fixtures: DB de penalidades (EFPenalties/EFAlias/EFClients mini-schema) ──

beforeAll(async () => {
  await resetDb();
  mkdirSync(dirname(FIXTURE_DB), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) rmSync(FIXTURE_DB + suffix, { force: true });
  const db = new Database(FIXTURE_DB);
  db.exec(`
    CREATE TABLE EFClients (ClientId INTEGER PRIMARY KEY, NetworkId INTEGER, Level INTEGER, CurrentAliasId INTEGER);
    CREATE TABLE EFAlias (AliasId INTEGER PRIMARY KEY, Name TEXT, SearchableName TEXT, IPAddress INTEGER);
    CREATE TABLE EFPenalties (
      PenaltyId INTEGER PRIMARY KEY, Active INTEGER, AutomatedOffense TEXT, Expires TEXT,
      IsEvadedOffense INTEGER, LinkId INTEGER, OffenderId INTEGER, Offense TEXT,
      PunisherId INTEGER, Type INTEGER, "When" TEXT
    );
  `);
  db.prepare('INSERT INTO EFClients (ClientId, NetworkId, Level, CurrentAliasId) VALUES (?,?,?,?)').run(5, 123, 0, 101);
  db.prepare('INSERT INTO EFClients (ClientId, NetworkId, Level, CurrentAliasId) VALUES (?,?,?,?)').run(6, 124, 0, 102);
  db.prepare('INSERT INTO EFClients (ClientId, NetworkId, Level, CurrentAliasId) VALUES (?,?,?,?)').run(7, 125, 0, 103);
  db.prepare('INSERT INTO EFClients (ClientId, NetworkId, Level, CurrentAliasId) VALUES (?,?,?,?)').run(9, 126, 0, 104);
  db.prepare('INSERT INTO EFClients (ClientId, NetworkId, Level, CurrentAliasId) VALUES (?,?,?,?)').run(10, 127, 6, 100);
  for (const [aliasId, name] of [[100, 'PunisherPat'], [101, 'Player5'], [102, 'ExpiredIan'], [103, 'KickedKim'], [104, 'OfflineSam']]) {
    db.prepare('INSERT INTO EFAlias (AliasId, Name, SearchableName, IPAddress) VALUES (?,?,?,?)').run(aliasId, name, String(name).toLowerCase(), 0x0100007f);
  }
  // [id, offender, punisher, type, offense, automated, when, expires]
  const rows: Array<[number, number, number, number, string, string | null, string, string | null]> = [
    [1, 5, 10, 5, 'cheating (permban)', null, '2026-11-05 13:00:00', null], // ban permanente (abierto)
    [2, 5, 10, 1, 'abuso de voz', null, '2026-11-05 14:00:00', '2030-01-01 00:00:00'], // warn abierto
    [3, 6, 10, 1, 'spam de voz', null, '2026-11-05 15:00:00', '2026-11-05 18:00:00'], // warn EXPIRADO
    [4, 7, 10, 3, 'tk reiterado', null, '2026-11-05 16:00:00', null], // kick (kick no se "expira")
    [5, 6, 10, 6, 'unban manual', null, '2026-11-05 17:00:00', null], // unban
    [6, 9, 10, 4, 'exploit', 'WL detect: xuid ABCDEF12', '2026-11-05 12:00:00', '2026-11-05 13:30:00'], // tempban expirado
  ];
  const insert = db.prepare(
    'INSERT INTO EFPenalties (PenaltyId, OffenderId, PunisherId, Type, Offense, AutomatedOffense, "When", Expires, Active) VALUES (?,?,?,?,?,?,?,?,?)',
  );
  for (const row of rows) insert.run(row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], 1);
  db.close();

  // Tokens: admin (promovido vía DB) + user normal.
  const admin = await req()
    .post('/api/auth/register')
    .send({ email: 'iam-admin@test.local', password: 'supersecret123', displayName: 'Iam Admin' });
  expect(admin.status).toBe(201);
  await prisma.user.update({ where: { email: 'iam-admin@test.local' }, data: { role: 'ADMIN' } });
  const login = await req().post('/api/auth/login').send({ identifier: 'Iam Admin', password: 'supersecret123' });
  adminToken = (login.body as { token: string }).token;

  const plebLogin = await registerUser('iam-pleb@test.local');
  userToken = plebLogin.token;
});

let adminToken = '';
let userToken = '';

afterAll(async () => {
  await resetDb();
});

beforeEach(() => {
  resetState();
  resetIamCookieCache();
  resetPenaltiesDbCache();
  stubFetch();
  delete process.env.IW4MADMIN_WEBFRONT_URL;
  delete process.env.IW4MADMIN_API_USER;
  delete process.env.IW4MADMIN_API_PASS;
  delete process.env.IW4MADMIN_PENALTIES_DB_PATH;
});

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
});

// ── Helpers de aserción ───────────────────────────────────────────────────

const errorBody = (body: unknown): { code: string; message: string } =>
  (body as { error: { code: string; message: string } }).error;

const executeCall = (): Call | undefined => {
  // La ÚLTIMA llamada de execute (los tests encadenan varias penalidades).
  const matches = calls.filter((call) => call.method === 'POST' && /\/execute$/.test(call.url.pathname));
  return matches[matches.length - 1];
};

const loginCalls = (): Call[] => calls.filter((call) => /\/login$/.test(call.url.pathname));

const serverCalls = (): Call[] => calls.filter((call) => call.url.pathname === '/api/server');

const findCalls = (): Call[] => calls.filter((call) => call.url.pathname === '/api/client/find');

// ── Tests ─────────────────────────────────────────────────────────────────

describe('GET /api/admin/iam/status', () => {
  it('sin env → configured:false + error legible (nunca explota 502 al frontend)', async () => {
    const res = await req().get('/api/admin/iam/status').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as { configured: boolean; reachable: boolean; error: string | null; penaltiesDb: { configured: boolean } };
    expect(body.configured).toBe(false);
    expect(body.reachable).toBe(false);
    expect(body.error).toContain('IW4MADMIN_WEBFRONT_URL');
    expect(body.penaltiesDb).toEqual({ configured: false });
  });

  it('con webfront: reachable:true y servers normalizados', async () => {
    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    const res = await req().get('/api/admin/iam/status').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      configured: boolean;
      reachable: boolean;
      error: string | null;
      servers: Array<{ id: number; name: string; game: string; map: string | null; gametype: string | null; players: number; maxPlayers: number; parser: string | null }>;
    };
    expect(body.configured).toBe(true);
    expect(body.reachable).toBe(true);
    expect(body.error).toBeNull();
    expect(body.servers).toEqual([
      {
        id: SERVER_ID,
        name: '^7[^1RANKING^7] ^7Test',
        game: 'IW4',
        map: 'Rust',
        gametype: 'Team Deathmatch',
        players: 1,
        maxPlayers: 18,
        parser: 'Call of Duty',
      },
    ]);
  });

  it('webfront caído: reachable:false + error (200 siempre)', async () => {
    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1624');
      }),
    );
    const res = await req().get('/api/admin/iam/status').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as { configured: boolean; reachable: boolean; error: string | null };
    expect(body.configured).toBe(true);
    expect(body.reachable).toBe(false);
    expect(body.error).toContain('ECONNREFUSED');
  });
});

describe('GET /api/admin/iam/clients', () => {
  it('503 IAM_NOT_CONFIGURED sin url', async () => {
    const res = await req().get('/api/admin/iam/clients?query=Player5').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(503);
    expect(errorBody(res.body).code).toBe('IAM_NOT_CONFIGURED');
  });

  it('400 con query corta (<3) y 403 con token USER', async () => {
    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    const short = await req().get('/api/admin/iam/clients?query=pl').set('Authorization', `Bearer ${adminToken}`);
    expect(short.status).toBe(400);
    expect(errorBody(short.body).code).toBe('VALIDATION_ERROR');

    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    const forbidden = await req().get('/api/admin/iam/clients?query=pl').set('Authorization', `Bearer ${userToken}`);
    expect(forbidden.status).toBe(403);
    expect(errorBody(forbidden.body).code).toBe('FORBIDDEN');
  });

  it('por nombre: sin DB de penalidades → openPenalties:null y level:null', async () => {
    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    const res = await req().get('/api/admin/iam/clients?query=Player5').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as { total: number; penaltiesDb: boolean; clients: Array<{ clientId: number; name: string; xuid: string; level: string | null; openPenalties: unknown[] | null }> };
    expect(body.penaltiesDb).toBe(false);
    expect(body.total).toBe(1);
    expect(body.clients).toEqual([
      { clientId: 5, name: 'Player5', xuid: 'AB12CD34', level: null, openPenalties: null },
    ]);
  });

  it('con DB: penalidades abiertas (solo vigentes) + level', async () => {
    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    process.env.IW4MADMIN_PENALTIES_DB_PATH = FIXTURE_DB;
    const res = await req().get('/api/admin/iam/clients?query=Player5').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      penaltiesDb: boolean;
      clients: Array<{ clientId: number; level: string | null; openPenalties: Array<{ type: string; reason: string | null; expires: string | null }> | null }>;
    };
    expect(body.penaltiesDb).toBe(true);
    const client = body.clients[0]!;
    expect(client.level).toBe('User');
    const types = client.openPenalties?.map((penalty) => penalty.type).sort();
    expect(types).toEqual(['ban', 'warn']); // el warn expirado (fecha 2026-11-05 18h) NO está
    expect(client.openPenalties?.find((penalty) => penalty.type === 'ban')?.reason).toBe('cheating (permban)');
    expect(client.openPenalties?.find((penalty) => penalty.type === 'warn')?.expires).toContain('2030-01-01');
  });

  it('por xuid hex usa el cauce Xuid del upstream', async () => {
    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    process.env.IW4MADMIN_PENALTIES_DB_PATH = FIXTURE_DB;
    const res = await req().get('/api/admin/iam/clients?query=ab12cd34').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(findCalls().some((call) => call.url.searchParams.get('Xuid') === 'ab12cd34')).toBe(true);
    const body = res.body as { clients: Array<{ clientId: number }> };
    expect(body.clients.some((client) => client.clientId === 5)).toBe(true);
  });
});

describe('GET /api/admin/iam/penalties', () => {
  it('503 sin IW4MADMIN_PENALTIES_DB_PATH', async () => {
    const res = await req().get('/api/admin/iam/penalties?limit=5').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(503);
    expect(errorBody(res.body).code).toBe('IAM_PENALTIES_DB_NOT_CONFIGURED');
  });

  it('historial normalizado (warn/kick/tempban/ban/unban), más nuevos primero + límite respetado', async () => {
    process.env.IW4MADMIN_PENALTIES_DB_PATH = FIXTURE_DB;
    const res = await req().get('/api/admin/iam/penalties?limit=2').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      limit: number;
      penalties: Array<{ id: number; type: string; when: string | null; offender: { clientId: number; name: string | null }; punisher: { clientId: number; name: string | null }; expires: string | null }>;
    };
    expect(body.limit).toBe(2);
    expect(body.penalties.map((penalty) => penalty.id)).toEqual([5, 4]);
    expect(body.penalties[0]).toMatchObject({
      id: 5,
      type: 'unban',
      when: '2026-11-05T17:00:00.000Z',
      offender: { clientId: 6, name: 'ExpiredIan' },
      punisher: { clientId: 10, name: 'PunisherPat' },
    });

    const all = await req().get('/api/admin/iam/penalties').set('Authorization', `Bearer ${adminToken}`);
    expect(all.status).toBe(200);
    const allBody = all.body as { penalties: Array<{ id: number; type: string }> };
    expect(allBody.penalties.length).toBe(6); // report/flag NO (whitelist de tipos del scope)
    expect(allBody.penalties.some((penalty) => penalty.type === 'tempban')).toBe(true);

    const bad = await req().get('/api/admin/iam/penalties?limit=101').set('Authorization', `Bearer ${adminToken}`);
    expect(bad.status).toBe(400);
  });
});

describe('GET /api/admin/iam/live', () => {
  it('players en vivo con clientId resuelto (match por nombre limpio)', async () => {
    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    const res = await req().get('/api/admin/iam/live').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as { servers: Array<{ id: number; online: boolean; players: Array<{ name: string; clientId: number | null; clientNumber: number; level: string | null; ping: number }> }> };
    const server = body.servers[0]!;
    expect(server.online).toBe(true);
    const player5 = server.players.find((player) => player.name === 'Player5')!;
    expect(player5.clientId).toBe(5);
    expect(player5.ping).toBe(50);
  });

  it('resolve=false: sin clientId y sin llamadas al find', async () => {
    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    const res = await req().get('/api/admin/iam/live?resolve=false').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as { servers: Array<{ players: Array<{ clientId: number | null }> }> };
    expect(body.servers[0]!.players.every((player) => player.clientId === null)).toBe(true);
    expect(findCalls()).toHaveLength(0);
  });

  it('upstream en timeout → 502 IAM_UPSTREAM_UNREACHABLE con motivo del timeout', async () => {
    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('The operation was aborted.');
        err.name = 'TimeoutError';
        throw err;
      }),
    );
    const res = await req().get('/api/admin/iam/live').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(502);
    expect(errorBody(res.body).code).toBe('IAM_UPSTREAM_UNREACHABLE');
    expect(errorBody(res.body).message).toContain('timeout');
  });
});

describe('POST /api/admin/iam/penalty', () => {
  it('403 con token USER (requireAdmin de la rama /admin)', async () => {
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ clientId: 5, type: 'warn', reason: 'abuso' });
    expect(res.status).toBe(403);
    expect(errorBody(res.body).code).toBe('FORBIDDEN');
  });

  it('400 VALIDATION_ERROR: motivo faltante, tipo fuera de whitelist, tempban sin/exceso duración, sin target', async () => {
    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    const send = (body: object): Promise<{ status: number }> =>
      req().post('/api/admin/iam/penalty').set('Authorization', `Bearer ${adminToken}`).send(body);

    expect((await send({ clientId: 5, type: 'warn' })).status).toBe(400); // sin motivo
    expect((await send({ clientId: 5, type: 'warn', reason: 'ab' })).status).toBe(400); // motivo corto (<3)
    expect((await send({ clientId: 5, type: 'nuke', reason: 'cheat' })).status).toBe(400); // tipo inválido
    expect((await send({ type: 'warn', reason: 'cheat' })).status).toBe(400); // sin clientId/clientName
    expect((await send({ clientId: 5, type: 'tempban', reason: 'cheat' })).status).toBe(400); // tempban sin duración
    expect((await send({ clientId: 5, type: 'tempban', durationMinutes: 0, reason: 'cheat' })).status).toBe(400);
    expect((await send({ clientId: 5, type: 'tempban', durationMinutes: 43201, reason: 'cheat' })).status).toBe(400); // >30d
    expect((await send({ clientId: 5, type: 'tempban', durationMinutes: 43200, reason: 'límite justo' })).status).not.toBe(400);
    expect((await send({ clientName: 'Player5', type: 'ban', reason: 'aimbot confirmado' })).status).toBe(200); // nombre OK
  });

  it('warn online: comando `warn @5 motivo`, output del upstream en relé', async () => {
    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: 5, type: 'warn', reason: 'abuso de voz' });
    expect(res.status).toBe(200);
    const body = res.body as { executed: boolean; type: string; clientId: number; serverId: number; output: string[] };
    expect(body.executed).toBe(true);
    expect(body.type).toBe('warn');
    expect(body.clientId).toBe(5);
    expect(body.serverId).toBe(SERVER_ID);
    expect(body.output.join(' ')).toContain('warn @5 abuso de voz');
    expect(JSON.parse(executeCall()!.body ?? '{}')).toEqual({ command: 'warn @5 abuso de voz' });
    // El reason nunca se manipula: viaja tal cual al comando.
  });

  it('warn offline → 400 (warn/kick solo aplican a players conectados)', async () => {
    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: 9, type: 'warn', reason: 'target offline' });
    expect(res.status).toBe(400);
    expect(errorBody(res.body).message).toContain('no está conectado');
  });

  it('tempban offline OK: comando `tempban @9 <n>m motivo` (siempre minutos)', async () => {
    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: 9, type: 'tempban', durationMinutes: 90, reason: 'exploit' });
    expect(res.status).toBe(200);
    expect(JSON.parse(executeCall()!.body ?? '{}')).toEqual({ command: 'tempban @9 90m exploit' });
  });

  it('permban offline OK: comando `ban @9 motivo`', async () => {
    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: 9, type: 'ban', reason: 'aimbot confirmado' });
    expect(res.status).toBe(200);
    expect(JSON.parse(executeCall()!.body ?? '{}')).toEqual({ command: 'ban @9 aimbot confirmado' });
  });

  it('clientId inexistente → 404 IAM_CLIENT_NOT_FOUND (detalle del /api/client/{id} 400 del upstream)', async () => {
    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: 999, type: 'ban', reason: 'cheat' });
    expect(res.status).toBe(404);
    expect(errorBody(res.body).code).toBe('IAM_CLIENT_NOT_FOUND');
  });

  it('nombre ambiguo → 400 VALIDATION_ERROR pidiendo clientId', async () => {
    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientName: 'Dup', type: 'warn', reason: 'cheat' });
    expect(res.status).toBe(400);
    expect(errorBody(res.body).message).toContain('envía clientId');
  });

  it('nombre exacto único: despacha al clientId correcto (limpiando colorcodes y case)', async () => {
    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientName: 'Player5', type: 'kick', reason: 'afk 10 minutos' });
    expect(res.status).toBe(200);
    expect(JSON.parse(executeCall()!.body ?? '{}')).toEqual({ command: 'kick @5 afk 10 minutos' });

    // 'ColorGamer' (sin codes) debería resolver al cliente 'Color^2Gamer' (#8) por cleanName.
    const gamer = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientName: 'ColorGamer', type: 'kick', reason: 'afk' });
    expect(gamer.status).toBe(200);
    expect(JSON.parse(executeCall()!.body ?? '{}')).toEqual({ command: 'kick @8 afk' });

    // Nombre que no existe → 404.
    const missing = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientName: 'Nadie', type: 'kick', reason: 'afk' });
    expect(missing.status).toBe(404);
    expect(errorBody(missing.body).code).toBe('IAM_CLIENT_NOT_FOUND');
  });

  it('execute del upstream 500 → 502 IAM_UPSTREAM_ERROR con detalle legible', async () => {
    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    routes = routes.map((route) =>
      route.method === 'POST' && route.path.test('/api/server/12700128961/execute')
        ? { ...route, handler: () => ({ status: 500, body: { title: 'boom interno' } }) }
        : route,
    );
    const res = await req()
      .post('/api/admin/iam/penalty')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: 5, type: 'warn', reason: 'cheat' });
    expect(res.status).toBe(502);
    expect(errorBody(res.body).code).toBe('IAM_UPSTREAM_ERROR');
    expect(errorBody(res.body).message).toContain('boom');
  });
});

describe('Auth del proxy (login-by-cookie: cache + relogin)', () => {
  it('sin credenciales: confianza de loopback, cero llamadas de login', async () => {
    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    const res = await req().get('/api/admin/iam/status').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect((res.body as { reachable: boolean }).reachable).toBe(true);
    expect(loginCalls()).toHaveLength(0);
  });

  it('con credenciales: login lazy una vez, cookie cacheada en llamadas siguientes', async () => {
    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    process.env.IW4MADMIN_API_USER = 'apiadmin';
    process.env.IW4MADMIN_API_PASS = 'super-secret-pass-BY-TEST';
    state.serverRequiresCookie = true; // el upstream EXIGE cookie: valida el cauce del login

    const res = await req().get('/api/admin/iam/status').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect((res.body as { reachable: boolean }).reachable).toBe(true);
    expect(loginCalls()).toHaveLength(1); // cache: una sola vez
    const login = loginCalls()[0]!;
    expect(login.url.pathname).toBe('/api/client/42/login');
    expect(JSON.parse(login.body ?? '{}')).toEqual({ password: 'super-secret-pass-BY-TEST' });
    const serverGet = serverCalls()[0]!;
    expect(serverGet.headers.cookie).toBe('.AspNetCore.Cookies=CfDJ8-TOKEN-42');
  });

  it('401 del upstream → relogin único + retry OK (y sin password en ninguna URL)', async () => {
    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    process.env.IW4MADMIN_API_USER = 'apiadmin';
    process.env.IW4MADMIN_API_PASS = 'super-secret-pass-BY-TEST';
    state.serverRequiresCookie = true;

    const first = await req().get('/api/admin/iam/status').set('Authorization', `Bearer ${adminToken}`);
    expect((first.body as { reachable: boolean }).reachable).toBe(true);
    expect(loginCalls()).toHaveLength(1);

    // La cookie "expira": /api/server devuelve 401 una vez (aunque llegue con cookie).
    let expiredOnce = false;
    routes = routes.map((route) =>
      route.method === 'GET' && route.path.test('/api/server')
        ? {
            ...route,
            handler: (call: Call) => {
              if (!expiredOnce) {
                expiredOnce = true;
                return { status: 401 };
              }
              if (!call.headers.cookie) return { status: 401 };
              return baseRoutes()[0]!.handler(call);
            },
          }
        : route,
    );
    const second = await req().get('/api/admin/iam/status').set('Authorization', `Bearer ${adminToken}`);
    expect(second.status).toBe(200);
    expect((second.body as { reachable: boolean }).reachable).toBe(true);
    expect(loginCalls()).toHaveLength(2); // cache + relogin del 401

    // El password NUNCA viaja en query ni headers (solo en el body del login).
    for (const call of calls) {
      expect(call.url.search).not.toContain('super-secret');
      expect(call.headers.cookie ?? '').not.toContain('super-secret');
    }
  });

  it('login rechazado → 503 IAM_UPSTREAM_LOGIN_REJECTED, sin password filtrado (vía /clients, que propaga)', async () => {
    process.env.IW4MADMIN_WEBFRONT_URL = 'http://127.0.0.1:1624';
    process.env.IW4MADMIN_API_USER = 'apiadmin';
    process.env.IW4MADMIN_API_PASS = 'wrong-pass-CENSURED';
    state.loginAlways = true;

    const res = await req().get('/api/admin/iam/clients?query=Player5').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(503);
    expect(errorBody(res.body).code).toBe('IAM_UPSTREAM_LOGIN_REJECTED');
    expect(JSON.stringify(res.body)).not.toContain('wrong-pass-CENSURED');
    // El password SÓLO viaja en el body del login (lugar legítimo): nunca en URLs
    // ni en headers (cookies). El cuerpo de `calls` NO se assertiona contra el
    // password porque el body del login lo contiene legítimamente.
    expect(calls.every((call) => !call.url.search.includes('wrong-pass-CENSURED'))).toBe(true);
    expect(calls.every((call) => (call.headers.cookie ?? '') !== `Bearer wrong-pass-CENSURED`)).toBe(true);
  });
});
