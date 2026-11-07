// CLI: Bootstrap IDEMPOTENTE del modelo de IDENTIDAD (nicks reservados + alertas).
// Pipeline en orden correcto (todo idempotente: re-ejecutar no infla ni duplica):
//   1. normalizeDisplayNames() → User.displayNameNormalized (nick reservado,
//      cleanName lower). Si hay colisiones históricas, a la cuenta más nueva se
//      le asigna sufijo "-2"/"-3"... (reportado; el displayName visible no cambia).
//   2. rebuildAliases() → PlayerAlias + Player.isBot (re-escaneo de Player y del
//      games_mp.log crudo; ver npm run rebuild:aliases).
//   3. seedIdentityAlerts() → IdentityAlert históricas: guid NO vinculado al
//      dueño usando su nick reservado (no-bots), mismas reglas que la ingesta.
//
// Uso: npm run rebuild:identity  (desde la raíz del monorepo)
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { rebuildIdentity } from '../services/identity.service.js';

const { normalize, aliases, alerts } = await rebuildIdentity(env.gameLogPath ?? null);

console.log(`[rebuild:identity] nicks normalizados: ${normalize.normalizedSet}/${normalize.usersScanned} users`);
for (const rename of normalize.renames) {
  console.log(`[rebuild:identity]   COLISIÓN resuelta: ${rename.email} "${rename.from}" → reservado como "${rename.to}"`);
}
console.log(`[rebuild:identity] alias: ${aliases.aliasesFromPlayers} de players + ${aliases.aliasesFromLog} históricos del log (total escaneados: ${aliases.playersScanned})`);
console.log(`[rebuild:identity] alertas de identidad: ${alerts.alertsCreated} creadas, ${alerts.alertsUpdated} actualizadas (filas de alias escaneadas: ${alerts.aliasRowsScanned})`);

const open = await prisma.identityAlert.count({ where: { status: 'OPEN' } });
const bots = await prisma.player.count({ where: { isBot: true } });
console.log(`[rebuild:identity] estado: ${open} alertas OPEN; ${bots} players marcados isBot`);
await prisma.$disconnect();
