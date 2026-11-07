import { z } from 'zod';

/** Tipos de penalidad emibles via execute de IW4MAdmin (scope del bridge). */
export const IAM_PENALTY_TYPES = ['warn', 'kick', 'tempban', 'ban'] as const;
export type IamPenaltyType = (typeof IAM_PENALTY_TYPES)[number];

/** Límite local de tempban: MaximumTempBanTime real está en la config de IW4MAdmin (30d acá). */
export const MAX_TEMPBAN_MINUTES = 30 * 24 * 60;

export const iamClientsQuery = z
  .object({
    /** Nombre (≥3 chars, LIKE del upstream) o GUID hex (xuid).
     *  Mismas reglas del /api/client/find de IW4MAdmin. */
    query: z.string().min(3).max(64),
  })
  .strict();

export const iamPenaltiesQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();

export const iamLiveQuery = z
  .object({
    /** Resuelve clientId de cada player vía /api/client/find (default true). */
    resolve: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
  })
  .strict();

export const iamPenaltyInput = z
  .object({
    clientId: z.number().int().positive().optional(),
    clientName: z.string().min(3).max(64).optional(),
    type: z.enum(IAM_PENALTY_TYPES),
    /** Requerido para tempban (entre 1 y MAX_TEMPBAN_MINUTES = 30 días). */
    durationMinutes: z.number().int().positive().optional(),
    /** Motivo OBLIGATORIO (el webfront de IW4MAdmin también lo exige). */
    reason: z.string().min(3).max(200),
  })
  .strict()
  .refine((body) => body.clientId !== undefined || body.clientName !== undefined, {
    message: 'Debes indicar clientId o clientName.',
    path: ['clientId'],
  })
  .refine((body) => body.type !== 'tempban' || body.durationMinutes !== undefined, {
    message: 'durationMinutes es requerido para tempban.',
    path: ['durationMinutes'],
  })
  .refine(
    (body) =>
      body.type !== 'tempban' ||
      body.durationMinutes === undefined ||
      (body.durationMinutes >= 1 && body.durationMinutes <= MAX_TEMPBAN_MINUTES),
    {
      message: `durationMinutes debe estar entre 1 y ${MAX_TEMPBAN_MINUTES} (límite de IW4MAdmin: 30 días).`,
      path: ['durationMinutes'],
    },
  );

export type IamClientsQuery = z.infer<typeof iamClientsQuery>;
export type IamPenaltiesQuery = z.infer<typeof iamPenaltiesQuery>;
export type IamLiveQuery = z.infer<typeof iamLiveQuery>;
export type IamPenaltyInput = z.infer<typeof iamPenaltyInput>;
