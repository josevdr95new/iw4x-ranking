import { z } from 'zod';

/** Tipos de penalidad emibles via RCON nativo del server IW4x (moderación). */
export const IAM_PENALTY_TYPES = ['warn', 'kick', 'tempban', 'ban'] as const;
export type IamPenaltyType = (typeof IAM_PENALTY_TYPES)[number];

/** Límite local de tempban per-caso (el nativo del juego es un dvar global). */
export const MAX_TEMPBAN_MINUTES = 30 * 24 * 60;

export const iamClientsQuery = z
  .object({
    /** Nombre (≥3 chars, LIKE limpio en la base del ranking) o GUID (hex o decimal). */
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
    /** Resuelve clientId de cada player contra la base del ranking (default true). */
    resolve: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
  })
  .strict();

export const iamPenaltyInput = z
  .object({
    /** clientId del ranking (Player.id): sirve ONLINE y OFFLINE (tempban/ban). */
    clientId: z.number().int().positive().optional(),
    /** Nombre exacto de un player CONECTADO (match limpio, sin color codes). */
    clientName: z.string().min(3).max(64).optional(),
    /** Slot directo (num de `status`): para targets no indexados (p. ej. bots). */
    cid: z.number().int().min(0).max(63).optional(),
    type: z.enum(IAM_PENALTY_TYPES),
    /** Requerido para tempban (entre 1 y MAX_TEMPBAN_MINUTES = 30 días). */
    durationMinutes: z.number().int().positive().optional(),
    /** Motivo OBLIGATORIO (viaja al juego via tell/say y queda en la DB). */
    reason: z.string().min(3).max(200),
  })
  .strict()
  .refine((body) => body.clientId !== undefined || body.clientName !== undefined || body.cid !== undefined, {
    message: 'Debes indicar clientId, clientName o cid.',
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
      message: `durationMinutes debe estar entre 1 y ${MAX_TEMPBAN_MINUTES} (límite local del panel).`,
      path: ['durationMinutes'],
    },
  );

export const iamUnbanInput = z
  .object({
    clientId: z.number().int().positive().optional(),
    /** GUID en HEX (formato status/bans.json) o decimal (formato ranking). */
    guid: z.string().min(8).max(20).optional(),
    cid: z.number().int().min(0).max(63).optional(),
  })
  .strict()
  .refine((body) => body.clientId !== undefined || body.guid !== undefined || body.cid !== undefined, {
    message: 'Debes indicar clientId, guid o cid.',
    path: ['clientId'],
  });

export type IamClientsQuery = z.infer<typeof iamClientsQuery>;
export type IamPenaltiesQuery = z.infer<typeof iamPenaltiesQuery>;
export type IamLiveQuery = z.infer<typeof iamLiveQuery>;
export type IamPenaltyInput = z.infer<typeof iamPenaltyInput>;
export type IamUnbanInput = z.infer<typeof iamUnbanInput>;
