import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { guidFromFileInput } from '../dto/identity.dto.js';
import { resolveGuidFromFile, claimFreshIdentity } from '../services/identity-guid.service.js';
import { asyncHandler } from '../lib/http.js';

/**
 * IDENTIDAD desde guid.dat (contrato del launcher — anti robo de identidad).
 *
 * CONTRATO EXACTO:
 *  POST /api/identity/guid-from-file  🔒 JWT de usuario
 *    body { dataBase64: <contenido CRUDO de un guid.dat en base64> }
 *    → { guid: "<hex16>"|null, guidDecimal: "<dec>"|null, ownedByMe: bool,
 *        ownerNick: string|null }
 *
 *    El launcher lo consulta ANTES de restaurar "el guid.dat de mi nube": si
 *    ownedByMe=false (o guid=null) NO debe restaurar ese archivo — restaurarlo
 *    haría que la PC arranque con la identidad de otra persona.
 *    Sanity del cuerpo: base64 válido cuyo decodificado pese 64B..4KB (un
 *    guid.dat real son ~200-300 B); fuera de rango → 400 VALIDATION_ERROR.
 *    Contenido no derivable → 200 con guid:null (no es un error HTTP).
 *
 *  POST /api/identity/claim-fresh  🔒 JWT de usuario (sin cuerpo)
 *    → { ok: true, claimFreshAt, clearedSessionGuid, linkedGuids }
 *    Flujo de CUARENTENA: marca que la cuenta espera una identidad NUEVA
 *    (guid.dat compartido contaminado). El auto-link por sesión aceptará el
 *    guid nuevo que nazca (one-shot) y deja de matchear por guids viejos.
 */
export const identityRouter: Router = Router();

identityRouter.use(requireAuth);

identityRouter.post(
  '/guid-from-file',
  validate(guidFromFileInput),
  asyncHandler(async (req, res) => {
    const input = guidFromFileInput.parse(req.body);
    res.json(await resolveGuidFromFile(req.user!.id, input.dataBase64));
  }),
);

identityRouter.post(
  '/claim-fresh',
  asyncHandler(async (req, res) => {
    res.json(await claimFreshIdentity(req.user!.id));
  }),
);
