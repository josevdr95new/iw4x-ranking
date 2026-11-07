const { PrismaClient } = require('@prisma/client');
const path = require('node:path');
const p = new PrismaClient({ datasources: { db: { url: 'file:' + path.resolve('C:/Users/josev/Documents/GitHub/iw4x-ranking/apps/api/prisma/dev.db').replace(/\\/g, '/') } } });
(async () => {
  const states = await p.logIngestState.findMany();
  for (const s of states) console.log('ingestState', s.source, 'offset', s.byteOffset.toString(), 'parsed', s.linesParsed, 'ignored', s.linesIgnored, s.lastRunAt && s.lastRunAt.toISOString());
  const runs = await p.syncRun.findMany({ orderBy: { id: 'desc' }, take: 3 });
  for (const r of runs) console.log('run', r.id, 'ok', r.ok, 'players', r.playersSynced, 'events', r.killEventsSynced, r.warnings);
  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
