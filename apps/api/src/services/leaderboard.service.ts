import { prisma } from '../lib/prisma.js';
import { parseWith } from '../middleware/validate.js';
import { leaderboardQuerySchema } from '../dto/leaderboard.dto.js';
import type { LeaderboardQuery } from '../dto/leaderboard.dto.js';
import { MEDAL_LEGEND_MIN_SKILL, medalFor, type Medal } from '../lib/medals.js';
import { SKILL } from './skill/elo.js';

/**
 * LEADERBOARD POR CUENTA (no por GUID).
 *
 * ROOT CAUSE del refactor (caso del dueño, cyber-café): un usuario juega desde
 * VARIAS PCs; cada PC = su propio guid, legítimamente vinculado a la MISMA
 * cuenta vía auto-link por sesión (multi-PC es una FEATURE, no se desvincula
 * nada). Antes el ranking era por GUID y el mismo jugador aparecía VARIAS
 * VECES ("admin" con 14 kills + "admin" con 40 kills). La identidad es la
 * CUENTA (User): el leaderboard agrupa por cuenta y NUNCA borra links/players.
 *
 * BOTS (2026-11-11, decisión del dueño): los bots DEJARON DE EXISTIR como
 * jugadores en la DB (sin Player row: ingesta no los crea, cleanup los borró).
 * Por tanto NO PUEDEN aparecer aquí por construcción. El query param
 * `includeBots` SIGUE ACEPTÁNDOSE por compatibilidad con la web, pero se
 * IGNORA: bots nunca aparecen. (Defensa en profundidad: loadAccountRows además
 * filtra isBot=false, así una fila de bot huérfana jamás rankea.)
 *
 * Contrato de agregación (documentado en docs/API.md):
 *  - Una fila por User con al menos 1 guid vinculado (humano). Los guids
 *    SIN cuenta no rankean (ranked = con cuenta; con exigir-launcher los
 *    anónimos no deberían existir). Las cuentas sin guids tampoco aparecen.
 *  - `name` = displayName de la CUENTA (NUNCA el último nick del juego).
 *  - Stats de guids vinculados SUMADAS: kills, deaths, headshots, timePlayed,
 *    connections (y kd recalculado sobre los sumas).
 *  - `skill` = el MÁXIMO de los skills de sus guids (su mejor rendimiento:
 *    la alternativa promedio penaliza el multi-PC y se descartó).
 *  - `level` = el máximo saveLevel entre sus guids (el saveXp/prestige
 *    coherente con ese mismo guid viven en el perfil per-guid).
 *  - `lastConnection` = la más reciente entre sus guids.
 *  - `guid` = el "guid primario" de la cuenta: el de MAYOR skill (empate:
 *    mayor kills, luego guid menor) — mantiene el shape (la web navega al
 *    perfil por guid) sin exponer preferencia por ninguna PC.
 *  - `linked` SIEMPRE true (todas las filas nacen de un AccountLink).
 *  - `rank` = posición GLOBAL de la CUENTA entre la población rankeada
 *    (cuentas), kills desc / displayName asc, independiente de
 *    búsqueda/filtros/paginación.
 */

export interface LeaderboardEntry {
  /** Posición GLOBAL de la cuenta (kills desc, empate name asc) — independiente de búsqueda/filtros/paginación. */
  rank: number;
  /**
   * GUID primario de la cuenta (el de mayor skill; empate: kills desc, guid asc).
   * Se expone para que el shape sea compatible y la web navegue al perfil.
   */
  guid: string;
  /** DisplayName de la CUENTA (nunca el nick del juego). */
  name: string;
  kills: number;
  deaths: number;
  kd: number;
  /** Segundos de juego SUMADOS entre los guids de la cuenta. */
  timePlayed: number;
  /** Conexiones SUMADAS entre los guids de la cuenta. */
  connections: number;
  /** El MÁXIMO de los skills de los guids de la cuenta (su mejor rendimiento). */
  skill: number;
  /** Kills con hitloc head/helmet SUMADAS (acreditadas al killer; fuente log). */
  headshots: number;
  /**
   * El MÁXIMO saveLevel del cloud save entre los guids de la cuenta; null si
   * ninguno tuvo un save parseado con éxito. Ordenable con sort=level
   * (nulls al final en desc, como en SQLite). Ver docs/API.md.
   */
  level: number | null;
  /** La más reciente entre las últimas conexiones de sus guids. */
  lastConnection: string | null;
  /** SIEMPRE true: las filas de cuenta nacen de un AccountLink. */
  linked: boolean;
  /** Medalla ELO derivada del skill de la CUENTA (ver docs/API.md "Medallas ELO"). */
  medal: Medal;
}

export interface LeaderboardResponse {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  sort: LeaderboardQuery['sort'];
  order: LeaderboardQuery['order'];
  players: LeaderboardEntry[];
}

/** Fila de agregación por cuenta (antes de orden/paginación). */
interface AccountAgg {
  userId: number;
  guid: string;
  name: string;
  kills: number;
  deaths: number;
  timePlayed: number;
  connections: number;
  skill: number;
  headshots: number;
  level: number | null;
  lastConnection: Date | null;
  /** Nicks de juego de sus guids (para que la búsqueda por nick encuentre la cuenta). */
  nickNames: string[];
  /** Algún guid humano en la población ELO (kills ≥ 1 o skillElo ≠ base). */
  eloQualified: boolean;
}

/** Fila rankeable. Desde 2026-11-11 SOLO cuentas: los bots no existen en DB. */
type RankableRow = { kind: 'account'; agg: AccountAgg } & { rank: number };

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function kdFor(kills: number, deaths: number): number {
  return round2(deaths > 0 ? kills / deaths : kills);
}

function timeValue(date: Date | null): number {
  return date?.getTime() ?? Number.NEGATIVE_INFINITY;
}

/** Carga los guids vinculados (humanos) y agrega una fila por cuenta. */
async function loadAccountRows(): Promise<AccountAgg[]> {
  const players = await prisma.player.findMany({
    where: { isBot: false, accountLinks: { some: {} } },
    select: {
      guid: true,
      name: true,
      kills: true,
      deaths: true,
      timePlayed: true,
      connections: true,
      skill: true,
      skillElo: true,
      headshots: true,
      saveLevel: true,
      lastConnection: true,
      accountLinks: { select: { userId: true } },
    },
  });

  const byUser = new Map<number, AccountAgg>();
  for (const player of players) {
    for (const link of player.accountLinks) {
      // guid @unique → a lo sumo un link por player; el loop es defensivo.
      const current = byUser.get(link.userId);
      if (!current) {
        byUser.set(link.userId, {
          userId: link.userId,
          guid: player.guid,
          name: '', // displayName de la cuenta, resuelto después
          kills: player.kills,
          deaths: player.deaths,
          timePlayed: player.timePlayed,
          connections: player.connections,
          skill: player.skill,
          headshots: player.headshots,
          level: player.saveLevel ?? null,
          lastConnection: player.lastConnection,
          nickNames: [player.name],
          eloQualified: player.kills >= 1 || player.skillElo !== SKILL.START,
        });
        continue;
      }
      // Stats: SUMA de guids.
      current.kills += player.kills;
      current.deaths += player.deaths;
      current.timePlayed += player.timePlayed;
      current.connections += player.connections;
      current.headshots += player.headshots;
      // skill y level: el MÁXIMO entre guids (el guid primario se re-resuelve al final).
      if (player.skill > current.skill) {
        current.skill = player.skill;
      }
      if (player.saveLevel !== null && (current.level === null || player.saveLevel > current.level)) {
        current.level = player.saveLevel;
      }
      if (timeValue(player.lastConnection) > timeValue(current.lastConnection)) {
        current.lastConnection = player.lastConnection;
      }
      current.nickNames.push(player.name);
      if (player.kills >= 1 || player.skillElo !== SKILL.START) current.eloQualified = true;
    }
  }

  if (byUser.size === 0) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: [...byUser.keys()] } },
    select: { id: true, displayName: true },
  });
  const nameByUser = new Map(users.map((user) => [user.id, user.displayName] as const));

  const rows = [...byUser.values()];
  for (const row of rows) {
    row.name = nameByUser.get(row.userId) ?? '';
  }

  // Desempate del guid primario por skill EMPATADO: mayor kills, luego guid menor.
  // Re-resuelto aquí con kills disponibles tras la agregación (O(n·m), m = guids por cuenta, pequeño).
  const perUserPlayers = new Map<number, typeof players>();
  for (const player of players) {
    for (const link of player.accountLinks) {
      const list = perUserPlayers.get(link.userId) ?? [];
      list.push(player);
      perUserPlayers.set(link.userId, list);
    }
  }
  for (const row of rows) {
    const list = perUserPlayers.get(row.userId) ?? [];
    const primary = [...list].sort(
      (a, b) => b.skill - a.skill || b.kills - a.kills || compareGuid(a.guid, b.guid),
    )[0];
    if (primary) {
      row.guid = primary.guid;
    }
  }

  return rows;
}

function compareGuid(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Comparación de texto determinista (code units, ~collation BINARY de SQLite). */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Posición global (kills desc, empate name asc) sobre la población rankeada
 * (SOLO cuentas: los bots no existen en DB). Asigna ranks SECUENCIALES
 * (1,2,3…) igual que el ROW_NUMBER anterior: sin saltos por empate.
 */
function assignGlobalRanks(rows: RankableRow[]): void {
  const ordered = [...rows].sort(
    (a, b) => b.agg.kills - a.agg.kills || compareText(a.agg.name, b.agg.name) || compareGuid(a.agg.guid, b.agg.guid),
  );
  ordered.forEach((row, index) => {
    row.rank = index + 1;
  });
}

/**
 * Posición global POR SKILL entre CUENTAS en la población ELO (alguno de sus
 * guids humanos con kills ≥ 1 o skillElo ≠ base). El orden usa el skill
 * EXPUESTO de la cuenta (el mismo número que consume medalFor → medalla y
 * posición siempre coherentes). Devuelve mapa userId -> rank.
 */
function skillRanksForAccounts(accounts: AccountAgg[]): Map<number, number> {
  const population = accounts
    .filter((account) => account.eloQualified)
    .sort((a, b) => b.skill - a.skill || compareText(a.name, b.name) || compareGuid(a.guid, b.guid));
  const ranks = new Map<number, number>();
  population.forEach((account, index) => {
    ranks.set(account.userId, index + 1);
  });
  return ranks;
}

export async function getLeaderboard(query: unknown): Promise<LeaderboardResponse> {
  const q = parseWith(leaderboardQuerySchema, query ?? {});
  const search = q.search?.toLowerCase() ?? null;
  // includeBots (si vino) se ACEPTA pero se IGNORA: los bots no tienen Player
  // rows (decisión 2026-11-11) → la query solo ve cuentas. Compat web.

  const accountRows = await loadAccountRows();

  const all: RankableRow[] = accountRows.map((agg) => ({ kind: 'account' as const, agg, rank: 0 }));

  // Rank global SIEMPRE sobre la población completa (búsqueda/filtros no afectan).
  assignGlobalRanks(all);

  // globalRank por SKILL solo hace falta para las LEYENDAS (tier 8, skill ≥
  // MEDAL_LEGEND_MIN_SKILL): población = cuentas ELO-calificadas.
  const legendAccounts = accountRows.filter((account) => account.skill >= MEDAL_LEGEND_MIN_SKILL);
  const skillRanks =
    legendAccounts.length > 0 ? skillRanksForAccounts(accountRows) : new Map<number, number>();

  // Búsqueda por displayName de cuenta Y por nick de cualquier guid vinculado
  // ("pepe" encuentra la cuenta aunque la fila sea por cuenta).
  const matchesSearch = (row: RankableRow): boolean => {
    if (search === null) return true;
    if (row.agg.name.toLowerCase().includes(search)) return true;
    return row.agg.nickNames.some((nick) => nick.toLowerCase().includes(search));
  };
  // minMatches sobre conexiones AGREGADAS de la cuenta.
  const matchesMin = (row: RankableRow): boolean => row.agg.connections >= q.minMatches;

  const filtered = all.filter((row) => matchesSearch(row) && matchesMin(row));

  // Orden pedido sobre los valores AGREGADOS; empate name asc (como antes).
  // level: null = "sin dato" (−∞) → en asc van primero y en desc al final
  // (idéntico al comportamiento SQLite del ranking por guid anterior).
  const sortField = q.sort;
  const dir = q.order === 'desc' ? -1 : 1;
  const valueOf = (row: RankableRow): number => {
    switch (sortField) {
      case 'kills':
        return row.agg.kills;
      case 'deaths':
        return row.agg.deaths;
      case 'kd':
        return kdFor(row.agg.kills, row.agg.deaths);
      case 'timePlayed':
        return row.agg.timePlayed;
      case 'skill':
        return row.agg.skill;
      case 'headshots':
        return row.agg.headshots;
      case 'level':
        return row.agg.level ?? Number.NEGATIVE_INFINITY;
    }
  };
  filtered.sort((a, b) => {
    const diff = dir * (valueOf(a) - valueOf(b));
    if (diff !== 0) return diff;
    return compareText(a.agg.name, b.agg.name) || compareGuid(a.agg.guid, b.agg.guid);
  });

  const total = filtered.length;
  const offset = (q.page - 1) * q.pageSize;
  const pageRows = filtered.slice(offset, offset + q.pageSize);

  return {
    page: q.page,
    pageSize: q.pageSize,
    total,
    totalPages: total === 0 ? 1 : Math.ceil(total / q.pageSize),
    sort: q.sort,
    order: q.order,
    players: pageRows.map((row) => ({
      rank: row.rank,
      guid: row.agg.guid,
      name: row.agg.name,
      kills: row.agg.kills,
      deaths: row.agg.deaths,
      kd: kdFor(row.agg.kills, row.agg.deaths),
      timePlayed: row.agg.timePlayed,
      connections: row.agg.connections,
      skill: row.agg.skill,
      headshots: row.agg.headshots,
      level: row.agg.level,
      lastConnection: row.agg.lastConnection?.toISOString() ?? null,
      linked: true, // todas las filas son cuentas (los bots no existen en DB)
      medal: medalFor(row.agg.skill, skillRanks.get(row.agg.userId) ?? null),
    })),
  };
}
