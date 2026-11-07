import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getServerConfig, restartServer, updateServerConfig } from '../services/serverconfig.service.js';
import { asyncHandler } from '../lib/http.js';
import { validate, parseWith } from '../middleware/validate.js';
import {
  createPenalty,
  getIamStatus,
  getLivePlayers,
  getRecentPenalties,
  searchClients,
} from '../services/iam.service.js';
import { getAliasConflicts } from '../services/alias.service.js';
import {
  iamClientsQuery,
  iamLiveQuery,
  iamPenaltiesQuery,
  iamPenaltyInput,
} from '../dto/iam.dto.js';
import { identityAlertsQuery, identityAlertResolveInput, identityAlertIdParam } from '../dto/identity.dto.js';
import { getIdentityAlerts, resolveIdentityAlert } from '../services/identity.service.js';

export const adminRouter: Router = Router();

// Toda la rama /admin exige JWT + rol ADMIN (leído fresco de la DB en cada request).
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get(
  '/server-config',
  asyncHandler(async (_req, res) => {
    res.json({ config: await getServerConfig() });
  }),
);

adminRouter.put(
  '/server-config',
  asyncHandler(async (req, res) => {
    res.json(await updateServerConfig(req.body ?? {}));
  }),
);

adminRouter.post(
  '/server/restart',
  asyncHandler(async (_req, res) => {
    res.json(await restartServer());
  }),
);

// Anti-confusión de identidades (read-only): colisiones de nombre entre GUIDs
// y guids con múltiples alias históricos (PCs compartidas / renombres).
adminRouter.get(
  '/alias-conflicts',
  asyncHandler(async (_req, res) => {
    res.json(await getAliasConflicts());
  }),
);

// ── Alertas de identidad (impersonación de nick registrado) ─────────────────

adminRouter.get(
  '/identity-alerts',
  validate(identityAlertsQuery, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await getIdentityAlerts(req.query as unknown as Parameters<typeof getIdentityAlerts>[0]));
  }),
);

adminRouter.post(
  '/identity-alerts/:id/resolve',
  asyncHandler(async (req, res) => {
    const { id } = parseWith(identityAlertIdParam, req.params);
    const { action } = parseWith(identityAlertResolveInput, req.body ?? {});
    res.json(await resolveIdentityAlert(id, action));
  }),
);

// ── Bridge de moderación con IW4MAdmin (/api/admin/iam/*) ─────────────────

adminRouter.get(
  '/iam/status',
  asyncHandler(async (_req, res) => {
    res.json(await getIamStatus());
  }),
);

adminRouter.get(
  '/iam/clients',
  validate(iamClientsQuery, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await searchClients(req.query as unknown as Parameters<typeof searchClients>[0]));
  }),
);

adminRouter.get(
  '/iam/penalties',
  validate(iamPenaltiesQuery, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await getRecentPenalties(req.query as unknown as Parameters<typeof getRecentPenalties>[0]));
  }),
);

adminRouter.get(
  '/iam/live',
  validate(iamLiveQuery, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await getLivePlayers(req.query as unknown as Parameters<typeof getLivePlayers>[0]));
  }),
);

adminRouter.post(
  '/iam/penalty',
  asyncHandler(async (req, res) => {
    const input = parseWith(iamPenaltyInput, req.body ?? {});
    res.json(await createPenalty(input));
  }),
);
