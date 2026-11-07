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
      // El .env real apunta al games_mp.log local: en tests SE DESACTIVA la fuente log
      // (cadena vacía → undefined tras el transform del schema) para que el sync de
      // sync.test.ts use solo el mock determinista.
      GAME_LOG_PATH: '',
      SYNC_INTERVAL_MINUTES: '0',
      SYNC_INTERVAL_SECONDS: '0',
      LINK_WINDOW_MINUTES: '10',
      CORS_ORIGIN: 'http://localhost:5173',
      ADMIN_EMAILS: 'admin-roles@test.local',
      // Cloud save: storage aislado bajo tests/data (gitignored, se limpia en global-setup).
      PROFILE_STORAGE_DIR: resolve(here, 'tests', 'data', 'profiles-storage'),
    },
  },
});
