/**
 * Cliente RCON NATIVO para el server dedicado IW4x (protocolo Quake-style UDP).
 *
 * Reemplaza el bridge HTTP con el webfront de IW4MAdmin: la moderación habla
 * DIRECTO con el juego vía rcon (facts verificados contra el código fuente
 * r5318 y EN VIVO contra el server real 127.0.0.1:28961):
 *
 *  - Request:  `FF FF FF FF` + `rcon <password> <comando>` (separador espacio),
 *    encoding latin1, sin terminador null.
 *  - Respuesta: `FF FF FF FF` + `print\n` + salida. Una respuesta que es SOLO
 *    `print\n` es un ACK válido (payload vacío). Los comandos AddSV
 *    (banClient/unbanClient/spawnBot) pueden NO ecoar nada.
 *  - `getinfo` NO lleva wrapper rcon (`FF FF FF FF getinfo <challenge>`) y
 *    REQUIERE un argumento de challenge (verificado en vivo: sin challenge el
 *    server hace drop silencioso). Responde `infoResponse\n\k\v\k\v...`.
 *  - Password malo o throttle (`rcon_timeout`, 100 ms/IP en server.cfg) =
 *    TIMEOUT SILENCIOSO, indistinguible de un server caído → por eso las
 *    LECTURAS reintentan con backoff y las ESCRITURAS jamás se reintentan
 *    ciegamente (un clientkick duplicado es un double-kick real).
 *  - `status`: línea `map: <map>` + tabla `num score ping guid name lastmsg
 *    address qport rate`. guid HEX (16 chars) para humanos y `botN` para bots
 *    (ping 999 verificado para bots; CNCT/ZMBI = conectando, fila corta).
 *  - bans.json: `{ "ip": [...], "id": ["HEXGUID"] }` en el userraw del server;
 *    SOLO se escribe vía rcon (banClient/unbanClient); el panel la LEE si
 *    RCON_BANS_FILE apunta a ella.
 *
 * Throttle: el server descarta datagramas por IP si llegan a menos de
 * `rcon_timeout` ms. La cola serializa con 1 comando en vuelo y spacing
 * configurable (default 200 ms > 100 ms del server, margen incluido).
 */
import dgram from 'node:dgram';

/** Prefijo Quake de paquetes connectionless. */
const HEADER = '\u00ff\u00ff\u00ff\u00ff';

// ── Errores tipados del cliente ────────────────────────────────────────────

/** RCON_PASSWORD vacío: el llamador lo mapea a 503 MODERATION_NOT_CONFIGURED. */
export class RconNotConfiguredError extends Error {
  constructor() {
    super('RCON_PASSWORD no está configurado: la moderación nativa está deshabilitada.');
    this.name = 'RconNotConfiguredError';
  }
}

/** Sin respuesta tras todos los reintentos (timeout silencioso del server). */
export class RconTimeoutError extends Error {
  public readonly attempts: number;
  constructor(attempts: number, timeoutMs: number) {
    super(
      `El server no respondió por RCON tras ${attempts} intento(s) (timeout ${timeoutMs}ms por intento): ` +
        'puede ser password inválido, throttle (rcon_timeout) o server caído.',
    );
    this.name = 'RconTimeoutError';
    this.attempts = attempts;
  }
}

/** Error de socket (send/bind). */
export class RconSocketError extends Error {
  constructor(message: string) {
    super(`Error de socket RCON: ${message}`);
    this.name = 'RconSocketError';
  }
}

// ── Tipos de salida parseada ───────────────────────────────────────────────

export interface StatusPlayer {
  /** Número de slot (columna "num"). Es el cid para tell/clientkick/banClient. */
  cid: number;
  score: number;
  /** Ping numérico; null para CNCT/ZMBI. Verificado: bots reportan 999. */
  ping: number | null;
  /** HEX (16 chars) para humanos, `botN` para bots. RAW sin normalizar. */
  guid: string;
  /** Nombre RAW con códigos de color (^X) — el UI los limpia. */
  name: string;
  lastmsg: number;
  /** Dirección tal cual (`a.b.c.d:port` o `00000000.0:0` para bots). */
  address: string;
  qport: number | null;
  rate: number | null;
  isBot: boolean;
  /** true cuando ping = CNCT/ZMBI (aún negociando; no se puede moderar). */
  connecting: boolean;
}

export interface RconStatus {
  map: string | null;
  players: StatusPlayer[];
  /** Texto crudo (para debug). */
  raw: string;
}

/** Infostring de getinfo parseado (`\key\value\...`). */
export type InfoString = Record<string, string>;

// ── Helpers de guid (HEX ↔ decimal string) ─────────────────────────────────

/** Convierte un guid HEX del status (ej. "AB12CD34EF567890") a decimal string (formato Player.guid). */
export function hexGuidToDecimal(hex: string): string | null {
  const trimmed = hex.trim();
  if (!/^[0-9a-fA-F]{1,16}$/.test(trimmed)) return null;
  try {
    return BigInt(`0x${trimmed}`).toString(10);
  } catch {
    return null;
  }
}

/** Convierte un guid decimal string a HEX uppercase de 16 chars (para unbanClient guid). */
export function decimalGuidToHex(decimal: string): string | null {
  const trimmed = decimal.trim();
  if (!/^\d{1,20}$/.test(trimmed)) return null;
  try {
    const hex = BigInt(trimmed).toString(16).toUpperCase();
    return hex.padStart(16, '0').slice(-16);
  } catch {
    return null;
  }
}

/** Quita códigos de color/control del juego (^X) y espacios extremos. */
export function stripColorCodes(raw: string): string {
  return raw.replace(/\^[0-9a-zA-Z]/g, '').replace(/[\u0000-\u001f]/g, '').trim();
}

/** Guid decimal normalizado de un player del status (null para bots/CNCT sin guid hex). */
export function statusGuidDecimal(player: StatusPlayer): string | null {
  if (player.isBot) return null;
  return hexGuidToDecimal(player.guid);
}

// ── Parser de `status` ─────────────────────────────────────────────────────

// Fila COMPLETA: num score ping guid name lastmsg address qport rate.
// ping acepta dígitos (999/30) y letras (CNCT/ZMBI); guid acepta hex 8..32 o botN.
const STATUS_ROW_FULL =
  /^ *(\d+) +(-?\d+) +((?:[A-Za-z]+|-?\d+)) +((?:[0-9a-zA-Z]{8,32})|(?:bot\d+)) *(.{0,32}?) +(\d+) +([\d.]+:-*\d{1,5}|loopback|unknown) +(-?\d+) +(\d+) *$/;
// Fila CORTA (conectando) CON address/qport/rate (guid vacío): num score CNCT name lastmsg addr qport rate.
const STATUS_ROW_CONNECTING_FULL =
  /^ *(\d+) +(-?\d+) +(CNCT|ZMBI) *(.{0,32}?) +(\d+) +([\d.]+:-*\d{1,5}|loopback|unknown) +(-?\d+) +(\d+) *$/;
// Fila CORTA (conectando) BARE: num score CNCT name lastmsg.
const STATUS_ROW_CONNECTING = /^ *(\d+) +(-?\d+) +(CNCT|ZMBI) *(.{0,32}?) +(\d+) *$/;
const STATUS_MAP_LINE = /^map:\s*(.+?)\s*$/;
const STATUS_HEADER_LINE = /^num +score +ping +guid/;

/**
 * Parsea la salida cruda de `status` (payload sin el prefijo `print\n`).
 * Tolerante a filas de bots (ping 999, guid botN), CNCT/ZMBI y nombres con
 * códigos de color y espacios.
 */
export function parseStatus(raw: string): RconStatus {
  const lines = raw.split(/\r?\n/);
  let map: string | null = null;
  const players: StatusPlayer[] = [];
  for (const line of lines) {
    const mapMatch = STATUS_MAP_LINE.exec(line);
    if (mapMatch) {
      map = mapMatch[1] ?? null;
      continue;
    }
    if (STATUS_HEADER_LINE.test(line) || /^--- /.test(line) || line.trim() === '') continue;

    const full = STATUS_ROW_FULL.exec(line);
    if (full) {
      const pingText = full[3] ?? '';
      const connecting = pingText === 'CNCT' || pingText === 'ZMBI';
      const guid = full[4] ?? '';
      players.push({
        cid: Number(full[1]),
        score: Number(full[2]),
        ping: /^\d+$/.test(pingText) ? Number(pingText) : null,
        guid,
        name: (full[5] ?? '').trim(),
        lastmsg: Number(full[6]),
        address: full[7] ?? '',
        qport: Number(full[8]),
        rate: Number(full[9]),
        isBot: /^bot\d+$/i.test(guid),
        connecting,
      });
      continue;
    }

    const connectingFull = STATUS_ROW_CONNECTING_FULL.exec(line);
    if (connectingFull) {
      players.push({
        cid: Number(connectingFull[1]),
        score: Number(connectingFull[2]),
        ping: null,
        guid: '',
        name: (connectingFull[4] ?? '').trim(),
        lastmsg: Number(connectingFull[5]),
        address: connectingFull[6] ?? '',
        qport: Number(connectingFull[7]),
        rate: Number(connectingFull[8]),
        isBot: false,
        connecting: true,
      });
      continue;
    }

    const partial = STATUS_ROW_CONNECTING.exec(line);
    if (partial) {
      players.push({
        cid: Number(partial[1]),
        score: Number(partial[2]),
        ping: null,
        guid: '',
        name: (partial[4] ?? '').trim(),
        lastmsg: Number(partial[5]),
        address: '',
        qport: null,
        rate: null,
        isBot: false,
        connecting: true,
      });
    }
  }
  return { map, players, raw };
}

/** Parsea un infostring `\key\value\key\value...` (respuesta a getinfo). */
export function parseInfoString(payload: string): InfoString {
  const body = payload.startsWith('infoResponse\n') ? payload.slice('infoResponse\n'.length) : payload;
  const parts = body.split('\\');
  const out: InfoString = {};
  // parts[0] es el residuo antes del primer '\' (normalmente '')
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const key = parts[i] ?? '';
    const value = parts[i + 1] ?? '';
    if (key.length > 0) out[key] = value;
  }
  return out;
}

/** Quita el prefijo `print\n` de una respuesta rcon. */
export function stripPrintPrefix(payload: string): string {
  return payload.startsWith('print\n') ? payload.slice('print\n'.length) : payload;
}

// ── Config leída EN CADA construcción (permite mutar env en tests) ─────────

export interface RconClientOptions {
  host?: string;
  port?: number;
  password?: string;
  /** Spacing mínimo entre envíos (ms). Default 200 (server: rcon_timeout 100). */
  spacingMs?: number;
  /** Timeout de respuesta por intento (ms). Default 1200. */
  responseTimeoutMs?: number;
  /** Ventana de silencio para acumular datagramas de una respuesta (ms). */
  idleWindowMs?: number;
  /** Reintentos EXTRA para lecturas (writes NUNCA reintentan). */
  readRetries?: number;
  /** Backoff base entre reintentos de lectura (ms): 550, +450 por reintento. */
  retryBackoffMs?: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function rconEnvOptions(): Required<Pick<RconClientOptions, 'host' | 'port' | 'spacingMs' | 'responseTimeoutMs' | 'idleWindowMs' | 'readRetries' | 'retryBackoffMs'>> & { password: string | undefined } {
  return {
    host: process.env.RCON_HOST?.trim() || '127.0.0.1',
    port: envInt('RCON_PORT', 28961),
    password: process.env.RCON_PASSWORD?.trim() || undefined,
    spacingMs: envInt('RCON_SPACING_MS', 200),
    responseTimeoutMs: envInt('RCON_RESPONSE_TIMEOUT_MS', 1200),
    idleWindowMs: 80,
    readRetries: 2,
    retryBackoffMs: 550,
  };
}

// ── El cliente ─────────────────────────────────────────────────────────────

interface PendingRequest {
  chunks: Buffer[];
  idleTimer: NodeJS.Timeout | null;
  timeoutTimer: NodeJS.Timeout;
  resolve: (payload: string) => void;
  reject: (err: Error) => void;
}

interface QueuedJob {
  bytes: Buffer;
  write: boolean;
  resolve: (payload: string) => void;
  reject: (err: Error) => void;
}

const BACKOFF_STEP_MS = 450;

export class IW4XRcon {
  private readonly host: string;
  private readonly port: number;
  private readonly password: string | undefined;
  private readonly spacingMs: number;
  private readonly responseTimeoutMs: number;
  private readonly idleWindowMs: number;
  private readonly readRetries: number;
  private readonly retryBackoffMs: number;

  private socket: dgram.Socket | null = null;
  private pending: PendingRequest | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private queueLength = 0;
  private lastSendAt = 0;
  private closed = false;

  constructor(options: RconClientOptions = {}) {
    const envOpts = rconEnvOptions();
    this.host = options.host ?? envOpts.host;
    this.port = options.port ?? envOpts.port;
    this.password = options.password !== undefined ? options.password : envOpts.password;
    this.spacingMs = options.spacingMs ?? envOpts.spacingMs;
    this.responseTimeoutMs = options.responseTimeoutMs ?? envOpts.responseTimeoutMs;
    this.idleWindowMs = options.idleWindowMs ?? envOpts.idleWindowMs;
    this.readRetries = options.readRetries ?? envOpts.readRetries;
    this.retryBackoffMs = options.retryBackoffMs ?? envOpts.retryBackoffMs;
  }

  get configured(): boolean {
    return this.password !== undefined && this.password.length > 0;
  }

  get remote(): string {
    return `${this.host}:${this.port}`;
  }

  /** Pendientes en cola (diagnóstico). */
  get pendingCount(): number {
    return this.queueLength;
  }

  private ensureSocket(): dgram.Socket {
    if (this.socket) return this.socket;
    const socket = dgram.createSocket('udp4');
    socket.on('message', (msg, rinfo) => {
      this.handleMessage(msg, rinfo);
    });
    socket.on('error', (err) => {
      // ECONNRESET (ICMP port unreachable) y similares: falla el pending actual.
      const pending = this.pending;
      if (pending) {
        this.clearPending(pending);
        pending.reject(new RconSocketError(err.message));
      }
    });
    socket.bind(); // puerto efímero; el server responde a este socket
    this.socket = socket;
    return socket;
  }

  private handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    // Response matching por origen: ignoramos datagramas que no sean del server.
    if (rinfo.address !== this.host || rinfo.port !== this.port) return;
    const pending = this.pending;
    if (!pending) return; // respuesta tardía/unsolicited: se descarta
    pending.chunks.push(msg);
    // Idle-window: una respuesta puede llegar en Varios datagramas; esperamos
    // a que el server calle 80 ms antes de resolver.
    if (pending.idleTimer) clearTimeout(pending.idleTimer);
    pending.idleTimer = setTimeout(() => {
      let payload = Buffer.concat(pending.chunks).toString('latin1');
      // La respuesta llega con el header Quake `FF FF FF FF`: se descarta.
      if (payload.startsWith(HEADER)) payload = payload.slice(HEADER.length);
      this.clearPending(pending);
      pending.resolve(payload);
    }, this.idleWindowMs);
  }

  private clearPending(pending: PendingRequest): void {
    if (pending.idleTimer) clearTimeout(pending.idleTimer);
    clearTimeout(pending.timeoutTimer);
    if (this.pending === pending) this.pending = null;
  }

  private spacingDelay(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastSendAt;
    const wait = this.spacingMs - elapsed;
    this.lastSendAt = Math.max(now, this.lastSendAt + this.spacingMs);
    return wait > 0 ? new Promise((resolve) => setTimeout(resolve, wait)) : Promise.resolve();
  }

  private sendOnce(bytes: Buffer, timeoutMs: number): Promise<string> {
    const socket = this.ensureSocket();
    return new Promise<string>((resolve, reject) => {
      const pending: PendingRequest = {
        chunks: [],
        idleTimer: null,
        timeoutTimer: setTimeout(() => {
          this.clearPending(pending);
          reject(new RconTimeoutError(1, timeoutMs));
        }, timeoutMs + this.idleWindowMs),
        resolve,
        reject,
      };
      this.pending = pending;
      socket.send(bytes, this.port, this.host, (err) => {
        if (err) {
          this.clearPending(pending);
          reject(new RconSocketError(err.message));
        }
      });
    });
  }

  /** Encola un job en la cadena serializada (1 comando en vuelo + spacing). */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    this.queueLength += 1;
    const run = this.queue.then(job, job);
    // La cadena de cola traga el resultado (éxito o error): el error se le
    // entrega al CALLER vía `run`; la cadena NUNCA genera unhandled rejections.
    this.queue = run.then(
      () => {
        this.queueLength -= 1;
      },
      () => {
        this.queueLength -= 1;
      },
    );
    return run;
  }

  /**
   * Ejecuta un comando rcon y devuelve el payload (sin `print\n`).
   *  - write=true: UN solo intento (jamás reintentar clientkick/ban/map).
   *  - write=false (default, lectura): hasta readRetries reintentos con backoff
   *    550/+450 ms y timeout creciente (el server a veces tarda >1s, verificado).
   * Respuesta vacía (`print\n` solo) = ACK válido → ''.
   */
  async exec(command: string, options: { write?: boolean } = {}): Promise<string> {
    if (!this.configured) throw new RconNotConfiguredError();
    if (this.closed) throw new RconSocketError('El cliente RCON está cerrado.');
    const bytes = Buffer.from(`${HEADER}rcon ${this.password} ${command}`, 'latin1');
    const write = options.write === true;
    const attempts = write ? 1 : this.readRetries + 1;

    return this.enqueue(async () => {
      if (this.closed) throw new RconSocketError('El cliente RCON está cerrado.');
      let lastError: Error = new RconTimeoutError(0, this.responseTimeoutMs);
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const attemptTimeout = this.responseTimeoutMs * Math.min(attempt, 4);
        try {
          await this.spacingDelay();
          const payload = await this.sendOnce(bytes, attemptTimeout);
          return stripPrintPrefix(payload);
        } catch (err) {
          lastError = err as Error;
          // Las escrituras NO se reintentan: un clientkick duplicado es real.
          if (write || attempt >= attempts || this.closed) break;
          if (err instanceof RconSocketError) break; // fallo local: no reintenta
          await new Promise((resolve) => setTimeout(resolve, this.retryBackoffMs + (attempt - 1) * BACKOFF_STEP_MS));
        }
      }
      if (lastError instanceof RconTimeoutError) {
        throw new RconTimeoutError(attempts, this.responseTimeoutMs);
      }
      throw lastError;
    });
  }

  /**
   * `getinfo` SIN auth rcon (y con challenge: sin él el server hace drop
   * silencioso — verificado en vivo). Devuelve el infostring parseado.
   */
  async getinfo(challenge = String(Date.now() % 1_000_000)): Promise<InfoString> {
    const bytes = Buffer.from(`${HEADER}getinfo ${challenge}`, 'latin1');
    const attempts = this.readRetries + 1;
    return this.enqueue(async () => {
      if (this.closed) throw new RconSocketError('El cliente RCON está cerrado.');
      let lastError: Error = new RconTimeoutError(0, this.responseTimeoutMs);
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const attemptTimeout = this.responseTimeoutMs * Math.min(attempt, 4);
        try {
          await this.spacingDelay();
          const payload = await this.sendOnce(bytes, attemptTimeout);
          if (!payload.startsWith('infoResponse\n')) {
            throw new RconSocketError('Respuesta inesperada a getinfo (sin infoResponse).');
          }
          return parseInfoString(payload);
        } catch (err) {
          lastError = err as Error;
          if (attempt >= attempts || this.closed || err instanceof RconSocketError) break;
          await new Promise((resolve) => setTimeout(resolve, this.retryBackoffMs + (attempt - 1) * BACKOFF_STEP_MS));
        }
      }
      if (lastError instanceof RconTimeoutError) throw new RconTimeoutError(attempts, this.responseTimeoutMs);
      throw lastError;
    });
  }

  /** `status` parseado. */
  async status(): Promise<RconStatus> {
    const payload = await this.exec('status');
    return parseStatus(payload);
  }

  // ── Comandos de moderación (writes: 1 intento, sin retry) ────────────────

  /** Chat global: `say <msg>` (el texto lo ve todo el server). */
  say(message: string): Promise<string> {
    return this.exec(`say ${sanitizeMessage(message)}`, { write: true });
  }

  /** Mensaje privado: `tell <cid> <msg>`. */
  tell(cid: number, message: string): Promise<string> {
    return this.exec(`tell ${cid} ${sanitizeMessage(message)}`, { write: true });
  }

  /** `clientkick <cid>` (expulsión simple). */
  clientkick(cid: number): Promise<string> {
    return this.exec(`clientkick ${cid}`, { write: true });
  }

  /**
   * `tempbanclient <cid> "<razón>"` — la DURACIÓN es el dvar GLOBAL
   * `sv_kickBanTime` (no per-caso): para tempban por minutos real, el servicio
   * usa clientkick + enforcer en nuestra DB.
   */
  tempbanclient(cid: number, reason: string): Promise<string> {
    return this.exec(`tempbanclient ${cid} "${sanitizeMessage(reason)}"`, { write: true });
  }

  /** `banClient <cid>` — ban PERMANENTE persistido en bans.json del server. */
  banClient(cid: number): Promise<string> {
    return this.exec(`banClient ${cid}`, { write: true });
  }

  /** `unbanClient guid <HEX>` o `unbanClient ip <a.b.c.d>` (hex uppercase). */
  unbanClient(kind: 'guid' | 'ip', value: string): Promise<string> {
    const target = kind === 'guid' ? value.trim().toUpperCase() : value.trim();
    return this.exec(`unbanClient ${kind} ${target}`, { write: true });
  }

  /** Cambio de mapa: `map <mapa>`. */
  map(mapName: string): Promise<string> {
    return this.exec(`map ${mapName}`, { write: true });
  }

  /** `map_rotate`. */
  mapRotate(): Promise<string> {
    return this.exec('map_rotate', { write: true });
  }

  /** `fast_restart`. */
  fastRestart(): Promise<string> {
    return this.exec('fast_restart', { write: true });
  }

  /** `spawnBot N` (puede no ecoar salida; confirma con status). */
  spawnBot(count = 1): Promise<string> {
    return this.exec(`spawnBot ${count}`, { write: true });
  }

  /** Cierra el socket y rejecta lo pendiente. */
  close(): void {
    this.closed = true;
    const pending = this.pending;
    if (pending) {
      this.clearPending(pending);
      pending.reject(new RconSocketError('Cliente cerrado con request pendiente.'));
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // ya cerrado
      }
      this.socket = null;
    }
  }
}

/** Sanitiza mensajes para el protocolo: sin saltos de línea ni comillas sueltas. */
export function sanitizeMessage(message: string): string {
  return message.replace(/[\r\n"\\]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Singleton compartido (un solo socket/cola para API + enforcer) ─────────

let shared: IW4XRcon | null = null;

/** Cliente compartido (lazy). Re-parametriza si cambió la env de puerto/host. */
export function getSharedRcon(): IW4XRcon {
  if (shared === null) shared = new IW4XRcon();
  return shared;
}

/** Test helper: descarta el singleton (la env puede haber cambiado). */
export function resetSharedRcon(): void {
  if (shared) {
    shared.close();
    shared = null;
  }
}

/** true si RCON_PASSWORD está configurado (leído fresco de process.env). */
export function isRconConfigured(): boolean {
  return (process.env.RCON_PASSWORD?.trim() ?? '').length > 0;
}
