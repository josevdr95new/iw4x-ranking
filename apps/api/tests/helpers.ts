import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

export const app = createApp();

export function req(): request.Test {
  return request(app);
}

/** Borra todas las filas respetando las FKs. */
export async function resetDb(): Promise<void> {
  await prisma.killEvent.deleteMany();
  await prisma.session.deleteMany();
  await prisma.accountLink.deleteMany();
  await prisma.linkAttempt.deleteMany();
  await prisma.player.deleteMany();
  await prisma.syncRun.deleteMany();
  await prisma.syncState.deleteMany();
  await prisma.logIngestState.deleteMany();
  await prisma.user.deleteMany();
}

export interface TestUser {
  id: number;
  token: string;
}

export async function registerUser(
  email: string,
  password = 'supersecret123',
  displayName = 'Tester',
): Promise<TestUser> {
  const res = await req()
    .post('/api/auth/register')
    .send({ email, password, displayName });
  if (res.status !== 201) {
    throw new Error(`register falló (${res.status}): ${JSON.stringify(res.body)}`);
  }
  const body = res.body as { token: string; user: { id: number } };
  return { id: body.user.id, token: body.token };
}
