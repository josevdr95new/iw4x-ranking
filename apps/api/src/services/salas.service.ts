/**
 * SALAS EN VIVO — endpoint PÚBLICO `GET /api/salas` (datos de server browser,
 * SIN auth y SIN datos sensibles: jamás expone rcon_password).
 *
 * Fuente: RCON por sala (env `RCON_SALAS`, ver lib/rcon/salas.ts):
 *  - `getinfo` (challenge, sin auth): hostname/mapname/gametype/sv_maxclients
 *    y, en fallback, `clients`/`bots` del infostring.
 *  - `status` (rcon): desglose jugadores por fila → HUMANOS (guid HEX) vs BOTS
 *    (guid `botN`); conectando (CNCT/ZMBI) no cuentan en ninguno de los dos.
 * Ambas consultas van en paralelo por sala y TODAS las salas se consultan en
 * paralelo entre sí, con cliente de probe dedicado (timeout corto ~0.9s, 1
 * intento): una sala caída NO cuelga el endpoint ni afecta a las demás →
 * online:false con el resto de campos null.
 */
import {
  getSalaProbeRcon,
  parseRconSalas,
  salaAddress,
  type SalaConfig,
} from '../lib/rcon/salas.js';
import type { InfoString, RconStatus } from '../lib/rcon/iw4x-rcon.js';

export interface SalaOverview {
  id: string;
  name: string;
  /** Address público (campo `address` de la sala o `host:port`). */
  address: string;
  /** false = sin respuesta getinfo+status (caída o password/throttle). */
  online: boolean;
  hostname: string | null;
  map: string | null;
  gametype: string | null;
  /** Humanos conectados (excluye bots y conectando). */
  players: number | null;
  /** Bots conectados (filas `botN` del status). */
  bots: number | null;
  /** sv_maxclients del infostring. */
  maxClients: number | null;
}

export interface SalasResponse {
  /** false si RCON_SALAS está vacía/ausente (o ninguna entrada válida). */
  configured: boolean;
  salas: SalaOverview[];
}

function nonEmpty(value: string | undefined): string | null {
  return value !== undefined && value.trim() !== '' ? value : null;
}

function intFromInfo(info: InfoString, key: string): number | null {
  const raw = info[key];
  if (raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

/** Desglose humanos/bots desde las filas del status. */
function countsFromStatus(status: RconStatus): { players: number; bots: number } {
  let players = 0;
  let bots = 0;
  for (const slot of status.players) {
    if (slot.connecting) continue;
    if (slot.isBot) bots += 1;
    else players += 1;
  }
  return { players, bots };
}

/**
 * Sonda UNA sala: getinfo + status en paralelo (el cliente serializa por
 * sala: 1 comando en vuelo; entre salas sí es real el paralelismo). Solo si
 * AMBAS fallan la sala está offline. Con getinfo OK pero status caído se
 * usa el desglose del infostring (`clients`/`bots`).
 */
async function probeSala(sala: SalaConfig): Promise<SalaOverview> {
  const client = getSalaProbeRcon(sala);
  const [infoResult, statusResult] = await Promise.allSettled([client.getinfo(), client.status()]);

  if (infoResult.status === 'rejected' && statusResult.status === 'rejected') {
    return {
      id: sala.id,
      name: sala.name,
      address: salaAddress(sala),
      online: false,
      hostname: null,
      map: null,
      gametype: null,
      players: null,
      bots: null,
      maxClients: null,
    };
  }

  const info: InfoString | null = infoResult.status === 'fulfilled' ? infoResult.value : null;
  const status: RconStatus | null = statusResult.status === 'fulfilled' ? statusResult.value : null;

  let players: number | null = null;
  let bots: number | null = null;
  if (status !== null) {
    const counts = countsFromStatus(status);
    players = counts.players;
    bots = counts.bots;
  } else if (info !== null) {
    // Fallback server-browser puro: clients totales − bots del infostring.
    const total = intFromInfo(info, 'clients');
    bots = intFromInfo(info, 'bots');
    players = total !== null && bots !== null ? Math.max(total - bots, 0) : total;
  }

  return {
    id: sala.id,
    name: sala.name,
    address: salaAddress(sala),
    online: true,
    hostname: info !== null ? nonEmpty(info.hostname) : null,
    map: (status?.map ?? null) ?? (info !== null ? nonEmpty(info.mapname) : null),
    gametype: info !== null ? nonEmpty(info.gametype) : null,
    players,
    bots,
    maxClients: info !== null ? intFromInfo(info, 'sv_maxclients') : null,
  };
}

/** Vista combinada de TODAS las salas (paralelo entre salas; nunca lanza). */
export async function getSalasOverview(): Promise<SalasResponse> {
  const { configured, salas } = parseRconSalas();
  if (!configured) return { configured: false, salas: [] };
  const overviews = await Promise.all(salas.map((sala) => probeSala(sala)));
  return { configured: true, salas: overviews };
}
