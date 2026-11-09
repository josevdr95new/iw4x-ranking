import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { parseWith, validate } from '../middleware/validate.js';
import { guidParamSchema, historyQuerySchema } from '../dto/link.dto.js';
import { saveClassesSchema } from '../dto/classes.dto.js';
import { getPlayerHistory, getPlayerProfile } from '../services/players.service.js';
import { getPlayerMaps, getPlayerWeapons } from '../services/weapons.service.js';
import { savePlayerClasses } from '../services/classes.service.js';
import { asyncHandler } from '../lib/http.js';
import { Errors } from '../lib/errors.js';

export const playersRouter: Router = Router();

/**
 * POST /api/players/classes 🔒 — ingesta de clases de loadout desde el dump del
 * CLIENTE (`/dumpPlayerData` → console_mp.log). El body trae el TEXTO del dump
 * (puede ser el log entero: el parser busca la sección customClasses). Antes de
 * la ruta paramétrica para que `classes` no la sombra.
 */
playersRouter.post(
  '/classes',
  requireAuth,
  validate(saveClassesSchema),
  asyncHandler(async (req, res) => {
    const auth = req.user;
    if (!auth) throw Errors.unauthorized();
    res.json(await savePlayerClasses(auth.id, req.body));
  }),
);

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
