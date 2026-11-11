/**
 * Tests de MAPAS (catálogo MW2/IW4x + control rcon) contra FakeRconServer.
 * Wire-format EXACTO de las escrituras y validación del catálogo.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { registerUser, req, resetDb } from './helpers.js';
import { resetSharedRcon } from '../src/lib/rcon/iw4x-rcon.js';
import { MW2_MAP_CATALOG } from '../src/services/server-maps.service.js';
import { FakeRconServer } from './fake-rcon.js';

const PASSWORD = 'test-rcon-pass';
let fake: FakeRconServer;
let adminToken = '';
let userToken = '';

const SAVED_ENV: Record<string, string | undefined> = {
  RCON_HOST: process.env.RCON_HOST,
  RCON_PORT: process.env.RCON_PORT,
  RCON_PASSWORD: process.env.RCON_PASSWORD,
  RCON_SPACING_MS: process.env.RCON_SPACING_MS,
  RCON_RESPONSE_TIMEOUT_MS: process.env.RCON_RESPONSE_TIMEOUT_MS,
};

beforeAll(async () => {
  for (const [key, value] of Object.entries(SAVED_ENV)) delete process.env[key];
  await resetDb();
  const admin = await registerUser('maps-admin@test.local', 'supersecret123', 'Maps Admin');
  await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
  const login = await req().post('/api/auth/login').send({ identifier: 'Maps Admin', password: 'supersecret123' });
  adminToken = (login.body as { token: string }).token;
  const pleb = await registerUser('maps-pleb@test.local');
  userToken = pleb.token;
});

afterAll(async () => {
  await resetDb();
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function useFake(server: FakeRconServer): void {
  process.env.RCON_HOST = '127.0.0.1';
  process.env.RCON_PORT = String(server.port);
  process.env.RCON_PASSWORD = PASSWORD;
  process.env.RCON_SPACING_MS = '15';
  process.env.RCON_RESPONSE_TIMEOUT_MS = '200';
}

beforeEach(async () => {
  resetSharedRcon();
  fake = new FakeRconServer({ password: PASSWORD, statusText: 'map: mp_terminal\nnum score ping guid\n 0 0 30 AB12CD34EF567890 ^1Toxic^7Player 15 192.168.3.50:28960 20 25000\n' });
  await fake.start();
  useFake(fake);
});

afterEach(async () => {
  resetSharedRcon();
  await fake.stop();
});

describe('GET /api/admin/server/maps', () => {
  it('devuelve {current, maps} con el catálogo completo y current EN VIVO del status', async () => {
    const res = await req().get('/api/admin/server/maps').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as { current: string | null; maps: Array<{ id: string; name: string; group: string }> };
    expect(body.current).toBe('mp_terminal'); // del status del fake
    expect(body.maps).toHaveLength(26); // 16 base + 10 dlc
    for (const entry of body.maps) {
      expect(entry.id).toMatch(/^mp_[a-z0-9_]+$/);
      expect(typeof entry.name).toBe('string');
      expect(['base', 'dlc']).toContain(entry.group);
    }
    expect(body.maps.filter((m) => m.group === 'base')).toHaveLength(16);
    expect(body.maps.filter((m) => m.group === 'dlc')).toHaveLength(10);
    // Ids críticos verificados contra rotaciones reales de IW4x:
    const ids = body.maps.map((m) => m.id);
    for (const must of ['mp_afghan', 'mp_brecourt', 'mp_checkpoint', 'mp_compact', 'mp_nightshift', 'mp_abandon', 'mp_fuel2', 'mp_trailerpark', 'mp_strike', 'mp_vacant', 'mp_crash', 'mp_overgrown', 'mp_storm', 'mp_rust', 'mp_terminal']) {
      expect(ids).toContain(must);
    }
    expect(MW2_MAP_CATALOG.find((m) => m.id === 'mp_brecourt')?.name).toBe('Wasteland');
    expect(MW2_MAP_CATALOG.find((m) => m.id === 'mp_checkpoint')?.name).toBe('Karachi');
  });

  it('sin RCON_PASSWORD → 503 MODERATION_NOT_CONFIGURED', async () => {
    delete process.env.RCON_PASSWORD;
    resetSharedRcon();
    const res = await req().get('/api/admin/server/maps').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(503);
    expect((res.body as { error: { code: string } }).error.code).toBe('MODERATION_NOT_CONFIGURED');
  });

  it('server caído → 502 MODERATION_UNREACHABLE (listener mudo que nunca responde)', async () => {
    // OJO: NO basta un puerto "cerrado" en Windows — el socket efímero del
    // propio cliente puede recibir el puerto adyacente y auto-ecoarse su
    // propio request. Un listener UDP mudo (nunca responde) es determinista:
    // el cliente agota timeouts de lectura → RconTimeoutError → 502.
    const { createSocket } = await import('node:dgram');
    const blackHole = createSocket('udp4');
    await new Promise<void>((resolvePromise) => blackHole.bind(0, '127.0.0.1', () => resolvePromise()));
    const silentPort = blackHole.address().port;
    process.env.RCON_PORT = String(silentPort);
    resetSharedRcon();
    try {
      const res = await req().get('/api/admin/server/maps').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(502);
      expect((res.body as { error: { code: string } }).error.code).toBe('MODERATION_UNREACHABLE');
    } finally {
      blackHole.close();
    }
  });

  it('no-admin → 403', async () => {
    const res = await req().get('/api/admin/server/maps').set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/server/map', () => {
  it('mapa del catálogo → envía `map <id>` EXACTO por rcon (1 intento) y responde {sent, map, note}', async () => {
    const res = await req().post('/api/admin/server/map').set('Authorization', `Bearer ${adminToken}`).send({ map: 'mp_terminal' });
    expect(res.status).toBe(200);
    const body = res.body as { sent: boolean; map: string; note: string };
    expect(body.sent).toBe(true);
    expect(body.map).toBe('mp_terminal');
    expect(body.note).toContain('segundos');
    const writes = fake.commandsWith('map ').map((entry) => entry.command);
    expect(writes).toEqual(['map mp_terminal']); // wire-format exacto
  });

  it('mapa desconocido → 400 y NINGÚN comando rcon (validación antes de escribir)', async () => {
    const res = await req().post('/api/admin/server/map').set('Authorization', `Bearer ${adminToken}`).send({ map: 'mp_nooo' });
    expect(res.status).toBe(400);
    expect((res.body as { error: { message: string } }).error.message).toContain('desconocido');
    expect(fake.commandsWith('map ')).toHaveLength(0);
  });

  it('inyección → 400 (el body solo admite [A-Za-z0-9_])', async () => {
    const evil = await req().post('/api/admin/server/map').set('Authorization', `Bearer ${adminToken}`).send({ map: 'mp_rust; clientkick 0' });
    expect(evil.status).toBe(400);
    const spaces = await req().post('/api/admin/server/map').set('Authorization', `Bearer ${adminToken}`).send({ map: 'mp rust' });
    expect(spaces.status).toBe(400);
    expect(fake.commandsWith('map ')).toHaveLength(0);
  });

  it('503 sin RCON_PASSWORD', async () => {
    delete process.env.RCON_PASSWORD;
    resetSharedRcon();
    const res = await req().post('/api/admin/server/map').set('Authorization', `Bearer ${adminToken}`).send({ map: 'mp_rust' });
    expect(res.status).toBe(503);
  });
});

describe('POST /api/admin/server/rotate y /fast_restart', () => {
  it('rotate → `map_rotate` EXACTO + {sent:true, command:"map_rotate"}', async () => {
    const res = await req().post('/api/admin/server/rotate').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true, command: 'map_rotate', note: expect.any(String) });
    expect(fake.received.map((entry) => entry.command)).toContain('map_rotate');
  });

  it('fast_restart → `fast_restart` EXACTO + {sent:true, command:"fast_restart"}', async () => {
    const res = await req().post('/api/admin/server/fast_restart').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true, command: 'fast_restart', note: expect.any(String) });
    expect(fake.received.map((entry) => entry.command)).toContain('fast_restart');
  });

  it('ambos → 403 para no-admin y 401 sin auth', async () => {
    expect((await req().post('/api/admin/server/rotate').set('Authorization', `Bearer ${userToken}`)).status).toBe(403);
    expect((await req().post('/api/admin/server/fast_restart').set('Authorization', `Bearer ${userToken}`)).status).toBe(403);
    expect((await req().post('/api/admin/server/rotate')).status).toBe(401);
    expect((await req().post('/api/admin/server/fast_restart')).status).toBe(401);
  });
});

// ── Verificación post-fallo (502 falso negativo del cambio de mapa) ────────
//
// Producción: `map <id>` cierra la partida y el server NO responde RCON a
// tiempo aunque el cambio SÍ aplique. Con ackWrites:false el fake replica ese
// comportamiento (los writes se quedan sin respuesta → RconTimeoutError) y los
// status siguen respondiendo (con el mapa nuevo tras el cambio).

const BASE_STATUS = 'map: mp_terminal\nnum score ping guid\n';

/**
 * Reemplaza el fake del beforeEach por uno que MUTA los writes (sin ACK):
 * el write jamás responde (timeout real del cliente) pero `status` sigue
 * respondiendo. Re-punta la env al puerto nuevo y resetea el cliente shared.
 */
async function useMuteWritesFake(): Promise<FakeRconServer> {
  await fake.stop();
  const silent = new FakeRconServer({ password: PASSWORD, ackWrites: false, statusText: BASE_STATUS });
  await silent.start();
  fake = silent;
  useFake(fake);
  resetSharedRcon();
  return fake;
}

describe('POST /api/admin/server/map: verificación por polling tras timeout', () => {
  const VERIFY_ENV: Record<string, string | undefined> = {
    RCON_MAP_VERIFY_TIMEOUT_MS: process.env.RCON_MAP_VERIFY_TIMEOUT_MS,
    RCON_MAP_VERIFY_INTERVAL_MS: process.env.RCON_MAP_VERIFY_INTERVAL_MS,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(VERIFY_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('timeout del `map` + status confirma el mapa nuevo → 200 {sent, map, verified:true}', async () => {
    process.env.RCON_MAP_VERIFY_TIMEOUT_MS = '1500';
    process.env.RCON_MAP_VERIFY_INTERVAL_MS = '60';
    const silent = await useMuteWritesFake();
    // Al recibir el write `map mp_rust`, el server "cambia" el status EN VIVO
    // (aunque el ACK nunca llegue: ShutdownGame silencia el RCON).
    silent.setOnCommand((command, server) => {
      if (command.startsWith('map ')) {
        server.setStatusText('map: mp_rust\nnum score ping guid\n');
      }
    });
    const res = await req().post('/api/admin/server/map').set('Authorization', `Bearer ${adminToken}`).send({ map: 'mp_rust' });
    expect(res.status).toBe(200);
    const body = res.body as { sent: boolean; map: string; verified: boolean; note: string };
    expect(body.sent).toBe(true);
    expect(body.map).toBe('mp_rust');
    expect(body.verified).toBe(true);
    expect(body.note).toContain('verificado');
    // El write salió (una sola vez, sin retry) y la verificación leyó status.
    expect(fake.commandsWith('map ').map((entry) => entry.command)).toEqual(['map mp_rust']);
    expect(fake.statusReplyCount).toBeGreaterThanOrEqual(1);
  });

  it('timeout del `map` + status NUNCA confirma → 502 MODERATION_UNREACHABLE (error original)', async () => {
    process.env.RCON_MAP_VERIFY_TIMEOUT_MS = '400';
    process.env.RCON_MAP_VERIFY_INTERVAL_MS = '60';
    // El status sigue en mp_terminal durante toda la ventana: sin confirmación.
    await useMuteWritesFake();
    const res = await req().post('/api/admin/server/map').set('Authorization', `Bearer ${adminToken}`).send({ map: 'mp_rust' });
    expect(res.status).toBe(502);
    expect((res.body as { error: { code: string; message: string } }).error.code).toBe('MODERATION_UNREACHABLE');
    expect((res.body as { error: { message: string } }).error.message).toContain('no respondió');
    // Hubo polling (más de 1 status) y el write no se reintentó.
    expect(fake.statusReplyCount).toBeGreaterThanOrEqual(2);
    expect(fake.commandsWith('map ').map((entry) => entry.command)).toEqual(['map mp_rust']);
  });

  it('write OK a la primera → verified:true y NINGÚN polling extra de verificación', async () => {
    const statusesBefore = fake.statusReplyCount;
    const res = await req().post('/api/admin/server/map').set('Authorization', `Bearer ${adminToken}`).send({ map: 'mp_rust' });
    expect(res.status).toBe(200);
    const body = res.body as { sent: boolean; map: string; verified: boolean };
    expect(body.sent).toBe(true);
    expect(body.map).toBe('mp_rust');
    expect(body.verified).toBe(true);
    expect(fake.statusReplyCount).toBe(statusesBefore); // sin polling post-write
  });
});

describe('POST /api/admin/server/rotate: verificación por polling tras timeout', () => {
  const VERIFY_ENV: Record<string, string | undefined> = {
    RCON_MAP_VERIFY_TIMEOUT_MS: process.env.RCON_MAP_VERIFY_TIMEOUT_MS,
    RCON_MAP_VERIFY_INTERVAL_MS: process.env.RCON_MAP_VERIFY_INTERVAL_MS,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(VERIFY_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('timeout del map_rotate + status reporta mapa DISTINTO al anterior → 200 verificado', async () => {
    process.env.RCON_MAP_VERIFY_TIMEOUT_MS = '1500';
    process.env.RCON_MAP_VERIFY_INTERVAL_MS = '60';
    const silent = await useMuteWritesFake();
    silent.setOnCommand((command, server) => {
      if (command === 'map_rotate') {
        server.setStatusText('map: mp_highrise\nnum score ping guid\n');
      }
    });
    const res = await req().post('/api/admin/server/rotate').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = res.body as { sent: boolean; command: string; note: string };
    expect(body.sent).toBe(true);
    expect(body.command).toBe('map_rotate');
    expect(body.note).toContain('verificado');
    expect(fake.received.map((entry) => entry.command)).toContain('map_rotate');
  });

  it('timeout del map_rotate + status no cambia → 502 MODERATION_UNREACHABLE', async () => {
    process.env.RCON_MAP_VERIFY_TIMEOUT_MS = '400';
    process.env.RCON_MAP_VERIFY_INTERVAL_MS = '60';
    await useMuteWritesFake(); // status se queda en mp_terminal
    const res = await req().post('/api/admin/server/rotate').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(502);
    expect((res.body as { error: { code: string } }).error.code).toBe('MODERATION_UNREACHABLE');
    expect(fake.statusReplyCount).toBeGreaterThanOrEqual(2); // hubo polling
    expect(fake.received.map((entry) => entry.command)).toContain('map_rotate');
  });

  it('fast_restart NO cambia: responde normal sin verificación post-fallo (comportamiento intacto)', async () => {
    // Con writes mudos el write de fast_restart también muere... pero
    // fast_restart no tiene polling: debe seguir fallando como siempre (502).
    process.env.RCON_MAP_VERIFY_TIMEOUT_MS = '400';
    process.env.RCON_MAP_VERIFY_INTERVAL_MS = '60';
    await useMuteWritesFake();
    const res = await req().post('/api/admin/server/fast_restart').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(502);
    expect((res.body as { error: { code: string } }).error.code).toBe('MODERATION_UNREACHABLE');
    expect(fake.received.map((entry) => entry.command)).toContain('fast_restart');
  });
});
