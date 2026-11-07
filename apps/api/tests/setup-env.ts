// Cinturón y tirantes: vitest.config ya define test.env, esto garantiza
// defaults coherentes si los tests se ejecutan sin esa configuración.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
// El auto-seed del admin por defecto NUNCA corre en tests (cinturón y tirantes:
// vitest.config ya inyecta SEED_DEFAULT_ADMIN=0; esto cubre runs sin esa config).
process.env.SEED_DEFAULT_ADMIN = process.env.SEED_DEFAULT_ADMIN ?? '0';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'file:./test.db';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-test-secret-test-secret';
process.env.LINK_WINDOW_MINUTES = process.env.LINK_WINDOW_MINUTES ?? '10';
process.env.SYNC_INTERVAL_MINUTES = process.env.SYNC_INTERVAL_MINUTES ?? '0';
process.env.IW4MADMIN_DB_PATH = process.env.IW4MADMIN_DB_PATH ?? resolve(here, 'data', 'mock-iw4madmin.sqlite');
// GAME_LOG_PATH / GAME_SERVER_ADDRESS: intencionalmente NO se setean en tests.
// El reader de log se prueba directamente (gamelog.test.ts) y así el sync de
// sync.test.ts sigue usando únicamente el mock de IW4MAdmin.
