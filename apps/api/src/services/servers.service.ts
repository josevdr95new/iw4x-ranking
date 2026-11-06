import { parseWith } from '../middleware/validate.js';
import { serversListSchema } from '../dto/serverconfig.dto.js';
import type { ServerEntry } from '../dto/serverconfig.dto.js';

/**
 * Lista de servers conocidos (pública, para launcher/web sin hardcodear):
 * 1. Env `SERVERS`: JSON array [{name, address, isDefault?}] (si es inválido → fallback con warning).
 * 2. Si no hay env: lista derivada de `GAME_SERVER_ADDRESS` (marcada como default).
 * 3. Sin ninguna fuente: lista vacía (la UI decide).
 *
 * Se lee process.env EN CADA LLAMADA (dotenv ya cargó el .env): permite cambios
 * sin reiniciar y simplifica los tests.
 */
export interface ServersResponse {
  servers: ServerEntry[];
  source: 'env' | 'derived' | 'none';
}

let warnedInvalid = false;

export function getServersList(): ServersResponse {
  const rawServers = process.env.SERVERS;
  if (rawServers !== undefined && rawServers.trim() !== '') {
    try {
      const parsed = JSON.parse(rawServers) as unknown;
      const servers = parseWith(serversListSchema, parsed);
      // Si ninguna está marcada, la primera es la default.
      const normalized = servers.some((server) => server.isDefault)
        ? servers
        : servers.map((server, index) => ({ ...server, isDefault: index === 0 }));
      return { servers: normalized, source: 'env' };
    } catch {
      if (!warnedInvalid) {
        console.warn('[servers] SERVERS no es un JSON válido (array de {name,address,isDefault?}); usando fallback derivado.');
        warnedInvalid = true;
      }
    }
  }

  const gameServerAddress = process.env.GAME_SERVER_ADDRESS;
  if (gameServerAddress) {
    return {
      servers: [{ name: 'Servidor del ranking', address: gameServerAddress, isDefault: true }],
      source: 'derived',
    };
  }

  return { servers: [], source: 'none' };
}
