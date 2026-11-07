// CLI: RECOMPUTE FROM SCRATCH del skill ELO.
// Desmarca TODOS los KillEvent (skillProcessed=false), reinicia el ELO base de
// TODOS los players a "no procesado" y vuelve a procesar todo el histórico en
// orden cronológico (timeEpoch ASC, id ASC). Determinista: mismo set de eventos
// → mismo skill. Útil tras un reset de DB o para recalibrar el modelo.
//
// Uso: npm run recompute:skill  (desde la raíz del monorepo)
import { prisma } from '../lib/prisma.js';
import { processSkillUpdates } from '../services/skill/skill.service.js';
import { SKILL } from '../services/skill/elo.js';

const events = await prisma.killEvent.updateMany({ where: { skillProcessed: true }, data: { skillProcessed: false } });
const players = await prisma.player.updateMany({ data: { skillElo: 0 } });
console.log(`[recompute:skill] eventos marcados para reproceso: ${events.count}; players reiniciados (skillElo=0): ${players.count}`);

const result = await processSkillUpdates();
console.log(`[recompute:skill] eventos procesados: ${result.processed} en ${result.batches} lote(s); players inicializados a ${SKILL.START}: ${result.initialized}`);
const top = await prisma.player.findMany({ orderBy: [{ skill: 'desc' }, { name: 'asc' }], take: 10, select: { name: true, skill: true, skillElo: true } });
console.table(top);
await prisma.$disconnect();
