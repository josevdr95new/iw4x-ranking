import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { parseWith } from '../middleware/validate.js';
import { linkCompleteSchema } from '../dto/link.dto.js';
import { completeLink, startLinkAttempt } from '../services/link.service.js';
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
