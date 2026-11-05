import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../lib/jwt.js';
import { Errors } from '../lib/errors.js';
import { asyncHandler } from '../lib/http.js';

export interface AuthUser {
  id: number;
  email: string;
  displayName: string;
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
  link?: { guid: string } | null;
}): AuthUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    linkedGuid: user.link?.guid ?? null,
  };
}

/** Middleware que exige un JWT Bearer válido y adjunta req.user. */
export const requireAuth = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw Errors.unauthorized('Falta el header Authorization: Bearer <token>.');
  }
  const payload = verifyToken(header.slice('Bearer '.length).trim());
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    include: { link: { select: { guid: true } } },
  });
  if (!user) throw Errors.userNotFound();
  req.user = toAuthUser(user);
  next();
});
