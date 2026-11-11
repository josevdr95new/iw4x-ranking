import { readFileSync } from 'node:fs';
import { prisma } from '../lib/prisma.js';
import { parseGameLogLine } from './sync/gamelog.reader.js';

/**
 * Anti-confusión de identidades: historial de alias por GUID.
 *
 * Contexto: comunidad con VARIAS PERSONAS compartiendo PCs. Las stats se keyean
 * por GUID (correcto), pero un mismo displayName puede aparecer en varios GUIDs
 * (colisión de nombre) y un mismo GUID puede haber usado varios nombres
 * (perfil compartido/rotado). Este servicio da las dos vistas:
 *
 *  - Historial de alias por GUID → perfil (GET /api/players/:guid → `aliases`).
 *  - Detección de conflictos (read-only) → panel admin
 *    (GET /api/admin/alias-conflicts → `nameCollisions` + `sharedGuids`).
 *
 * La tabla se puebla SOLO desde la ingesta del games_mp.log (líneas J y K):
 * la fase de agregación de IW4MAdmin NO crea alias porque se re-ejecuta entera
 * en cada ciclo de sync (inflaría occurrences a cada pasada). El bootstrap de
 * datos históricos va en rebuildAliases() (npm run rebuild:aliases).
 */

/** Limpia códigos de color de Quake/IW ("^7", "^1", ...): ^ seguido de 1 carácter. */
export function stripColorCodes(name: string): string {
  return name.replace(/\^./g, '');
}

/**
 * Clave de comparación de nombres para conflictos: sin códigos ^X,
 * sin espacios de los extremos y case-insensitive.
 */
export function aliasKey(name: string): string {
  return normalizeDisplayName(name);
}

/**
 * Normalización CANÓNICA de displayName/nick (única fuente de verdad, compartida
 * por alias, nick reservado (User.displayNameNormalized) y login por nick).
 */
export function normalizeDisplayName(name: string): string {
  return stripColorCodes(name).trim().toLowerCase();
}

/**
 * Heurística de bot: los bots del server dedicado se mapean al rango hex
 * dedicado 0xb07… con ANCHO FIJO de 15 chars hex ("b07" + 12 dígitos).
 * Un guid real de 16 hex chars nunca colisiona con ese rango.
 */
export function isBotGuid(guid: string): boolean {
  try {
    const hex = BigInt(guid).toString(16);
    return hex.length === 15 && hex.startsWith('b07');
  } catch {
    return false;
  }
}

/** Nombres que no aportan identidad (nunca crean alias ni cuentan como conflicto). */
function isMeaninglessName(name: string): boolean {
  const cleaned = stripColorCodes(name).trim();
  return cleaned === '' || cleaned.toLowerCase() === 'unknown';
}

export interface PlayerAliasUpsert {
  guid: string;
  name: string;
  server: string | null;
  when: Date;
}

/**
 * Upsert de un alias (guid, name): existe → lastSeenAt=max, lastServer si viene,
 * occurrences+1; no existe → crea con firstSeenAt=lastSeenAt=when.
 * Los nombres vacíos/'unknown' se ignoran (no aportan identidad).
 * BOTS (2026-11-11): los guids del rango 0xb07… NUNCA crean alias — los bots
 * ya no tienen Player row (cero estadística de bot) y PlayerAlias tiene FK a
 * Player: crear un alias de bot fallaría y re-crearía identidad de bot.
 */
export async function upsertPlayerAlias(input: PlayerAliasUpsert): Promise<boolean> {
  if (isBotGuid(input.guid)) return false;
  if (isMeaninglessName(input.name)) return false;
  await prisma.playerAlias.upsert({
    where: { guid_name: { guid: input.guid, name: input.name } },
    create: {
      guid: input.guid,
      name: input.name,
      firstSeenAt: input.when,
      lastSeenAt: input.when,
      lastServer: input.server,
      occurrences: 1,
    },
    update: {
      lastSeenAt: input.when,
      occurrences: { increment: 1 },
      ...(input.server !== null ? { lastServer: input.server } : {}),
    },
  });
  return true;
}

export interface PlayerAliasDto {
  name: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
}

/** Historial de alias para el perfil: excluye el nombre actual, máx 10, último visto primero. */
export async function getPlayerAliases(guid: string, currentName: string, limit = 10): Promise<PlayerAliasDto[]> {
  const rows = await prisma.playerAlias.findMany({
    where: { guid, name: { not: currentName } },
    orderBy: [{ lastSeenAt: 'desc' }],
    take: limit,
    select: { name: true, firstSeenAt: true, lastSeenAt: true, occurrences: true },
  });
  return rows.map((row) => ({
    name: row.name,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    occurrences: row.occurrences,
  }));
}

// ── Detección de conflictos (read-only, para el panel admin) ────────────────

export interface AliasConflictGuidRow {
  guid: string;
  /** Nombre EXACTO más reciente visto con esta clave para el guid. */
  name: string;
  /** true = guid con cuenta web vinculada. */
  linked: boolean;
  /** Email de la cuenta vinculada (solo se expone por un endpoint ADMIN). */
  linkedAccountId: number | null;
  linkedEmail: string | null;
  isBot: boolean;
  lastSeenAt: string;
  /** Suma de apariciones de TODAS las variantes del nombre para este guid. */
  occurrences: number;
}

export interface NameCollisionDto {
  /** Clave normalizada (cleanName sin ^X, lowercase) que colisiona. */
  nameKey: string;
  /** Nombre exacto más reciente del grupo (para pintar). */
  displayName: string;
  /** Cuentas web DISTINTAS vinculadas a los guids del grupo. */
  distinctAccounts: number;
  /** 'high' = ≥2 guids del grupo linked a cuentas DISTINTAS (conflicto real de personas). */
  severity: 'high' | 'low';
  guids: AliasConflictGuidRow[];
}

export interface MultiAliasGuidDto {
  guid: string;
  /** Nombre ACTUAL del Player (fuera del conteo de alias). */
  name: string;
  linked: boolean;
  isBot: boolean;
  /** Claves limpias DISTINTAS ≠ nombre actual (≥2 → perfil compartido/rotado). */
  aliasCount: number;
  aliases: PlayerAliasDto[];
}

export interface AliasConflictsDto {
  /** Tipo 1: un mismo displayName usado por ≥2 GUIDs distintos. */
  nameCollisions: NameCollisionDto[];
  /** Tipo 2: un mismo GUID con ≥2 alias distintos ≠ nombre actual. */
  sharedGuids: MultiAliasGuidDto[];
  generatedAt: string;
}

/**
 * Detecta los DOS tipos de conflicto (read-only, sin acciones automáticas):
 *
 *  1. Colisión de nombre: un mismo name (case-insensitive, comparando cleanName
 *     sin códigos ^X) usado por ≥2 GUIDs distintos. Ordenado por gravedad:
 *     primero los grupos con ≥2 guids linked a cuentas DISTINTAS (dos personas
 *     reales usando el mismo alias → riesgo de atribución), luego por nº de
 *     cuentas implicadas y nº de guids.
 *  2. Guid con nombre histórico múltiple: un mismo guid con ≥2 alias distintos
 *     ≠ nombre actual (señal de perfil compartido o renombrado en la misma PC).
 */
export async function getAliasConflicts(): Promise<AliasConflictsDto> {
  const [aliases, players, links] = await Promise.all([
    prisma.playerAlias.findMany({
      select: { guid: true, name: true, firstSeenAt: true, lastSeenAt: true, occurrences: true },
    }),
    prisma.player.findMany({ select: { guid: true, name: true } }),
    prisma.accountLink.findMany({
      select: { guid: true, userId: true, user: { select: { email: true } } },
    }),
  ]);

  const playerNameByGuid = new Map(players.map((p) => [p.guid, p.name] as const));
  const linkByGuid = new Map(links.map((l) => [l.guid, l] as const));

  // Agrega filas por (guid, clave limpia): un guid puede tener 'Snake' y 'Snake^1'.
  interface KeyRow {
    guid: string;
    displayName: string; // nombre exacto más reciente
    lastSeenAt: Date;
    firstSeenAt: Date;
    occurrences: number;
  }
  const byKey = new Map<string, Map<string, KeyRow>>(); // nameKey → guid → row
  for (const row of aliases) {
    const key = aliasKey(row.name);
    if (key === '' || key === 'unknown') continue; // ruido sin identidad
    let perGuid = byKey.get(key);
    if (!perGuid) {
      perGuid = new Map();
      byKey.set(key, perGuid);
    }
    const current = perGuid.get(row.guid);
    if (!current) {
      perGuid.set(row.guid, {
        guid: row.guid,
        displayName: row.name,
        lastSeenAt: row.lastSeenAt,
        firstSeenAt: row.firstSeenAt,
        occurrences: row.occurrences,
      });
    } else {
      // Variante del mismo nombre limpio: representa con la fila más reciente.
      if (row.lastSeenAt > current.lastSeenAt) {
        current.displayName = row.name;
        current.lastSeenAt = row.lastSeenAt;
      }
      if (row.firstSeenAt < current.firstSeenAt) current.firstSeenAt = row.firstSeenAt;
      current.occurrences += row.occurrences;
    }
  }

  const buildGuidRow = (row: KeyRow): AliasConflictGuidRow => {
    const link = linkByGuid.get(row.guid);
    return {
      guid: row.guid,
      name: row.displayName,
      linked: link !== undefined,
      linkedAccountId: link?.userId ?? null,
      linkedEmail: link?.user.email ?? null,
      isBot: isBotGuid(row.guid),
      lastSeenAt: row.lastSeenAt.toISOString(),
      occurrences: row.occurrences,
    };
  };

  // ── Tipo 1: colisiones de nombre (≥2 guids con la misma clave) ─────────────
  const nameCollisions: NameCollisionDto[] = [];
  for (const [nameKey, perGuid] of byKey) {
    if (perGuid.size < 2) continue;
    const rows = [...perGuid.values()].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
    const guidRows = rows.map(buildGuidRow);
    const accountIds = new Set(guidRows.map((r) => r.linkedAccountId).filter((id): id is number => id !== null));
    nameCollisions.push({
      nameKey,
      displayName: rows[0]?.displayName ?? nameKey,
      distinctAccounts: accountIds.size,
      severity: accountIds.size >= 2 ? 'high' : 'low',
      guids: guidRows,
    });
  }
  nameCollisions.sort(
    (a, b) =>
      (a.severity === 'high' ? 0 : 1) - (b.severity === 'high' ? 0 : 1) ||
      b.distinctAccounts - a.distinctAccounts ||
      b.guids.length - a.guids.length ||
      a.nameKey.localeCompare(b.nameKey),
  );

  // ── Tipo 2: guids con ≥2 alias históricos ≠ nombre actual ──────────────────
  const byGuid = new Map<string, typeof aliases>();
  for (const row of aliases) {
    if (aliasKey(row.name) === '' || aliasKey(row.name) === 'unknown') continue;
    const list = byGuid.get(row.guid);
    if (list) list.push(row);
    else byGuid.set(row.guid, [row]);
  }

  const sharedGuids: MultiAliasGuidDto[] = [];
  for (const [guid, rows] of byGuid) {
    const currentName = playerNameByGuid.get(guid) ?? '';
    const currentKey = aliasKey(currentName);
    const historic = rows.filter((row) => aliasKey(row.name) !== currentKey);
    const distinctKeys = new Set(historic.map((row) => aliasKey(row.name)));
    if (distinctKeys.size < 2) continue; // 0 o 1 nombre histórico ≠ actual: normal
    const sorted = [...historic].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
    sharedGuids.push({
      guid,
      name: currentName,
      linked: linkByGuid.has(guid),
      isBot: isBotGuid(guid),
      aliasCount: distinctKeys.size,
      aliases: sorted.slice(0, 10).map((row) => ({
        name: row.name,
        firstSeenAt: row.firstSeenAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
        occurrences: row.occurrences,
      })),
    });
  }
  sharedGuids.sort((a, b) => b.aliasCount - a.aliasCount || a.guid.localeCompare(b.guid));

  return { nameCollisions, sharedGuids, generatedAt: new Date().toISOString() };
}

// ── Bootstrap de datos existentes (npm run rebuild:aliases) ─────────────────

export interface RebuildAliasesResult {
  playersScanned: number;
  /** Filas de alias creadas/actualizadas desde Player (nombre actual). */
  aliasesFromPlayers: number;
  /** ¿Se escaneó el games_mp.log crudo desde el byte 0? */
  logScanned: boolean;
  logLinesParsed: number;
  /** Pares (guid, name) distintos encontrados en el log. */
  logAliasPairs: number;
  /** Filas creadas solo gracias al log (nombres HISTÓRICOS, ej. renombres). */
  aliasesFromLog: number;
}

/**
 * Bootstrap IDEMPOTENTE del historial de alias para datos ya existentes.
 *
 * MÉTODO (documentado por decisión de diseño): ni KillEvent ni Session guardan
 * nombres (revisión real del schema: solo guids + aggregates). Las únicas dos
 * fuentes de nombres son:
 *
 *  A. Player.name (nombre ACTUAL de cada guid) → siembra/normaliza el alias
 *     actual: occurrences ≈ connections (≥1), fechas = first/lastConnection,
 *     lastServer del player. Escritura ABSOLUTA con max()/min() → re-ejecutar
 *     no infla nada (idempotente) y nunca regresa un valor ya incrementado
 *     por la ingesta viva.
 *
 *  B. Re-escaneo del games_mp.log CRUDO desde el byte 0 (si existe): recuenta
 *     J/K por (guid, name) y descubre nombres HISTÓRICOS que ya no son el
 *     nombre actual (renombres). occurrences = max(existente, conteo del log);
 *     fechas aproximadas con las del player (el log no lleva timestamp
 *     absoluto, solo m:ss de juego).
 *
 * El script CLI vive en src/scripts/rebuild-aliases.ts; esta función es el
 * núcleo reutilizable (también la usan los tests).
 */
export async function rebuildAliases(options: { logPath?: string | null }): Promise<RebuildAliasesResult> {
  const result: RebuildAliasesResult = {
    playersScanned: 0,
    aliasesFromPlayers: 0,
    logScanned: false,
    logLinesParsed: 0,
    logAliasPairs: 0,
    aliasesFromLog: 0,
  };
  const now = new Date();

  // ── Pasada A: nombre actual de cada Player ────────────────────────────────
  const players = await prisma.player.findMany();
  result.playersScanned = players.length;
  for (const player of players) {
    // Bootstrap de isBot (set absoluto → idempotente): guid del rango 0xb07… → bot.
    const shouldBeBot = isBotGuid(player.guid);
    if (player.isBot !== shouldBeBot) {
      await prisma.player.update({ where: { id: player.id }, data: { isBot: shouldBeBot } });
    }
    if (isMeaninglessName(player.name)) continue;
    const first = player.firstConnection ?? player.updatedAt ?? now;
    const last = player.lastConnection ?? player.updatedAt ?? now;
    const minOccurrences = Math.max(1, player.connections);
    const existing = await prisma.playerAlias.findUnique({
      where: { guid_name: { guid: player.guid, name: player.name } },
    });
    if (!existing) {
      await prisma.playerAlias.create({
        data: {
          guid: player.guid,
          name: player.name,
          firstSeenAt: first,
          lastSeenAt: last,
          lastServer: player.lastServer,
          occurrences: minOccurrences,
        },
      });
    } else {
      // Monótono (max/min): re-ejecutar el bootstrap NO infla ni regresa valores.
      await prisma.playerAlias.update({
        where: { id: existing.id },
        data: {
          firstSeenAt: existing.firstSeenAt < first ? existing.firstSeenAt : first,
          lastSeenAt: existing.lastSeenAt > last ? existing.lastSeenAt : last,
          lastServer: player.lastServer ?? existing.lastServer,
          occurrences: Math.max(existing.occurrences, minOccurrences),
        },
      });
    }
    result.aliasesFromPlayers += 1;
  }

  // ── Pasada B: re-escaneo del log crudo (nombres históricos) ────────────────
  const logPath = options.logPath ?? null;
  if (logPath) {
    let raw: string;
    try {
      raw = readFileSync(logPath, 'utf8');
    } catch {
      return result; // log inaccesible: la pasada A ya dejó el bootstrap mínimo
    }
    result.logScanned = true;

    const counts = new Map<string, number>(); // `${guid}\u0000${name}` → apariciones
    for (const line of raw.split('\n')) {
      let event: ReturnType<typeof parseGameLogLine> = null;
      try {
        event = parseGameLogLine(line);
      } catch {
        continue;
      }
      if (!event || event === 'ignored') continue;
      // BOTS (2026-11-11): sus pares (guid, name) del log se DESCARTAN — los
      // bots no tienen Player row (FK de PlayerAlias) ni alias (cero
      // estadística de bot). Sin este skip, el create de un alias de bot
      // fallaría por FK.
      if (event.kind === 'connect') {
        if (isBotGuid(event.guid)) continue;
        if (!isMeaninglessName(event.name)) {
          const key = `${event.guid}\u0000${event.name}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      } else if (event.kind === 'kill') {
        // Semántica de esta build: killerName (2º bloque) y victimName (1er bloque).
        // A los efectos de alias el rol no importa: ambos participantes cuentan.
        const killerIsBot = event.killerGuid !== null && isBotGuid(event.killerGuid);
        if (!killerIsBot && !isMeaninglessName(event.killerName ?? '')) {
          const key = `${event.killerGuid}\u0000${event.killerName}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        // Víctima "world" no tiene guid (killerGuid null) → skip.
        if (
          !isBotGuid(event.victimGuid) &&
          event.victimGuid !== event.killerGuid &&
          event.victimName &&
          !isMeaninglessName(event.victimName)
        ) {
          const key = `${event.victimGuid}\u0000${event.victimName}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      result.logLinesParsed += 1;
    }
    result.logAliasPairs = counts.size;

    const datesByGuid = new Map(players.map((p) => [p.guid, p] as const));
    for (const [key, count] of counts) {
      const [guid, name] = key.split('\u0000');
      if (!guid || !name) continue;
      const player = datesByGuid.get(guid);
      // El log no tiene timestamps absolutos: mejor aproximación disponible.
      const first = player?.firstConnection ?? now;
      const last = player?.lastConnection ?? now;
      const existing = await prisma.playerAlias.findUnique({
        where: { guid_name: { guid, name } },
      });
      if (!existing) {
        await prisma.playerAlias.create({
          data: {
            guid,
            name,
            firstSeenAt: first,
            lastSeenAt: last,
            lastServer: player?.lastServer ?? null,
            occurrences: count,
          },
        });
        result.aliasesFromLog += 1;
      } else if (count > existing.occurrences) {
        await prisma.playerAlias.update({ where: { id: existing.id }, data: { occurrences: count } });
      }
    }
  }

  return result;
}
