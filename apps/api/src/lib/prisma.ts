import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasourceUrl: env.databaseUrl,
  });

if (!env.isProduction) {
  globalForPrisma.prisma = prisma;
}


/**
 * PRAGMAs de SQLite (WAL). synchronous=NORMAL es seguro con WAL y evita un
 * fsync por commit: reduce el coste de las escrituras del sync. busy_timeout
 * hace que las escrituras concurrentes esperen en vez de fallar.
 */
export async function initSqlitePragmas(): Promise<void> {
  if (!env.databaseUrl.startsWith('file:')) return;
  try {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await prisma.$queryRawUnsafe('PRAGMA synchronous = NORMAL');
    await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 30000');
    await prisma.$queryRawUnsafe('PRAGMA wal_autocheckpoint = 1000');
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>('PRAGMA synchronous');
    const syncMode = rows.map((row) => String(row.synchronous)).join(',');
    console.log(`[db] pragmas SQLite OK (journal_mode=wal, synchronous=${syncMode}, busy_timeout=30000)`);
  } catch (err) {
    console.warn('[db] no se pudieron aplicar pragmas SQLite:', err instanceof Error ? err.message : String(err));
  }
}
