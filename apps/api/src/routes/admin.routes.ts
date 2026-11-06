import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getServerConfig, restartServer, updateServerConfig } from '../services/serverconfig.service.js';
import { asyncHandler } from '../lib/http.js';

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
