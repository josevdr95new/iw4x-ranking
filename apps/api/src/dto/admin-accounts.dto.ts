import { z } from 'zod';
import { GUID_PATTERN } from '../lib/validation.js';

/**
 * DTOs de la gestión de cuentas por el ADMIN del panel (/api/admin/accounts).
 * Los validadores NO aceptan campos extra (.strict()).
 */

/** :id de cuenta en el path (numérico positivo). */
export const accountIdParam = z.object({
  id: z.coerce.number().int().positive('El id de la cuenta debe ser numérico positivo.'),
});

/** :id + :guid en el path (guid decimal NetworkId, mismo patrón que /api/link). */
export const accountGuidParam = z.object({
  id: z.coerce.number().int().positive('El id de la cuenta debe ser numérico positivo.'),
  guid: z.string().regex(GUID_PATTERN, 'El GUID debe ser numérico (NetworkId de IW4MAdmin).'),
});

/**
 * POST /api/admin/accounts/:id/password { password } — misma regla de longitud
 * que el registro (min 8); el techo (64) y el código de error específico
 * (ACCOUNT_WEAK_PASSWORD 400) los aplica el servicio.
 */
export const adminSetPasswordInput = z.object({
  password: z.string({ required_error: 'password (string) es obligatorio.' }),
});

/**
 * PATCH /api/admin/accounts/:id { displayName?, email?, role? } — todos
 * opcionales (mínimo uno); mismas restricciones que el registro.
 */
export const adminUpdateAccountInput = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(3, 'El nombre visible debe tener al menos 3 caracteres')
      .max(32, 'El nombre visible no puede superar 32 caracteres')
      .optional(),
    email: z.string().trim().toLowerCase().email('Email inválido').max(254).optional(),
    role: z
      .enum(['USER', 'ADMIN'], {
        errorMap: () => ({ message: 'role debe ser "USER" o "ADMIN".' }),
      })
      .optional(),
  })
  .strict()
  .refine((data) => data.displayName !== undefined || data.email !== undefined || data.role !== undefined, {
    message: 'Debes enviar displayName, email y/o role.',
  });

export type AdminUpdateAccountInput = z.infer<typeof adminUpdateAccountInput>;
