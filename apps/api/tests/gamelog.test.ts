import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { guidHexToDecimal, ingestGameLog, parseGameLogLine } from '../src/services/sync/gamelog.reader.js';
import { prisma } from '../src/lib/prisma.js';
import { resetDb } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));

// GUIDs hex sintéticos de 16 chars (formato real del games_mp.log).
const HEX_A = 'a1b2c3d4e5f60718';
const HEX_B = '0f1e2d3c4b5a6978';
const HEX_C = 'deadbeefcafebabe';
const DEC_A = BigInt(`0x${HEX_A}`).toString(10);
const DEC_B = BigInt(`0x${HEX_B}`).toString(10);
const DEC_C = BigInt(`0x${HEX_C}`).toString(10);

/**
 * Log sintético ampliado que cubre: InitGame con infostring (estado mapa/modo),
 * J (sesiones), D (daño no letal → damageDealt/Taken sin evento), K con headshot,
 * world kill, teamkill, suicidio y Q (cierre de sesión).
 *
 * Orden de campos K/D verificado contra muestra real:
 *   K;aguid;acid;ateam;aname;vguid;vcid;vteam;vname;weapon;dmg;mod;hitloc
 */
const SYNTHETIC_LINES = [
  '  0:00 ------------------------------------------------------------',
  '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\sv_maxclients\\12',
  `  0:04 J;${HEX_A};0;Alpha^7`,
  `  0:05 J;${HEX_B};1;Bravo`,
  `  0:06 J;${HEX_C};2;Charlie`,
  `  0:07 D;${HEX_A};0;allies;Alpha^7;${HEX_B};1;axis;Bravo;ak47;50;MOD_RIFLE_BULLET;chest`, // daño no letal
  `  0:10 K;${HEX_A};0;allies;Alpha^7;${HEX_B};1;axis;Bravo;ak47;120;MOD_RIFLE_BULLET;head`, // kill + HEADSHOT
  `  0:12 K;${HEX_C};2;axis;Charlie;;-1;world;;none;100;MOD_FALLING;none`, // world kill (muerte, sin evento)
  `  0:14 K;${HEX_B};1;axis;Bravo;${HEX_C};2;axis;Charlie;ak74u;90;MOD_RIFLE_BULLET;torso_lower`, // TEAMKILL
  `  0:16 K;${HEX_C};2;axis;Charlie;${HEX_C};2;axis;Charlie;semtex;300;MOD_GRENADE;none`, // suicidio (sin evento)
  '  0:17 línea-basura-no-reconocida',
  '  0:18 ExitLevel: executed',
  `  0:20 Q;${HEX_C};2;Charlie`,
];

const LOG_PATH = resolve(here, 'data', 'test-games_mp.log');
const SERVER_LABEL = '192.168.3.99:28961';

function writeLog(lines: string[]): void {
  mkdirData();
  writeFileSync(LOG_PATH, lines.map((l) => `${l}\n`).join(''), 'utf8');
}

function mkdirData(): void {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
}

beforeAll(async () => {
  await resetDb();
});

beforeEach(async () => {
  await resetDb();
  mkdirData();
  rmSync(LOG_PATH, { force: true });
});

describe('guidHexToDecimal', () => {
  it('convierte GUID hex de 16 chars a decimal BigInt', () => {
    expect(guidHexToDecimal(HEX_A)).toBe(DEC_A);
    expect(guidHexToDecimal(HEX_A)).not.toBe(Number(DEC_A).toString()); // sin pérdida de precisión
    expect(guidHexToDecimal('B94BE6DECA6C750C')).toBe(BigInt('0xB94BE6DECA6C750C').toString(10)); // case-insensitive
  });

  it('rechaza GUIDs inválidos', () => {
    expect(guidHexToDecimal('')).toBeNull();
    expect(guidHexToDecimal('zzzz1234567890ab')).toBeNull();
    expect(guidHexToDecimal('1234567890ABCDEF0')).toBeNull(); // 17 chars
  });
});

describe('guidHexToDecimal: GUIDs de bots ("botN", spawnBot real de r5318)', () => {
  /** Fórmula aprobada por el orquestador: BigInt('0xb07' + n en hex, pad 12). */
  const botExpected = (n: number): string => BigInt(`0xb07${n.toString(16).padStart(12, '0')}`).toString(10);

  it('mapea botN DETERMINISTA al rango dedicado 0xb07… (dentro de la máscara de 16 hex chars / 64 bits)', () => {
    expect(guidHexToDecimal('bot5')).toBe(botExpected(5));
    expect(guidHexToDecimal('bot0')).toBe(botExpected(0));
    expect(guidHexToDecimal('bot14')).toBe(botExpected(14));
    // Máscara 64-bit: el guid mapeado SIEMPRE cabe en 16 hex chars y cae en el rango b07….
    const asHex = BigInt(guidHexToDecimal('bot5')!).toString(16);
    expect(asHex.startsWith('b07')).toBe(true);
    expect(BigInt(guidHexToDecimal('bot5')!)).toBeLessThan(2n ** 64n);
  });

  it('es ESTABLE entre llamadas y distinto por número (el perfil del bot acumula)', () => {
    expect(guidHexToDecimal('bot5')).toBe(guidHexToDecimal('bot5'));
    expect(guidHexToDecimal('bot6')).not.toBe(guidHexToDecimal('bot5'));
    expect(guidHexToDecimal('bot63')).not.toBe(guidHexToDecimal('bot36'));
  });

  it('no colisiona con el parseo hex real: tokens hex siguen siendo hex', () => {
    expect(guidHexToDecimal(HEX_A)).toBe(DEC_A); // regresión: hex intacto
    expect(guidHexToDecimal('bot')).toBeNull(); // sin número
    expect(guidHexToDecimal('boto')).toBeNull(); // 'o' no es hex ni el patrón botN
    expect(guidHexToDecimal('bot99999')).toBeNull(); // fuera del cap defensivo (65535)
    expect(guidHexToDecimal('bot-1')).toBeNull();
  });

  it('las líneas con guid "botN" se parsean como eventos (no "ignored")', () => {
    const BOT5 = BigInt('0xb07000000000005').toString(10);
    const BOT8 = BigInt('0xb07000000000008').toString(10);
    // J de bot (línea REAL verificada en el server con 14 bots).
    expect(parseGameLogLine('  0:12 J;bot5;15;Laupetin')).toEqual({
      kind: 'connect',
      guid: BOT5,
      name: 'Laupetin',
      clientNum: 15,
    });
    // K bot mata bot (hitloc head: el headshot se calcula en la ingesta, no en el parseo).
    const kill = parseGameLogLine('  0:20 K;bot5;15;axis;Laupetin;bot8;18;allies;OtroBot;ak47;120;MOD_RIFLE_BULLET;head');
    expect(kill).toMatchObject({
      kind: 'kill',
      originGuid: BOT5,
      targetGuid: BOT8,
      weapon: 'ak47',
      damage: 120,
      hitloc: 'head',
      isTeamkill: false,
    });
    // Q de bot.
    expect(parseGameLogLine('  1:02 Q;bot5;15;Laupetin')).toMatchObject({ kind: 'disconnect', guid: BOT5 });
    // Bot fuera de rango → evento corrupto (ignorado), como un hex inválido.
    expect(parseGameLogLine('  0:20 K;bot99999;99;axis;x;bot8;18;allies;y;w;10;MOD;x')).toBe('ignored');
  });
});

describe('parseGameLogLine', () => {
  it('parsea J (conexión) con prefijo de tiempo y devuelve GUID decimal', () => {
    const ev = parseGameLogLine(`  0:04 J;${HEX_A};4;Mandango ProMax`);
    expect(ev).toEqual({ kind: 'connect', guid: BigInt(`0x${HEX_A}`).toString(10), name: 'Mandango ProMax', clientNum: 4 });
  });

  it('parsea InitGame con infostring (mapa y modo)', () => {
    const ev = parseGameLogLine('0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\sv_maxclients\\12');
    expect(ev).toEqual({ kind: 'initgame', map: 'mp_rust', gametype: 'war' });
  });

  it('parsea InitGame sin infostring (estado a null)', () => {
    expect(parseGameLogLine('  0:00 InitGame')).toEqual({ kind: 'initgame', map: null, gametype: null });
    expect(parseGameLogLine('  1:27 ShutdownGame:')).toEqual({ kind: 'shutdown' });
  });

  it('parsea K real de muestra (world kill con campos vacíos)', () => {
    const ev = parseGameLogLine('0:39 K;b94be6deca6c750c;4;axis;Mandango ProMax;;-1;world;;none;100;MOD_FALLING;none');
    expect(ev).toEqual({
      kind: 'kill',
      originGuid: BigInt('0xb94be6deca6c750c').toString(10),
      targetGuid: null,
      originName: 'Mandango ProMax', // anti-confusión: nombre exacto del atacante para alias
      targetName: null, // víctima world: vname vacío → null (sin alias de víctima)
      weapon: 'none',
      damage: 100,
      hitloc: 'none',
      isTeamkill: false,
    });
  });

  it('parsea K normal con hitloc y detecta teamkill', () => {
    const ev = parseGameLogLine(`K;${HEX_B};1;axis;Bravo;${HEX_C};2;axis;Charlie;ak74u;90;MOD_RIFLE_BULLET;torso_lower`);
    expect(ev).toMatchObject({ kind: 'kill', targetGuid: DEC_C, weapon: 'ak74u', damage: 90, hitloc: 'torso_lower', isTeamkill: true });
  });

  it('parsea D como daño no letal y Q como desconexión', () => {
    const dmg = parseGameLogLine(`D;${HEX_A};0;allies;Alpha^7;${HEX_B};1;axis;Bravo;ak47;50;MOD_RIFLE_BULLET;chest`);
    expect(dmg).toEqual({ kind: 'damage', originGuid: DEC_A, targetGuid: DEC_B, damage: 50 });
    const q = parseGameLogLine(`Q;${HEX_B};1;Bravo`);
    expect(q).toEqual({ kind: 'disconnect', guid: DEC_B, name: 'Bravo', clientNum: 1 });
  });

  it('ignora líneas no-evento y devuelve "ignored" para eventos corruptos', () => {
    expect(parseGameLogLine('  1:27 ------------------------------------------------------------')).toBeNull();
    expect(parseGameLogLine('  0:15 línea-basura-no-reconocida')).toBeNull();
    expect(parseGameLogLine('  0:10 K;NOHEX;0;allies;x;0f1e2d3c4b5a6978;1;axis;y;w;1;MOD;x')).toBe('ignored');
    expect(parseGameLogLine('  0:10 K;solo;tres;campos')).toBe('ignored');
    expect(parseGameLogLine('  0:04 J;;4;SinGuid')).toBe('ignored');
  });
});

describe('ingestGameLog (integración con Prisma)', () => {
  it('genera jugadores con kills/deaths/daño/headshots/teamkills/streak y eventos con mapa/modo', async () => {
    writeLog(SYNTHETIC_LINES);
    const result = await ingestGameLog(LOG_PATH, SERVER_LABEL);

    expect(result.ok).toBe(true);
    expect(result.killEventsSynced).toBe(2); // A→B (head) y B→C (teamkill); world y suicidio no crean evento
    expect(result.linesParsed).toBe(10); // InitGame + 3 J + D + 4 K + Q
    expect(result.linesIgnored).toBe(3); // separador + basura + ExitLevel
    expect(result.sessionsOpened).toBe(3); // 3 J

    const alpha = await prisma.player.findUnique({ where: { guid: DEC_A } });
    const bravo = await prisma.player.findUnique({ where: { guid: DEC_B } });
    const charlie = await prisma.player.findUnique({ where: { guid: DEC_C } });

    // Alpha: 1 kill (headshot), 50+120 de daño hecho, 0 muertes, streak 1.
    expect(alpha?.kills).toBe(1);
    expect(alpha?.deaths).toBe(0);
    expect(alpha?.headshots).toBe(1);
    expect(alpha?.damageDealt).toBe(170); // 50 (D) + 120 (K)
    expect(alpha?.damageTaken).toBe(0);
    expect(alpha?.bestStreak).toBe(1);
    expect(alpha?.teamkills).toBe(0);
    expect(alpha?.kd).toBe(1);
    expect(alpha?.connections).toBe(1);
    expect(alpha?.matchesPlayed).toBe(1); // mp_rust (evento + sesión, dedup)
    expect(alpha?.lastServer).toBe(SERVER_LABEL);
    expect(alpha?.name).toBe('Alpha^7');

    // Bravo: mató a Charlie (teamkill), murió 1 vez, daño hecho/recibido.
    expect(bravo?.kills).toBe(1);
    expect(bravo?.deaths).toBe(1); // Alpha lo mató
    expect(bravo?.teamkills).toBe(1); // B (axis) mató a C (axis)
    expect(bravo?.damageDealt).toBe(90);
    expect(bravo?.damageTaken).toBe(170); // 50 (D) + 120 (K)
    expect(bravo?.headshots).toBe(0);
    expect(bravo?.bestStreak).toBe(1); // murió (0:10) antes de matar (0:14)
    expect(bravo?.matchesPlayed).toBe(1);

    // Charlie: world + teamkill + suicidio = 3 muertes, 0 kills, daño recibido.
    expect(charlie?.kills).toBe(0);
    expect(charlie?.deaths).toBe(3);
    expect(charlie?.damageTaken).toBe(490); // 100 world + 90 teamkill + 300 suicidio
    expect(charlie?.damageDealt).toBe(0);
    expect(charlie?.bestStreak).toBe(0);
    expect(charlie?.teamkills).toBe(0);

    // KillEvents con weapon/damage/hitloc/headshot/teamkill/map/gametype.
    const events = await prisma.killEvent.findMany({ orderBy: [{ id: 'asc' }] });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      originGuid: DEC_A,
      targetGuid: DEC_B,
      weapon: 'ak47',
      damage: 120,
      hitloc: 'head',
      headshot: true,
      isTeamkill: false,
      map: 'mp_rust',
      gametype: 'war',
      server: SERVER_LABEL,
    });
    expect(events[1]).toMatchObject({
      originGuid: DEC_B,
      targetGuid: DEC_C,
      weapon: 'ak74u',
      damage: 90,
      hitloc: 'torso_lower',
      headshot: false,
      isTeamkill: true,
      map: 'mp_rust',
      gametype: 'war',
    });

    // Sesiones: J abre, Q cierra. Charlie tiene sesión cerrada; Alpha/Bravo en curso.
    const sessions = await prisma.session.findMany();
    expect(sessions).toHaveLength(3);
    const charlieSession = sessions.find((s) => s.guid === DEC_C);
    expect(charlieSession?.end).not.toBeNull();
    expect(charlieSession?.map).toBe('mp_rust');
    expect(sessions.find((s) => s.guid === DEC_A)?.end).toBeNull();
    expect(sessions.find((s) => s.guid === DEC_B)?.end).toBeNull();
  });

  it('cierra todas las sesiones abiertas en ShutdownGame y detecta el nuevo mapa (multi-mapa)', async () => {
    writeLog(SYNTHETIC_LINES);
    const first = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(first.sessionsOpened).toBe(3);
    expect(first.sessionsClosed).toBe(1); // Q de Charlie

    // Rotación: ShutdownGame cierra Alpha/Bravo; InitGame cambia a mp_terminal; Alpha reconecta.
    appendFileSync(
      LOG_PATH,
      [
        '  1:30 ExitLevel: executed',
        '  1:30 ShutdownGame:',
        '  1:30 ------------------------------------------------------------',
        '  1:30 InitGame: \\g_gametype\\war\\map\\mp_terminal\\',
        `  1:32 J;${HEX_A};0;Alpha^7`,
        `  1:35 K;${HEX_A};0;allies;Alpha^7;${HEX_B};1;axis;Bravo;m1014;87;MOD_RIFLE_BULLET;helmet`, // headshot (helmet)
        `  1:36 Q;${HEX_A};0;Alpha^7\n`,
      ].join('\n'),
      'utf8',
    );

    const second = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(second.sessionsClosed).toBe(3); // 2 por ShutdownGame (Alpha y Bravo) + 1 por el Q de Alpha
    expect(second.sessionsOpened).toBe(1); // Alpha reconecta en mp_terminal
    expect(second.killEventsSynced).toBe(1);

    const alpha = await prisma.player.findUnique({ where: { guid: DEC_A } });
    expect(alpha?.kills).toBe(2);
    expect(alpha?.headshots).toBe(2); // head + helmet
    expect(alpha?.damageDealt).toBe(257); // 170 + 87
    expect(alpha?.matchesPlayed).toBe(2); // mp_rust + mp_terminal

    // El evento nuevo quedó etiquetado con el mapa/mode vigente tras InitGame.
    const terminalEvent = await prisma.killEvent.findFirst({ where: { map: 'mp_terminal' } });
    expect(terminalEvent).toMatchObject({ weapon: 'm1014', headshot: true, gametype: 'war', originGuid: DEC_A });

    // Alpha: 2 sesiones, ambas cerradas (shutdown + Q).
    const alphaSessions = await prisma.session.findMany({ where: { guid: DEC_A }, orderBy: [{ start: 'asc' }] });
    expect(alphaSessions).toHaveLength(2);
    expect(alphaSessions[0]?.end).not.toBeNull(); // cerrada por ShutdownGame
    expect(alphaSessions[1]?.end).not.toBeNull(); // cerrada por Q
    expect(alphaSessions[1]?.map).toBe('mp_terminal');
    expect(alphaSessions.every((s) => s.durationMin >= 0)).toBe(true);
  });

  it('es incremental: re-ingestar sin líneas nuevas no duplica nada', async () => {
    writeLog(SYNTHETIC_LINES);
    const first = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    const playersAfter = await prisma.player.count();
    const eventsAfter = await prisma.killEvent.count();
    const sessionsAfter = await prisma.session.count();
    expect(first.ok).toBe(true);

    const second = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(second.killEventsSynced).toBe(0);
    expect(second.linesParsed).toBe(0);
    expect(second.sessionsOpened).toBe(0);
    expect(await prisma.player.count()).toBe(playersAfter);
    expect(await prisma.killEvent.count()).toBe(eventsAfter);
    expect(await prisma.session.count()).toBe(sessionsAfter);

    const alpha = await prisma.player.findUnique({ where: { guid: DEC_A } });
    expect(alpha?.kills).toBe(1); // sin doble conteo
    expect(alpha?.damageDealt).toBe(170);
  });

  it('tolera línea truncada a mitad de escritura y la completa en la siguiente pasada', async () => {
    writeLog(SYNTHETIC_LINES.slice(0, 6)); // separador, InitGame, J×3, D
    appendFileSync(LOG_PATH, `  0:11 K;${HEX_A};0;allies;Alpha^7`, 'utf8'); // K a medias, SIN \n final

    const first = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(first.killEventsSynced).toBe(0); // la K incompleta NO se procesa
    expect(await prisma.killEvent.count()).toBe(0);

    // Llega el resto de la línea.
    appendFileSync(LOG_PATH, `;${HEX_B};1;axis;Bravo;m1014;87;MOD_RIFLE_BULLET;head\n`, 'utf8');
    const second = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(second.killEventsSynced).toBe(1);

    const alpha = await prisma.player.findUnique({ where: { guid: DEC_A } });
    expect(alpha?.kills).toBe(1);
    expect(alpha?.headshots).toBe(1);
    const events = await prisma.killEvent.findMany();
    expect(events[0]?.weapon).toBe('m1014');
    expect(events[0]?.damage).toBe(87);
    expect(events[0]?.headshot).toBe(true);
  });

  it('detecta truncado/rotación del archivo y reinicia el offset', async () => {
    writeLog(SYNTHETIC_LINES);
    await ingestGameLog(LOG_PATH, SERVER_LABEL);

    // El servidor reinicia y el log se recrea con contenido NUEVO (otra partida).
    const fresh = [
      '  0:00 InitGame: \\g_gametype\\war\\map\\mp_strike\\',
      `  0:05 J;${HEX_A};0;Alpha^7`,
      `  0:09 K;${HEX_A};0;allies;Alpha^7;${HEX_B};1;axis;Bravo;ak47;40;MOD_RIFLE_BULLET;neck\n`,
    ];
    writeFileSync(LOG_PATH, fresh.map((l) => `${l}\n`).join(''), 'utf8');

    const result = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes('trunc'))).toBe(true);
    // La partida nueva se ingesta: Alpha suma 1 kill más (total 2, sin duplicar la anterior).
    const alpha = await prisma.player.findUnique({ where: { guid: DEC_A } });
    expect(alpha?.kills).toBe(2);
    expect(alpha?.deaths).toBe(0);
    // El estado InitGame persistido pasó de mp_terminal... a mp_strike.
    const state = await prisma.logIngestState.findUnique({ where: { source: `gamelog:${LOG_PATH}` } });
    expect(state?.currentMap).toBe('mp_strike');
  });

  it('funciona con server=null (GAME_SERVER_ADDRESS sin configurar)', async () => {
    writeLog([`  0:04 J;${HEX_A};0;Solo`, `  0:06 K;${HEX_A};0;axis;Solo;${HEX_B};1;allies;Otro;ak47;10;MOD_RIFLE_BULLET;none\n`]);
    const result = await ingestGameLog(LOG_PATH, null);
    expect(result.ok).toBe(true);
    const alpha = await prisma.player.findUnique({ where: { guid: DEC_A } });
    expect(alpha?.lastServer).toBeNull();
    const events = await prisma.killEvent.findMany();
    expect(events[0]?.server).toBeNull();
  });

  it('devuelve ok=false + warning si el archivo no existe (defensivo)', async () => {
    const missing = resolve(here, 'data', 'no-existe-games_mp.log');
    if (existsSync(missing)) rmSync(missing);
    const result = await ingestGameLog(missing, null);
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes('no existe'))).toBe(true);
  });
});

describe('SyncState/cursor de log (LogIngestState)', () => {
  it('persiste el cursor por ruta (en bytes) y la telemetría de líneas', async () => {
    writeLog(SYNTHETIC_LINES);
    await ingestGameLog(LOG_PATH, SERVER_LABEL);

    const state = await prisma.logIngestState.findUnique({ where: { source: `gamelog:${LOG_PATH}` } });
    expect(state).not.toBeNull();
    const fileSize = BigInt(readFileSync(LOG_PATH).length);
    expect(state?.byteOffset).toBe(fileSize); // consumió todo (offset en BYTES, tolera UTF-8)
    expect(state!.linesParsed).toBeGreaterThan(0);
    expect(state!.linesIgnored).toBeGreaterThan(0);
    expect(state!.currentMap).toBe('mp_rust');
    expect(state!.currentGametype).toBe('war');
    expect(state!.lastRunAt).not.toBeNull();
  });
});

/**
 * BOTS REALES del server dedicado (`+spawnBot N`): el engine escribe guid
 * literal "botN". Fixture con líneas reales verificadas en campo (build
 * r5318, 14 bots jugando). Equipos: Laupetin(bot5)=axis, BotSix(bot6)=allies,
 * Alpha(humano)=axis.
 */
const BOT5_DEC = BigInt('0xb07000000000005').toString(10);
const BOT6_DEC = BigInt('0xb07000000000006').toString(10);

const BOT_LINES = [
  '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
  '  0:04 J;bot5;15;Laupetin',
  '  0:05 J;bot6;16;BotSix',
  `  0:06 J;${HEX_A};0;Alpha`,
  // 1) BOT mata BOT (headshot, equipos distintos → kill normal).
  '  0:10 K;bot5;15;axis;Laupetin;bot6;16;allies;BotSix;ak47;120;MOD_RIFLE_BULLET;head',
  // 2) BOT mata HUMANO (kill normal).
  `  0:12 K;bot6;16;allies;BotSix;${HEX_A};0;axis;Alpha;mp5k;100;MOD_RIFLE_BULLET;torso_lower`,
  // 3) HUMANO mata BOT (kill normal).
  `  0:14 K;${HEX_A};0;axis;Alpha;bot6;16;allies;BotSix;ak74u;90;MOD_RIFLE_BULLET;chest`,
  // 4) BOT muere por world (como el humano del fixture sintético).
  '  0:16 K;bot6;16;allies;BotSix;;-1;world;;none;100;MOD_FALLING;none',
  // 5) SUICIDIO de bot (origin == target → solo death, sin evento).
  '  0:18 K;bot5;15;axis;Laupetin;bot5;15;axis;Laupetin;semtex;300;MOD_GRENADE;none',
  // 6) Q del bot: cierra su sesión.
  '  0:20 Q;bot5;15;Laupetin',
];

describe('ingesta con BOTS (guid literal "botN")', () => {
  it('crea Players de bots con nombre, cuenta kills/deaths en los 4 sentidos y cierra su sesión con Q', async () => {
    writeLog(BOT_LINES);
    const result = await ingestGameLog(LOG_PATH, SERVER_LABEL);

    expect(result.ok).toBe(true);
    expect(result.eventsSkipped).toBe(0); // ningún bot descartado por guid inválido
    expect(result.killEventsSynced).toBe(3); // bot→bot, bot→humano, humano→bot
    expect(result.linesParsed).toBe(10); // InitGame + 3 J + 5 K + Q
    expect(result.sessionsOpened).toBe(3);
    expect(result.sessionsClosed).toBe(1); // Q de bot5

    const laupetin = await prisma.player.findUnique({ where: { guid: BOT5_DEC } });
    const botsix = await prisma.player.findUnique({ where: { guid: BOT6_DEC } });
    const alpha = await prisma.player.findUnique({ where: { guid: DEC_A } });

    // El J del bot creó el Player con SU nombre (guid mapeado, no 'unknown').
    expect(laupetin?.name).toBe('Laupetin');
    // Laupetin: 1 kill (headshot), 1 death (suicidio), headshot 1.
    expect(laupetin?.kills).toBe(1);
    expect(laupetin?.deaths).toBe(1);
    expect(laupetin?.headshots).toBe(1);
    expect(laupetin?.damageDealt).toBe(120);
    expect(laupetin?.damageTaken).toBe(300); // daño del suicidio
    expect(laupetin?.connections).toBe(1);
    // Su sesión se cerró con Q.
    const laupetinSessions = await prisma.session.findMany({ where: { guid: BOT5_DEC } });
    expect(laupetinSessions).toHaveLength(1);
    expect(laupetinSessions[0]?.end).not.toBeNull();

    // BotSix: mató a Alpha (1), murió 3 veces (Laupetin + Alpha + world).
    expect(botsix?.name).toBe('BotSix');
    expect(botsix?.kills).toBe(1);
    expect(botsix?.deaths).toBe(3);
    expect(botsix?.damageDealt).toBe(100);
    expect(botsix?.damageTaken).toBe(310); // 120 (kill de Laupetin) + 90 (kill de Alpha) + 100 (world)

    // HUMANO sin regresión: Alpha mató al bot y murió contra el bot, guid hex intacto.
    expect(alpha?.guid).toBe(DEC_A);
    expect(alpha?.kills).toBe(1);
    expect(alpha?.deaths).toBe(1);
    expect(alpha?.damageDealt).toBe(90);
    expect(alpha?.damageTaken).toBe(100);

    // KillEvents: las 3 kills válidas, con guids mapeados y metadatos.
    const events = await prisma.killEvent.findMany({ orderBy: [{ id: 'asc' }] });
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ originGuid: BOT5_DEC, targetGuid: BOT6_DEC, headshot: true, damage: 120, weapon: 'ak47', map: 'mp_rust', gametype: 'war' });
    expect(events[1]).toMatchObject({ originGuid: BOT6_DEC, targetGuid: DEC_A, headshot: false, damage: 100, weapon: 'mp5k' });
    expect(events[2]).toMatchObject({ originGuid: DEC_A, targetGuid: BOT6_DEC, headshot: false, damage: 90, weapon: 'ak74u' });

    // World (línea 4) y suicidio (línea 5) NO generaron evento.
    expect(events.some((e) => e.targetGuid === '' )).toBe(false);

    // Sesiones: 3 abiertas por los J, solo la del bot cerrada por Q (las otras siguen en curso).
    expect(await prisma.session.count()).toBe(3);
    expect(await prisma.session.findFirst({ where: { guid: BOT6_DEC, end: null } })).not.toBeNull();
    expect(await prisma.session.findFirst({ where: { guid: DEC_A, end: null } })).not.toBeNull();
  });

  it('es incremental con bots: re-ingesta no duplica y el guid del bot es estable', async () => {
    writeLog(BOT_LINES);
    await ingestGameLog(LOG_PATH, SERVER_LABEL);
    const second = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(second.killEventsSynced).toBe(0);
    expect(await prisma.killEvent.count()).toBe(3);
    expect(await prisma.player.count()).toBe(3);

    // Misma partida tras un "reboot" del server (log nuevo, mismo bot5): MISMO guid.
    const fresh = [
      '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
      '  0:04 J;bot5;15;Laupetin',
      '  0:09 K;bot5;15;axis;Laupetin;bot6;16;allies;BotSix;ak47;80;MOD_RIFLE_BULLET;neck\n',
    ];
    writeFileSync(LOG_PATH, fresh.map((l) => `${l}\n`).join(''), 'utf8');
    const reboot = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(reboot.ok).toBe(true);
    expect(reboot.killEventsSynced).toBe(1);

    // El bot5 de "mañana" acumula sobre el perfil de "hoy" (mismo guid decimal).
    const laupetin = await prisma.player.findUnique({ where: { guid: BOT5_DEC } });
    expect(laupetin?.name).toBe('Laupetin');
    expect(laupetin?.kills).toBe(2); // 1 del primer log + 1 del segundo
    expect(laupetin?.connections).toBe(2); // 1 conexión por "sesión de server"
  });
});
