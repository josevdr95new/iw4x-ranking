import { z } from 'zod';

/**
 * DTOs de los endpoints de administración del server (sesiones de juego,
 * launcher-only, mapas y bots). Los validadores NO aceptan campos extra.
 */

// ── launcher-only ───────────────────────────────────────────────────────────

export const launcherOnlyInput = z
  .object({
    enabled: z.boolean({ required_error: 'enabled (boolean) es obligatorio.' }),
  })
  .strict();

// ── Mapas ───────────────────────────────────────────────────────────────────

/** Id mp_ del catálogo (el servicio valida que exista → 400 si desconocido). */
export const mapChangeInput = z
  .object({
    map: z
      .string({ required_error: 'map (string) es obligatorio.' })
      .trim()
      .min(1, 'map no puede ser vacío.')
      .max(64)
      .regex(/^[A-Za-z0-9_]+$/, 'map solo admite [A-Za-z0-9_] (id mp_ del catálogo).'),
  })
  .strict();

// ── Bots ────────────────────────────────────────────────────────────────────

/** Contador por equipo de bots_skill=8 (hard=skill 7, med=skill 4). */
const teamCount = z.number().int().min(0).max(64);

export const botsDifficultyInput = z
  .object({
    level: z.union([
      z
        .number({ required_error: 'level (number 0-9 o objeto per-team) es obligatorio.' })
        .int()
        .min(0, 'bots_skill admite 0-9 (0=aleatorio, 1-7 fijo, 8=per-team custom, 9=aleatorio continuo).')
        .max(9, 'bots_skill admite 0-9 (0=aleatorio, 1-7 fijo, 8=per-team custom, 9=aleatorio continuo).'),
      z
        .object({
          alliesHard: teamCount.optional(),
          alliesMed: teamCount.optional(),
          axisHard: teamCount.optional(),
          axisMed: teamCount.optional(),
        })
        .strict(),
    ]),
  })
  .strict();

export const botsCountInput = z
  .object({
    count: z
      .number({ required_error: 'count (number) es obligatorio.' })
      .int()
      .min(0, 'count no puede ser negativo.')
      .max(64, 'count máximo 64 (cap defensivo sobre sv_maxclients).'),
  })
  .strict();

export type LauncherOnlyInput = z.infer<typeof launcherOnlyInput>;
export type MapChangeInput = z.infer<typeof mapChangeInput>;
export type BotsDifficultyInput = z.infer<typeof botsDifficultyInput>;
export type BotsCountInput = z.infer<typeof botsCountInput>;
