import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ingestGameLog, parseLogTimeSeconds } from '../src/services/sync/gamelog.reader.js';
import { prisma } from '../src/lib/prisma.js';
import { SKILL, round2 } from '../src/services/skill/elo.js';
import { matchTop3, type MatchPlayerTally } from '../src/services/skill/match-bonus.js';
import { processSkillUpdates } from '../src/services/skill/skill.service.js';
import { resetDb } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = resolve(here, 'data', 'match-bonus-games_mp.log');
const SERVER_LABEL = '192.168.3.99:28961';

// GUIDs hex sintéticos de 16 chars (formato real del games_mp.log).
const HEX_A = 'a000000000000001';
const HEX_B = 'a000000000000002';
const HEX_C = 'a000000000000003';
const HEX_D = 'a000000000000004';
const DEC_A = BigInt(`0x${HEX_A}`).toString(10);
const DEC_B = BigInt(`0x${HEX_B}`).toString(10);
const DEC_C = BigInt(`0x${HEX_C}`).toString(10);
const DEC_D = BigInt(`0x${HEX_D}`).toString(10);
const BOT7_DEC = BigInt('0xb07000000000007').toString(10);

const NAME_A = 'Alpha';
const NAME_B = 'Bravo';
const NAME_C = 'Charlie';
const NAME_D = 'Delta';

function writeLog(lines: string[]): void {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  rmSync(LOG_PATH, { force: true });
  writeFileSync(LOG_PATH, lines.map((l) => `${l}\n`).join(''), 'utf8');
}

/** Línea K de ESTA build: PRIMER bloque = VÍCTIMA, SEGUNDO = KILLER. */
function killLine(at: string, victimHex: string, victimName: string, killerHex: string, killerName: string): string {
  return `${at} K;${victimHex};0;axis;${victimName};${killerHex};1;allies;${killerName};ak47;100;MOD_RIFLE_BULLET;torso_lower`;
}

/**
 * Arma una partida sintética: InitGame + J de los humanos que matan + kills
 * según el tally pedido + ShutdownGame (opcional, con su segundo de log).
 * `kills[guid]` = kills que ese humano consigue (la víctima rota entre los demás).
 */
function buildMatch(opts: {
  kills: Map<string, number>; // guid DECIMAL → kills del humano en la partida
  initAt?: string; // segundo de log del InitGame (default "0:00")
  shutdownAt?: string | null; // segundo de log del ShutdownGame (default "5:00"); null = sin shutdown
  withInitGame?: boolean; // default true; false = log arranca a mitad de partida
}): string[] {
  const hexByName: Record<string, [string, string]> = {
    [DEC_A]: [HEX_A, NAME_A],
    [DEC_B]: [HEX_B, NAME_B],
    [DEC_C]: [HEX_C, NAME_C],
    [DEC_D]: [HEX_D, NAME_D],
  };
  const lines: string[] = [];
  if (opts.withInitGame !== false) {
    lines.push(`${opts.initAt ?? '0:00'} InitGame: \\g_gametype\\war\\map\\mp_rust\\`);
  }
  // Conectan SOLO los humanos del tally (son los participantes de la partida).
  for (const guid of opts.kills.keys()) {
    const entry = hexByName[guid];
    if (entry) lines.push(`0:04 J;${entry[0]};${lines.length};${entry[1]}`);
  }
  let tick = 10;
  const victims = Object.entries(hexByName);
  for (const [killerGuid, count] of opts.kills) {
    const killer = hexByName[killerGuid];
    if (!killer) continue; // bot: sus líneas se construyen a mano
    for (let i = 0; i < count; i += 1) {
      const victim = victims.find(([guid]) => guid !== killerGuid)![1];
      lines.push(killLine(`${Math.floor(tick / 60)}:${String(tick % 60).padStart(2, '0')}`, victim[0], victim[1], killer[0], killer[1]));
      tick += 5;
    }
  }
  if (opts.shutdownAt !== null) {
    lines.push(`${opts.shutdownAt ?? '5:00'} ShutdownGame:`);
  }
  return lines;
}

async function bonusRows(): Promise<Array<{ guid: string; position: number; delta: number; killsInMatch: number; humansInMatch: number; matchDurationSec: number; map: string | null; gametype: string | null }>> {
  const rows = await prisma.matchBonusEvent.findMany({ orderBy: [{ position: 'asc' }] });
  return rows.map((row) => ({
    guid: row.guid,
    position: row.position,
    delta: row.delta,
    killsInMatch: row.killsInMatch,
    humansInMatch: row.humansInMatch,
    matchDurationSec: row.matchDurationSec,
    map: row.map,
    gametype: row.gametype,
  }));
}

beforeAll(async () => {
  await resetDb();
});

describe('parseLogTimeSeconds (reloj de partida del log)', () => {
  it('convierte el prefijo m:ss a segundos y devuelve null sin prefijo válido', () => {
    expect(parseLogTimeSeconds('  0:04 K;x;y')).toBe(4);
    expect(parseLogTimeSeconds('12:03 ShutdownGame:')).toBe(723);
    expect(parseLogTimeSeconds('  0:00 InitGame: \\map\\mp_rust\\')).toBe(0);
    expect(parseLogTimeSeconds('sin prefijo')).toBeNull();
    expect(parseLogTimeSeconds('  x:99 InitGame')).toBeNull();
  });
});

describe('matchTop3 (puro: ranking determinista del bonus)', () => {
  const tally = (entries: Array<[string, number, number, string]>): Map<string, MatchPlayerTally> =>
    new Map(entries.map(([guid, kills, deaths, name]) => [guid, { kills, deaths, name }] as const));

  it('top-3 correcto: 1º +15, 2º +10, 3º +5 por kills DESC', () => {
    const awards = matchTop3(tally([
      [DEC_A, 10, 4, NAME_A],
      [DEC_B, 8, 6, NAME_B],
      [DEC_C, 5, 9, NAME_C],
    ]));
    expect(awards).toEqual([
      { guid: DEC_A, position: 1, delta: 15 },
      { guid: DEC_B, position: 2, delta: 10 },
      { guid: DEC_C, position: 3, delta: 5 },
    ]);
  });

  it('humano con <5 kills NO califica (aunque haya hueco en el 3º)', () => {
    const awards = matchTop3(tally([
      [DEC_A, 8, 2, NAME_A],
      [DEC_B, 6, 3, NAME_B],
      [DEC_C, 4, 9, NAME_C], // 4 kills < 5: fuera
    ]));
    expect(awards).toEqual([
      { guid: DEC_A, position: 1, delta: 15 },
      { guid: DEC_B, position: 2, delta: 10 },
    ]);
  });

  it('los BOTS nunca califican (defensivo: el tally del reader ya los excluye)', () => {
    const awards = matchTop3(tally([
      [BOT7_DEC, 30, 0, 'BotSeven'], // el bot lidera por kills…
      [DEC_A, 8, 2, NAME_A],
      [DEC_B, 6, 3, NAME_B],
    ]));
    expect(awards.map((award) => award.guid)).toEqual([DEC_A, DEC_B]); // …y no recibe nada
  });

  it('<2 humanos en la partida → sin bonus', () => {
    expect(matchTop3(tally([[DEC_A, 20, 0, NAME_A]]))).toEqual([]);
    expect(matchTop3(tally([]))).toEqual([]);
  });

  it('desempate determinista: kills DESC → deaths ASC → name ASC', () => {
    const awards = matchTop3(tally([
      [DEC_A, 7, 5, NAME_A],
      [DEC_B, 7, 3, NAME_B], // mismas kills, menos muertes: gana el desempate
      [DEC_C, 5, 1, NAME_C],
    ]));
    expect(awards.map((award) => award.guid)).toEqual([DEC_B, DEC_A, DEC_C]);

    const byName = matchTop3(tally([
      ['900000000000000001', 7, 3, 'Zulu'],
      ['900000000000000002', 7, 3, 'Alpha'], // kills y deaths iguales: name ASC
      [DEC_C, 5, 1, NAME_C],
    ]));
    expect(byName.map((award) => award.guid)).toEqual(['900000000000000002', '900000000000000001', DEC_C]);
  });
});

describe('bonus top-3 por partida (ingesta del log + skill ELO)', () => {
  beforeEach(async () => {
    await resetDb();
    rmSync(LOG_PATH, { force: true });
  });

  it('partida completa (3 humanos ≥5 kills, ≥3 min): +15/+10/+5 a los correctos y ELO aplicado', async () => {
    const kills = new Map<string, number>([
      [DEC_A, 7], // 1º
      [DEC_B, 6], // 2º
      [DEC_C, 5], // 3º
    ]);
    writeLog(buildMatch({ kills, shutdownAt: '5:00' }));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    spy.mockRestore();

    expect(result.ok).toBe(true);
    expect(result.matchBonusEventsSynced).toBe(3);
    const rows = await bonusRows();
    expect(rows).toEqual([
      { guid: DEC_A, position: 1, delta: 15, killsInMatch: 7, humansInMatch: 3, matchDurationSec: 300, map: 'mp_rust', gametype: 'war' },
      { guid: DEC_B, position: 2, delta: 10, killsInMatch: 6, humansInMatch: 3, matchDurationSec: 300, map: 'mp_rust', gametype: 'war' },
      { guid: DEC_C, position: 3, delta: 5, killsInMatch: 5, humansInMatch: 3, matchDurationSec: 300, map: 'mp_rust', gametype: 'war' },
    ]);

    // El bonus se aplica vía processSkillUpdates (mismo mecanismo que los kills):
    // skills calculados (antes del proceso están a 0) y bonus marcados procesados.
    const processed = await processSkillUpdates();
    expect(processed.processed).toBe(18 + 3); // 18 kills + 3 bonus
    for (const guid of [DEC_A, DEC_B, DEC_C]) {
      const row = await prisma.player.findUniqueOrThrow({ where: { guid } });
      expect(row.skillElo).not.toBe(0);
    }
    const pendingBonus = await prisma.matchBonusEvent.count({ where: { skillProcessed: false } });
    expect(pendingBonus).toBe(0);
    // El delta EXACTO (+15/+10/+5) se verifica en el test "el delta del bonus es EXACTO".
  });

  it('el delta del bonus es EXACTO: mismas kills con y sin ShutdownGame → diferencia = +15/+10/+5', async () => {
    // NOTA SOBRE DETERMINISMO (causa raíz del flaky de CI, 3 pushes rojos
    // 2026-11-08): este test compara dos ingestas con `toBe` EXACTO sobre
    // skillElo absoluto, así que exige que el stream de skill ordene IGUAL en
    // ambas. El orden es (timeEpoch, id); el timeEpoch de los eventos NO sale
    // de los prefijos m:ss del log (el reader los descarta: es el reloj de
    // PARTIDA, no wall-clock) sino de Date.now() de la ingesta → las dos
    // corridas tienen epochs distintos ENTRE SÍ, pero eso es inocuo (cada
    // corrida se procesa por separado). El flaky real era DENTRO de la corrida
    // 2: los kills de una pasada llevan el epoch del INICIO de la pasada y el
    // bonus llevaba SU PROPIO Date.now() al ShutdownGame → si la ingesta cabía
    // en <1s (CI ubuntu rápida) compartían segundo y el desempate por id
    // comparaba ids de TABLAS DISTINTAS (secuencias autoincrement
    // independientes: ids de bonus ≪ ids de kill) → el bonus ordenaba ANTES de
    // los kills de su propia partida y el delta real daba ≠ +15
    // (899.52 vs 903.17). Fix de raíz: el reader fija al bonus un floor de
    // epoch estrictamente posterior a su pasada (gamelog.reader.ts, rama
    // shutdown, minTimeEpoch) → orden determinista aquí y en producción
    // (recompute:skill reproduce los epochs GUARDADOS, que ya no dependen de
    // la velocidad de la máquina).
    const kills = new Map<string, number>([
      [DEC_A, 7],
      [DEC_B, 6],
      [DEC_C, 5],
    ]);

    // RUN 1: misma partida SIN ShutdownGame (no hay bonus) → skills base.
    writeLog(buildMatch({ kills, shutdownAt: null }));
    await ingestGameLog(LOG_PATH, SERVER_LABEL);
    await processSkillUpdates();
    const base = new Map(
      (await prisma.player.findMany({ where: { guid: { in: [DEC_A, DEC_B, DEC_C] } } }))
        .map((row) => [row.guid, row.skillElo] as const),
    );

    // RUN 2: idéntica partida CON ShutdownGame → skills base + delta del bonus.
    await resetDb();
    writeLog(buildMatch({ kills, shutdownAt: '5:00' }));
    await ingestGameLog(LOG_PATH, SERVER_LABEL);

    // Invariante de orden (regresión del bug de CI): el bonus queda
    // ESTRICTAMENTE DESPUÉS de los kills de su partida, haya o no cambio de
    // segundo durante la ingesta.
    const killEpoch = (await prisma.killEvent.findFirst({ select: { timeEpoch: true } }))!.timeEpoch;
    const bonusEpoch = (await prisma.matchBonusEvent.findFirst({ select: { timeEpoch: true } }))!.timeEpoch;
    expect(bonusEpoch).toBeGreaterThan(killEpoch);

    await processSkillUpdates();
    for (const [guid, delta] of [[DEC_A, 15], [DEC_B, 10], [DEC_C, 5]] as const) {
      const row = await prisma.player.findUniqueOrThrow({ where: { guid } });
      // La DIFERENCIA entre escenarios mide EXACTAMENTE lo que dice el test
      // (final − base = bonus, sin contaminación del orden de los kills).
      expect(round2(row.skillElo - base.get(guid)!)).toBe(delta);
      // Absoluto exacto (round2 estable): legítimo ahora que el orden del
      // stream es determinista (invariante de arriba).
      expect(row.skillElo).toBe(round2(base.get(guid)! + delta));
    }
  });

  it('log claro por consola: "Bonus top-3 partida: 1º <nick> +15, 2º <nick> +10, 3º <nick> +5"', async () => {
    const kills = new Map<string, number>([
      [DEC_A, 7],
      [DEC_B, 6],
      [DEC_C, 5],
    ]);
    writeLog(buildMatch({ kills, shutdownAt: '5:00' }));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await ingestGameLog(LOG_PATH, SERVER_LABEL);
    const logged = spy.mock.calls.map((call) => call.map(String).join(' ')).find((line) => line.includes('Bonus top-3'));
    spy.mockRestore();
    expect(logged).toBeDefined();
    expect(logged).toContain('Bonus top-3 partida: 1º Alpha +15, 2º Bravo +10, 3º Charlie +5');
  });

  it('humano con <5 kills no califica aunque haya 3 premios que repartir', async () => {
    const kills = new Map<string, number>([
      [DEC_A, 8],
      [DEC_B, 6],
      [DEC_C, 4], // <5: fuera (solo 2 premios)
    ]);
    writeLog(buildMatch({ kills, shutdownAt: '5:00' }));
    const result = await ingestGameLog(LOG_PATH, SERVER_LABEL);

    expect(result.matchBonusEventsSynced).toBe(2);
    const rows = await bonusRows();
    expect(rows.map((row) => [row.guid, row.delta])).toEqual([[DEC_A, 15], [DEC_B, 10]]);
    expect(rows.some((row) => row.guid === DEC_C)).toBe(false);
  });

  it('los BOTS nunca reciben bonus aunque lideren la partida en kills', async () => {
    // El bot mata a Alpha 12 veces (lidia por kills); Alpha y Bravo sí se matan entre ellos.
    const lines = [
      '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
      `  0:04 J;${HEX_A};0;${NAME_A}`,
      `  0:05 J;${HEX_B};1;${NAME_B}`,
      '  0:06 J;bot7;7;BotSeven',
    ];
    let tick = 10;
    for (let i = 0; i < 12; i += 1) {
      // ESTA build: víctima (1º) = Alpha; killer (2º) = bot7.
      lines.push(killLine(`${Math.floor(tick / 60)}:${String(tick % 60).padStart(2, '0')}`, HEX_A, NAME_A, 'bot7', 'BotSeven'));
      tick += 3;
    }
    for (let i = 0; i < 7; i += 1) {
      lines.push(killLine(`${Math.floor(tick / 60)}:${String(tick % 60).padStart(2, '0')}`, HEX_B, NAME_B, HEX_A, NAME_A));
      tick += 3;
    }
    for (let i = 0; i < 6; i += 1) {
      lines.push(killLine(`${Math.floor(tick / 60)}:${String(tick % 60).padStart(2, '0')}`, HEX_A, NAME_A, HEX_B, NAME_B));
      tick += 3;
    }
    lines.push('  5:00 ShutdownGame:');
    writeLog(lines);

    const result = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(result.killEventsSynced).toBe(25);
    // Tally humanos: Alpha 7, Bravo 6 (bot 12 EXCLUIDO) → 2 premios, nunca el bot.
    const rows = await bonusRows();
    expect(rows.map((row) => [row.guid, row.delta])).toEqual([[DEC_A, 15], [DEC_B, 10]]);
    expect(rows.some((row) => row.guid === BOT7_DEC)).toBe(false);
  });

  it('partida <3 min de log (anti-farmeo): SIN bonus; con exactamente 3:00 SÍ', async () => {
    const kills = new Map<string, number>([[DEC_A, 7], [DEC_B, 6]]);

    writeLog(buildMatch({ kills, shutdownAt: '2:59' })); // 179s
    const short = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(short.matchBonusEventsSynced).toBe(0);
    expect(await prisma.matchBonusEvent.count()).toBe(0);

    await resetDb();
    writeLog(buildMatch({ kills, shutdownAt: '3:00' })); // 180s exacto: incluido
    const exact = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(exact.matchBonusEventsSynced).toBe(2);
    expect((await bonusRows())[0]?.matchDurationSec).toBe(180);
  });

  it('un solo humano en la partida (vs puros bots): SIN bonus aunque haga 15 kills', async () => {
    const lines = [
      '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
      `  0:04 J;${HEX_A};0;${NAME_A}`,
      '  0:05 J;bot7;7;BotSeven',
    ];
    let tick = 10;
    for (let i = 0; i < 15; i += 1) {
      lines.push(killLine(`${Math.floor(tick / 60)}:${String(tick % 60).padStart(2, '0')}`, 'bot7', 'BotSeven', HEX_A, NAME_A));
      tick += 5;
    }
    lines.push('  5:00 ShutdownGame:');
    writeLog(lines);

    const result = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(result.matchBonusEventsSynced).toBe(0); // 1 humano < 2 requeridos
    expect(await prisma.matchBonusEvent.count()).toBe(0);
  });

  it('log arrancado a MITAD de partida (sin InitGame): SIN bonus (duración desconocida)', async () => {
    const kills = new Map<string, number>([[DEC_A, 7], [DEC_B, 6]]);
    writeLog(buildMatch({ kills, shutdownAt: '5:00', withInitGame: false }));

    const result = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(result.matchBonusEventsSynced).toBe(0);
    expect(await prisma.matchBonusEvent.count()).toBe(0);
  });

  it('multi-partida en el mismo log: el tally SE REINICIA por InitGame (sin leaks entre partidas)', async () => {
    const match1 = buildMatch({ kills: new Map([[DEC_A, 7], [DEC_B, 6], [DEC_C, 5]]), shutdownAt: '5:00' });
    // Partida 2 (≥3 min también): si el tally NO se reiniciara, Alpha entraría
    // con 7+10=17 kills; con reset correcto gana con killsInMatch EXACTO 10.
    const match2 = [
      '  0:00 InitGame: \\g_gametype\\war\\map\\mp_terminal\\',
      `  0:10 J;${HEX_A};0;${NAME_A}`,
      `  0:11 J;${HEX_C};2;${NAME_C}`,
      ...Array.from({ length: 10 }, (_, i) => killLine(`0:${String(20 + i * 2).padStart(2, '0')}`, HEX_C, NAME_C, HEX_A, NAME_A)),
      '  5:00 ShutdownGame:',
    ];
    writeLog([...match1, ...match2]);

    const result = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(result.matchBonusEventsSynced).toBe(4); // 3 de la partida 1 + 1 de la partida 2

    const rows = await prisma.matchBonusEvent.findMany({ orderBy: [{ id: 'asc' }, { position: 'asc' }] });
    const match2Rows = rows.filter((row) => row.map === 'mp_terminal');
    expect(match2Rows).toHaveLength(1);
    expect(match2Rows[0]).toMatchObject({ guid: DEC_A, position: 1, delta: 15, killsInMatch: 10, humansInMatch: 2 }); // sin leak: 10, no 17
    const match1Rows = rows.filter((row) => row.map === 'mp_rust');
    expect(match1Rows).toHaveLength(3);
    expect(match1Rows.every((row) => row.killsInMatch <= 7)).toBe(true);
  });

  it('RECOMPUTE reproducible: reset de flags + skillElo=0 → mismo skill final (kills + bonus)', async () => {
    const kills = new Map<string, number>([[DEC_A, 7], [DEC_B, 6], [DEC_C, 5]]);
    writeLog(buildMatch({ kills, shutdownAt: '5:00' }));
    await ingestGameLog(LOG_PATH, SERVER_LABEL);
    await processSkillUpdates();
    const before = await prisma.player.findMany({
      where: { guid: { in: [DEC_A, DEC_B, DEC_C] } },
      select: { guid: true, skillElo: true, skill: true },
      orderBy: { guid: 'asc' },
    });
    expect(before.every((row) => row.skillElo !== SKILL.START)).toBe(true);

    // Flujo EXACTO de npm run recompute:skill (src/scripts/recompute-skill.ts):
    // desmarca KillEvent + MatchBonusEvent, reinicia skillElo y reprocesa TODO.
    await prisma.killEvent.updateMany({ where: {}, data: { skillProcessed: false } });
    await prisma.matchBonusEvent.updateMany({ where: {}, data: { skillProcessed: false } });
    await prisma.player.updateMany({ where: {}, data: { skillElo: 0, skill: 0 } });
    const rerun = await processSkillUpdates();
    expect(rerun.processed).toBe(18 + 3);

    const after = await prisma.player.findMany({
      where: { guid: { in: [DEC_A, DEC_B, DEC_C] } },
      select: { guid: true, skillElo: true, skill: true },
      orderBy: { guid: 'asc' },
    });
    expect(after).toEqual(before); // determinista al 100%: kills y bonus reproducidos
  });

  it('es incremental: re-ingesta sin líneas nuevas no duplica bonus', async () => {
    const kills = new Map<string, number>([[DEC_A, 7], [DEC_B, 6]]);
    writeLog(buildMatch({ kills, shutdownAt: '5:00' }));
    await ingestGameLog(LOG_PATH, SERVER_LABEL);
    await processSkillUpdates();

    const second = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(second.matchBonusEventsSynced).toBe(0);
    expect(await prisma.matchBonusEvent.count()).toBe(2);
    const after = await processSkillUpdates();
    expect(after.processed).toBe(0); // nada pendiente: el bonus no se re-aplica
  });
});
