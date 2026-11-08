import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../lib/http.js';
import { startOrRefreshPlaySession } from '../services/play-session.service.js';

/**
 * Sesiones de juego del launcher (anti no-launcher).
 *
 * CONTRATO EXACTO con el launcher (respetar shapes al carácter):
 *  POST /api/play/session  🔒 JWT de usuario
 *   → crea/refresca la sesión de juego de ESA cuenta (TTL deslizante, default
 *     10 min, env PLAY_SESSION_TTL_MIN). Idempotente (refresh = upsert).
 *   → {ok:true, nick:<displayName>, expiresAt:<ISO>}
 * El launcher la llama al dar JUGAR y en cada heartbeat.
 */
export const playRouter: Router = Router();

playRouter.use(requireAuth);

playRouter.post(
  '/session',
  asyncHandler(async (req, res) => {
    const result = await startOrRefreshPlaySession(req.user!.id);
    res.json(result);
  }),
);
