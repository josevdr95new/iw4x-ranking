/**
 * Sonda RCON del server dedicado IW4x (diagnóstico manual, read-only).
 *
 * Uso: npx tsx scripts/rcon-probe.ts [host] [port]
 * Lee RCON_HOST / RCON_PORT / RCON_PASSWORD del .env (via src/config/env.ts)
 * y ejecuta `getinfo` (sin auth) y `status` (rcon) imprimiendo la respuesta cruda.
 * NUNCA envía comandos de escritura (kick/ban/map): es una sonda de solo lectura.
 */
import dgram from 'node:dgram';
import { env } from '../src/config/env.js';

const host = process.argv[2] ?? env.rconHost ?? '127.0.0.1';
const port = Number(process.argv[3] ?? env.rconPort ?? 28961);
const password = env.rconPassword ?? '';

if (!password) {
  console.error('[probe] RCON_PASSWORD no está configurado: solo se hará getinfo (sin auth).');
}

const socket = dgram.createSocket('udp4');
let chunks: Buffer[] = [];
let idleTimer: NodeJS.Timeout | null = null;
let waiters: Array<(text: string) => void> = [];

socket.on('message', (msg, rinfo) => {
  if (rinfo.address !== host || rinfo.port !== port) return;
  chunks.push(msg);
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(flush, 80); // idle-window: acumula datagramas
});

function flush(): void {
  const text = Buffer.concat(chunks).toString('latin1');
  chunks = [];
  const pending = waiters;
  waiters = [];
  for (const resolve of pending) resolve(text);
}

function send(bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(bytes, port, host, (err) => (err ? reject(err) : resolve()));
  });
}

function exchange(bytes: Buffer, timeoutMs = 1500): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== waiter);
      reject(new Error(`TIMEOUT (${timeoutMs}ms) — password malo/throttle/server caído`));
    }, timeoutMs);
    const waiter = (text: string): void => {
      clearTimeout(timer);
      resolve(text);
    };
    waiters.push(waiter);
    void send(bytes).catch((err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function rcon(command: string): Buffer {
  return Buffer.from(`\u00ff\u00ff\u00ff\u00ffrcon ${password} ${command}`, 'latin1');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

socket.bind(() => {
  void (async () => {
    try {
      const info = await exchange(Buffer.from('\u00ff\u00ff\u00ff\u00ffgetinfo', 'latin1'));
      console.log('=== GETINFO RAW ===');
      console.log(JSON.stringify(info));
      await sleep(250);
      if (password) {
        const status = await exchange(rcon('status'));
        console.log('=== STATUS RAW ===');
        console.log(status);
        await sleep(250);
      }
      console.log('=== DONE ===');
    } catch (err) {
      console.error('[probe] ERROR:', (err as Error).message);
    } finally {
      socket.close();
    }
  })();
});
