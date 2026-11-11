/**
 * REGISTRO MULTI-SALA de servers dedicados IW4x por RCON (env `RCON_SALAS`).
 *
 * El dueño corre DOS salas en el MISMO host LXC (la API vive dentro del LXC →
 * RCON por localhost a ambas): sala1 = 127.0.0.1:28960 (systemd `iw4x`) y
 * sala2 = 127.0.0.1:28961 (`iw4x-sala2`). La config viaja por env:
 *
 *   RCON_SALAS=[{"id":"sala1","name":"CTHolguin Sala 1","host":"127.0.0.1",
 *                "port":28960,"rconPassword":"...","address":"192.168.2.251:28960"},
 *               {"id":"sala2",...}]
 *
 *  - `address` es OPCIONAL y es la dirección PÚBLICA que muestra /api/salas
 *    (útil cuando el host de RCON es localhost pero el browser la ve por LAN).
 *  - Se lee process.env EN CADA LLAMADA (patrón servers.service.ts): dotenv ya
 *    cargó el .env y los tests mutan la env por-test sin reimportar.
 *  - Entradas inválidas se descartan con warning (una vez por proceso); si
 *    NINGUNA es válida → configured:false → todo sigue en modo compat.
 *
 * COMPAT: sin RCON_SALAS (vacía/ausente), getRconTargets() devuelve el server
 * ÚNICO de siempre (RCON_HOST/RCON_PORT/RCON_PASSWORD vía getSharedRcon()):
 * enforcer, moderación y endpoints existentes se comportan EXACTAMENTE igual
 * que antes. Con RCON_SALAS, las acciones RCON cubren TODAS las salas.
 */
import { errMessage } from '../errors.js';
import { IW4XRcon, getSharedRcon, isRconConfigured, rconEnvOptions } from './iw4x-rcon.js';
import { z } from 'zod';

/** Entrada de `RCON_SALAS` (una sala). */
export interface SalaConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  rconPassword: string;
  /** Address público opcional para /api/salas; default `${host}:${port}`. */
  address?: string;
}

const salaEntrySchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(64),
  host: z.string().trim().min(1).max(253),
  port: z.coerce.number().int().min(1).max(65535),
  rconPassword: z.string().min(1).max(128),
  address: z.string().trim().min(1).max(64).optional(),
});

export interface SalasParseResult {
  configured: boolean;
  salas: SalaConfig[];
}

let warnedInvalid = false;

function warnInvalidSalas(reason: string): void {
  if (warnedInvalid) return;
  warnedInvalid = true;
  console.warn(`[salas] RCON_SALAS inválida y SE IGNORA (modo server único): ${reason}`);
}

/**
 * Parsea `RCON_SALAS` (JSON array de salas). Vacía/ausente/íntegramente
 * inválida → {configured:false, salas:[]} (modo compat server único).
 * Entradas individuales inválidas se descartan (las válidas siguen).
 */
export function parseRconSalas(): SalasParseResult {
  const raw = process.env.RCON_SALAS?.trim() ?? '';
  if (raw === '') return { configured: false, salas: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warnInvalidSalas(`no es JSON válido (${errMessage(err)})`);
    return { configured: false, salas: [] };
  }
  if (!Array.isArray(parsed)) {
    warnInvalidSalas('debe ser un JSON array de {id,name,host,port,rconPassword,address?}.');
    return { configured: false, salas: [] };
  }
  const salas: SalaConfig[] = [];
  const seenIds = new Set<string>();
  for (const [index, item] of parsed.entries()) {
    const result = salaEntrySchema.safeParse(item);
    if (!result.success) {
      warnInvalidSalas(`entrada #${index} descartada (${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}).`);
      continue;
    }
    if (seenIds.has(result.data.id)) {
      warnInvalidSalas(`id duplicado "${result.data.id}" (entrada #${index} descartada).`);
      continue;
    }
    seenIds.add(result.data.id);
    salas.push(result.data);
  }
  return { configured: salas.length > 0, salas };
}

/** Address público de una sala (el configurado o `host:port`). */
export function salaAddress(sala: SalaConfig): string {
  return sala.address ?? `${sala.host}:${sala.port}`;
}

// ── Clientes RCON por sala (cacheados; key incluye password: si cambia, se re-crea) ──

const moderationClients = new Map<string, IW4XRcon>();
const probeClients = new Map<string, IW4XRcon>();

function clientKey(sala: SalaConfig): string {
  return `${sala.host.toLowerCase()}|${sala.port}|${sala.rconPassword}`;
}

/** Cliente de moderación/enforcer de una sala: timeouts y retries de las env existentes. */
export function getSalaModerationRcon(sala: SalaConfig): IW4XRcon {
  const key = clientKey(sala);
  let client = moderationClients.get(key);
  if (!client) {
    client = new IW4XRcon({ host: sala.host, port: sala.port, password: sala.rconPassword });
    moderationClients.set(key, client);
  }
  return client;
}

/** Probe de /api/salas: timeout CORTO y UN intento (una sala caída no cuelga el endpoint). */
export const SALA_PROBE_TIMEOUT_MS = 900;
export const SALA_PROBE_SPACING_MS = 50;

export function getSalaProbeRcon(sala: SalaConfig): IW4XRcon {
  const key = clientKey(sala);
  let client = probeClients.get(key);
  if (!client) {
    client = new IW4XRcon({
      host: sala.host,
      port: sala.port,
      password: sala.rconPassword,
      responseTimeoutMs: SALA_PROBE_TIMEOUT_MS,
      readRetries: 0,
      spacingMs: SALA_PROBE_SPACING_MS,
    });
    probeClients.set(key, client);
  }
  return client;
}

/** Test/mutación de env helper: cierra y descarta TODOS los clientes de salas. */
export function resetSalasRcon(): void {
  for (const client of moderationClients.values()) client.close();
  moderationClients.clear();
  for (const client of probeClients.values()) client.close();
  probeClients.clear();
}

// ── Targets RCON (multi-sala o server único legacy) ─────────────────────────

/** Un destino RCON para acciones (enforcer / moderación). */
export interface RconTarget {
  /** Id de sala ('sala1'...) o 'default' en modo compat. */
  id: string;
  /** Nombre descriptivo (para logs). */
  name: string;
  host: string;
  port: number;
  /** Cliente RCON ya parametrizado para ESTA sala. */
  client: IW4XRcon;
  /** true si viene de RCON_SALAS (multi-sala real; false = compat server único). */
  fromSalasEnv: boolean;
}

/**
 * true si hay moderación RCON disponible: `RCON_SALAS` válida (los passwords
 * viajan por sala) O el `RCON_PASSWORD` clásico.
 */
export function isModerationRconConfigured(): boolean {
  if (parseRconSalas().configured) return true;
  return isRconConfigured();
}

/**
 * Targets RCON para enforcer/moderación:
 *  - `RCON_SALAS` configurada → TODAS las salas (cada una con SU cliente:
 *    sockets y colas independientes → consultables en paralelo).
 *  - Sin `RCON_SALAS` → el server único de siempre (COMPAT total: el cliente
 *    es getSharedRcon(), los tests que re-mutenv + resetSharedRcon() siguen
 *    funcionando idéntico).
 */
export function getRconTargets(): RconTarget[] {
  const { configured, salas } = parseRconSalas();
  if (configured) {
    return salas.map((sala) => ({
      id: sala.id,
      name: sala.name,
      host: sala.host,
      port: sala.port,
      client: getSalaModerationRcon(sala),
      fromSalasEnv: true,
    }));
  }
  if (!isRconConfigured()) return [];
  const envOpts = rconEnvOptions();
  return [
    {
      id: 'default',
      name: 'Server',
      host: envOpts.host,
      port: envOpts.port,
      client: getSharedRcon(),
      fromSalasEnv: false,
    },
  ];
}
