import { Router } from 'express';
import { parseWith } from '../middleware/validate.js';
import { guidParamSchema, historyQuerySchema } from '../dto/link.dto.js';
import { getPlayerHistory, getPlayerProfile } from '../services/players.service.js';
import { asyncHandler } from '../lib/http.js';

export const playersRouter: Router = Router();

playersRouter.get(
  '/:guid',
  asyncHandler(async (req, res) => {
    const { guid } = parseWith(guidParamSchema, req.params);
    res.json(await getPlayerProfile(guid));
  }),
);

playersRouter.get(
  '/:guid/history',
  asyncHandler(async (req, res) => {
    const { guid } = parseWith(guidParamSchema, req.params);
    const { days } = parseWith(historyQuerySchema, req.query);
    res.json(await getPlayerHistory(guid, days));
  }),
);
