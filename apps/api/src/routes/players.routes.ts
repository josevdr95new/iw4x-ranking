import { Router } from 'express';
import { parseWith } from '../middleware/validate.js';
import { guidParamSchema, historyQuerySchema } from '../dto/link.dto.js';
import { getPlayerHistory, getPlayerProfile } from '../services/players.service.js';
import { getPlayerMaps, getPlayerWeapons } from '../services/weapons.service.js';
import { asyncHandler } from '../lib/http.js';

export const playersRouter: Router = Router();

playersRouter.get(
  '/:guid/weapons',
  asyncHandler(async (req, res) => {
    const { guid } = parseWith(guidParamSchema, req.params);
    res.json(await getPlayerWeapons(guid));
  }),
);

playersRouter.get(
  '/:guid/maps',
  asyncHandler(async (req, res) => {
    const { guid } = parseWith(guidParamSchema, req.params);
    res.json(await getPlayerMaps(guid));
  }),
);

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
