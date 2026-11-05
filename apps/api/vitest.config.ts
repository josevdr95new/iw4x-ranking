import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

// DATABASE_URL relativa se resuelve respecto a apps/api/prisma/ (ubicación del schema).
const TEST_DATABASE_URL = 'file:./test.db';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: './tests/global-setup.ts',
    setupFiles: ['./tests/setup-env.ts'],
    // SQLite de test compartida: los archivos de test corren en serie.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: 'test-secret-test-secret-test-secret',
      IW4MADMIN_DB_PATH: resolve(here, 'tests', 'data', 'mock-iw4madmin.sqlite'),
      SYNC_INTERVAL_MINUTES: '0',
      LINK_WINDOW_MINUTES: '10',
      CORS_ORIGIN: 'http://localhost:5173',
    },
  },
});
