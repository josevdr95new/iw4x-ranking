import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { apiRouter } from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
    }),
  );
  // Cloud save PUT: hasta 12 archivos × 256 KB base64 ≈ 3+ MB de JSON.
  // Parser con límite mayor SOLO para /api/profile/save (body-parser salta la
  // segunda pasada si el body ya fue parseado por req._body).
  app.use('/api/profile/save', express.json({ limit: '12mb' }));
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
