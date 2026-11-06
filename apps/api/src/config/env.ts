import { randomBytes } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const moduleDir = dirname(fileURLToPath(import.meta.url)); // apps/api/src/config (o dist/config)
const apiRoot = resolve(moduleDir, '../..'); // apps/api
const repoRoot = resolve(apiRoot, '../..'); // raíz del monorepo

// Carga apps/api/.env primero (mayor prioridad) y luego el .env de la raíz del repo.
// dotenv no sobrescribe variables ya presentes en process.env.
loadDotenv({ path: resolve(apiRoot, '.env') });
loadDotenv({ path: resolve(repoRoot, '.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1).default('file:./dev.db'),
  JWT_SECRET: z.string().min(16).optional(),
  JWT_EXPIRES_IN: z.string().min(1).default('7d'),
  IW4MADMIN_DB_PATH: z.string().min(1).optional(),
  GAME_LOG_PATH: z.string().min(1).optional(),
  GAME_SERVER_ADDRESS: z.string().min(1).optional(),
  SYNC_INTERVAL_MINUTES: z.coerce.number().default(0),
  SYNC_INTERVAL_SECONDS: z.coerce.number().default(0),
  LINK_WINDOW_MINUTES: z.coerce.number().int().positive().default(10),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:5173'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Configuración de entorno inválida: ${issues}`);
}

const raw = parsed.data;

let jwtSecret = raw.JWT_SECRET;
if (!jwtSecret && raw.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET es obligatorio cuando NODE_ENV=production.');
}
if (!jwtSecret) {
  // En desarrollo/test sin secreto configurado: secreto efímero (los tokens
  // se invalidan al reiniciar el proceso) para nunca correr sin firma.
  jwtSecret = randomBytes(32).toString('hex');
  if (raw.NODE_ENV !== 'test') {
    console.warn('[env] JWT_SECRET no configurado: usando un secreto efímero; los tokens se invalidarán al reiniciar.');
  }
}

export const env = {
  nodeEnv: raw.NODE_ENV,
  isProduction: raw.NODE_ENV === 'production',
  port: raw.PORT,
  databaseUrl: raw.DATABASE_URL,
  jwtSecret,
  jwtExpiresIn: raw.JWT_EXPIRES_IN,
  iw4madminDbPath: raw.IW4MADMIN_DB_PATH,
  gameLogPath: raw.GAME_LOG_PATH,
  gameServerAddress: raw.GAME_SERVER_ADDRESS,
  syncIntervalMinutes: raw.SYNC_INTERVAL_MINUTES,
  syncIntervalSeconds: raw.SYNC_INTERVAL_SECONDS,
  linkWindowMinutes: raw.LINK_WINDOW_MINUTES,
  corsOrigins: raw.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
} as const;

export type Env = typeof env;
export const paths = { repoRoot, apiRoot } as const;
