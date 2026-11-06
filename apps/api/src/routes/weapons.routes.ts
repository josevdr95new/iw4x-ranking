import { Router } from 'express';
import { getWeaponsRanking } from '../services/weapons.service.js';
import { asyncHandler } from '../lib/http.js';

export const weaponsRouter: Router = Router();

// Ranking global de armas (público, mismo estilo que /api/leaderboard).
weaponsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await getWeaponsRanking(req.query));
  }),
);
