import { createApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { startSyncScheduler, stopSyncScheduler } from './scheduler.js';

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
