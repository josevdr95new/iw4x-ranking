import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { putSaveSchema, saveFileQuerySchema, type PutSaveInput, type SaveFileQuery } from '../dto/profile-save.dto.js';
import { getLatestSave, getSaveFile, listSaveVersions, putSave } from '../services/profile-save.service.js';
import { asyncHandler } from '../lib/http.js';
import { Errors } from '../lib/errors.js';

/**
 * Cloud save de progresión (/api/profile/*). Auth JWT normal: cada usuario solo
 * accede a SU save (aislado por userId en el layout de storage; nunca hay rutas
 * con userId del request).
 *
 * Convención decidida para GET /save cuando la cuenta nunca subió:
 * **200 con `{ exists: false }`** (NO 404), para que el launcher trate
 * "primera vez en este PC" como caso normal del flujo pre-launch.
 */
export const profileRouter: Router = Router();

profileRouter.use(requireAuth);

profileRouter.get(
  '/save',
  asyncHandler(async (req, res) => {
    const auth = req.user;
    if (!auth) throw Errors.unauthorized();
    const manifest = getLatestSave(auth.id);
    if (!manifest) {
      res.json({ exists: false });
      return;
    }
    res.json({
      exists: true,
      version: manifest.version,
      updatedAt: manifest.updatedAt,
      build: manifest.build,
      files: manifest.files,
    });
  }),
);

profileRouter.put(
  '/save',
  validate(putSaveSchema),
  asyncHandler(async (req, res) => {
    const auth = req.user;
    if (!auth) throw Errors.unauthorized();
    const result = await putSave(auth.id, req.body as PutSaveInput);
    res.json(result);
  }),
);

// IMPORTANTE: /save/file y /save/versions antes de cualquier ruta futura con params.
profileRouter.get(
  '/save/file',
  validate(saveFileQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const auth = req.user;
    if (!auth) throw Errors.unauthorized();
    const query = req.query as unknown as SaveFileQuery;
    const result = getSaveFile(auth.id, query.path, query.version);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(result.data.length));
    res.setHeader('X-Save-Sha256', result.sha256);
    res.setHeader('X-Save-Version', String(result.version));
    res.send(result.data);
  }),
);

profileRouter.get(
  '/save/versions',
  asyncHandler(async (req, res) => {
    const auth = req.user;
    if (!auth) throw Errors.unauthorized();
    res.json({ versions: listSaveVersions(auth.id) });
  }),
);
