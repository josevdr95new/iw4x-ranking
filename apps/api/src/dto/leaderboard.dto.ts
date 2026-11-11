import { z } from 'zod';

export const leaderboardQuerySchema = z.object({
  sort: z.enum(['kills', 'deaths', 'kd', 'timePlayed', 'skill', 'headshots', 'level']).default('kills'),
  order: z.enum(['asc', 'desc']).default('desc'),
  search: z
    .string()
    .trim()
    .max(64)
    .optional()
    .transform((value) => (value !== undefined && value.length > 0 ? value : undefined)),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  minMatches: z.coerce.number().int().min(0).default(0),
  // DEPRECATED/COMPAT (2026-11-11): los bots YA NO EXISTEN como jugadores en la
  // DB (sin Player row) → este param se ACEPTA ("true"/"false", coacción
  // idempotente del string crudo Y del boolean ya parseado) pero se IGNORA:
  // los bots NUNCA aparecen en el leaderboard, con o sin él. La web puede
  // seguir enviándolo sin efecto.
  includeBots: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((value) => value === true || value === 'true'),
});

export type LeaderboardQuery = z.infer<typeof leaderboardQuerySchema>;
