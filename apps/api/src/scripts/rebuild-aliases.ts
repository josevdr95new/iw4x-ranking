// CLI: Bootstrap IDEMPOTENTE del historial de alias (PlayerAlias) + flag isBot
// para datos ya existentes. Ver docs/API.md ("Anti-confusión de identidades").
//
// MÉTODO: ni KillEvent ni Session guardan nombres (solo guids), así que el
// bootstrap combina DOS fuentes:
//   A. Player.name (nombre actual de cada guid) → siembra el alias actual
//      con occurrences ≈ connections y fechas first/lastConnection. Además fija
//      Player.isBot según el rango de guids de bots (0xb07…).
//   B. Re-escaneo del games_mp.log CRUDO desde el byte 0 (si GAME_LOG_PATH
//      existe y es accesible) → recuenta J/K y descubre nombres HISTÓRICOS
//      (renombres) que ya no son el nombre actual del guid.
// Todas las escrituras son monótonas (max/min, set absoluto): re-ejecutar el
// script NO infla occurrences ni regresa fechas (idempotente).
// Para el bootstrap de identidad (nicks reservados + alertas): npm run rebuild:identity.
//
// Uso: npm run rebuild:aliases  (desde la raíz del monorepo)
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { rebuildAliases } from '../services/alias.service.js';

const result = await rebuildAliases({ logPath: env.gameLogPath ?? null });
console.log(`[rebuild:aliases] players escaneados (pasada A, nombre actual): ${result.playersScanned}`);
console.log(`[rebuild:aliases] alias sembrados/normalizados desde Player: ${result.aliasesFromPlayers}`);
if (result.logScanned) {
  console.log(`[rebuild:aliases] log re-escaneado desde byte 0: ${result.logLinesParsed} líneas de evento`);
  console.log(`[rebuild:aliases] pares (guid, name) distintos en el log: ${result.logAliasPairs}`);
  console.log(`[rebuild:aliases] alias históricos NUEVOS descubiertos por el log: ${result.aliasesFromLog}`);
} else {
  console.log('[rebuild:aliases] GAME_LOG_PATH no configurado o inaccesible: solo pasada A (nombres actuales)');
}
const total = await prisma.playerAlias.count();
const conMultiAlias = await prisma.playerAlias.groupBy({ by: ['guid'], _count: { _all: true } });
console.log(`[rebuild:aliases] PlayerAlias total en DB: ${total} (guids con alias: ${conMultiAlias.length})`);
await prisma.$disconnect();
