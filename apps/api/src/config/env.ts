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
  // ── Moderación NATIVA por RCON (reemplaza el bridge IW4MADMIN_WEBFRONT_URL) ──
  /** Host del server dedicado IW4x (default 127.0.0.1). */
  RCON_HOST: z.string().min(1).default('127.0.0.1'),
  /** Puerto UDP del server (default 28961). */
  RCON_PORT: z.coerce.number().int().min(1).max(65535).default(28961),
  /** Password de `rcon_password` del server.cfg. SIN default: vacío = moderación 503. */
  RCON_PASSWORD: z
    .string()
    .optional()
    .transform((value) => (value !== undefined && value.trim().length > 0 ? value.trim() : undefined)),
  /** Spacing mínimo entre comandos rcon en ms (default 200; server: rcon_timeout 100). */
  RCON_SPACING_MS: z.coerce.number().int().min(0).default(200),
  /** Timeout de respuesta rcon por intento en ms (default 1200; lecturas reintentan). */
  RCON_RESPONSE_TIMEOUT_MS: z.coerce.number().int().min(100).default(1200),
  /** Intervalo del enforcer (tempbans/bans de nuestra DB re-kickeados) en ms (default 30000). */
  RCON_ENFORCER_INTERVAL_MS: z.coerce.number().int().min(1000).default(30000),
  /** Path a userraw/bans.json del server para leerlo en el panel (SOLO lectura). */
  RCON_BANS_FILE: z
    .string()
    .optional()
    .transform((value) => (value !== undefined && value.trim().length > 0 ? value.trim() : undefined)),
  GAME_LOG_PATH: z
    .string()
    .optional()
    .transform((value) => (value !== undefined && value.trim().length > 0 ? value : undefined)),
  /** Fuentes log ADICIONALES (multi-sala). Formato: "ruta|direccion;ruta2|direccion2". */
  GAME_LOG_PATHS: z.string().optional(),
  /**
   * Snapshot(s) en vivo que escribe el script GSC del server (apps/api/gsc/
   * iw4x-ranking.gsc → userraw/scriptdata/iw4x-ranking.json). Acepta VARIAS
   * rutas separadas por COMA (una por sala: cada sala escribe SU archivo
   * relativo a su propio userraw) → merge de players por guid. Vacío = ingesta
   * live DESACTIVADA (todo null silencioso).
   */
  LIVE_STATS_FILE: z
    .string()
    .optional()
    .transform((value) => (value !== undefined && value.trim().length > 0 ? value : undefined)),
  /** Intervalo del scheduler de ingesta live en ms (default 30000; min 1000). */
  LIVE_STATS_INTERVAL_MS: z.coerce.number().int().min(1000).default(30000),
  /** Detector unlockstats: salto de XP en el límite de la ventana → suspicious. */
  LIVE_XP_JUMP_LIMIT: z.coerce.number().int().min(1).default(500000),
  /** Detector unlockstats: ventana temporal del salto en ms (default 10 min). */
  LIVE_XP_JUMP_WINDOW_MS: z.coerce.number().int().min(1000).default(600000),
  /** Mensaje del tell antes del clientkick por unlockstats (autokick ON). */
  ANTI_UNLOCK_KICK_MSG: z.string().min(1).default('Stats modificados detectados'),
  GAME_SERVER_ADDRESS: z.string().min(1).optional(),
  SYNC_INTERVAL_MINUTES: z.coerce.number().default(0),
  SYNC_INTERVAL_SECONDS: z.coerce.number().default(0),
  ADMIN_EMAILS: z.string().default(''),
  /** Admin por defecto (seed). Login SOLO por nick: el email no es credencial. */
  ADMIN_NICK: z.string().min(1).default('admin'),
  ADMIN_EMAIL: z.string().min(1).default('admin@admin.com'),
  ADMIN_PASSWORD: z.string().min(1).default('admin123'),
  /** Auto-seed al arrancar SOLO si la tabla User está vacía. Default true; "false"/"0" desactiva. */
  SEED_DEFAULT_ADMIN: z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return true;
      return !['false', '0', 'no', 'off'].includes(value.trim().toLowerCase());
    }),
  LINK_WINDOW_MINUTES: z.coerce.number().int().positive().default(10),
  /** TTL (minutos) de la sesión de juego del launcher (TTL deslizante por heartbeat). */
  PLAY_SESSION_TTL_MIN: z.coerce.number().int().positive().default(10),
  /** Mensaje que ve el jugador kickeado por el enforcer launcher-only. */
  LAUNCHER_ONLY_KICK_MSG: z
    .string()
    .min(1)
    .default('Este server exige el launcher IW4x Ranking - entra desde www.tuweb (descarga en la web)'),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:5173'),
  /** Raíz de almacenamiento del cloud save por cuenta (default: <repo>/apps/api/storage/profiles). */
  PROFILE_STORAGE_DIR: z.string().min(1).optional(),
  // ── Decay ELO contra BOTS (anti-farmeo: los bots son rivales fijos ~1000) ──
  /** Factor mínimo de decay (skill ≥ BOT_ELO_DECAY_HARD → este factor). Default 0.15. */
  BOT_ELO_DECAY_MIN: z.coerce.number().min(0).max(1).default(0.15),
  /** Skill donde el decay EMPIEZA (≤ soft → factor 1.0, ELO pleno). Default 1300. */
  BOT_ELO_DECAY_SOFT: z.coerce.number().int().min(1).default(1300),
  /** Skill donde el decay llega al mínimo (≥ hard → factor min). Default 2400. */
  BOT_ELO_DECAY_HARD: z.coerce.number().int().min(1).default(2400),
  // ── Balance ELO asimétrico (2026-11-10, decisión del dueño: leve inflación aceptada) ──
  /**
   * Escala aplicada al delta que PIERDE la víctima en TODAS las muertes
   * (vs bots, vs humanos y world/suicidio: WORLD_LOSS×escala; en teamkill la
   * víctima no pierde nada). Default 0.5: bajar duele LA MITAD. El atacante
   * NO usa esta escala (usa SKILL_ATTACK_GAIN_SCALE).
   */
  SKILL_VICTIM_LOSS_SCALE: z.coerce.number().min(0).max(1).default(0.5),
  /**
   * Escala aplicada a la GANANCIA del atacante en kills válidos (vs bots y vs
   * humanos por igual; NO aplica a teamkill ni a world). Se aplica al delta
   * FINAL del atacante, DESPUÉS del multiplicador de evento (el cap ×1.6 de
   * eventMult queda como está) y después del decay de bots. Default 1.5: +50%.
   */
  SKILL_ATTACK_GAIN_SCALE: z.coerce.number().min(0).default(1.5),
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
  rconHost: raw.RCON_HOST,
  rconPort: raw.RCON_PORT,
  rconPassword: raw.RCON_PASSWORD,
  rconSpacingMs: raw.RCON_SPACING_MS,
  rconResponseTimeoutMs: raw.RCON_RESPONSE_TIMEOUT_MS,
  rconEnforcerIntervalMs: raw.RCON_ENFORCER_INTERVAL_MS,
  rconBansFile: raw.RCON_BANS_FILE,
  gameLogPath: raw.GAME_LOG_PATH,
  /** Lista efectiva de fuentes log: GAME_LOG_PATH + GAME_LOG_PATHS (deduplicada). */
  gameLogSources: (() => {
    const sources: Array<{ path: string; address: string | null }> = [];
    if (raw.GAME_LOG_PATH) {
      sources.push({ path: raw.GAME_LOG_PATH, address: raw.GAME_SERVER_ADDRESS ?? null });
    }
    for (const entry of (raw.GAME_LOG_PATHS ?? '').split(/[;\n]/)) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const sep = trimmed.lastIndexOf('|');
      const path = (sep >= 0 ? trimmed.slice(0, sep) : trimmed).trim();
      const address = sep >= 0 ? trimmed.slice(sep + 1).trim() : '';
      if (path && !sources.some((source) => source.path === path)) {
        sources.push({ path, address: address || null });
      }
    }
    return sources;
  })(),
  liveStatsFile: raw.LIVE_STATS_FILE,
  liveStatsIntervalMs: raw.LIVE_STATS_INTERVAL_MS,
  liveXpJumpLimit: raw.LIVE_XP_JUMP_LIMIT,
  liveXpJumpWindowMs: raw.LIVE_XP_JUMP_WINDOW_MS,
  antiUnlockKickMsg: raw.ANTI_UNLOCK_KICK_MSG,
  gameServerAddress: raw.GAME_SERVER_ADDRESS,
  syncIntervalMinutes: raw.SYNC_INTERVAL_MINUTES,
  syncIntervalSeconds: raw.SYNC_INTERVAL_SECONDS,
  adminEmails: raw.ADMIN_EMAILS.split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0),
  adminNick: raw.ADMIN_NICK,
  adminEmail: raw.ADMIN_EMAIL.toLowerCase(),
  adminPassword: raw.ADMIN_PASSWORD,
  seedDefaultAdmin: raw.SEED_DEFAULT_ADMIN,
  linkWindowMinutes: raw.LINK_WINDOW_MINUTES,
  playSessionTtlMin: raw.PLAY_SESSION_TTL_MIN,
  launcherOnlyKickMsg: raw.LAUNCHER_ONLY_KICK_MSG,
  corsOrigins: raw.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
  // Cloud save: rutas relativas se resuelven SIEMPRE contra la raíz del repo
  // (determinista, independiente del cwd del proceso).
  profileStorageDir: resolve(repoRoot, raw.PROFILE_STORAGE_DIR ?? resolve(repoRoot, 'apps', 'api', 'storage', 'profiles')),
  botEloDecayMin: raw.BOT_ELO_DECAY_MIN,
  botEloDecaySoft: raw.BOT_ELO_DECAY_SOFT,
  botEloDecayHard: raw.BOT_ELO_DECAY_HARD,
  skillVictimLossScale: raw.SKILL_VICTIM_LOSS_SCALE,
  skillAttackGainScale: raw.SKILL_ATTACK_GAIN_SCALE,
} as const;

export type Env = typeof env;
export const paths = { repoRoot, apiRoot } as const;
