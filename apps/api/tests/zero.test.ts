import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, beforeAll, describe, expect, it } from 'vitest';
import { ingestGameLog } from '../src/services/sync/gamelog.reader.js';
import { prisma } from '../src/lib/prisma.js';
import { env } from '../src/config/env.js';
import { zeroStats } from '../scripts/recount-stats.js';
import { registerUser, resetDb } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));

const HEX_A = 'a1b2c3d4e5f60718'; // "ReservedName" (dueño: AccountLink conservado)
const HEX_B = '0f1e2d3c4b5a6978'; // impostor con el nick reservado → IdentityAlert
const DEC_A = BigInt(`0x${HEX_A}`).toString(10);
const DEC_B = BigInt(`0x${HEX_B}`).toString(10);
const SERVER_LABEL = '192.168.3.99:28961';

const LOG_PATH = resolve(here, 'data', 'test-zero-games_mp.log');
const BACKUP_DIR = resolve(here, 'data', 'zero-backups');

/** Log etapa 1: el dueño (A) conecta con nick neutro → nace su Player (para poder crear el AccountLink). */
const LOG_PRE = [
  '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
  `  0:04 J;${HEX_A};0;Alpha\n`,
];

/** Log etapa 2 (append): el impostor (B) usa el nick RESERVADO del dueño → IdentityAlert; y 1 kill. */
const LOG_POST = [
  `  0:05 J;${HEX_B};1;ReservedName`,
  `  0:10 K;${HEX_B};1;axis;Bravo;${HEX_A};0;allies;Alpha;ak47;100;MOD_RIFLE_BULLET;head\n`,
];

function writeLog(lines: string[]): void {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  writeFileSync(LOG_PATH, lines.map((l) => `${l}\n`).join(''), 'utf8');
}

/** Seed completo: cuenta → player del dueño → link → impostor + kill (alerta de identidad). */
async function seedGameAndAccountData(): Promise<{ userId: number; storageDir: string }> {
  const { id: userId } = await registerUser('zero-owner@test.local', 'supersecret123', 'ReservedName');
  writeLog(LOG_PRE);
  await ingestGameLog(LOG_PATH, SERVER_LABEL); // nace Player DEC_A (sin alerta: nick neutro)
  await prisma.accountLink.create({ data: { userId, guid: DEC_A } });
  writeFileSync(LOG_PATH, LOG_POST.map((l) => `${l}\n`).join(''), { flag: 'a' });
  await ingestGameLog(LOG_PATH, SERVER_LABEL); // B usa el nick reservado (alerta) + kill de A
  await prisma.penalty.create({ data: { offenderGuid: DEC_B, type: 'warn', reason: 'zero-test' } });
  await prisma.linkAttempt.create({ data: { userId, status: 'pending' } });
  await prisma.syncRun.create({ data: { ok: true } });
  // Cloud-save "del dueño": el modo zero NUNCA debe tocarlo (verificación).
  const storageDir = join(env.profileStorageDir, '999777');
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(join(storageDir, 'latest.json'), '{"ok":true}', 'utf8');
  return { userId, storageDir };
}

beforeAll(async () => {
  await resetDb();
});

beforeEach(async () => {
  await resetDb();
  rmSync(LOG_PATH, { force: true });
  rmSync(BACKUP_DIR, { recursive: true, force: true });
});

describe('zeroStats (modo db:zero: wipe total de datos de juego, sin re-ingesta)', () => {
  it('borra TODO lo derivado de juego, PRESERVA User/AccountLink/SyncState/cloud-saves y fija el cursor al EOF del log', async () => {
    const { userId, storageDir } = await seedGameAndAccountData();
    // Estado pre: 2 players, 1 killEvent, 2 sesiones abiertas, 3 aliases
    // (Alpha, ReservedName del impostor, Bravo de la línea K), 1 identityAlert.
    expect(await prisma.player.count()).toBe(2);
    expect(await prisma.killEvent.count()).toBe(1);
    expect(await prisma.session.count()).toBe(2);
    expect(await prisma.playerAlias.count()).toBe(3);
    expect(await prisma.identityAlert.count()).toBe(1);

    const result = await zeroStats({ logPath: LOG_PATH, server: SERVER_LABEL, backupDir: BACKUP_DIR });

    expect(result.ok).toBe(true);
    expect(result.dry).toBe(false);
    expect(result.fkRestored).toBe(true);
    expect(result.backupPath).not.toBeNull();
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(result.backupPath).toContain('.zero-');

    // BORRADOS reportados = filas efectivamente borradas.
    expect(result.wiped.killEvents).toBe(1);
    expect(result.wiped.players).toBe(2);
    expect(result.wiped.sessions).toBe(2); // sesiones de JUEGO (FK → Player)
    expect(result.wiped.aliases).toBe(3);
    expect(result.wiped.penalties).toBe(1);
    expect(result.wiped.identityAlerts).toBe(1);
    expect(result.wiped.linkAttempts).toBe(1);
    expect(result.wiped.syncRuns).toBe(1);

    // DB en cero: sin ninguna fila de datos de juego.
    expect(await prisma.killEvent.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
    expect(await prisma.playerAlias.count()).toBe(0);
    expect(await prisma.player.count()).toBe(0);
    expect(await prisma.penalty.count()).toBe(0);
    expect(await prisma.identityAlert.count()).toBe(0);
    expect(await prisma.linkAttempt.count()).toBe(0);
    expect(await prisma.syncRun.count()).toBe(0);

    // CONSERVADOS: User, AccountLink (apunta al guid para el auto-link) y SyncState.
    expect(await prisma.user.count({ where: { email: 'zero-owner@test.local' } })).toBe(1);
    const link = await prisma.accountLink.findUniqueOrThrow({ where: { guid: DEC_A } });
    expect(link.userId).toBe(userId);
    expect(result.linkedGuids).toContain(DEC_A);
    expect(result.preserved.users).toBe(1);
    expect(result.preserved.accountLinks).toBe(1);
    expect(result.preserved.storageDirs).toBeGreaterThanOrEqual(1);
    // Cloud-saves INTACTOS: el filesystem NO se toca.
    expect(existsSync(join(storageDir, 'latest.json'))).toBe(true);
    rmSync(storageDir, { recursive: true, force: true }); // cleanup del fixture

    // CURSOR: fijado al EOF ACTUAL del archivo (NO a 0), telemetría a cero.
    expect(result.cursor.pinned).toBe(true);
    expect(result.cursor.offsetBefore).not.toBe('0');
    const state = await prisma.logIngestState.findUniqueOrThrow({ where: { source: `gamelog:${LOG_PATH}` } });
    expect(state.byteOffset).toBe(BigInt(statSync(LOG_PATH).size));
    expect(state.linesParsed).toBe(0);
    expect(state.linesIgnored).toBe(0);

    // El AccountLink queda temporalmente sin Player (esperado; se cura solo).
    expect(result.danglingLinks).toEqual([{ userId, guid: DEC_A }]);

    // CURACIÓN: la próxima aparición del guid en el log (1 línea J nueva) nace
    // de nuevo con el MISMO guid → la FK del AccountLink queda satisfecha.
    writeFileSync(LOG_PATH, `  5:00 J;${HEX_A};0;Alpha\n`, { flag: 'a' });
    const ingest = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(ingest.playersSynced).toBe(1);
    expect(await prisma.killEvent.count()).toBe(0); // solo conectó: sin kills nuevas
    const reborn = await prisma.player.findUniqueOrThrow({ where: { guid: DEC_A } });
    expect(reborn.kills).toBe(0); // nace a cero
    expect(await prisma.accountLink.count({ where: { guid: DEC_A } })).toBe(1);
    expect(await danglingCheck(DEC_A)).toBe(false);
  });

  it('es IDEMPOTENTE: la segunda corrida borra 0 y re-fija el cursor al EOF (aunque el log haya crecido)', async () => {
    await seedGameAndAccountData();
    const first = await zeroStats({ logPath: LOG_PATH, server: SERVER_LABEL, backupDir: BACKUP_DIR });
    expect(first.ok).toBe(true);

    // El server "escribió" líneas nuevas tras el zero: el cursor debe saltar
    // al NUEVO EOF y el histórico agregado NO se cuenta.
    writeFileSync(LOG_PATH, `  6:00 J;${HEX_A};0;Alpha\n  6:05 K;${HEX_B};1;axis;Bravo;${HEX_A};0;allies;Alpha;ak47;60;MOD_RIFLE_BULLET;chest\n`, { flag: 'a' });
    const eofAfterGrowth = BigInt(statSync(LOG_PATH).size);

    const second = await zeroStats({ logPath: LOG_PATH, server: SERVER_LABEL, backupDir: BACKUP_DIR });
    expect(second.ok).toBe(true);
    expect(second.wiped.killEvents).toBe(0);
    expect(second.wiped.players).toBe(0);
    expect(second.wiped.sessions).toBe(0);
    expect(second.wiped.aliases).toBe(0);
    expect(second.wiped.penalties).toBe(0);
    expect(second.wiped.identityAlerts).toBe(0);
    expect(second.wiped.linkAttempts).toBe(0);
    expect(second.wiped.syncRuns).toBe(0);

    expect(await prisma.killEvent.count()).toBe(0);
    expect(await prisma.player.count()).toBe(0);
    expect(await prisma.accountLink.count({ where: { guid: DEC_A } })).toBe(1); // link intacto
    const state = await prisma.logIngestState.findUniqueOrThrow({ where: { source: `gamelog:${LOG_PATH}` } });
    expect(state.byteOffset).toBe(eofAfterGrowth); // re-fijado al nuevo EOF
    expect(second.cursor.offsetAfter).toBe(eofAfterGrowth.toString());
    expect(second.cursor.pinned).toBe(true);
  });

  it('--dry: imprime el plan EXACTO y no borra NI escribe nada (sin backup, sin tocar el cursor)', async () => {
    await seedGameAndAccountData();

    const before = {
      players: await prisma.player.count(),
      killEvents: await prisma.killEvent.count(),
      sessions: await prisma.session.count(),
      aliases: await prisma.playerAlias.count(),
      penalties: await prisma.penalty.count(),
      identityAlerts: await prisma.identityAlert.count(),
      linkAttempts: await prisma.linkAttempt.count(),
      syncRuns: await prisma.syncRun.count(),
      links: await prisma.accountLink.count(),
      users: await prisma.user.count(),
    };

    const plan = await zeroStats({ logPath: LOG_PATH, dry: true, backupDir: BACKUP_DIR });

    expect(plan.ok).toBe(true);
    expect(plan.dry).toBe(true);
    expect(plan.backupPath).toBeNull(); // en seco ni backup
    expect(plan.wiped.killEvents).toBe(before.killEvents);
    expect(plan.wiped.players).toBe(before.players);
    expect(plan.wiped.sessions).toBe(before.sessions);
    expect(plan.wiped.aliases).toBe(before.aliases);
    expect(plan.wiped.penalties).toBe(before.penalties);
    expect(plan.wiped.identityAlerts).toBe(before.identityAlerts);
    expect(plan.wiped.linkAttempts).toBe(before.linkAttempts);
    expect(plan.wiped.syncRuns).toBe(before.syncRuns);
    expect(plan.preserved.users).toBe(before.users);
    expect(plan.preserved.accountLinks).toBe(before.links);
    expect(plan.cursor.pinned).toBe(false); // en seco no se fija

    // IDEMPOTENTE EN SECO: la DB queda EXACTAMENTE igual y el cursor intacto.
    expect(await prisma.player.count()).toBe(before.players);
    expect(await prisma.killEvent.count()).toBe(before.killEvents);
    expect(await prisma.accountLink.count()).toBe(before.links);
    const cursor = await prisma.logIngestState.findUniqueOrThrow({ where: { source: `gamelog:${LOG_PATH}` } });
    expect(cursor.byteOffset).toBe(BigInt(statSync(LOG_PATH).size)); // sin cambios
    expect(existsSync(BACKUP_DIR)).toBe(false); // no se creó backup
  });
});

/** true si el guid tiene AccountLink sin Player asociado (FK colgando). */
async function danglingCheck(guid: string): Promise<boolean> {
  const player = await prisma.player.findUnique({ where: { guid }, select: { guid: true } });
  const link = await prisma.accountLink.findUnique({ where: { guid }, select: { guid: true } });
  return link !== null && player === null;
}
