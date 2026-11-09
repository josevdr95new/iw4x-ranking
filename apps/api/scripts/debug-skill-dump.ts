/**
 * DEBUG (temporal): vuelca el estado ELO del guid objetivo y los eventos
 * KillEvent/MatchBonusEvent que lo involucran. Uso:
 *   npx tsx scripts/debug-skill-dump.ts [guid]
 */
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const guid = process.argv[2] ?? '15211139446454624108';
const dbPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'dev.db');
const db = new Database(dbPath, { readonly: true });

console.log(`=== Player ${guid} ===`);
const player = db.prepare('SELECT guid, name, kills, deaths, skill, skillElo, bestStreak, isBot FROM Player WHERE guid = ?').get(guid);
console.log(player ?? '(sin fila)');

console.log(`\n=== KillEvent con targetGuid = ${guid} (víctima) ===`);
const asVictim = db.prepare('SELECT id, timeEpoch, originGuid, targetGuid, isKill, isTeamkill, headshot, hitloc, damage, skillProcessed FROM KillEvent WHERE targetGuid = ? ORDER BY timeEpoch, id').all(guid);
console.log(JSON.stringify(asVictim, null, 2));

console.log(`\n=== Últimos 10 KillEvent con originGuid = ${guid} (atacante) ===`);
const asOrigin = db.prepare('SELECT id, timeEpoch, originGuid, targetGuid, isKill, isTeamkill, headshot, damage, skillProcessed FROM KillEvent WHERE originGuid = ? ORDER BY timeEpoch DESC, id DESC LIMIT 10').all(guid);
console.log(JSON.stringify(asOrigin, null, 2));

console.log(`\n=== MatchBonusEvent de ${guid} ===`);
const bonus = db.prepare('SELECT id, timeEpoch, guid, position, delta, skillProcessed FROM MatchBonusEvent WHERE guid = ? ORDER BY timeEpoch, id').all(guid);
console.log(JSON.stringify(bonus, null, 2));

console.log(`\n=== Orígenes de las muertes del guid (aggregate) ===`);
const deaths = db.prepare('SELECT originGuid, COUNT(*) as n, MIN(isKill) as allKill, MAX(isKill) as anyKill, MIN(isTeamkill) as anyTeam FROM KillEvent WHERE targetGuid = ? GROUP BY originGuid').all(guid);
console.log(JSON.stringify(deaths, null, 2));

console.log(`\n=== skillProcessed pendientes (global) ===`);
console.log(db.prepare('SELECT COUNT(*) as pendingKills FROM KillEvent WHERE skillProcessed = 0').get());
console.log(db.prepare('SELECT COUNT(*) as pendingBonus FROM MatchBonusEvent WHERE skillProcessed = 0').get());

db.close();
