import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ingestGameLog } from '../src/services/sync/gamelog.reader.js';
import { prisma } from '../src/lib/prisma.js';
import { recountStats } from '../scripts/recount-stats.js';
import { SKILL } from '../src/services/skill/elo.js';
import { registerUser, resetDb } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));

const HEX_A = 'a1b2c3d4e5f60718'; // "Alpha" (mata en el log A y B)
const HEX_B = '0f1e2d3c4b5a6978'; // "Bravo" (víctima)
const DEC_A = BigInt(`0x${HEX_A}`).toString(10);
const DEC_B = BigInt(`0x${HEX_B}`).toString(10);
const SERVER_LABEL = '192.168.3.99:28961';

const LOG_PATH = resolve(here, 'data', 'test-recount-games_mp.log');
const BACKUP_DIR = resolve(here, 'data', 'recount-backups');

/** Log A: Alpha (2º bloque = killer) mata 1 vez a Bravo (1º bloque = víctima). */
const LOG_A = [
  '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
  `  0:04 J;${HEX_A};0;Alpha`,
  `  0:05 J;${HEX_B};1;Bravo`,
  `  0:10 K;${HEX_B};1;axis;Bravo;${HEX_A};0;allies;Alpha;ak47;100;MOD_RIFLE_BULLET;head\n`,
];

/** Log B (tras "rotación"): Alpha mata 2 veces más a Bravo (head SÍ es headshot; neck NO). */
const LOG_B = [
  '  0:00 InitGame: \\g_gametype\\war\\map\\mp_strike\\',
  `  0:04 J;${HEX_A};0;Alpha`,
  `  0:05 J;${HEX_B};1;Bravo`,
  `  0:10 K;${HEX_B};1;axis;Bravo;${HEX_A};0;allies;Alpha;ak47;120;MOD_RIFLE_BULLET;head`,
  `  0:12 K;${HEX_B};1;axis;Bravo;${HEX_A};0;allies;Alpha;mp5k;80;MOD_RIFLE_BULLET;neck\n`,
];

function writeLog(lines: string[]): void {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  writeFileSync(LOG_PATH, lines.map((l) => `${l}\n`).join(''), 'utf8');
}

beforeAll(async () => {
  await resetDb();
});

beforeEach(async () => {
  await resetDb();
  rmSync(LOG_PATH, { force: true });
  rmSync(BACKUP_DIR, { recursive: true, force: true });
});

describe('recountStats --dry (no borra nada, solo imprime el plan)', () => {
  it('el dry-run NO borra NADA y reporta exactamente lo que haría', async () => {
    writeLog(LOG_A);
    await ingestGameLog(LOG_PATH, SERVER_LABEL); // deja datos + cursor al EOF

    const before = {
      players: await prisma.player.count(),
      events: await prisma.killEvent.count(),
      sessions: await prisma.session.count(),
      aliases: await prisma.playerAlias.count(),
      cursors: await prisma.logIngestState.count(),
      alpha: await prisma.player.findUniqueOrThrow({ where: { guid: DEC_A } }),
      bravo: await prisma.player.findUniqueOrThrow({ where: { guid: DEC_B } }),
    };
    expect(before.events).toBe(1);

    const plan = await recountStats({ logPath: LOG_PATH, dry: true });

    // El plan describe el estado ACTUAL (lo que se borraría).
    expect(plan.ok).toBe(true);
    expect(plan.dry).toBe(true);
    expect(plan.killEventsDeleted).toBe(before.events);
    expect(plan.playersDeleted).toBe(before.players); // sin links: todos se borrarían
    expect(plan.playersKeptLinked).toBe(0);
    expect(plan.sessionsDeleted).toBe(before.sessions);
    expect(plan.aliasesDeleted).toBe(before.aliases);
    expect(plan.cursorsRewound).toBe(1);
    expect(plan.eof).toBe(true); // el cursor ya está al EOF
    expect(plan.backupPath).toBeNull(); // en seco ni backup

    // IDEMPOTENTE EN SECO: la DB queda EXACTAMENTE igual (ni una fila menos).
    expect(await prisma.player.count()).toBe(before.players);
    expect(await prisma.killEvent.count()).toBe(before.events);
    expect(await prisma.session.count()).toBe(before.sessions);
    expect(await prisma.playerAlias.count()).toBe(before.aliases);
    const alphaAfter = await prisma.player.findUniqueOrThrow({ where: { guid: DEC_A } });
    expect(alphaAfter.deaths).toBe(before.alpha.deaths);
    const bravoAfter = await prisma.player.findUniqueOrThrow({ where: { guid: DEC_B } });
    expect(bravoAfter.kills).toBe(before.bravo.kills);
    expect(bravoAfter.headshots).toBe(before.bravo.headshots);
    // El cursor NO se rewireó en seco.
    const cursor = await prisma.logIngestState.findUniqueOrThrow({ where: { source: `gamelog:${LOG_PATH}` } });
    expect(cursor.byteOffset).toBeGreaterThan(0n);
  });
});

describe('recountStats real (wipe + re-ingesta + skill + verificación)', () => {
  it('rewindea el cursor, re-ingesta el log entero con el parser vigente, recalcula skill y VERIFICA counters', async () => {
    // 1) Estado "viejo": log A ingestado (1 evento, cursor al EOF de A).
    writeLog(LOG_A);
    await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(await prisma.killEvent.count()).toBe(1);
    const alphaOld = await prisma.player.findUniqueOrThrow({ where: { guid: DEC_A } });
    expect(alphaOld.kills).toBe(1); // Alpha es el KILLER (2º bloque)

    // 2) El log "rotó" y ahora tiene más partidas (log B): el recuento debe
    //    reflejar SOLO el contenido actual del archivo (2 eventos), sin rastro de A.
    writeLog(LOG_B);
    const result = await recountStats({ logPath: LOG_PATH, server: SERVER_LABEL, backupDir: BACKUP_DIR });

    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true); // counters de Player == agregado de KillEvent
    expect(result.attempts).toBe(1);
    expect(result.eof).toBe(true);
    expect(result.backupPath).not.toBeNull();
    expect(existsSync(result.backupPath!)).toBe(true);
    // Wipe reportado: lo que había de A.
    expect(result.killEventsDeleted).toBe(1);
    expect(result.playersDeleted).toBe(2); // Alpha y Bravo sin link
    expect(result.cursorsRewound).toBe(1);
    // Re-ingesta: 2 kills del log B (head + neck), 1 headshot para Alpha (head).
    expect(result.killEventsReingested).toBe(2);
    const events = await prisma.killEvent.findMany({ orderBy: [{ id: 'asc' }] });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.skillProcessed)).toBe(true); // skill ELO recalculado completo

    const alpha = await prisma.player.findUniqueOrThrow({ where: { guid: DEC_A } });
    expect(alpha.kills).toBe(2);
    expect(alpha.headshots).toBe(1); // head SÍ cuenta; neck NO (solo head/helmet)
    const bravo = await prisma.player.findUniqueOrThrow({ where: { guid: DEC_B } });
    expect(bravo.deaths).toBe(2);
    expect(bravo.headshots).toBe(0);

    // Skill ELO recalculado desde cero: el killer (Alpha) ganó ELO sobre el START.
    expect(alpha.skillElo).toBeGreaterThan(SKILL.START);
    expect(bravo.skillElo).toBeLessThan(SKILL.START);
    expect(bravo.skillElo).toBeGreaterThanOrEqual(SKILL.FLOOR);

    // Cursor al EOF del archivo actual.
    const state = await prisma.logIngestState.findUniqueOrThrow({ where: { source: `gamelog:${LOG_PATH}` } });
    expect(state.byteOffset).toBe(BigInt(statSync(LOG_PATH).size));
    expect(state.currentMap).toBe('mp_strike');

    // Tabla resumen incluida en el resultado.
    expect(result.players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ guid: DEC_A, kills: 2, deaths: 0, headshots: 1 }),
        expect.objectContaining({ guid: DEC_B, kills: 0, deaths: 2, headshots: 0 }),
      ]),
    );

    // IDEMPOTENTE: segundo recuento sobre el MISMO log → mismos números.
    const rerun = await recountStats({ logPath: LOG_PATH, server: SERVER_LABEL, backupDir: BACKUP_DIR });
    expect(rerun.ok).toBe(true);
    expect(rerun.killEventsReingested).toBe(2);
    const alphaRerun = await prisma.player.findUniqueOrThrow({ where: { guid: DEC_A } });
    expect(alphaRerun.kills).toBe(2);
    expect(await prisma.killEvent.count()).toBe(2);
  });

  it('conserva User, AccountLink y counters a 0 de los players vinculados (se re-pueblan con la re-ingesta)', async () => {
    writeLog(LOG_A);
    await ingestGameLog(LOG_PATH, SERVER_LABEL);
    const { token } = await registerUser('recount-linker@test.local');
    expect(token).toBeTruthy();
    // Vincula la cuenta al guid de Alpha (aparece en el log B → se re-puebla).
    await prisma.accountLink.create({ data: { userId: (await prisma.user.findFirstOrThrow({ where: { email: 'recount-linker@test.local' } })).id, guid: DEC_A } });

    writeLog(LOG_B);
    const result = await recountStats({ logPath: LOG_PATH, server: SERVER_LABEL, backupDir: BACKUP_DIR });
    expect(result.ok).toBe(true);
    expect(result.playersKeptLinked).toBe(1); // la fila de Alpha se conservó (FK) con counters a 0

    // User y AccountLink INTACTOS.
    expect(await prisma.user.count({ where: { email: 'recount-linker@test.local' } })).toBe(1);
    expect(await prisma.accountLink.count({ where: { guid: DEC_A } })).toBe(1);

    // El player vinculado fue re-poblado por la re-ingesta (Alpha mata 2 veces en B).
    const alpha = await prisma.player.findUniqueOrThrow({ where: { guid: DEC_A } });
    expect(alpha.kills).toBe(2);
    expect(alpha.deaths).toBe(0);
  });

  it('falla controlado si el log no existe (defensivo, sin tocar la DB)', async () => {
    const missing = resolve(here, 'data', 'no-existe-recount.log');
    rmSync(missing, { force: true });
    const before = await prisma.player.count();
    const result = await recountStats({ logPath: missing, dry: false });
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes('no existe'))).toBe(true);
    expect(await prisma.player.count()).toBe(before); // DB intacta
  });
});
