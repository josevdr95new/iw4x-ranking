import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../lib/jwt.js';
import { Errors } from '../lib/errors.js';
import { asyncHandler } from '../lib/http.js';

export type UserRole = 'USER' | 'ADMIN';

export interface AuthUser {
  id: number;
  email: string;
  displayName: string;
  role: UserRole;
  linkedGuid: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export function toAuthUser(user: {
  id: number;
  email: string;
  displayName: string;
  role?: string;
  accountLinks?: Array<{ guid: string }>;
}): AuthUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role === 'ADMIN' ? 'ADMIN' : 'USER',
    // Legacy (1 GUID): primer vínculo para compatibilidad con el launcher actual.
    linkedGuid: user.accountLinks?.[0]?.guid ?? null,
  };
}

/** Middleware que exige un JWT Bearer válido y adjunta req.user (con rol fresco de la DB). */
export const requireAuth = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw Errors.unauthorized('Falta el header Authorization: Bearer <token>.');
  }
  const payload = verifyToken(header.slice('Bearer '.length).trim());
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    include: { accountLinks: { select: { guid: true }, orderBy: [{ id: 'asc' }] } },
  });
  if (!user) throw Errors.userNotFound();
  req.user = toAuthUser(user);
  next();
});

/** Middleware que exige rol ADMIN (siempre después de requireAuth). */
export const requireAdmin = asyncHandler(async (req, _res, next) => {
  if (req.user?.role !== 'ADMIN') {
    throw Errors.forbidden('Esta operación requiere una cuenta ADMIN.');
  }
  next();
});
