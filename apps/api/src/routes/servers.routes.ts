import { Router } from 'express';
import { getServersList } from '../services/servers.service.js';
import { asyncHandler } from '../lib/http.js';

export const serversRouter: Router = Router();

// Público a propósito: el launcher y la web necesitan la lista sin loguearse.
serversRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(getServersList());
  }),
);
