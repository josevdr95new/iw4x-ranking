import { z } from 'zod';
import { IDENTITY_ALERT_STATUSES } from '../services/identity.service.js';

/** GET /api/admin/identity-alerts?status=&limit= (sin status → todas). */
export const identityAlertsQuery = z.object({
  status: z.enum(IDENTITY_ALERT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export type IdentityAlertsQuery = z.infer<typeof identityAlertsQuery>;

/** POST /api/admin/identity-alerts/:id/resolve { action: "LINK_TO_OWNER" | "DISMISS" }. */
export const identityAlertResolveInput = z.object({
  action: z.enum(['LINK_TO_OWNER', 'DISMISS'], {
    errorMap: () => ({ message: 'action debe ser "LINK_TO_OWNER" o "DISMISS".' }),
  }),
});

export const identityAlertIdParam = z.object({
  id: z.coerce.number().int().positive('El id de la alerta debe ser numérico positivo.'),
});

/**
 * POST /api/identity/guid-from-file { dataBase64 } — contenido CRUDO de un
 * guid.dat (antes de subir/restaurar a la nube). Sanity: el DECODIFICADO debe
 * pesar 64B..4KB (un guid.dat real son ~200-300 bytes; fuera de ese rango ni
 * se intenta parsear).
 */
export const guidFromFileInput = z.object({
  dataBase64: z
    .string({ required_error: 'dataBase64 es obligatorio (contenido crudo del guid.dat en base64).' })
    .refine((v) => /^[A-Za-z0-9+/]*={0,2}$/.test(v) && v.length % 4 === 0, {
      message: 'dataBase64 no es base64 válido.',
    })
    .refine((v) => {
      try {
        return Buffer.from(v, 'base64').length >= 64 && Buffer.from(v, 'base64').length <= 4096;
      } catch {
        return false;
      }
    }, { message: 'El guid.dat decodificado debe pesar entre 64 bytes y 4 KB.' }),
});

export type GuidFromFileInput = z.infer<typeof guidFromFileInput>;
