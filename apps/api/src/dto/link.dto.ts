import { z } from 'zod';
import { GUID_PATTERN } from '../lib/validation.js';

export const guidParamSchema = z.object({
  guid: z.string().regex(GUID_PATTERN, 'El GUID debe ser numérico (NetworkId de IW4MAdmin).'),
});

export const historyQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

export const linkCompleteSchema = z.object({
  guid: z.string().regex(GUID_PATTERN, 'El GUID debe ser numérico (NetworkId de IW4MAdmin).').optional(),
});

export const linkStartResponseSchema = z.object({
  attemptId: z.number(),
  status: z.literal('pending'),
  windowMinutes: z.number(),
  createdAt: z.string(),
});
