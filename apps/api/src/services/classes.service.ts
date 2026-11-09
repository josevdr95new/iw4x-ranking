import { prisma } from '../lib/prisma.js';
import { Errors } from '../lib/errors.js';
import {
  NUM_CUSTOM_CLASSES,
  parseConsoleLog,
  type ParsedLoadoutClass,
} from '../lib/classes/parse-console-log.js';
import type { SaveClassesInput } from '../dto/classes.dto.js';

export interface SaveClassesResult {
  guid: string;
  classesUpdatedAt: string;
  /** Clases realmente halladas en el dump (0 = dump válido pero sin clases). */
  count: number;
  classes: ParsedLoadoutClass[];
}

/**
 * Atribución del dump al Player vinculado al usuario del token:
 *  - 0 guids vinculados  → 400 SIN_IDENTITY (no hay a quién guardarle las clases).
 *  - 1 guid vinculado    → ese guid.
 *  - N guids vinculados  → el de `lastConnection` MÁS RECIENTE (PCs compartidas:
 *    el guid que el dueño usó por última vez es el que jugó con esas clases).
 *    Tie-break determinista: guids sin Player/lastConnection pierden; empate
 *    de fechas → guid alfabético. Documentado en docs/API.md.
 */
async function resolveTargetGuid(userId: number): Promise<string> {
  const links = await prisma.accountLink.findMany({
    where: { userId },
    select: { guid: true },
    orderBy: [{ id: 'asc' }],
  });
  if (links.length === 0) throw Errors.sinIdentity();
  if (links.length === 1) return links[0]!.guid;

  const players = await prisma.player.findMany({
    where: { guid: { in: links.map((link) => link.guid) } },
    select: { guid: true, lastConnection: true },
  });
  const lastConnectionByGuid = new Map(players.map((player) => [player.guid, player.lastConnection] as const));

  const sorted = [...links]
    .map((link) => ({ guid: link.guid, lastConnection: lastConnectionByGuid.get(link.guid) ?? null }))
    .sort((a, b) => {
      const aMs = a.lastConnection?.getTime() ?? -1;
      const bMs = b.lastConnection?.getTime() ?? -1;
      return bMs - aMs || a.guid.localeCompare(b.guid); // reciente primero; nulls y empates al final (determinista)
    });
  return sorted[0]!.guid;
}

/**
 * Parsea el TEXTO del dump (`/dumpPlayerData` → console_mp.log, puede venir el
 * log entero) y guarda las clases en el Player vinculado al usuario del token.
 */
export async function savePlayerClasses(userId: number, input: SaveClassesInput): Promise<SaveClassesResult> {
  const parsed = parseConsoleLog(input.dumpText);
  if (parsed.classes === null) throw Errors.classesNotFound();

  const guid = await resolveTargetGuid(userId);
  const classesUpdatedAt = new Date();

  // Upsert defensivo: el Player normalmente ya existe (sync/ingesta), pero si
  // el guid vinculado nunca sincronizó no bloqueamos la ingesta de clases.
  const player = await prisma.player.upsert({
    where: { guid },
    create: { guid, name: 'unknown', classesJson: JSON.stringify(parsed.classes), classesUpdatedAt },
    update: { classesJson: JSON.stringify(parsed.classes), classesUpdatedAt },
    select: { guid: true },
  });

  return {
    guid: player.guid,
    classesUpdatedAt: classesUpdatedAt.toISOString(),
    count: parsed.count,
    classes: parsed.classes,
  };
}

/**
 * Clases persistidas para un guid. `null` si nunca subió un dump (o si el JSON
 * guardado resultara ilegible: nunca debe pasar, pero no rompemos el perfil).
 */
export function getStoredPlayerClasses(
  classesJson: string | null,
  classesUpdatedAt: Date | null,
): { classes: ParsedLoadoutClass[] | null; classesUpdatedAt: string | null } {
  if (classesJson === null || classesUpdatedAt === null) return { classes: null, classesUpdatedAt: null };
  try {
    const parsed: unknown = JSON.parse(classesJson);
    if (!Array.isArray(parsed) || parsed.length !== NUM_CUSTOM_CLASSES) {
      return { classes: null, classesUpdatedAt: null };
    }
    return { classes: parsed as ParsedLoadoutClass[], classesUpdatedAt: classesUpdatedAt.toISOString() };
  } catch {
    return { classes: null, classesUpdatedAt: null };
  }
}
