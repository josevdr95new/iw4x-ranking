/**
 * Refresca la ÚLTIMA CONEXIÓN de N jugadores en la DB mock de IW4MAdmin
 * (Database/Database.sqlite) para que aparezcan como candidatos reales en
 * POST /api/link/complete (ventana LINK_WINDOW_MINUTES).
 *
 * Útil para probar el flujo de vinculación en cualquier momento, sin
 * regenerar el mock entero. SOLO toca la DB mock — nunca una DB real.
 *
 * Uso:
 *   npm run mock:refresh-connections
 *   npm run mock:refresh-connections -- --count 3 --minutes 2 --exclude guid1,guid2 --db C:/ruta/Database.sqlite
 *
 * Después corre `npm run sync` para que el cambio llegue a la DB del ranking.
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

export interface RefreshOptions {
  count?: number;
  minutesAgo?: number;
  /** GUIDs a evitar (p. ej., ya vinculados en la app). */
  excludeGuids?: string[];
  dbPath?: string;
}

export interface RefreshedPlayer {
  clientId: number;
  guid: string;
  name: string;
  lastConnection: string;
}

interface ClientRow {
  ClientId: unknown;
  NetworkId: unknown;
  clientName: unknown;
}

export function refreshMockConnections(dbPath: string, options: RefreshOptions = {}): RefreshedPlayer[] {
  const count = options.count ?? 3;
  const minutesAgo = options.minutesAgo ?? 2;
  const exclude = new Set(options.excludeGuids ?? []);

  if (!existsSync(dbPath)) {
    throw new Error(`No existe la DB mock en ${dbPath}. Corre primero "npm run mock:db".`);
  }

  const db = new Database(dbPath); // lectura/escritura: es NUESTRA mock, no la de IW4MAdmin real
  try {
    const cols = (db.pragma(`table_info('EFClient')`) as Array<Record<string, unknown>>)
      .map((row) => (typeof row['name'] === 'string' ? row['name'] : ''))
      .filter((name) => name.length > 0);
    for (const required of ['ClientId', 'NetworkId', 'LastConnection']) {
      if (!cols.includes(required)) {
        throw new Error(`La tabla EFClient no tiene la columna ${required}; ¿es una DB mock válida?`);
      }
    }
    const nameCol = cols.includes('CurrentName') ? 'CurrentName' : 'Name';

    const rows = db
      .prepare(`SELECT "ClientId", "NetworkId", "${nameCol}" AS clientName FROM "EFClient"`)
      .all() as Array<ClientRow>;

    const guidToString = (value: unknown): string | null => {
      if (value === null || value === undefined) return null;
      return typeof value === 'bigint' ? value.toString() : String(value);
    };

    const eligible = rows
      .map((row) => ({
        clientId: Number(row['ClientId']),
        guid: guidToString(row['NetworkId']),
        name: row['clientName'] === null || row['clientName'] === undefined ? null : String(row['clientName']),
      }))
      .filter((row) => row.guid !== null && !exclude.has(row.guid)) as Array<{
      clientId: number;
      guid: string;
      name: string | null;
    }>;

    if (eligible.length === 0) {
      throw new Error('No hay jugadores elegibles (¿todos excluidos?).');
    }

    // Mezcla con semilla temporal: cada refresh elige jugadores distintos.
    for (let i = eligible.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const a = eligible[i] as (typeof eligible)[number];
      const b = eligible[j] as (typeof eligible)[number];
      eligible[i] = b;
      eligible[j] = a;
    }

    const picked = eligible.slice(0, Math.min(count, eligible.length));
    const stamp = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const update = db.prepare('UPDATE "EFClient" SET "LastConnection" = ? WHERE "ClientId" = ?');

    const updated: RefreshedPlayer[] = picked.map((player) => {
      update.run(stamp, player.clientId);
      return {
        clientId: player.clientId,
        guid: player.guid as string,
        name: player.name ?? 'unknown',
        lastConnection: stamp,
      };
    });
    return updated;
  } finally {
    db.close();
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  let dbPath: string | null = null;
  let count = 3;
  let minutes = 2;
  let exclude: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--db' && next !== undefined) {
      dbPath = next;
      i += 1;
    } else if (arg === '--count' && next !== undefined) {
      count = Math.max(1, Number.parseInt(next, 10) || 3);
      i += 1;
    } else if (arg === '--minutes' && next !== undefined) {
      minutes = Math.max(1, Number.parseInt(next, 10) || 2);
      i += 1;
    } else if (arg === '--exclude' && next !== undefined) {
      exclude = next.split(',').map((guid) => guid.trim()).filter((guid) => guid !== '');
      i += 1;
    }
  }

  const target = dbPath !== null ? resolve(process.cwd(), dbPath) : resolve(repoRoot, 'Database', 'Database.sqlite');
  const updated = refreshMockConnections(target, { count, minutesAgo: minutes, excludeGuids: exclude });

  console.log(`[refresh] LastConnection actualizada (~hace ${minutes} min) para ${updated.length} jugador(es):`);
  for (const player of updated) {
    console.log(`  - ${player.name} (guid=${player.guid}, ClientId=${player.clientId})`);
  }
  console.log('[refresh] Siguiente paso: npm run sync  → aparecerán en POST /api/link/complete.');
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) main();
