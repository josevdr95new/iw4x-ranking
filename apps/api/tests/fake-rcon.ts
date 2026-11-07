/**
 * FAKE server UDP RCON IW4x para tests (misma superficie que el protocolo real
 * verificado en vivo contra el server dedicado):
 *
 *  - Request  `FF FF FF FF rcon <password> <cmd>` → responde `FF FF FF FF print\n<out>`
 *    (o SOLO `print\n` = ACK vacío). Password incorrecto → drop SILENCIOSO.
 *  - Request  `FF FF FF FF getinfo <challenge>` → `FF FF FF FF infoResponse\n\challenge\<ch>\...`
 *    (sin challenge → drop, como el server real).
 *  - Configuración por-test: fixture de status, partición en N datagramas
 *    (idle-window), delay de respuesta (timeouts), drop selectivo (retries),
 *    registro de payloads/timestamps (spacing), mutación en caliente (TOCTOU).
 */
import dgram from 'node:dgram';

export interface FakeRconCommand {
  /** Comando sin el wrapper `rcon <pass> ` (ej. "status", "clientkick 3"). */
  command: string;
  /** Payload EXACTO recibido (latin1), incluyendo header. */
  raw: string;
  /** Timestamp de llegada (performance.now no: Date.now para medir spacing real). */
  at: number;
}

export interface FakeRconOptions {
  password?: string;
  /** Salida cruda de `status` (SIN el prefijo print\n). */
  statusText?: string;
  /** Infostring para getinfo (SIN header ni "infoResponse\n"). */
  infostring?: string;
  /** Trocear cada respuesta en N datagramas (default 1). */
  splitParts?: number;
  /** Delay artificial de respuesta en ms (default 5). */
  delayMs?: number;
  /** Respuestas vacías (ACK print\n) para comandos write (default true). */
  ackWrites?: boolean;
  /** Hook para mutar fixtures entre comandos (anti-TOCTOU). */
  onCommand?: (command: string, server: FakeRconServer) => void;
}

const HEADER = '\u00ff\u00ff\u00ff\u00ff';

export class FakeRconServer {
  private socket: dgram.Socket | null = null;
  private stopped = false;
  private readonly opts: Required<Omit<FakeRconOptions, 'onCommand'>> & { onCommand?: (command: string, server: FakeRconServer) => void };
  private bufferChunks: Buffer[] = [];
  private idleTimer: NodeJS.Timeout | null = null;
  private currentSender: dgram.RemoteInfo | null = null;

  /** Comandos recibidos con password VÁLIDA (en orden de llegada). */
  readonly received: FakeRconCommand[] = [];
  /** Requests con password INVÁLIDA (el server real los recibe y los dropea). */
  readonly rejected: FakeRconCommand[] = [];
  /** Timestamps de RESPUESTA enviada (para medir spacing del cliente). */
  readonly replyTimes: number[] = [];
  /** Contador de respuestas de status emitidas (para scripts por-llamada). */
  statusReplyCount = 0;

  constructor(options: FakeRconOptions = {}) {
    this.opts = {
      password: options.password ?? 'test-rcon-pass',
      statusText: options.statusText ?? '',
      infostring:
        options.infostring ??
        '\\hostname\\^7[^1RANKING^7] ^7Fake Server\\gamename\\IW4\\clients\\2\\bots\\1\\sv_maxclients\\18\\gametype\\war\\mapname\\mp_rust',
      splitParts: options.splitParts ?? 1,
      delayMs: options.delayMs ?? 5,
      ackWrites: options.ackWrites ?? true,
      onCommand: options.onCommand,
    };
  }

  get port(): number {
    if (!this.socket) throw new Error('FakeRconServer no iniciado');
    return this.socket.address().port;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      socket.on('error', reject);
      socket.on('message', (msg, rinfo) => {
        this.handleMessage(msg, rinfo);
      });
      socket.bind(0, '127.0.0.1', () => {
        this.socket = socket;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.stopped = true; // ignora requests/responses en vuelo desde ya
      if (this.socket) {
        this.socket.close(() => resolve());
        this.socket = null;
      } else {
        resolve();
      }
    });
  }

  /** Reemplaza fixtures en caliente. */
  setStatusText(text: string): void {
    this.opts.statusText = text;
  }

  setInfostring(text: string): void {
    this.opts.infostring = text;
  }

  /** true si el comando N recibido coincide con el prefijo. */
  hasCommand(prefix: string): boolean {
    return this.received.some((entry) => entry.command === prefix || entry.command.startsWith(prefix));
  }

  commandsWith(prefix: string): FakeRconCommand[] {
    return this.received.filter((entry) => entry.command.startsWith(prefix));
  }

  private handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    if (this.stopped) return;
    const raw = msg.toString('latin1');
    // Acumulamos por datagramas del mismo cliente (requests son de 1 datagrama).
    this.bufferChunks.push(msg);
    this.currentSender = rinfo;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.processRequest().catch(() => undefined);
    }, 5);
  }

  private async processRequest(): Promise<void> {
    const raw = Buffer.concat(this.bufferChunks).toString('latin1');
    this.bufferChunks = [];
    const sender = this.currentSender;
    if (!sender || !raw.startsWith(HEADER)) return;
    const body = raw.slice(HEADER.length);

    let response: string | null = null;
    if (body.startsWith('getinfo')) {
      const parts = body.split(/\s+/);
      if (parts.length < 2 || !parts[1]) return; // sin challenge → drop (como el real)
      this.received.push({ command: body, raw, at: Date.now() }); // sin auth: se registra igual
      response = `${HEADER}infoResponse\n\\challenge\\${parts[1]}${this.opts.infostring}`;
    } else if (body.startsWith('rcon ')) {
      const rest = body.slice('rcon '.length);
      const sep = rest.indexOf(' ');
      const password = sep >= 0 ? rest.slice(0, sep) : rest;
      const command = sep >= 0 ? rest.slice(sep + 1) : '';
      if (password !== this.opts.password) {
        // Password inválida: el server real SÍ recibe el datagrama y NO responde.
        this.rejected.push({ command, raw, at: Date.now() });
        return; // drop silencioso (como el real)
      }
      this.received.push({ command, raw, at: Date.now() });
      this.opts.onCommand?.(command, this);

      if (command === 'status') {
        response = `${HEADER}print\n${this.opts.statusText}`;
        this.statusReplyCount += 1;
      } else if (this.opts.ackWrites) {
        response = `${HEADER}print\n`;
      } else {
        response = null;
      }
    } else {
      return; // paquete desconocido: drop
    }

    if (response !== null) await this.send(response, sender);
  }

  private async send(payload: string, rinfo: dgram.RemoteInfo): Promise<void> {
    const socket = this.socket;
    if (!socket || this.stopped) return;
    await new Promise((resolve) => setTimeout(resolve, this.opts.delayMs));
    if (this.stopped) return; // se detuvo durante el delay
    const buffer = Buffer.from(payload, 'latin1');
    const parts = Math.max(1, this.opts.splitParts);
    const chunkSize = Math.ceil(buffer.length / parts);
    for (let offset = 0; offset < buffer.length; offset += chunkSize) {
      if (this.stopped) return;
      const chunk = buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length));
      await new Promise<void>((resolve) => {
        try {
          socket.send(chunk, rinfo.port, rinfo.address, () => resolve());
        } catch {
          resolve(); // socket cerrado entre vueltas: no importa en tests
        }
      });
    }
    this.replyTimes.push(Date.now());
  }
}

/** Fixture REAL de `status` (capturado en vivo del server con 2 bots + humano). */
export const LIVE_STATUS_FIXTURE = [
  'map: mp_terminal',
  'num score ping guid                             name            lastmsg address               qport rate',
  '--- ----- ---- -------------------------------- --------------- ------- --------------------- ----- -----',
  '  0  1250   30 AB12CD34EF567890 ^1Toxic^7Player            15 192.168.3.50:28960    20    25000',
  '  1     0  999 bot15 RektInator^7         9450 00000000.000000000000:3840   16 99999',
  '  2     0  999 bot16 Diamante^7           8950 00000000.000000000000:4096   17 99999',
  '',
].join('\n');

/** Fixture con un CNCT (conectando, fila corta real: name + lastmsg) + humano multi-palabra. */
export const CONNECTING_STATUS_FIXTURE = [
  'map: mp_crash',
  'num score ping guid                             name            lastmsg address               qport rate',
  '--- ----- ---- -------------------------------- --------------- ------- --------------------- ----- -----',
  '  3     0 CNCT                              ^7Newbie^7         5',
  '  4   300   45 FEDCBA9876543210 Multi ^2Word Guy^7        120 192.168.3.52:28001    5     20000',
  '',
].join('\n');
