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
  /** URL del webfront de IW4MAdmin (ej. http://127.0.0.1:1624) - SOLO bridge de moderación. */
  IW4MADMIN_WEBFRONT_URL: z.string().min(1).optional(),
  /** Credenciales OPCIONALES de un cliente privilegiado del webfront (las NO recomendamos). */
  IW4MADMIN_API_USER: z.string().min(1).optional(),
  IW4MADMIN_API_PASS: z.string().min(1).optional(),
  /** SQLite de IW4MAdmin, en SOLO-LECTURA, para el historial de penalidades NO para stats. */
  IW4MADMIN_PENALTIES_DB_PATH: z.string().min(1).optional(),
  GAME_LOG_PATH: z
    .string()
    .optional()
    .transform((value) => (value !== undefined && value.trim().length > 0 ? value : undefined)),
  GAME_SERVER_ADDRESS: z.string().min(1).optional(),
  SYNC_INTERVAL_MINUTES: z.coerce.number().default(0),
  SYNC_INTERVAL_SECONDS: z.coerce.number().default(0),
  ADMIN_EMAILS: z.string().default(''),
  LINK_WINDOW_MINUTES: z.coerce.number().int().positive().default(10),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:5173'),
  /** Raíz de almacenamiento del cloud save por cuenta (default: <repo>/apps/api/storage/profiles). */
  PROFILE_STORAGE_DIR: z.string().min(1).optional(),
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
  iw4madminWebfrontUrl: raw.IW4MADMIN_WEBFRONT_URL,
  iw4madminApiUser: raw.IW4MADMIN_API_USER,
  iw4madminApiPass: raw.IW4MADMIN_API_PASS,
  iw4madminPenaltiesDbPath: raw.IW4MADMIN_PENALTIES_DB_PATH,
  gameLogPath: raw.GAME_LOG_PATH,
  gameServerAddress: raw.GAME_SERVER_ADDRESS,
  syncIntervalMinutes: raw.SYNC_INTERVAL_MINUTES,
  syncIntervalSeconds: raw.SYNC_INTERVAL_SECONDS,
  adminEmails: raw.ADMIN_EMAILS.split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0),
  linkWindowMinutes: raw.LINK_WINDOW_MINUTES,
  corsOrigins: raw.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
  // Cloud save: rutas relativas se resuelven SIEMPRE contra la raíz del repo
  // (determinista, independiente del cwd del proceso).
  profileStorageDir: resolve(repoRoot, raw.PROFILE_STORAGE_DIR ?? resolve(repoRoot, 'apps', 'api', 'storage', 'profiles')),
} as const;

export type Env = typeof env;
export const paths = { repoRoot, apiRoot } as const;
