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
  // Query param "true"/"false" (default false: el leaderboard público es SOLO-humanos).
  // IDEMPOTENTE: acepta el string crudo del query Y el boolean ya parseado, porque
  // el service re-valida con este mismo schema lo que validate() ya transformó.
  includeBots: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((value) => value === true || value === 'true'),
});

export type LeaderboardQuery = z.infer<typeof leaderboardQuerySchema>;
