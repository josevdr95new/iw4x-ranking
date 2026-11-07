import { execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMockDb } from '../../scripts/mock-iw4madmin.js';

const here = dirname(fileURLToPath(import.meta.url)); // apps/api/tests
const apiRoot = resolve(here, '..');
const prismaDir = resolve(apiRoot, 'prisma');
const testDbFile = resolve(prismaDir, 'test.db');
const mockDbFile = resolve(here, 'data', 'mock-iw4madmin.sqlite');
// Mismo path que PROFILE_STORAGE_DIR de vitest.config (env de tests).
const profilesStorageDir = resolve(here, 'data', 'profiles-storage');

/**
 * Prepara el entorno de tests:
 * 1. Recrea la SQLite de la app (prisma db push) con DATABASE_URL de vitest.config.
 * 2. Genera la DB mock de IW4MAdmin con datos deterministas (seed fija).
 */
export default function globalSetup(): void {
  // Guard explícito: el auto-seed del admin por defecto NUNCA corre en tests
  // (vitest.config + setup-env.ts ya fijan SEED_DEFAULT_ADMIN=0 en los workers;
  // esto documenta la intención en el bootstrap del entorno de test).
  process.env.SEED_DEFAULT_ADMIN = '0';
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    rmSync(testDbFile + suffix, { force: true });
  }
  execSync('npx prisma db push --skip-generate', {
    cwd: apiRoot,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: 'file:./test.db' },
  });

  mkdirSync(dirname(mockDbFile), { recursive: true });
  rmSync(mockDbFile, { force: true });
  generateMockDb(mockDbFile, { players: 12, killEvents: 300, servers: 4, seed: 7, recentCandidates: 3 });

  // Storage de cloud save limpio en cada run (PROFILE_STORAGE_DIR de vitest.config).
  rmSync(profilesStorageDir, { recursive: true, force: true });
  mkdirSync(profilesStorageDir, { recursive: true });
}
