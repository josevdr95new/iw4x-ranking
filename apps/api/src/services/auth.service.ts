import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { Errors } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { signToken } from '../lib/jwt.js';
import type { LoginInput, RegisterInput } from '../dto/auth.dto.js';

type UserWithLink = Prisma.UserGetPayload<{ include: { link: { select: { guid: true } } } }>;

export interface PublicUser {
  id: number;
  email: string;
  displayName: string;
  createdAt: string;
  linkedGuid: string | null;
}

export interface AuthResult {
  user: PublicUser;
  token: string;
}

export function toPublicUser(user: UserWithLink): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt.toISOString(),
    linkedGuid: user.link?.guid ?? null,
  };
}

export async function registerUser(input: RegisterInput): Promise<AuthResult> {
  const passwordHash = await hashPassword(input.password);
  try {
    const user = await prisma.user.create({
      data: { email: input.email, passwordHash, displayName: input.displayName },
      include: { link: { select: { guid: true } } },
    });
    return { user: toPublicUser(user), token: signToken({ sub: user.id }) };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw Errors.emailTaken();
    }
    throw err;
  }
}

export async function loginUser(input: LoginInput): Promise<AuthResult> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    include: { link: { select: { guid: true } } },
  });
  if (!user) throw Errors.invalidCredentials();
  const passwordOk = await verifyPassword(input.password, user.passwordHash);
  if (!passwordOk) throw Errors.invalidCredentials();
  return { user: toPublicUser(user), token: signToken({ sub: user.id }) };
}

export async function getUserPublic(userId: number): Promise<PublicUser> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { link: { select: { guid: true } } },
  });
  if (!user) throw Errors.userNotFound();
  return toPublicUser(user);
}
