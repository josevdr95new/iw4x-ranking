import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { parseWith } from '../middleware/validate.js';
import { guidParamSchema, linkCompleteSchema } from '../dto/link.dto.js';
import { completeLink, startLinkAttempt, unlinkGuid } from '../services/link.service.js';
import { asyncHandler } from '../lib/http.js';
import { Errors } from '../lib/errors.js';

export const linkRouter: Router = Router();

linkRouter.post(
  '/start',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = req.user;
    if (!auth) throw Errors.unauthorized();
    res.json(await startLinkAttempt(auth.id));
  }),
);

linkRouter.post(
  '/complete',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = req.user;
    if (!auth) throw Errors.unauthorized();
    const body = parseWith(linkCompleteSchema, req.body ?? {});
    res.json(await completeLink(auth.id, body.guid));
  }),
);

// Desvincular un GUID propio (PCs compartidas: liberar/cambiar cuenta).
linkRouter.delete(
  '/:guid',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = req.user;
    if (!auth) throw Errors.unauthorized();
    const { guid } = parseWith(guidParamSchema, req.params);
    res.json(await unlinkGuid(auth.id, guid));
  }),
);
