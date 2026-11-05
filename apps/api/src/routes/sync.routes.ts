import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { runSync, getPublicSyncStatus } from '../services/sync/sync.service.js';
import { asyncHandler } from '../lib/http.js';

export const syncRouter: Router = Router();

syncRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const result = await runSync();
    res.json({ result });
  }),
);

// Público a propósito: el frontend muestra "último sync" sin obligar a loguearse.
syncRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json(await getPublicSyncStatus());
  }),
);

