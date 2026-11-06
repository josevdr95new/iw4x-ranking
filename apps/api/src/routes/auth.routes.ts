import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { parseWith } from '../middleware/validate.js';
import { loginSchema, registerSchema, updateProfileSchema } from '../dto/auth.dto.js';
import { getUserMe, loginUser, registerUser, updateProfile } from '../services/auth.service.js';
import { asyncHandler } from '../lib/http.js';
import { Errors } from '../lib/errors.js';

export const authRouter: Router = Router();

authRouter.post(
  '/register',
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const input = parseWith(registerSchema, req.body);
    res.status(201).json(await registerUser(input));
  }),
);

authRouter.post(
  '/login',
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const input = parseWith(loginSchema, req.body);
    res.json(await loginUser(input));
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = req.user;
    if (!auth) throw Errors.unauthorized();
    res.json({ user: await getUserMe(auth.id) });
  }),
);

authRouter.patch(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = req.user;
    if (!auth) throw Errors.unauthorized();
    const body = parseWith(updateProfileSchema, req.body ?? {});
    res.json({ user: await updateProfile(auth.id, body) });
  }),
);
