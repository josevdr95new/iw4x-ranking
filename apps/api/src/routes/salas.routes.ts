import { Router } from 'express';
import { getSalasOverview } from '../services/salas.service.js';
import { asyncHandler } from '../lib/http.js';

export const salasRouter: Router = Router();

// Público a propósito: datos de server browser (hostname/mapa/jugadores/bots).
// JAMÁS expone rcon_password ni credenciales (la shape no las incluye).
salasRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await getSalasOverview());
  }),
);
