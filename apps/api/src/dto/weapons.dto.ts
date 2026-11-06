import { z } from 'zod';

export const weaponsQuerySchema = z.object({
  sort: z.enum(['kills', 'damage', 'victims', 'headshots']).default('kills'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type WeaponsQuery = z.infer<typeof weaponsQuerySchema>;
