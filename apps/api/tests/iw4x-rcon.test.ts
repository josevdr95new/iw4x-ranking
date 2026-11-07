/**
 * Tests del cliente RCON nativo contra un FAKE server UDP (protocolo verificado
 * en vivo contra el server dedicado IW4x real, ver src/lib/rcon/iw4x-rcon.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  IW4XRcon,
  RconNotConfiguredError,
  RconTimeoutError,
  decimalGuidToHex,
  hexGuidToDecimal,
  parseInfoString,
  parseStatus,
  resetSharedRcon,
  statusGuidDecimal,
  stripColorCodes,
} from '../src/lib/rcon/iw4x-rcon.js';
import { CONNECTING_STATUS_FIXTURE, FakeRconServer, LIVE_STATUS_FIXTURE } from './fake-rcon.js';

const SAVED_ENV: Record<string, string | undefined> = {
  RCON_HOST: process.env.RCON_HOST,
  RCON_PORT: process.env.RCON_PORT,
  RCON_PASSWORD: process.env.RCON_PASSWORD,
  RCON_SPACING_MS: process.env.RCON_SPACING_MS,
};

beforeAll(async () => {
  for (const key of Object.keys(SAVED_ENV)) delete process.env[key];
});

afterEach(() => {
  resetSharedRcon();
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(async () => {
  resetSharedRcon();
});

describe('encoding y protocolo del request', () => {
  it('envía `FFFFrcon <password> <cmd>` en latin1 sin terminador null', async () => {
    const fake = new FakeRconServer({ statusText: LIVE_STATUS_FIXTURE });
    await fake.start();
    try {
      const client = new IW4XRcon({
        host: '127.0.0.1',
        port: fake.port,
        password: 'test-rcon-pass',
        spacingMs: 10,
        responseTimeoutMs: 300,
        readRetries: 0,
      });
      await client.exec('status');
      expect(fake.received).toHaveLength(1);
      const packet = fake.received[0]!;
      // El payload EXACTO (sin header) que llega al server.
      expect(packet.raw.slice(4)).toBe('rcon test-rcon-pass status');
      expect(packet.raw.endsWith('\u0000')).toBe(false);
    } finally {
      await fake.stop();
    }
  });

  it('password incorrecta → timeout SILENCIOSO (el server jamás responde)', async () => {
    const fake = new FakeRconServer({ statusText: LIVE_STATUS_FIXTURE });
    await fake.start();
    try {
      const client = new IW4XRcon({
        host: '127.0.0.1',
        port: fake.port,
        password: 'wrong-password',
        spacingMs: 5,
        responseTimeoutMs: 80,
        readRetries: 0,
      });
      await expect(client.exec('status')).rejects.toBeInstanceOf(RconTimeoutError);
      // El request SÍ llegó al server (como en el real) pero fue dropeado.
      expect(fake.rejected).toHaveLength(1);
      expect(fake.rejected[0]!.command).toBe('status');
      expect(fake.received).toHaveLength(0); // y jamás respondió
    } finally {
      await fake.stop();
    }
  });

  it('sin RCON_PASSWORD → RconNotConfiguredError sin abrir socket', async () => {
    const client = new IW4XRcon({ password: undefined, spacingMs: 5, readRetries: 0 });
    await expect(client.exec('status')).rejects.toBeInstanceOf(RconNotConfiguredError);
    expect(client.configured).toBe(false);
  });
});

describe('parser de status', () => {
  it('parsea el fixture REAL: humanos con guid hex, bots ping 999 guid botN', () => {
    const status = parseStatus(LIVE_STATUS_FIXTURE);
    expect(status.map).toBe('mp_terminal');
    expect(status.players).toHaveLength(3);

    const human = status.players[0]!;
    expect(human.cid).toBe(0);
    expect(human.score).toBe(1250);
    expect(human.ping).toBe(30);
    expect(human.guid).toBe('AB12CD34EF567890');
    expect(human.name).toBe('^1Toxic^7Player');
    expect(human.isBot).toBe(false);
    expect(human.connecting).toBe(false);
    expect(human.address).toBe('192.168.3.50:28960');
    expect(statusGuidDecimal(human)).toBe(hexGuidToDecimal('AB12CD34EF567890'));

    const bot = status.players[1]!;
    expect(bot.cid).toBe(1);
    expect(bot.guid).toBe('bot15');
    expect(bot.ping).toBe(999);
    expect(bot.isBot).toBe(true);
    expect(bot.address).toBe('00000000.000000000000:3840');
    expect(bot.rate).toBe(99999);
    expect(statusGuidDecimal(bot)).toBeNull();
  });

  it('parsea filas CNCT (conectando) y nombres multi-palabra', () => {
    const status = parseStatus(CONNECTING_STATUS_FIXTURE);
    expect(status.map).toBe('mp_crash');
    expect(status.players).toHaveLength(2);

    const connecting = status.players[0]!;
    expect(connecting.cid).toBe(3);
    expect(connecting.connecting).toBe(true);
    expect(connecting.ping).toBeNull();
    expect(connecting.name).toBe('^7Newbie^7');
    expect(connecting.guid).toBe('');
    expect(connecting.address).toBe('');

    const multi = status.players[1]!;
    expect(multi.cid).toBe(4);
    expect(multi.name).toBe('Multi ^2Word Guy^7');
    expect(stripColorCodes(multi.name)).toBe('Multi Word Guy');
    expect(multi.guid).toBe('FEDCBA9876543210');
    expect(multi.connecting).toBe(false);
  });

  it('convierte guids hex↔decimal de forma redonda (16 chars, uppercase)', () => {
    const decimal = hexGuidToDecimal('0B08D9C7F6A1B234');
    expect(decimal).toBe('795124787090403892');
    expect(decimalGuidToHex(decimal!)).toBe('0B08D9C7F6A1B234');
    expect(decimalGuidToHex('12345')).toBe('0000000000003039');
    expect(hexGuidToDecimal('nothex!')).toBeNull();
    expect(decimalGuidToHex('12abc')).toBeNull();
  });
});

describe('getinfo', () => {
  it('envía `FFFFgetinfo <challenge>` SIN wrapper rcon y parsea el infostring', async () => {
    const fake = new FakeRconServer();
    await fake.start();
    try {
      const client = new IW4XRcon({
        host: '127.0.0.1',
        port: fake.port,
        password: 'test-rcon-pass',
        spacingMs: 5,
        responseTimeoutMs: 300,
        readRetries: 0,
      });
      const info = await client.getinfo('chall-42');
      const packet = fake.received[0]!;
      expect(packet.raw.slice(4)).toBe('getinfo chall-42');
      expect(info.challenge).toBe('chall-42');
      expect(info.hostname).toBe('^7[^1RANKING^7] ^7Fake Server');
      expect(info.sv_maxclients).toBe('18');
      expect(info.mapname).toBe('mp_rust');
      expect(parseInfoString('infoResponse\n\\a\\1\\b\\dos')).toEqual({ a: '1', b: 'dos' });
    } finally {
      await fake.stop();
    }
  });
});

describe('cola serializada y throttle', () => {
  it('respeta el spacing entre envíos (>= spacingMs - margen de 15ms)', async () => {
    const fake = new FakeRconServer({ statusText: LIVE_STATUS_FIXTURE });
    await fake.start();
    try {
      const client = new IW4XRcon({
        host: '127.0.0.1',
        port: fake.port,
        password: 'test-rcon-pass',
        spacingMs: 120,
        responseTimeoutMs: 300,
        readRetries: 0,
      });
      await client.exec('status');
      await client.exec('status');
      await client.exec('cmdlist');
      expect(fake.received.length).toBeGreaterThanOrEqual(3);
      const gaps = fake.received.slice(1).map((entry, index) => entry.at - fake.received[index]!.at);
      for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(105);
    } finally {
      await fake.stop();
    }
  });

  it('1 comando en vuelo: los exec simultáneos se resuelven sin intercalar', async () => {
    const fake = new FakeRconServer({ statusText: LIVE_STATUS_FIXTURE });
    await fake.start();
    try {
      const client = new IW4XRcon({
        host: '127.0.0.1',
        port: fake.port,
        password: 'test-rcon-pass',
        spacingMs: 10,
        responseTimeoutMs: 300,
        readRetries: 0,
      });
      const [a, b, c] = await Promise.all([
        client.exec('status'),
        client.exec('cmdlist'),
        client.exec('status'),
      ]);
      expect(a.startsWith('map: mp_terminal')).toBe(true);
      expect(b.length).toBeGreaterThanOrEqual(0);
      expect(c.startsWith('map: mp_terminal')).toBe(true);
      expect(fake.received.map((entry) => entry.command)).toEqual(['status', 'cmdlist', 'status']);
    } finally {
      await fake.stop();
    }
  });
});

describe('retries: lecturas sí, escrituras JAMÁS', () => {
  it('lectura: reintenta tras un timeout y resuelve cuando el server contesta', async () => {
    const fake = new FakeRconServer({ statusText: LIVE_STATUS_FIXTURE, delayMs: 250 });
    await fake.start();
    try {
      const client = new IW4XRcon({
        host: '127.0.0.1',
        port: fake.port,
        password: 'test-rcon-pass',
        spacingMs: 10,
        responseTimeoutMs: 150, // intento 1 (150+idle 80 = 230ms < 250) → timeout
        readRetries: 2,         // intento 2 (300+80 = 380ms > 250) → responde
        retryBackoffMs: 20,
      });
      const payload = await client.exec('status');
      expect(payload.startsWith('map: mp_terminal')).toBe(true);
      expect(fake.received).toHaveLength(2); // 2 intentos de envío
    } finally {
      await fake.stop();
    }
  });

  it('escritura (clientkick): UN solo intento aunque nadie responda', async () => {
    // ackWrites=false: el fake no responde NADA a los writes (peor caso real).
    const fake = new FakeRconServer({ ackWrites: false });
    await fake.start();
    try {
      const client = new IW4XRcon({
        host: '127.0.0.1',
        port: fake.port,
        password: 'test-rcon-pass',
        spacingMs: 5,
        responseTimeoutMs: 80,
        readRetries: 3,
        retryBackoffMs: 10,
      });
      await expect(client.clientkick(2)).rejects.toBeInstanceOf(RconTimeoutError);
      expect(fake.received.filter((entry) => entry.command.startsWith('clientkick'))).toHaveLength(1);
    } finally {
      await fake.stop();
    }
  });

  it('ACK vacío (`print\\n` solo) = payload "" sin error', async () => {
    const fake = new FakeRconServer({}); // ackWrites=true → print\n solito
    await fake.start();
    try {
      const client = new IW4XRcon({
        host: '127.0.0.1',
        port: fake.port,
        password: 'test-rcon-pass',
        spacingMs: 5,
        responseTimeoutMs: 300,
        readRetries: 0,
      });
      await expect(client.clientkick(5)).resolves.toBe('');
      expect(fake.hasCommand('clientkick 5')).toBe(true);
    } finally {
      await fake.stop();
    }
  });
});

describe('idle-window multi-datagrama', () => {
  it('acumula una respuesta troceada en 4 datagramas y la resuelve completa', async () => {
    const fake = new FakeRconServer({ statusText: LIVE_STATUS_FIXTURE, splitParts: 4, delayMs: 30 });
    await fake.start();
    try {
      const client = new IW4XRcon({
        host: '127.0.0.1',
        port: fake.port,
        password: 'test-rcon-pass',
        spacingMs: 5,
        responseTimeoutMs: 600,
        readRetries: 0,
      });
      const payload = await client.exec('status');
      const parsed = parseStatus(payload);
      expect(parsed.map).toBe('mp_terminal');
      expect(parsed.players).toHaveLength(3);
    } finally {
      await fake.stop();
    }
  });
});

describe('comandos de moderación (formato exacto del wire)', () => {
  it('say / tell / banClient / tempbanclient / unbanClient guid HEX uppercase', async () => {
    const fake = new FakeRconServer({});
    await fake.start();
    try {
      const client = new IW4XRcon({
        host: '127.0.0.1',
        port: fake.port,
        password: 'test-rcon-pass',
        spacingMs: 5,
        responseTimeoutMs: 300,
        readRetries: 0,
      });
      await client.say('Test moderacion nativa');
      await client.tell(3, 'cuidado con el teamkill');
      await client.banClient(2);
      await client.tempbanclient(4, 'tk reiterado');
      await client.unbanClient('guid', '0b08d9c7f6a1b234');

      expect(fake.received.map((entry) => entry.command)).toEqual([
        'say Test moderacion nativa',
        'tell 3 cuidado con el teamkill',
        'banClient 2',
        'tempbanclient 4 "tk reiterado"',
        'unbanClient guid 0B08D9C7F6A1B234', // hex del guid real, uppercase
      ]);
    } finally {
      await fake.stop();
    }
  });
});
