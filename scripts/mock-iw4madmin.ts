/**
 * Genera una SQLite con el esquema (simplificado pero fiel) de IW4MAdmin y
 * datos demo: ~50 jugadores con nombres realistas, ~10 servidores y miles de
 * kills. Sirve para desarrollar y demostrar el ranking sin servidores reales.
 *
 * Uso:
 *   npm run mock:db                          # → Database/Database.sqlite (raíz del repo)
 *   tsx scripts/mock-iw4madmin.ts --out X    # ruta personalizada
 */
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDir, '..');

export interface MockDbOptions {
  players?: number;
  killEvents?: number;
  servers?: number;
  seed?: number;
  /** Jugadores con última conexión reciente (dentro de la ventana de link). */
  recentCandidates?: number;
}

export interface MockDbStats {
  path: string;
  players: number;
  killEvents: number;
  servers: number;
  recentCandidates: number;
}

const PLAYER_NAMES: readonly string[] = [
  'Ghost_Riley', 'Soap_MacTavish', 'Cpt_Price', 'Gaz_141', 'Roach_141',
  'Yuri_Bear', 'Nikolai_Vodka', 'Kamarov_RUS', 'Sandman_Metal', 'Truck_Metal1',
  'Grinch_Metal2', 'Frost_SS1', 'Walker_Blackbird', 'Salazar_USA', 'Griggs_USMC',
  'Vasquez_Lt', 'ZombieSlayer69', 'NoScopeKing', 'xXQuickscoperXx', 'MolonLabe1776',
  'Cpl_Punishment', 'TacoTuesdayPro', 'RustyShackleford', 'MountainDewManiac', 'SovietWomble',
  'ChefCurryNoScope', 'Ramirez_DO_EVERYTHING', 'Kilo_2-1_Actual', 'Delta_6_Actual', 'Overwatch_Six',
  'Claymore_Kenny', 'Harrier_JetLife', 'AC130_Gunner', 'Chopper_Gunner', 'Nuke_Wannabe',
  'UAV_Spammer', 'CarePackage_Sniper', 'Thermal_Predator', 'Silenced_UMP45', 'Akimbo_1887',
  'RiotShield_Guy', 'MarathonPro_Runner', 'ColdBlooded_Camo', 'Scavenger_Farmer', 'Bling_FMwJ',
  'OneManArmy_Tuber', 'StoppingPower_Pro', 'SteadyAim_Fragger', 'NinjaPro_Backflip', 'Commando_Lunge',
  'FinalStand_Clinger', 'SitRep_Pro', 'DangerClose_Arty', 'Lightweight_Sprinter', 'BlastShield_Tank',
  'Hardline_Captain', 'QuickFix_Rusher', 'Ghost_Cloaker', 'BlindEye_AntiAir', 'ExtendedMags_Guy',
];

/** PRNG determinista (mulberry32): misma seed → mismos datos, útil para tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface MockPlayer {
  clientId: number;
  guid: string;
  weight: number;
  firstMs: number;
  lastMs: number;
}

export function generateMockDb(dbPath: string, options: MockDbOptions = {}): MockDbStats {
  const playerCount = options.players ?? 50;
  const killCount = options.killEvents ?? 9_000;
  const serverCount = options.servers ?? 10;
  const recentCandidates = options.recentCandidates ?? 8;
  const seed = options.seed ?? 20260501;

  const rng = mulberry32(seed);
  const randInt = (min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));

  mkdirSync(dirname(dbPath), { recursive: true });
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    rmSync(dbPath + suffix, { force: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');

  // Esquema simplificado de IW4MAdmin: mismas tablas/columnas relevantes.
  db.exec(`
    CREATE TABLE EFServer (
      ServerId       INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      ServerEndPoint TEXT,
      Port           INTEGER
    );

    CREATE TABLE EFClient (
      ClientId            INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      NetworkId           INTEGER NOT NULL UNIQUE,
      Name                TEXT NOT NULL,
      Guid                TEXT,
      Level               INTEGER NOT NULL DEFAULT 0,
      CurrentName         TEXT,
      FirstConnection     TEXT,
      LastConnection      TEXT,
      TotalConnectionTime INTEGER NOT NULL DEFAULT 0,
      Connections         INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE EFClientKill (
      OriginClientId INTEGER NOT NULL,
      TargetClientId INTEGER NOT NULL,
      IsKill         INTEGER NOT NULL DEFAULT 1,
      Damage         INTEGER NOT NULL DEFAULT 0,
      Time           INTEGER NOT NULL,
      Weapon         INTEGER,
      ServerId       INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_efclientkill_origin ON EFClientKill (OriginClientId, Time);
    CREATE INDEX IF NOT EXISTS idx_efclientkill_target ON EFClientKill (TargetClientId, Time);
  `);

  const insertServer = db.prepare('INSERT INTO EFServer (ServerId, ServerEndPoint, Port) VALUES (?, ?, ?)');
  const insertClient = db.prepare(`
    INSERT INTO EFClient
      (NetworkId, Name, Guid, Level, CurrentName, FirstConnection, LastConnection, TotalConnectionTime, Connections)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertKill = db.prepare(
    'INSERT INTO EFClientKill (OriginClientId, TargetClientId, IsKill, Damage, Time, Weapon, ServerId) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  const nowMs = Date.now();
  const DAY = 86_400_000;
  const DEMO_WINDOW_MS = 90 * DAY;

  // ── Servidores ────────────────────────────────────────────────
  // ServerId empieza en 0 para cuadrar con los ServerId de EFClientKill.
  for (let s = 0; s < serverCount; s += 1) {
    insertServer.run(s, `192.0.2.${s + 1}`, 28960 + s);
  }

  // ── Jugadores ─────────────────────────────────────────────────
  const names = [...PLAYER_NAMES].sort(() => rng() - 0.5); // mezcla determinista
  const players: MockPlayer[] = [];

  for (let i = 0; i < playerCount; i += 1) {
    const baseName = names[i % names.length] ?? `Player${i}`;
    const name = i < names.length ? baseName : `${baseName}${i}`;
    // NetworkId de 64 bits (> 2^53) para ejercitar el manejo BigInt del sync.
    const networkId = BigInt(`${randInt(1, 9)}${randInt(10 ** 16, 10 ** 17 - 1)}`);
    const isRecent = i < recentCandidates;
    const firstMs = nowMs - randInt(45, 730) * DAY;
    const lastMs = isRecent
      ? nowMs - randInt(30, 480) * 1000 // últimos minutos → candidatos de vinculación
      : nowMs - randInt(0, 60) * DAY;
    const totalSeconds = randInt(1_800, 400 * 3_600);
    const connections = randInt(10, 800);

    insertClient.run(
      networkId,
      name,
      `0123456789abcdef${String(i).padStart(4, '0')}`,
      randInt(0, 40),
      name,
      new Date(firstMs).toISOString(),
      new Date(lastMs).toISOString(),
      totalSeconds,
      connections,
    );

    players.push({
      clientId: i + 1,
      guid: networkId.toString(),
      weight: 0.4 + rng() * 1.6, // skill desigual, como en la vida real
      firstMs,
      lastMs,
    });
  }

  // ── Kills ─────────────────────────────────────────────────────
  const totalWeight = players.reduce((acc, player) => acc + player.weight, 0);
  const pickWeighted = (): MockPlayer => {
    let roll = rng() * totalWeight;
    for (const player of players) {
      roll -= player.weight;
      if (roll <= 0) return player;
    }
    const last = players[players.length - 1];
    return last !== undefined ? last : players[0] as MockPlayer;
  };

  const killRows: Array<[number, number, number, number, number, number, number]> = [];
  for (let k = 0; k < killCount; k += 1) {
    const origin = pickWeighted();
    let target = players[randInt(0, players.length - 1)] as MockPlayer;
    if (target.clientId === origin.clientId) {
      const other = players[origin.clientId % players.length];
      if (other !== undefined && other.clientId !== origin.clientId) target = other;
    }

    const startMs = Math.max(origin.firstMs, nowMs - DEMO_WINDOW_MS);
    const endMs = Math.min(origin.lastMs, nowMs);
    const timeSec = startMs >= endMs
      ? Math.floor(endMs / 1000)
      : randInt(Math.floor(startMs / 1000), Math.floor(endMs / 1000));

    const isKill = rng() < 0.95 ? 1 : 0; // ~5% eventos no letales, como IW4MAdmin real
    killRows.push([
      origin.clientId,
      target.clientId,
      isKill,
      randInt(50, 250), // damage
      timeSec,
      randInt(0, 19), // weapon (id numérico, como IW4MAdmin)
      randInt(0, serverCount - 1),
    ]);
  }

  const insertAllKills = db.transaction((rows: Array<[number, number, number, number, number, number, number]>) => {
    for (const row of rows) insertKill.run(...row);
  });
  insertAllKills(killRows);

  const countOf = (sql: string): number => {
    const row = db.prepare(sql).get() as { c: number | bigint };
    return Number(row['c']);
  };
  const stats: MockDbStats = {
    path: dbPath,
    players: countOf('SELECT COUNT(*) AS c FROM EFClient'),
    killEvents: countOf('SELECT COUNT(*) AS c FROM EFClientKill'),
    servers: serverCount,
    recentCandidates,
  };

  db.close();
  return stats;
}

function main(): void {
  const argv = process.argv.slice(2);
  let out: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const next = argv[i + 1];
      out = next ?? null;
      if (next !== undefined) i += 1;
    } else if (arg !== undefined && arg.startsWith('--out=')) {
      out = arg.slice('--out='.length);
    }
  }

  const dbPath = out !== null && out !== '' ? resolve(process.cwd(), out) : resolve(repoRoot, 'Database', 'Database.sqlite');
  const started = Date.now();
  const stats = generateMockDb(dbPath);
  console.log(`[mock] DB IW4MAdmin simulada creada en: ${stats.path}`);
  console.log(`[mock] jugadores=${stats.players} killEvents=${stats.killEvents} servidores=${stats.servers}`);
  console.log(`[mock] ${stats.recentCandidates} jugadores con conexión reciente (candidatos para vincular por GUID)`);
  console.log(`[mock] generado en ${Date.now() - started} ms`);
  console.log('[mock] Siguiente paso: configura IW4MADMIN_DB_PATH en apps/api/.env y corre "npm run sync".');
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) main();
