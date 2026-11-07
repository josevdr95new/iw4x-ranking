import { createApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { runStartupSeed } from './services/seed.service.js';
import { startSyncScheduler, stopSyncScheduler } from './scheduler.js';

// Primera instalación: si la tabla User está vacía, crea el admin por defecto
// (nick "admin" / admin123) ANTES de escuchar. Idempotente y con guards
// (NODE_ENV=test / SEED_DEFAULT_ADMIN=false). Nunca tumba el server.
await runStartupSeed();

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(`[api] IW4x Ranking escuchando en http://localhost:${env.port} (env=${env.nodeEnv})`);
  console.log(`[api] CORS permitido para: ${env.corsOrigins.join(', ')}`);
  console.log(`[api] IW4MAdmin DB: ${env.iw4madminDbPath ?? '(no configurada — sync manual devolverá 503)'}`);
});

const scheduler = startSyncScheduler();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[api] recibido ${signal}; cerrando...`);
  stopSyncScheduler(scheduler);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
