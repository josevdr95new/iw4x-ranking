import { Router } from 'express';
import { authRouter } from './auth.routes.js';
import { linkRouter } from './link.routes.js';
import { leaderboardRouter } from './leaderboard.routes.js';
import { playersRouter } from './players.routes.js';
import { syncRouter } from './sync.routes.js';
import { weaponsRouter } from './weapons.routes.js';

export const apiRouter: Router = Router();

apiRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), now: new Date().toISOString() });
});

apiRouter.use('/auth', authRouter);
apiRouter.use('/link', linkRouter);
apiRouter.use('/leaderboard', leaderboardRouter);
apiRouter.use('/players', playersRouter);
apiRouter.use('/sync', syncRouter);
apiRouter.use('/weapons', weaponsRouter);
