import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { isBotGuid } from '../alias.service.js';
import { SKILL, botDecayFactor, clampAndBonus, clampElo, killEloDelta, round2, streakBonus } from './elo.js';

/**
 * Procesamiento INCREMENTAL del skill (ELO) sobre DOS streams de eventos:
 *  - KillEvent (kills por evento: intercambio ASIMÉTRICO — el atacante gana
 *    `delta × SKILL_ATTACK_GAIN_SCALE` (1.5) y la víctima pierde
 *    `delta × SKILL_VICTIM_LOSS_SCALE` (0.5); balance 2026-11-10 del dueño,
 *    inflación de ELO aceptada).
 *  - MatchBonusEvent (bonus de fin de partida: top-3 de kills entre humanos,
 *    delta directo al premiado; los crea la ingesta del log en ShutdownGame).
 *
 *  - Solo toma eventos con `skillProcessed = false` (los nuevos de cada sync).
 *  - Orden de procesamiento: (timeEpoch ASC, id ASC) sobre el STREAM COMBINADO
 *    (determinista; el desempate por id soporta eventos cronológicos
 *    duplicados de UNA tabla). El bonus de una partida siempre ordena DESPUÉS
 *    de los kills de su partida: el reader le fija un timeEpoch ESTRICTAMENTE
 *    posterior al de los kills de su pasada (minTimeEpoch, ver
 *    gamelog.reader.ts rama shutdown; el desempate por id NO es comparable
 *    entre KillEvent y MatchBonusEvent: secuencias autoincrement separadas) y
 *    ANTES de los kills de la partida siguiente → el merge respeta la
 *    cronología real.
 *  - Mantiene el ELO en memoria POR LOTE y lo persiste (con los flags) en una
 *    transacción por lote → si el proceso muere a mitad, el lote pendiente se
 *    re-procesa entero (nada queda procesado sin skill aplicado).
 *  - Al final inicializa a 1000 a los players que no aparecen en ningún evento.
 *
 * RECOMPUTE FROM SCRATCH (bootstrap): como los eventos quedan con
 * `skillProcessed = false` por default, tras la migración el primer sync
 * procesa TODOS los eventos existentes en orden cronológico. Para forzarlo
 * de nuevo está `npm run recompute:skill` (src/scripts/recompute-skill.ts):
 * desmarca KillEvent Y MatchBonusEvent, reinicia skillElo y reproduce el
 * histórico completo (kills + bonus) → mismo skill final.
 */

const SKILL_EVENT_BATCH = 2_000;
/** Los bonus son ~3 por partida: un lote pequeño basta. */
const MATCH_BONUS_BATCH = 500;

export interface SkillProcessResult {
  /** Eventos que se marcaron como procesados (incluye no-kill, teamkill y bonus). */
  processed: number;
  batches: number;
  /** Players inicializados a 1000 (no participan de ningún evento). */
  initialized: number;
}

interface KillEventRow {
  id: number;
  originGuid: string;
  targetGuid: string | null;
  isKill: boolean;
  isTeamkill: boolean;
  headshot: boolean;
  hitloc: string | null;
  damage: number;
}

interface MatchBonusEventRow {
  id: number;
  guid: string;
  delta: number;
}

/** Evento unificado del stream de skill, con su clave de orden (timeEpoch, id). */
type SkillEvent =
  | ({ kind: 'kill'; timeEpoch: number } & KillEventRow)
  | ({ kind: 'match-bonus'; timeEpoch: number } & MatchBonusEventRow);

function sortKey(event: SkillEvent): [number, number] {
  return [event.timeEpoch, event.id];
}

function compareEvents(a: SkillEvent, b: SkillEvent): number {
  const [aEpoch, aId] = sortKey(a);
  const [bEpoch, bId] = sortKey(b);
  return aEpoch - bEpoch || aId - bId;
}

export async function processSkillUpdates(): Promise<SkillProcessResult> {
  let processed = 0;
  let batches = 0;

  for (;;) {
    // Dos streams pendientes, cada uno ordenado cronológicamente. El lote es el
    // STREAM COMBINADO ordenado por (timeEpoch, id): el bonus de una partida
    // siempre ordena DESPUÉS de los kills de su partida (el reader le fija un
    // timeEpoch estrictamente posterior al de su pasada; ver gamelog.reader
    // rama shutdown) y ANTES de los kills de la partida siguiente. Sin filtros:
    // la matemática ELO aplica clamp y redondeo INLINE por evento, así el
    // resultado es independiente de por dónde caiga el límite de lote (mismo
    // invariante que los KillEvent).
    const [kills, bonuses] = await Promise.all([
      prisma.killEvent.findMany({
        where: { skillProcessed: false },
        orderBy: [{ timeEpoch: 'asc' }, { id: 'asc' }],
        take: SKILL_EVENT_BATCH,
        select: {
          id: true,
          timeEpoch: true,
          originGuid: true,
          targetGuid: true,
          isKill: true,
          isTeamkill: true,
          headshot: true,
          hitloc: true,
          damage: true,
        },
      }),
      prisma.matchBonusEvent.findMany({
        where: { skillProcessed: false },
        orderBy: [{ timeEpoch: 'asc' }, { id: 'asc' }],
        take: MATCH_BONUS_BATCH,
        select: { id: true, timeEpoch: true, guid: true, delta: true },
      }),
    ]);
    if (kills.length === 0 && bonuses.length === 0) break;
    batches += 1;

    const batch: SkillEvent[] = [
      ...kills.map((event) => ({ kind: 'kill' as const, ...event })),
      ...bonuses.map((event) => ({ kind: 'match-bonus' as const, ...event })),
    ].sort(compareEvents);

    await processBatch(batch);
    processed += batch.length;
    if (kills.length < SKILL_EVENT_BATCH && bonuses.length < MATCH_BONUS_BATCH) break;
  }

  // Players que NO participan de ningún evento: skill inicial 1000.
  const initialized = await prisma.player.updateMany({
    where: { skillElo: { equals: 0 } },
    data: { skillElo: SKILL.START, skill: SKILL.START },
  });

  return { processed, batches, initialized: initialized.count };
}

async function processBatch(batch: SkillEvent[]): Promise<void> {
  const guids = new Set<string>();
  for (const event of batch) {
    if (event.kind === 'kill') {
      guids.add(event.originGuid);
      if (event.targetGuid !== null && event.targetGuid !== '') guids.add(event.targetGuid);
    } else {
      guids.add(event.guid);
    }
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
    if (event.kind === 'match-bonus') {
      // Bonus de fin de partida: delta DIRECTO al premiado (top-3 de kills).
      elo.set(event.guid, clampRound((elo.get(event.guid) ?? SKILL.START) + event.delta));
      continue;
    }

    if (!event.isKill) continue; // evento no letal: no mueve ELO (solo se marca procesado)

    const victimGuid = event.targetGuid === '' ? null : event.targetGuid;
    const originElo = elo.get(event.originGuid) ?? SKILL.START;

    // World/suicidio (la ingesta del gamelog SÍ crea estos eventos desde
    // 2026-11-08: originGuid = víctima, targetGuid = ''): sin atacante no hay
    // pool ni ganancia → pérdida plana pequeña (WORLD_LOSS) escalada por la
    // escala de VÍCTIMA (4 × 0.5 = 2 efectivos con defaults). La escala de
    // atacante NO aplica aquí (no hay atacante).
    if (victimGuid === null || victimGuid === event.originGuid) {
      elo.set(event.originGuid, clampRound(originElo - SKILL.WORLD_LOSS * env.skillVictimLossScale));
      continue;
    }

    if (event.isTeamkill) {
      // Teamkill: penalidad plana al atacante; la víctima no gana nada.
      elo.set(event.originGuid, clampRound(originElo - SKILL.TEAMKILL_PENALTY));
      continue;
    }

    const victimElo = elo.get(victimGuid) ?? SKILL.START;
    let delta = killEloDelta(originElo, victimElo, {
      isKill: event.isKill,
      isTeamkill: event.isTeamkill,
      headshot: event.headshot,
      hitloc: event.hitloc,
      damage: event.damage,
    });

    // DECAY CONTRA BOTS (anti-farmeo): si UNO de los dos lados del kill es un
    // bot, el delta del evento se escala por botFactor(skill VIGENTE del
    // HUMANO) — con factor 1 por debajo de 1300, lineal hasta 0.15 en 2400+
    // (env BOT_ELO_DECAY_*). Contra HUMANOS el decay NO aplica: ELO pleno solo
    // jugando contra personas. Bot-vs-bot tampoco (no hay humano que farmee).
    // El factor usa el skill EN MEMORIA del momento del evento → el recompute
    // secuencial (recompute:skill) reproduce el decay naturalmente.
    const originIsBot = isBotGuid(event.originGuid);
    const victimIsBot = isBotGuid(victimGuid);
    if (originIsBot !== victimIsBot) {
      const humanElo = elo.get(originIsBot ? victimGuid : event.originGuid) ?? SKILL.START;
      delta *= botDecayFactor(humanElo, {
        min: env.botEloDecayMin,
        soft: env.botEloDecaySoft,
        hard: env.botEloDecayHard,
      });
    }

    // INTERCAMBIO ASIMÉTRICO (balance 2026-11-10, decisión del dueño): las
    // escalas se aplican al delta FINAL (tras mult de evento y decay de bots;
    // NO están dentro del cap ×1.6 de eventMult). El atacante gana
    // `delta × SKILL_ATTACK_GAIN_SCALE` (1.5: +50% al eliminar, igual vs bots
    // y vs humanos) y la víctima pierde `delta × SKILL_VICTIM_LOSS_SCALE`
    // (0.5: bajar duele la mitad). Ya no es zero-sum: inflación aceptada.
    elo.set(event.originGuid, clampRound(originElo + delta * env.skillAttackGainScale));
    elo.set(victimGuid, clampRound(victimElo - delta * env.skillVictimLossScale));
  }

  // Persistencia atómica del lote: skill + flags de eventos (por tipo).
  const operations: Array<ReturnType<typeof prisma.player.create | typeof prisma.player.update | typeof prisma.killEvent.updateMany | typeof prisma.matchBonusEvent.updateMany>> = [];
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
  const batchKillIds = batch.filter((event): event is Extract<SkillEvent, { kind: 'kill' }> => event.kind === 'kill').map((event) => event.id);
  if (batchKillIds.length > 0) {
    operations.push(
      prisma.killEvent.updateMany({
        where: { id: { in: batchKillIds } },
        data: { skillProcessed: true },
      }),
    );
  }
  const batchBonusIds = batch.filter((event) => event.kind === 'match-bonus').map((event) => event.id);
  if (batchBonusIds.length > 0) {
    operations.push(
      prisma.matchBonusEvent.updateMany({
        where: { id: { in: batchBonusIds } },
        data: { skillProcessed: true },
      }),
    );
  }
  await prisma.$transaction(operations);
}
