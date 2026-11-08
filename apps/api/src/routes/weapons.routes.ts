import { Router } from 'express';
import { getWeaponsRanking } from '../services/weapons.service.js';
import { weaponDictionary } from '../lib/weapons.js';
import { asyncHandler } from '../lib/http.js';

export const weaponsRouter: Router = Router();

// Diccionario estático code→name (MW2/IW4x) para la web: decodifica weaponCodes
// crudos sin duplicar la tabla en el frontend. Público, sin estado.
weaponsRouter.get(
  '/dictionary',
  asyncHandler(async (_req, res) => {
    res.json(weaponDictionary());
  }),
);

// Ranking global de armas (público, mismo estilo que /api/leaderboard).
weaponsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await getWeaponsRanking(req.query));
  }),
);
