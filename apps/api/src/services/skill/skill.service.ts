import { prisma } from '../../lib/prisma.js';
import { SKILL, clampAndBonus, clampElo, killEloDelta, round2, streakBonus } from './elo.js';

/**
 * Procesamiento INCREMENTAL del skill (ELO) sobre los KillEvents:
 *  - Solo toma eventos con `skillProcessed = false` (los nuevos de cada sync).
 *  - Orden de procesamiento: timeEpoch ASC, id ASC (determinista; el desempate
 *    por id soporta eventos cronológicos duplicados).
 *  - Mantiene el ELO en memoria POR LOTE y lo persiste (con el flag) en una
 *    transacción por lote → si el proceso muere a mitad, el lote pendiente se
 *    re-procesa entero (nada queda procesado sin skill aplicado).
 *  - Al final inicializa a 1000 a los players que no aparecen en ningún evento.
 *
 * RECOMPUTE FROM SCRATCH (bootstrap): como los eventos quedan con
 * `skillProcessed = false` por default, tras la migración el primer sync
 * procesa TODOS los KillEvent existentes en orden cronológico. Para forzarlo
 * de nuevo está `npm run recompute:skill` (src/scripts/recompute-skill.ts).
 */

const SKILL_EVENT_BATCH = 2_000;

export interface SkillProcessResult {
  /** Eventos que se marcaron como procesados (incluye no-kill y teamkill). */
  processed: number;
  batches: number;
  /** Players inicializados a 1000 (no participan de ningún evento). */
  initialized: number;
}

interface EventRow {
  id: number;
  originGuid: string;
  targetGuid: string | null;
  isKill: boolean;
  isTeamkill: boolean;
  headshot: boolean;
  hitloc: string | null;
  damage: number;
}

export async function processSkillUpdates(): Promise<SkillProcessResult> {
  let processed = 0;
  let batches = 0;

  for (;;) {
    const batch = await prisma.killEvent.findMany({
      where: { skillProcessed: false },
      orderBy: [{ timeEpoch: 'asc' }, { id: 'asc' }],
      take: SKILL_EVENT_BATCH,
      select: {
        id: true,
        originGuid: true,
        targetGuid: true,
        isKill: true,
        isTeamkill: true,
        headshot: true,
        hitloc: true,
        damage: true,
      },
    });
    if (batch.length === 0) break;
    batches += 1;

    await processBatch(batch as EventRow[]);
    processed += batch.length;
    if (batch.length < SKILL_EVENT_BATCH) break;
  }

  // Players que NO participan de ningún evento: skill inicial 1000.
  const initialized = await prisma.player.updateMany({
    where: { skillElo: { equals: 0 } },
    data: { skillElo: SKILL.START, skill: SKILL.START },
  });

  return { processed, batches, initialized: initialized.count };
}

async function processBatch(batch: EventRow[]): Promise<void> {
  const guids = new Set<string>();
  for (const event of batch) {
    guids.add(event.originGuid);
    if (event.targetGuid !== null && event.targetGuid !== '') guids.add(event.targetGuid);
  }

  const rows = await prisma.player.findMany({
    where: { guid: { in: [...guids] } },
    select: { guid: true, bestStreak: true, skillElo: true },
  });
  const rowByGuid = new Map(rows.map((row) => [row.guid, row] as const));

  // ELO vigente al empezar el lote (0 = nunca procesado → START).
  const elo = new Map<string, number>();
  for (const guid of guids) {
    const row = rowByGuid.get(guid);
    elo.set(guid, row !== undefined && row.skillElo > 0 ? row.skillElo : SKILL.START);
  }

  // Aplica los eventos EN ORDEN sobre el estado en memoria. El clamp y el
  // redondeo se aplican INLINE tras cada evento para que el resultado sea
  // independientemente de cómo caigan los límites de lote (partiduras de lote distintos → mismo skill).
  const clampRound = (value: number): number => round2(clampElo(value));
  for (const event of batch) {
    if (!event.isKill) continue; // evento no letal: no mueve ELO (solo se marca procesado)

    const victimGuid = event.targetGuid === '' ? null : event.targetGuid;
    const originElo = elo.get(event.originGuid) ?? SKILL.START;

    // World/suicidio (defensivo: la ingesta por log no almacena estos casos):
    // sin atacante no hay pool de quien robar → pérdida plana pequeña.
    if (victimGuid === null || victimGuid === event.originGuid) {
      elo.set(event.originGuid, clampRound(originElo - SKILL.WORLD_LOSS));
      continue;
    }

    if (event.isTeamkill) {
      // Teamkill: penalidad plana al atacante; la víctima no gana nada.
      elo.set(event.originGuid, clampRound(originElo - SKILL.TEAMKILL_PENALTY));
      continue;
    }

    const victimElo = elo.get(victimGuid) ?? SKILL.START;
    const delta = killEloDelta(originElo, victimElo, {
      isKill: event.isKill,
      isTeamkill: event.isTeamkill,
      headshot: event.headshot,
      hitloc: event.hitloc,
      damage: event.damage,
    });
    elo.set(event.originGuid, clampRound(originElo + delta));
    elo.set(victimGuid, clampRound(victimElo - delta));
  }

  // Persistencia atómica del lote: skill + flag de eventos.
  const operations: Array<ReturnType<typeof prisma.player.create | typeof prisma.player.update | typeof prisma.killEvent.updateMany>> = [];
  for (const guid of guids) {
    const row = rowByGuid.get(guid);
    const newElo = clampRound(elo.get(guid) ?? SKILL.START);
    if (row === undefined) {
      // GUID huérfano (evento insertado sin Player): se crea solo con el ELO actual.
      operations.push(
        prisma.player.create({
          data: { guid, name: 'unknown', skillElo: newElo, skill: clampAndBonus(newElo, 0) },
        }),
      );
      continue;
    }
    operations.push(
      prisma.player.update({
        where: { guid },
        data: { skillElo: newElo, skill: clampAndBonus(newElo, row.bestStreak) },
      }),
    );
  }
  operations.push(
    prisma.killEvent.updateMany({
      where: { id: { in: batch.map((event) => event.id) } },
      data: { skillProcessed: true },
    }),
  );
  await prisma.$transaction(operations);
}
