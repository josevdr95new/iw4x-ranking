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
