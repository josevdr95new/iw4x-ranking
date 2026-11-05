import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { Errors } from './errors.js';

export interface TokenPayload {
  sub: number;
}

const ISSUER = 'iw4x-ranking';

export function signToken(payload: TokenPayload): string {
  const options: jwt.SignOptions = {
    issuer: ISSUER,
    expiresIn: env.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  };
  return jwt.sign({ sub: payload.sub }, env.jwtSecret, options);
}

export function verifyToken(token: string): TokenPayload {
  let decoded: string | jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, env.jwtSecret, { issuer: ISSUER });
  } catch {
    throw Errors.unauthorized('Token inválido o expirado.');
  }
  if (typeof decoded === 'object' && decoded !== null && 'sub' in decoded) {
    const sub = Number((decoded as { sub: unknown }).sub);
    if (Number.isInteger(sub) && sub > 0) {
      return { sub };
    }
  }
  throw Errors.unauthorized('Token inválido o expirado.');
}
