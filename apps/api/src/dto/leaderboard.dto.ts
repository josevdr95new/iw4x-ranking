import { z } from 'zod';

export const leaderboardQuerySchema = z.object({
  sort: z.enum(['kills', 'deaths', 'kd', 'timePlayed', 'skill']).default('kills'),
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
});

export type LeaderboardQuery = z.infer<typeof leaderboardQuerySchema>;
