import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { leaderboardQuerySchema } from '../dto/leaderboard.dto.js';
import { getLeaderboard } from '../services/leaderboard.service.js';
import { asyncHandler } from '../lib/http.js';

export const leaderboardRouter: Router = Router();

leaderboardRouter.get(
  '/',
  validate(leaderboardQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await getLeaderboard(req.query));
  }),
);
