// CLI: CLEANUP DE BOTS (decisión del dueño, 2026-11-11): los bots DEJAN DE
// EXISTIR como jugadores en la DB. Borra TODA fila Player con isBot=true
// (rango dedicado 0xb07…) y TODO lo dependiente (PlayerAlias, Session,
// AccountLink defensivo, IdentityAlert defensiva, MatchBonusEvent defensivo —
// los bots nunca calificaron al bonus). Idempotente: re-ejecutar borra 0.
//
// ⚠️ LO QUE SE CONSERVA (intencional): los KillEvent con guids de bot SE
// QUEDAN — son las kills/muertes de HUMANOS contra bots y alimentan el kill
// counter, el ELO decayado, el feed y las medallas de los humanos. Antes de
// borrar las filas de bot, el script BACKFILLA las columnas denormalizadas
// KillEvent.originName/targetName (añadidas 2026-11-11) con el nombre del
// Player del bot: sin eso, el histórico del feed perdería el nombre del bot
// ("mataste a Lunarion") al borrar su fila.
//
// BACKUP: antes de borrar crea <prismaDir>/backups/<db>.pre-bots-<timestamp>
// vía `VACUUM INTO` (snapshot consistente aunque la DB esté abierta por la
// API; fallback: copia de archivo con -wal/-shm). Restaura copiando el backup
// sobre la DB original.
//
// Uso:  npm run cleanup:bots          (backup + borra)
//       npm run cleanup:bots -- --dry (solo imprime contadores; no borra nada)
//
// Uso en producción (LXC): correr DESPUÉS del deploy del código nuevo (la
// ingesta ya no crea bots) y del `prisma db push` (columnas de nombres).
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { prisma } from '../src/lib/prisma.js';
import { env, paths } from '../src/config/env.js';
import { isBotGuid } from '../src/services/alias.service.js';

const DRY = process.argv.includes('--dry');

/** Resuelve el archivo SQLite desde DATABASE_URL ("file:./dev.db" → prisma/dev.db). */
function resolveDbFile(): string {
  const raw = env.databaseUrl.replace(/^file:/, '').split('?')[0] ?? '';
  if (raw === '') throw new Error('DATABASE_URL vacía: no se puede localizar el archivo SQLite.');
  // Prisma resuelve rutas relativas de SQLite contra la ubicación del schema (prisma/).
  return resolve(paths.apiRoot, 'prisma', raw);
}

/** Backup consistente: VACUUM INTO (snapshot aunque haya otro proceso escribiendo). */
async function backupDatabase(dbFile: string, backupDir: string, stamp: string): Promise<string> {
  mkdirSync(backupDir, { recursive: true });
  const backupPath = resolve(backupDir, `${basename(dbFile)}.pre-bots-${stamp}`);
  try {
    // Escapa comillas simples para el literal SQL.
    await prisma.$executeRawUnsafe(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    return backupPath;
  } catch (err) {
    // Fallback: copia directa de archivo (incluye -wal/-shm si existen).
    console.warn(`[cleanup:bots] VACUUM INTO falló (${err instanceof Error ? err.message : String(err)}); copiando archivo...`);
    copyFileSync(dbFile, backupPath);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(dbFile + suffix)) copyFileSync(dbFile + suffix, backupPath + suffix);
    }
    return backupPath;
  }
}

async function main(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  // ── Contadores ANTES ──────────────────────────────────────────────────────
  const bots = await prisma.player.findMany({
    where: { isBot: true },
    select: { guid: true, name: true },
  });
  const botGuids = bots.map((bot) => bot.guid);
  // Defensa: guids del rango 0xb07… sin flag (isBot mal seteado por DB vieja).
  const allPlayers = await prisma.player.findMany({ select: { guid: true, name: true, isBot: true } });
  const unflaggedBots = allPlayers.filter((p) => !p.isBot && isBotGuid(p.guid));
  const deleteGuids = [...new Set([...botGuids, ...unflaggedBots.map((p) => p.guid)])];

  const aliasesCount = deleteGuids.length
    ? await prisma.playerAlias.count({ where: { guid: { in: deleteGuids } } })
    : 0;
  const sessionsCount = deleteGuids.length
    ? await prisma.session.count({ where: { guid: { in: deleteGuids } } })
    : 0;
  const linksCount = deleteGuids.length
    ? await prisma.accountLink.count({ where: { guid: { in: deleteGuids } } })
    : 0;
  const alertsCount = deleteGuids.length
    ? await prisma.identityAlert.count({ where: { guid: { in: deleteGuids } } })
    : 0;
  const bonusesCount = deleteGuids.length
    ? await prisma.matchBonusEvent.count({ where: { guid: { in: deleteGuids } } })
    : 0;
  const botEvents = deleteGuids.length
    ? await prisma.killEvent.count({
        where: { OR: [{ originGuid: { in: deleteGuids } }, { targetGuid: { in: deleteGuids } }] },
      })
    : 0;

  console.log('[cleanup:bots] estado ANTES:');
  console.log(`  Player isBot=true ............ ${botGuids.length}`);
  console.log(`  Player rango b07 sin flag .... ${unflaggedBots.length} (defensa: se incluyen)`);
  console.log(`  PlayerAlias de bots .......... ${aliasesCount}`);
  console.log(`  Session de bots .............. ${sessionsCount}`);
  console.log(`  AccountLink de bots .......... ${linksCount} (debería ser 0: nunca linkeable)`);
  console.log(`  IdentityAlert de bots ........ ${alertsCount} (debería ser 0: ingesta las excluye)`);
  console.log(`  MatchBonusEvent de bots ...... ${bonusesCount} (debería ser 0: tally excluye bots)`);
  console.log(`  KillEvent con guids de bot ... ${botEvents} (SE CONSERVAN: son kills de humanos)`);

  if (deleteGuids.length === 0) {
    console.log('[cleanup:bots] no hay bots en la DB: nada que hacer.');
    return;
  }
  if (DRY) {
    console.log('[cleanup:bots] --dry: no se borró ni modificó nada.');
    return;
  }

  // ── Backup ────────────────────────────────────────────────────────────────
  const dbFile = resolveDbFile();
  const backupPath = await backupDatabase(dbFile, resolve(paths.apiRoot, 'prisma', 'backups'), stamp);
  console.log(`[cleanup:bots] backup: ${backupPath}`);

  // ── Backfill de nombres denormalizados (ANTES de borrar los Players) ─────
  // Los eventos históricos (previos a las columnas originName/targetName)
  // quedan con null → el feed no sabría el nombre del bot. Con el nombre del
  // Player del bot aún vivo, se rellena aquí.
  let backfilled = 0;
  for (const bot of bots) {
    const targetRes = await prisma.killEvent.updateMany({
      where: { targetGuid: bot.guid, targetName: null },
      data: { targetName: bot.name },
    });
    const originRes = await prisma.killEvent.updateMany({
      where: { originGuid: bot.guid, originName: null },
      data: { originName: bot.name },
    });
    backfilled += targetRes.count + originRes.count;
  }
  console.log(`[cleanup:bots] backfill KillEvent.originName/targetName: ${backfilled} celdas rellenadas con el nombre del bot`);

  // ── Borrado (orden seguro de FKs) ─────────────────────────────────────────
  const delAliases = await prisma.playerAlias.deleteMany({ where: { guid: { in: deleteGuids } } });
  const delSessions = await prisma.session.deleteMany({ where: { guid: { in: deleteGuids } } });
  const delLinks = await prisma.accountLink.deleteMany({ where: { guid: { in: deleteGuids } } });
  const delAlerts = await prisma.identityAlert.deleteMany({ where: { guid: { in: deleteGuids } } });
  const delBonuses = await prisma.matchBonusEvent.deleteMany({ where: { guid: { in: deleteGuids } } });
  const delPlayers = await prisma.player.deleteMany({ where: { guid: { in: deleteGuids } } });

  console.log('[cleanup:bots] borrado:');
  console.log(`  PlayerAlias ................. ${delAliases.count}`);
  console.log(`  Session ..................... ${delSessions.count}`);
  console.log(`  AccountLink ................. ${delLinks.count}`);
  console.log(`  IdentityAlert ............... ${delAlerts.count}`);
  console.log(`  MatchBonusEvent ............. ${delBonuses.count}`);
  console.log(`  Player (isBot/rango b07) .... ${delPlayers.count}`);

  // ── Contadores DESPUÉS ────────────────────────────────────────────────────
  const playersAfter = await prisma.player.count();
  const botsAfter = await prisma.player.count({ where: { isBot: true } });
  const eventsAfter = await prisma.killEvent.count();
  console.log('[cleanup:bots] estado DESPUÉS:');
  console.log(`  Player totales .............. ${playersAfter}`);
  console.log(`  Player isBot=true ........... ${botsAfter} (debe ser 0)`);
  console.log(`  KillEvent totales ........... ${eventsAfter} (intactos: kills de humanos)`);

  console.log('[cleanup:bots] OK. Los bots ya no existen como jugadores; sus kills contra humanos permanecen.');
}

main()
  .catch((err) => {
    console.error('[cleanup:bots] FALLO:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
