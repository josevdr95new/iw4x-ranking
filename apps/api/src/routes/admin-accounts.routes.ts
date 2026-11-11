import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { Errors } from '../lib/errors.js';
import { validate, parseWith } from '../middleware/validate.js';
import {
  accountIdParam,
  accountGuidParam,
  adminSetPasswordInput,
  adminUpdateAccountInput,
} from '../dto/admin-accounts.dto.js';
import {
  listAccounts,
  getAccountDetail,
  setAccountPassword,
  updateAccount,
  deleteAccount,
  unlinkGuid,
} from '../services/admin-accounts.service.js';

/**
 * Gestión de cuentas por el ADMIN del panel (/api/admin/accounts/*).
 *
 * Se monta bajo adminRouter (routes/admin.routes.ts), que ya aplica
 * requireAuth + requireAdmin a toda la rama: hereda el gate JWT+ADMIN.
 */
export const adminAccountsRouter: Router = Router();

// GET /api/admin/accounts → { accounts: [...] } ordenado por createdAt desc (cap 200).
adminAccountsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ accounts: await listAccounts() });
  }),
);

// GET /api/admin/accounts/:id → { account: {..., guids, save, sessions} } (404 si no existe).
adminAccountsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parseWith(accountIdParam, req.params);
    res.json({ account: await getAccountDetail(id) });
  }),
);

// POST /api/admin/accounts/:id/password { password } → { updated: true } (hash con el mismo bcrypt del registro).
adminAccountsRouter.post(
  '/:id/password',
  validate(adminSetPasswordInput, 'body'),
  asyncHandler(async (req, res) => {
    const { id } = parseWith(accountIdParam, req.params);
    const { password } = parseWith(adminSetPasswordInput, req.body ?? {});
    res.json(await setAccountPassword(id, password));
  }),
);

// PATCH /api/admin/accounts/:id { displayName?, email?, role? } → { updated: true, account }.
adminAccountsRouter.patch(
  '/:id',
  validate(adminUpdateAccountInput, 'body'),
  asyncHandler(async (req, res) => {
    const { id } = parseWith(accountIdParam, req.params);
    const input = parseWith(adminUpdateAccountInput, req.body ?? {});
    res.json(await updateAccount(id, input));
  }),
);

// DELETE /api/admin/accounts/:id → { deleted: true } (NO self, NO última ADMIN; borra links+auth+saves).
adminAccountsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parseWith(accountIdParam, req.params);
    if (!req.user) throw Errors.unauthorized();
    res.json(await deleteAccount(id, req.user.id));
  }),
);

// DELETE /api/admin/accounts/:id/guids/:guid → { unlinked: true } (anti-suplantación; el guid queda libre).
adminAccountsRouter.delete(
  '/:id/guids/:guid',
  asyncHandler(async (req, res) => {
    const { id, guid } = parseWith(accountGuidParam, req.params);
    res.json(await unlinkGuid(id, guid));
  }),
);
