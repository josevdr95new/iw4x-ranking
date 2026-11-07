// CLI: RECUENTO COMPLETO del histórico desde el games_mp.log con el parser
// vigente. Úsalo cuando cambie la semántica del parser (ej. fix víctima-primero
// de esta build de IW4x) o cuando los agregados de Player queden inconsistentes
// con los KillEvent: borra los derivados del log y RE-INGESTA el archivo entero
// desde el byte 0, recalculando skill ELO y headshots desde cero.
//
// ⚠️ EJECUTAR IDEALMENTE CON EL SERVER VACÍO: mientras corre, el scheduler del
// dev:api puede ingestar líneas nuevas en paralelo. El script mitiga la carrera
// con (a) wipe+rewind ATÓMICO en una transacción, (b) re-ingesta en bucle hasta
// EOF estable, y (c) VERIFICACIÓN agregada (KillEvent vs counters de Player)
// con reintento automático si detecta doble conteo por un tick concurrente del
// scheduler. Aun así, el orden seguro es: server apagado → recount → arrancar.
//
// QUÉ BORRA (solo derivados del log): KillEvent, Session, PlayerAlias, Player
// SIN cuenta web vinculada, y counters de los Player VINCULADOS (la fila se
// conserva por la FK de AccountLink; la re-ingesta la re-puebla).
// QUÉ NUNCA TOCA: User, Penalty, IdentityAlert, AccountLink, cloud-saves
// (storage/profiles) y SyncRun (auditoría).
//
// Copia de seguridad: ANTES del wipe crea <prismaDir>/backups/dev.db.recount-<timestamp>
// vía `VACUUM INTO` (snapshot consistente aunque la DB esté abierta por la API;
// fallback: copia de archivo). Restaura copiando el backup sobre dev.db.
//
// Uso:  npm run recount:stats          (recuento real)
//       npm run recount:stats -- --dry (no borra nada; solo imprime el plan)
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, paths } from '../src/config/env.js';
import { prisma } from '../src/lib/prisma.js';
import { HEADSHOT_HITLOCS, ingestGameLog, parseGameLogLine } from '../src/services/sync/gamelog.reader.js';
import { processSkillUpdates } from '../src/services/skill/skill.service.js';

export interface RecountStatsOptions {
  /** Ruta del games_mp.log. Default: env.gameLogPath. */
  logPath?: string | null;
  /** Etiqueta de server para la ingesta. Default: env.gameServerAddress ?? null. */
  server?: string | null;
  /** --dry: NO borra ni escribe nada; solo imprime lo que haría. */
  dry?: boolean;
  /** Dir destino del backup. Default: <apps/api>/prisma/backups. */
  backupDir?: string;
}

export interface RecountPlayerRow {
  guid: string;
  name: string;
  kills: number;
  deaths: number;
  headshots: number;
  teamkills: number;
  connections: number;
  isBot: boolean;
  linked: boolean;
}

/** Verdad esperada por guid, derivada de parsear el propio log. */
interface LogTruth {
  kills: Map<string, number>;
  deaths: Map<string, number>;
  headshots: Map<string, number>;
  teamkills: Map<string, number>;
  damageDealt: Map<string, number>;
  damageTaken: Map<string, number>;
}

export interface RecountStatsResult {
  ok: boolean;
  dry: boolean;
  logPath: string | null;
  logExists: boolean;
  logBytes: number;
  backupPath: string | null;
  killEventsDeleted: number;
  sessionsDeleted: number;
  aliasesDeleted: number;
  playersDeleted: number;
  playersKeptLinked: number;
  cursorsRewound: number;
  ingestPasses: number;
  killEventsReingested: number;
  playersReingested: number;
  eventsForSkill: number;
  verified: boolean;
  attempts: number;
  finalOffset: string;
  eof: boolean;
  warnings: string[];
  players: RecountPlayerRow[];
}

const MAX_ATTEMPTS = 5; // reintentos si la verificación detecta desvíos (ticks concurrentes del scheduler)
const MAX_INGEST_PASSES = 50; // guard anti-bucle (el server puede escribir sin parar)

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
  const backupPath = resolve(backupDir, `${basename(dbFile)}.recount-${stamp}`);
  try {
    // Escapa comillas simples para el literal SQL.
    await prisma.$executeRawUnsafe(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    return backupPath;
  } catch (err) {
    // Fallback: copia directa de archivo (incluye -wal/-shm si existen).
    console.warn(`[recount:stats] VACUUM INTO falló (${err instanceof Error ? err.message : String(err)}); copiando archivo...`);
    copyFileSync(dbFile, backupPath);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(dbFile + suffix)) copyFileSync(dbFile + suffix, backupPath + suffix);
    }
    return backupPath;
  }
}

/**
 * VERDAD ABSOLUTA desde el log: parsea los primeros `bytesCovered` bytes del
 * archivo con el parser vigente y agrega lo que la DB DEBERÍA contener para
 * cada guid. Incluye world/suicidio (muertes sin evento) y las líneas D (daño
 * sin evento), que el agregado de KillEvent NO puede explicar.
 * Con esto la verificación es absoluta: cualquier doble conteo (tick del
 * scheduler ingestando en paralelo) o fila fantasma se detecta como desajuste.
 */
async function truthFromLog(logPath: string, bytesCovered: number): Promise<LogTruth> {
  const truth: LogTruth = {
    kills: new Map(), deaths: new Map(), headshots: new Map(), teamkills: new Map(),
    damageDealt: new Map(), damageTaken: new Map(),
  };
  const bump = (map: Map<string, number>, guid: string, n: number): void => map.set(guid, (map.get(guid) ?? 0) + n);
  const handle = await open(logPath, 'r');
  try {
    const buffer = Buffer.alloc(bytesCovered);
    const { bytesRead } = await handle.read(buffer, 0, bytesCovered, 0);
    const text = buffer.toString('utf8', 0, bytesRead);
    for (const line of text.split('\n')) {
      let event: ReturnType<typeof parseGameLogLine> = null;
      try {
        event = parseGameLogLine(line);
      } catch {
        continue;
      }
      if (!event || event === 'ignored') continue;
      if (event.kind === 'kill') {
        if (event.killerGuid !== null && event.killerGuid !== event.victimGuid) {
          bump(truth.kills, event.killerGuid, 1);
          bump(truth.damageDealt, event.killerGuid, event.damage);
          if (event.hitloc !== null && HEADSHOT_HITLOCS.has(event.hitloc.toLowerCase())) {
            bump(truth.headshots, event.killerGuid, 1);
          }
          if (event.isTeamkill) bump(truth.teamkills, event.killerGuid, 1);
        }
        // La víctima siempre suma death (world/suicidio incluidos: sin evento en DB).
        bump(truth.deaths, event.victimGuid, 1);
        bump(truth.damageTaken, event.victimGuid, event.damage);
      } else if (event.kind === 'damage') {
        if (event.dealerGuid !== null && event.dealerGuid !== event.receiverGuid) {
          bump(truth.damageDealt, event.dealerGuid, event.damage);
        }
        bump(truth.damageTaken, event.receiverGuid, event.damage);
      }
    }
    return truth;
  } finally {
    await handle.close();
  }
}

/** Compara counters de Player contra la verdad del log (detecta doble conteo/filas fantasma). */
async function verifyAgainstLog(logPath: string, bytesCovered: number): Promise<{ ok: boolean; mismatches: string[] }> {
  const truth = await truthFromLog(logPath, bytesCovered);
  const players = await prisma.player.findMany({
    select: { guid: true, name: true, kills: true, deaths: true, headshots: true, teamkills: true, damageDealt: true, damageTaken: true },
  });
  const mismatches: string[] = [];
  const expected = (map: Map<string, number>, guid: string): number => map.get(guid) ?? 0;
  for (const player of players) {
    const exp = {
      kills: expected(truth.kills, player.guid),
      deaths: expected(truth.deaths, player.guid),
      headshots: expected(truth.headshots, player.guid),
      teamkills: expected(truth.teamkills, player.guid),
      damageDealt: expected(truth.damageDealt, player.guid),
      damageTaken: expected(truth.damageTaken, player.guid),
    };
    if (
      player.kills !== exp.kills ||
      player.deaths !== exp.deaths ||
      player.headshots !== exp.headshots ||
      player.teamkills !== exp.teamkills ||
      player.damageDealt !== exp.damageDealt ||
      player.damageTaken !== exp.damageTaken
    ) {
      mismatches.push(
        `${player.name} (${player.guid}): player k=${player.kills}/d=${player.deaths}/hs=${player.headshots}/tk=${player.teamkills}/dd=${player.damageDealt}/dt=${player.damageTaken} vs log k=${exp.kills}/d=${exp.deaths}/hs=${exp.headshots}/tk=${exp.teamkills}/dd=${exp.damageDealt}/dt=${exp.damageTaken}`,
      );
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** Recolecta la tabla resumen de players tras el recuento. */
async function collectPlayers(): Promise<RecountPlayerRow[]> {
  const players = await prisma.player.findMany({
    select: { guid: true, name: true, kills: true, deaths: true, headshots: true, teamkills: true, connections: true, isBot: true, accountLinks: { select: { guid: true } } },
    orderBy: [{ kills: 'desc' }, { name: 'asc' }],
  });
  return players.map((p) => ({
    guid: p.guid,
    name: p.name,
    kills: p.kills,
    deaths: p.deaths,
    headshots: p.headshots,
    teamkills: p.teamkills,
    connections: p.connections,
    isBot: p.isBot,
    linked: p.accountLinks.length > 0,
  }));
}

/**
 * Recuento completo: backup → wipe+rewind atómico → re-ingesta hasta EOF →
 * skill ELO from scratch → verificación con reintento. Con dry=true solo
 * reporta el plan y NO escribe nada.
 */
export async function recountStats(options: RecountStatsOptions = {}): Promise<RecountStatsResult> {
  const logPath = options.logPath ?? env.gameLogPath ?? null;
  const server = options.server !== undefined ? options.server : (env.gameServerAddress ?? null);
  const dry = options.dry ?? false;
  const backupDir = options.backupDir ?? resolve(paths.apiRoot, 'prisma', 'backups');

  const result: RecountStatsResult = {
    ok: false,
    dry,
    logPath,
    logExists: false,
    logBytes: 0,
    backupPath: null,
    killEventsDeleted: 0,
    sessionsDeleted: 0,
    aliasesDeleted: 0,
    playersDeleted: 0,
    playersKeptLinked: 0,
    cursorsRewound: 0,
    ingestPasses: 0,
    killEventsReingested: 0,
    playersReingested: 0,
    eventsForSkill: 0,
    verified: false,
    attempts: 0,
    finalOffset: '0',
    eof: false,
    warnings: [],
    players: [],
  };

  if (!logPath) {
    result.warnings.push('GAME_LOG_PATH no configurado: nada que recountear.');
    return result;
  }
  if (!existsSync(logPath)) {
    result.warnings.push(`el log no existe: ${logPath}`);
    return result;
  }
  result.logExists = true;
  result.logBytes = statSync(logPath).size;

  const sourceKey = `gamelog:${logPath}`;

  // ── DRY: solo el plan ────────────────────────────────────────────────
  if (dry) {
    const [killEvents, sessions, aliases, playersTotal, playersLinked, cursors] = await Promise.all([
      prisma.killEvent.count(),
      prisma.session.count(),
      prisma.playerAlias.count(),
      prisma.player.count(),
      prisma.player.count({ where: { accountLinks: { some: {} } } }),
      prisma.logIngestState.findMany({ where: { source: sourceKey } }),
    ]);
    result.killEventsDeleted = killEvents;
    result.sessionsDeleted = sessions;
    result.aliasesDeleted = aliases;
    result.playersDeleted = playersTotal - playersLinked;
    result.playersKeptLinked = playersLinked;
    result.cursorsRewound = cursors.length;
    result.eof = cursors.length === 0 || cursors.every((c) => c.byteOffset >= BigInt(result.logBytes));
    result.finalOffset = cursors[0]?.byteOffset?.toString() ?? '0';
    result.verified = false; // en seco no hay verificación post-wipe
    result.ok = true;
    return result;
  }

  const dbFile = resolveDbFile();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    result.attempts = attempt;

    // ── 1. Backup (solo en el primer intento) ────────────────────────
    if (attempt === 1) {
      result.backupPath = await backupDatabase(dbFile, backupDir, stamp);
      console.log(`[recount:stats] backup: ${result.backupPath}`);
    } else {
      result.warnings.push(`intento ${attempt}: verificación falló en el intento ${attempt - 1} (posible tick concurrente del scheduler); repitiendo wipe+reingesta.`);
    }

    // ── 2. Wipe + rewind ATÓMICO (una transacción) ───────────────────
    await prisma.$transaction(async (tx) => {
      result.killEventsDeleted = (await tx.killEvent.deleteMany()).count;
      result.sessionsDeleted = (await tx.session.deleteMany()).count;
      result.aliasesDeleted = (await tx.playerAlias.deleteMany()).count;
      // Players SIN cuenta web vinculada: fuera (la re-ingesta los recrea).
      result.playersDeleted = (await tx.player.deleteMany({ where: { accountLinks: { none: {} } } })).count;
      // Players VINCULADOS: la fila queda (FK de AccountLink) pero con counters a 0.
      const reset = await tx.player.updateMany({
        data: {
          kills: 0, deaths: 0, kd: 0, headshots: 0, damageDealt: 0, damageTaken: 0,
          bestStreak: 0, teamkills: 0, matchesPlayed: 0, timePlayed: 0, connections: 0,
          skillElo: 0, skill: 0,
        },
      });
      result.playersKeptLinked = reset.count;
      // REWIND del cursor del gamelog al byte 0 (telemetría y estado InitGame a 0/null).
      result.cursorsRewound = (await tx.logIngestState.updateMany({
        where: { source: sourceKey },
        data: { byteOffset: 0, linesParsed: 0, linesIgnored: 0, currentMap: null, currentGametype: null, lastRunAt: null },
      })).count;
    });
    console.log(`[recount:stats] wipe: ${result.killEventsDeleted} killEvents, ${result.sessionsDeleted} sessions, ${result.aliasesDeleted} aliases, ${result.playersDeleted} players (quedan ${result.playersKeptLinked} vinculados con counters a 0); cursor rewireado: ${result.cursorsRewound}`);

    // ── 3. Re-ingesta inmediata hasta EOF estable ────────────────────
    result.killEventsReingested = 0;
    result.playersReingested = 0;
    result.ingestPasses = 0;
    let stablePasses = 0;
    let lastOffset = 0n;
    for (;;) {
      const ingest = await ingestGameLog(logPath, server);
      result.ingestPasses += 1;
      result.killEventsReingested += ingest.killEventsSynced;
      result.playersReingested += ingest.playersSynced;
      if (ingest.warnings.length > 0) result.warnings.push(...ingest.warnings);
      lastOffset = ingest.newOffset;
      const size = statSync(logPath).size;
      const atEof = ingest.newOffset >= BigInt(size);
      result.eof = atEof;
      // Estable: nada nuevo por ingestar Y cursor al EOF (dos pasadas seguidas).
      if (ingest.killEventsSynced === 0 && ingest.playersSynced === 0 && atEof) {
        stablePasses += 1;
        if (stablePasses >= 2) break;
      } else {
        stablePasses = 0;
      }
      if (result.ingestPasses >= MAX_INGEST_PASSES) {
        result.warnings.push(`límite de ${MAX_INGEST_PASSES} pasadas de ingesta alcanzado (el server sigue escribiendo); se continúa con el cursor en ${lastOffset}.`);
        break;
      }
    }
    result.finalOffset = lastOffset.toString();
    console.log(`[recount:stats] re-ingesta: ${result.ingestPasses} pasada(s), ${result.playersReingested} player-upserts, ${result.killEventsReingested} killEvents, cursor=${result.finalOffset} (eof=${result.eof})`);

    // ── 4. Skill ELO from scratch: tras el wipe TODOS los KillEvent están
    //      sin marcar (skillProcessed=false) → processSkillUpdates procesa el
    //      histórico completo en orden cronológico (equivale a recompute:skill).
    const skill = await processSkillUpdates();
    result.eventsForSkill = skill.processed;
    console.log(`[recount:skill] ${skill.processed} eventos procesados en ${skill.batches} lote(s); inicializados a 1000: ${skill.initialized}`);

    // ── 5. Verificación contra la VERDAD DEL LOG (bytes [0, lastOffset)):
    //      counters de Player vs lo que el parser vigente dice que debería haber.
    const verification = await verifyAgainstLog(logPath, Number(lastOffset));
    if (verification.ok) {
      result.verified = true;
      result.ok = result.eof;
      break;
    }
    result.warnings.push(...verification.mismatches.map((m) => `desajuste: ${m}`));
    if (attempt === MAX_ATTEMPTS) {
      result.ok = false;
      result.warnings.push(`verificación NO superó tras ${MAX_ATTEMPTS} intentos; revisar los desajustes (posible ingesta concurrente durante todo el proceso). Ejecutar de nuevo con el server vacío.`);
    }
  }

  result.players = await collectPlayers();
  return result;
}

// ── CLI (solo cuando se ejecuta directamente: npm run recount:stats) ────────
const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const dry = process.argv.includes('--dry');
  void (async () => {
    console.log(dry ? '[recount:stats] MODO DRY: no se borrará ni escribirá nada.' : '[recount:stats] RECUENTO REAL: se borrará y re-ingestará el histórico (backup previo).');
    console.log('[recount:stats] Recomendado ejecutarlo con el server idealmente vacío (el scheduler del dev:api puede ingestar en paralelo; el script verifica y reintenta igualmente).');
    const result = await recountStats({ dry });
    console.log(`[recount:stats] ok=${result.ok} dry=${result.dry} intentos=${result.attempts} verificado=${result.verified}`);
    console.log(`[recount:stats] log: ${result.logPath} (${result.logBytes} bytes); cursor final=${result.finalOffset} eof=${result.eof}`);
    if (result.backupPath) console.log(`[recount:stats] backup en: ${result.backupPath}`);
    if (result.dry) {
      console.log(`[recount:stats] PLAN (lo que borraría): ${result.killEventsDeleted} killEvents, ${result.sessionsDeleted} sessions, ${result.aliasesDeleted} aliases, ${result.playersDeleted} players sin link (quedarían ${result.playersKeptLinked} players vinculados con counters a 0); cursors a rewirear: ${result.cursorsRewound}`);
    }
    if (result.players.length > 0) {
      console.table(result.players.map((p) => ({ name: p.name, guid: p.guid, kills: p.kills, deaths: p.deaths, headshots: p.headshots, teamkills: p.teamkills, isBot: p.isBot, linked: p.linked })));
    }
    if (result.warnings.length > 0) {
      console.log(`[recount:stats] warnings (${result.warnings.length}):`);
      for (const warning of result.warnings.slice(0, 20)) console.log(`  - ${warning}`);
      if (result.warnings.length > 20) console.log(`  ... y ${result.warnings.length - 20} más`);
    }
    await prisma.$disconnect();
    if (!result.ok) process.exitCode = 1;
  })();
}
