import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { guidHexToDecimal, ingestGameLog, parseGameLogLine } from '../src/services/sync/gamelog.reader.js';
import { processSkillUpdates } from '../src/services/skill/skill.service.js';
import { SKILL } from '../src/services/skill/elo.js';
import { env } from '../src/config/env.js';
import { getWeaponsRanking } from '../src/services/weapons.service.js';
import { prisma } from '../src/lib/prisma.js';
import { req, resetDb } from './helpers.js';

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
 * ⚠️ Orden de campos K/D de ESTA build (verificado con scoreboard en vivo):
 *   K;vguid;vcid;vteam;vname;kguid;kcid;kteam;kname;weapon;dmg;mod;hitloc
 * (PRIMER bloque = VÍCTIMA, SEGUNDO = KILLER; el stock IW4 es al revés).
 * En las líneas de este fixture: Bravo mata a Alpha (headshot), Charlie cae por
 * world, Charlie teamkill-ea a Bravo (mismo team axis) y Charlie se suicida.
 */
const SYNTHETIC_LINES = [
  '  0:00 ------------------------------------------------------------',
  '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\sv_maxclients\\12',
  `  0:04 J;${HEX_A};0;Alpha^7`,
  `  0:05 J;${HEX_B};1;Bravo`,
  `  0:06 J;${HEX_C};2;Charlie`,
  `  0:07 D;${HEX_A};0;allies;Alpha^7;${HEX_B};1;axis;Bravo;ak47;50;MOD_RIFLE_BULLET;chest`, // daño: Alpha RECIBE 50 de Bravo
  `  0:10 K;${HEX_A};0;allies;Alpha^7;${HEX_B};1;axis;Bravo;ak47;120;MOD_RIFLE_BULLET;head`, // Bravo (2º bloque) mata a Alpha con HEADSHOT
  `  0:12 K;${HEX_C};2;axis;Charlie;;-1;world;;none;100;MOD_FALLING;none`, // world: Charlie (1º bloque) muere → evento world (targetGuid='') para el skill
  `  0:14 K;${HEX_B};1;axis;Bravo;${HEX_C};2;axis;Charlie;ak74u;90;MOD_RIFLE_BULLET;torso_lower`, // Charlie teamkill-ea a Bravo (axis/axis)
  `  0:16 K;${HEX_C};2;axis;Charlie;${HEX_C};2;axis;Charlie;semtex;300;MOD_GRENADE;none`, // suicidio → evento world (targetGuid='') para el skill
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
    // ESTA build: bot5 (1er bloque) = VÍCTIMA, bot8 (2º bloque) = KILLER.
    const kill = parseGameLogLine('  0:20 K;bot5;15;axis;Laupetin;bot8;18;allies;OtroBot;ak47;120;MOD_RIFLE_BULLET;head');
    expect(kill).toMatchObject({
      kind: 'kill',
      victimGuid: BOT5,
      killerGuid: BOT8,
      victimName: 'Laupetin',
      killerName: 'OtroBot',
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
    // ESTA build: la VÍCTIMA (Mandango) va en el PRIMER bloque y el killer
    // world en el segundo (guid vacío, cid -1, team "world").
    const ev = parseGameLogLine('0:39 K;b94be6deca6c750c;4;axis;Mandango ProMax;;-1;world;;none;100;MOD_FALLING;none');
    expect(ev).toEqual({
      kind: 'kill',
      victimGuid: BigInt('0xb94be6deca6c750c').toString(10),
      killerGuid: null,
      victimName: 'Mandango ProMax', // anti-confusión: nombre exacto de la víctima para alias
      killerName: null, // killer world: nombre vacío → null (sin alias de killer)
      weapon: 'none',
      mod: 'MOD_FALLING',
      damage: 100,
      hitloc: 'none',
      isTeamkill: false,
    });
  });

  it('parsea K normal con hitloc y detecta teamkill', () => {
    // ESTA build: Bravo (1er bloque) es la VÍCTIMA; Charlie (2º bloque) el KILLER.
    // Mismo team (axis/axis) → teamkill del KILLER.
    const ev = parseGameLogLine(`K;${HEX_B};1;axis;Bravo;${HEX_C};2;axis;Charlie;ak74u;90;MOD_RIFLE_BULLET;torso_lower`);
    expect(ev).toMatchObject({
      kind: 'kill',
      victimGuid: DEC_B,
      killerGuid: DEC_C,
      victimName: 'Bravo',
      killerName: 'Charlie',
      weapon: 'ak74u',
      damage: 90,
      hitloc: 'torso_lower',
      isTeamkill: true,
    });
  });

  it('parsea D como daño no letal y Q como desconexión', () => {
    // ESTA build: Alpha (1er bloque) RECIBE el daño; Bravo (2º) lo INFLIGE.
    const dmg = parseGameLogLine(`D;${HEX_A};0;allies;Alpha^7;${HEX_B};1;axis;Bravo;ak47;50;MOD_RIFLE_BULLET;chest`);
    expect(dmg).toEqual({ kind: 'damage', receiverGuid: DEC_A, dealerGuid: DEC_B, damage: 50 });
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
    expect(result.killEventsSynced).toBe(4); // Bravo→Alpha (head), Charlie world, Charlie→Bravo (teamkill) y suicidio de Charlie (eventos world/suicidio desde 2026-11-08)
    expect(result.linesParsed).toBe(10); // InitGame + 3 J + D + 4 K + Q
    expect(result.linesIgnored).toBe(3); // separador + basura + ExitLevel
    expect(result.sessionsOpened).toBe(3); // 3 J

    const alpha = await prisma.player.findUnique({ where: { guid: DEC_A } });
    const bravo = await prisma.player.findUnique({ where: { guid: DEC_B } });
    const charlie = await prisma.player.findUnique({ where: { guid: DEC_C } });

    // Alpha: 0 kills, 1 muerte (headshot de Bravo), daño SOLO recibido (50 D + 120 K).
    expect(alpha?.kills).toBe(0);
    expect(alpha?.deaths).toBe(1);
    expect(alpha?.headshots).toBe(0);
    expect(alpha?.damageDealt).toBe(0);
    expect(alpha?.damageTaken).toBe(170); // 50 (D) + 120 (K)
    expect(alpha?.bestStreak).toBe(0);
    expect(alpha?.teamkills).toBe(0);
    expect(alpha?.kd).toBe(0);
    expect(alpha?.connections).toBe(1);
    expect(alpha?.matchesPlayed).toBe(1); // mp_rust (evento + sesión, dedup)
    expect(alpha?.lastServer).toBe(SERVER_LABEL);
    expect(alpha?.name).toBe('Alpha^7');

    // Bravo: KILLER de Alpha (headshot, 2º bloque) y VÍCTIMA del teamkill de Charlie.
    expect(bravo?.kills).toBe(1);
    expect(bravo?.deaths).toBe(1); // teamkill de Charlie (0:14)
    expect(bravo?.teamkills).toBe(0); // el teamkill fue de Charlie
    expect(bravo?.headshots).toBe(1); // headshot del kill sobre Alpha
    expect(bravo?.damageDealt).toBe(170); // 50 (D) + 120 (K)
    expect(bravo?.damageTaken).toBe(90); // teamkill recibido
    expect(bravo?.bestStreak).toBe(1); // mató (0:10) ANTES de morir (0:14)
    expect(bravo?.matchesPlayed).toBe(1);
    expect(bravo?.kd).toBe(1);

    // Charlie: world + suicidio = 2 muertes; teamkill sobre Bravo (kills+1 y teamkills+1).
    expect(charlie?.kills).toBe(1); // teamkill (mismo team axis)
    expect(charlie?.deaths).toBe(2); // world (0:12) + suicidio (0:16)
    expect(charlie?.teamkills).toBe(1);
    expect(charlie?.headshots).toBe(0);
    expect(charlie?.damageTaken).toBe(400); // 100 world + 300 suicidio
    expect(charlie?.damageDealt).toBe(90); // daño del teamkill
    expect(charlie?.bestStreak).toBe(1); // el teamkill cuenta como kill almacenada
    expect(charlie?.kd).toBe(0.5);

    // KillEvents con weapon/damage/hitloc/headshot/teamkill/map/gametype.
    // La DB guarda semántica stock: originGuid = KILLER, targetGuid = VÍCTIMA.
    const events = await prisma.killEvent.findMany({ orderBy: [{ id: 'asc' }] });
    expect(events).toHaveLength(4); // kill + world + teamkill + suicidio (eventos world/suicidio desde 2026-11-08)
    expect(events[0]).toMatchObject({
      originGuid: DEC_B, // Bravo (2º bloque) = killer
      targetGuid: DEC_A, // Alpha (1er bloque) = víctima
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
      originGuid: DEC_C, // Charlie world (0:12): origin = VÍCTIMA (sin atacante)
      targetGuid: '', // marcador world → skill aplica WORLD_LOSS × escala de víctima (plano×0.5)
      weapon: 'none',
      mod: 'MOD_FALLING',
      damage: 100,
      headshot: false,
      isTeamkill: false,
      map: 'mp_rust',
      gametype: 'war',
    });
    expect(events[2]).toMatchObject({
      originGuid: DEC_C, // Charlie (2º bloque) = killer (teamkiller)
      targetGuid: DEC_B, // Bravo (1er bloque) = víctima
      weapon: 'ak74u',
      damage: 90,
      hitloc: 'torso_lower',
      headshot: false,
      isTeamkill: true,
      map: 'mp_rust',
      gametype: 'war',
    });
    expect(events[3]).toMatchObject({
      originGuid: DEC_C, // suicidio (0:16): origin = víctima
      targetGuid: '',
      weapon: 'semtex',
      mod: 'MOD_GRENADE',
      damage: 300,
      headshot: false,
      isTeamkill: false,
    });
    // El orden por id respeta la cronología del log: kill, world, teamkill, suicidio.
    expect(events.map((e) => [e.originGuid, e.targetGuid])).toEqual([
      [DEC_B, DEC_A], // Bravo→Alpha (0:10)
      [DEC_C, ''], // world (0:12)
      [DEC_C, DEC_B], // Charlie→Bravo teamkill (0:14)
      [DEC_C, ''], // suicidio (0:16)
    ]);

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

    // ESTA build: Bravo (2º bloque) mata a Alpha (1º bloque) con headshot helmet.
    const bravo = await prisma.player.findUnique({ where: { guid: DEC_B } });
    expect(bravo?.kills).toBe(2); // 1 del primer mapa + 1 de mp_terminal
    expect(bravo?.headshots).toBe(2); // head + helmet
    expect(bravo?.damageDealt).toBe(257); // 170 + 87
    expect(bravo?.matchesPlayed).toBe(2); // mp_rust + mp_terminal
    const alpha = await prisma.player.findUnique({ where: { guid: DEC_A } });
    expect(alpha?.kills).toBe(0); // sigue sin matar: él es la víctima
    expect(alpha?.deaths).toBe(2); // head (mp_rust) + helmet (mp_terminal)

    // El evento nuevo quedó etiquetado con el mapa/mode vigente tras InitGame.
    const terminalEvent = await prisma.killEvent.findFirst({ where: { map: 'mp_terminal' } });
    expect(terminalEvent).toMatchObject({ weapon: 'm1014', headshot: true, gametype: 'war', originGuid: DEC_B, targetGuid: DEC_A });

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

    const bravo = await prisma.player.findUnique({ where: { guid: DEC_B } });
    expect(bravo?.kills).toBe(1); // sin doble conteo
    expect(bravo?.damageDealt).toBe(170);
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

    // ESTA build: Alpha (1er bloque) es la VÍCTIMA; Bravo (2º) el killer con headshot.
    const bravo = await prisma.player.findUnique({ where: { guid: DEC_B } });
    expect(bravo?.kills).toBe(1);
    expect(bravo?.headshots).toBe(1);
    const alpha = await prisma.player.findUnique({ where: { guid: DEC_A } });
    expect(alpha?.deaths).toBe(1);
    const events = await prisma.killEvent.findMany();
    expect(events[0]?.weapon).toBe('m1014');
    expect(events[0]?.damage).toBe(87);
    expect(events[0]?.headshot).toBe(true);
    expect(events[0]?.originGuid).toBe(DEC_B);
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
    // La partida nueva se ingesta: ESTA build → Bravo (2º bloque) suma 1 kill más (total 2).
    const bravo = await prisma.player.findUnique({ where: { guid: DEC_B } });
    expect(bravo?.kills).toBe(2);
    const alpha = await prisma.player.findUnique({ where: { guid: DEC_A } });
    expect(alpha?.deaths).toBe(2); // 1 del primer log + 1 de la partida nueva
    expect(alpha?.kills).toBe(0);
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
 * literal "botN" EN CUALQUIERA de los dos bloques de la línea K. Fixture con
 * líneas reales verificadas en campo (build r5318, 14 bots jugando), con la
 * semántica DE ESTA BUILD (1er bloque = víctima, 2º = killer).
 * Equipos: Laupetin(bot5)=axis, BotSix(bot6)=allies, Alpha(humano)=axis.
 */
const BOT5_DEC = BigInt('0xb07000000000005').toString(10);
const BOT6_DEC = BigInt('0xb07000000000006').toString(10);

const BOT_LINES = [
  '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
  '  0:04 J;bot5;15;Laupetin',
  '  0:05 J;bot6;16;BotSix',
  `  0:06 J;${HEX_A};0;Alpha`,
  // 1) BOT mata BOT (headshot, equipos distintos → kill normal): BotSix mata a Laupetin.
  '  0:10 K;bot5;15;axis;Laupetin;bot6;16;allies;BotSix;ak47;120;MOD_RIFLE_BULLET;head',
  // 2) HUMANO mata BOT: Alpha mata a BotSix.
  `  0:12 K;bot6;16;allies;BotSix;${HEX_A};0;axis;Alpha;mp5k;100;MOD_RIFLE_BULLET;torso_lower`,
  // 3) BOT mata HUMANO: BotSix mata a Alpha.
  `  0:14 K;${HEX_A};0;axis;Alpha;bot6;16;allies;BotSix;ak74u;90;MOD_RIFLE_BULLET;chest`,
  // 4) BOT muere por world (como el humano del fixture sintético).
  '  0:16 K;bot6;16;allies;BotSix;;-1;world;;none;100;MOD_FALLING;none',
  // 5) SUICIDIO de bot (mismo guid en los dos bloques → solo death, sin evento).
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
    expect(result.killEventsSynced).toBe(3); // bot→bot, humano→bot, bot→humano
    expect(result.linesParsed).toBe(10); // InitGame + 3 J + 5 K + Q
    expect(result.sessionsOpened).toBe(3);
    expect(result.sessionsClosed).toBe(1); // Q de bot5

    const laupetin = await prisma.player.findUnique({ where: { guid: BOT5_DEC } });
    const botsix = await prisma.player.findUnique({ where: { guid: BOT6_DEC } });
    const alpha = await prisma.player.findUnique({ where: { guid: DEC_A } });

    // El J del bot creó el Player con SU nombre (guid mapeado, no 'unknown').
    expect(laupetin?.name).toBe('Laupetin');
    // Laupetin: 0 kills, 2 muertes (victima del headshot de BotSix + suicidio).
    expect(laupetin?.kills).toBe(0);
    expect(laupetin?.deaths).toBe(2);
    expect(laupetin?.headshots).toBe(0);
    expect(laupetin?.damageDealt).toBe(0);
    expect(laupetin?.damageTaken).toBe(420); // 120 (headshot de BotSix) + 300 (suicidio)
    expect(laupetin?.connections).toBe(1);
    // Su sesión se cerró con Q.
    const laupetinSessions = await prisma.session.findMany({ where: { guid: BOT5_DEC } });
    expect(laupetinSessions).toHaveLength(1);
    expect(laupetinSessions[0]?.end).not.toBeNull();

    // BotSix: killer en 2 líneas (headshot a Laupetin + kill a Alpha), murió 2 veces.
    expect(botsix?.name).toBe('BotSix');
    expect(botsix?.kills).toBe(2);
    expect(botsix?.deaths).toBe(2); // Alpha lo mató (0:12) + world (0:16)
    expect(botsix?.headshots).toBe(1); // headshot sobre Laupetin
    expect(botsix?.damageDealt).toBe(210); // 120 (headshot) + 90 (kill de Alpha)
    expect(botsix?.damageTaken).toBe(200); // 100 (kill de Alpha) + 100 (world)

    // HUMANO sin regresión: Alpha mató al bot y murió contra el bot, guid hex intacto.
    expect(alpha?.guid).toBe(DEC_A);
    expect(alpha?.kills).toBe(1);
    expect(alpha?.deaths).toBe(1);
    expect(alpha?.damageDealt).toBe(100);
    expect(alpha?.damageTaken).toBe(90);

    // KillEvents: las 3 kills válidas (semántica DB stock: origin=killer, target=víctima).
    const events = await prisma.killEvent.findMany({ orderBy: [{ id: 'asc' }] });
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ originGuid: BOT6_DEC, targetGuid: BOT5_DEC, headshot: true, damage: 120, weapon: 'ak47', map: 'mp_rust', gametype: 'war' });
    expect(events[1]).toMatchObject({ originGuid: DEC_A, targetGuid: BOT6_DEC, headshot: false, damage: 100, weapon: 'mp5k' });
    expect(events[2]).toMatchObject({ originGuid: BOT6_DEC, targetGuid: DEC_A, headshot: false, damage: 90, weapon: 'ak74u' });

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
    // ESTA build: bot5 (1er bloque) es la VÍCTIMA de bot6 (2º bloque).
    const fresh = [
      '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
      '  0:04 J;bot5;15;Laupetin',
      '  0:09 K;bot5;15;axis;Laupetin;bot6;16;allies;BotSix;ak47;80;MOD_RIFLE_BULLET;neck\n',
    ];
    writeFileSync(LOG_PATH, fresh.map((l) => `${l}\n`).join(''), 'utf8');
    const reboot = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(reboot.ok).toBe(true);
    expect(reboot.killEventsSynced).toBe(1);

    // El bot6 de "mañana" acumula sobre el perfil de "hoy" (mismo guid decimal);
    // bot5 acumula DEATHS (aquí siempre es la víctima).
    const botsix = await prisma.player.findUnique({ where: { guid: BOT6_DEC } });
    expect(botsix?.name).toBe('BotSix');
    expect(botsix?.kills).toBe(3); // 2 del primer log + 1 del segundo
    const laupetin = await prisma.player.findUnique({ where: { guid: BOT5_DEC } });
    expect(laupetin?.deaths).toBe(3); // 2 del primer log + 1 del segundo
    expect(laupetin?.connections).toBe(2); // 1 conexión por "sesión de server"
  });
});

// ── FIXTURES REALES del log de ESTA build (2026-11-07) + REGRESIÓN ──────────

const ADMIN_HEX = 'c103bb7531742427';
const ADMIN_DEC = BigInt(`0x${ADMIN_HEX}`).toString(10); // 13908166186265486375 (el dueño)
const MANDANGO_DEC = BigInt('0xb94be6deca6c750c').toString(10); // 13352019364823201036
const RBOT4_DEC = BigInt('0xb07000000000004').toString(10);
const RBOT5_DEC = BigInt('0xb07000000000005').toString(10);
const RBOT8_DEC = BigInt('0xb07000000000008').toString(10);

/**
 * ⚠️ TEST DE REGRESIÓN DEL FORMATO DEL GAMELOG.
 *
 * ESTA build loguea la línea K con la VÍCTIMA en el PRIMER bloque y el KILLER
 * en el SEGUNDO — el INVERSO del estándar IW4/stock. Lo fijó el experimento del
 * scoreboard (2026-11-07, partida en vivo): el juego mostraba para el guid
 * c103bb7531742427 ("admin"/"pollacaballo"/"TESTPROBE", mismo dueño) Kills 12 /
 * Deaths 0 / score 1200 (12×100), mientras la DB parseada como atacante-primero
 * le contaba kills≈0-1 / deaths=13. Esas 13 "muertes" stock eran sus KILLS
 * REALES (guid en el 2º bloque); los bots solo aparecen 2 veces con su guid en
 * el 1er bloque (1 muerte + 1 suicidio) y NUNCA hay "world" en el 1er bloque.
 *
 * SI ESTE TEST FALLA, ALGUIEN CAMBIÓ EL FORMATO DEL LOG: repetir el experimento
 * del scoreboard (kills/deaths visibles en el juego vs bloques del log) antes
 * de tocar parseGameLogLine. Tras el fix, correr npm run recount:stats.
 */
describe('FIXTURES REALES de esta build: víctima-primero (regresión de formato)', () => {
  it('REGRESIÓN: K real 3:04 — bot5 (víctima, 1º bloque) muere a manos de pollacaballo/admin (killer, 2º bloque)', () => {
    const ev = parseGameLogLine('  3:04 K;bot5;4;allies;/dev/../;c103bb7531742427;5;axis;pollacaballo;sa80_grip_reflex_mp;40;MOD_RIFLE_BULLET;right_arm_lower');
    expect(ev).toMatchObject({
      kind: 'kill',
      victimGuid: RBOT5_DEC, // bot5 = VÍCTIMA (primer bloque)
      killerGuid: ADMIN_DEC, // pollacaballo (el dueño) = KILLER (segundo bloque)
      victimName: '/dev/../',
      killerName: 'pollacaballo',
      weapon: 'sa80_grip_reflex_mp',
      damage: 40,
      hitloc: 'right_arm_lower',
      isTeamkill: false,
    });
  });

  it('REGRESIÓN: K real 3:17 — admin (víctima, 1º bloque) muere a manos de bot8 (killer, 2º bloque)', () => {
    const ev = parseGameLogLine('  3:17 K;c103bb7531742427;14;axis;admin;bot8;7;allies;/dev/full;famas_gl_mp;56;MOD_RIFLE_BULLET;right_arm_lower');
    expect(ev).toMatchObject({
      kind: 'kill',
      victimGuid: ADMIN_DEC, // admin = VÍCTIMA aquí
      killerGuid: RBOT8_DEC, // bot8 "/dev/full" = KILLER
      victimName: 'admin',
      killerName: '/dev/full',
      weapon: 'famas_gl_mp',
      isTeamkill: false,
    });
  });

  it('REGRESIÓN: K real de world (0:39) — Mandango (víctima, 1º bloque) cae por caída, sin killer', () => {
    const ev = parseGameLogLine('  0:39 K;b94be6deca6c750c;4;axis;Mandango ProMax;;-1;world;;none;100;MOD_FALLING;none');
    expect(ev).toMatchObject({
      kind: 'kill',
      victimGuid: MANDANGO_DEC,
      killerGuid: null, // world: guid vacío en el 2º bloque
      victimName: 'Mandango ProMax',
      killerName: null,
      isTeamkill: false,
    });
  });

  it('HEADSHOT REAL (1:52): el KILLER (2º bloque, admin) recibe el headshot y el kill', async () => {
    // Línea REAL del log con MOD_HEAD_SHOT: bot4 "/dev/console" (1º bloque) es
    // la víctima; admin (2º bloque) el killer con headshot en "head".
    writeLog([
      '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
      '  2:52 J;c103bb7531742427;14;admin',
      '  1:52 K;bot4;3;allies;/dev/console;c103bb7531742427;14;axis;admin;ump45_eotech_mp;55;MOD_HEAD_SHOT;head\n',
    ]);
    const result = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(result.ok).toBe(true);
    expect(result.killEventsSynced).toBe(1);

    const admin = await prisma.player.findUnique({ where: { guid: ADMIN_DEC } });
    expect(admin?.kills).toBe(1); // el KILLER (2º bloque) suma el kill
    expect(admin?.headshots).toBe(1); // …y el headshot
    expect(admin?.deaths).toBe(0);

    const bot4 = await prisma.player.findUnique({ where: { guid: RBOT4_DEC } });
    expect(bot4?.deaths).toBe(1); // la VÍCTIMA (1er bloque) suma la muerte
    expect(bot4?.kills).toBe(0);
    expect(bot4?.damageTaken).toBe(55);

    const event = await prisma.killEvent.findFirstOrThrow();
    expect(event).toMatchObject({
      originGuid: ADMIN_DEC, // semántica DB stock: origin = killer
      targetGuid: RBOT4_DEC, // target = víctima
      headshot: true,
      hitloc: 'head',
      weapon: 'ump45_eotech_mp',
      damage: 55,
    });
  });

  it('mini-partida REAL completa: world + kills del dueño en 2º bloque + su muerte + suicidio real (19:30)', async () => {
    writeLog([
      '  0:00 ------------------------------------------------------------',
      '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
      '  0:04 J;b94be6deca6c750c;4;Mandango ProMax',
      '  2:52 J;c103bb7531742427;5;pollacaballo',
      '  0:39 K;b94be6deca6c750c;4;axis;Mandango ProMax;;-1;world;;none;100;MOD_FALLING;none', // Mandango (real guid 13352019364823201036) muere por caída: LEGÍTIMO
      '  3:04 K;bot5;4;allies;/dev/../;c103bb7531742427;5;axis;pollacaballo;sa80_grip_reflex_mp;40;MOD_RIFLE_BULLET;right_arm_lower',
      '  3:17 K;c103bb7531742427;14;axis;admin;bot8;7;allies;/dev/full;famas_gl_mp;56;MOD_RIFLE_BULLET;right_arm_lower',
      ' 19:30 K;c103bb7531742427;0;axis;admin;c103bb7531742427;0;axis;admin;semtex_mp;191;MOD_GRENADE_SPLASH;none', // suicidio REAL (mismo guid en ambos bloques)
    ]);
    const result = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(result.ok).toBe(true);
    expect(result.killEventsSynced).toBe(4); // 3:04, world de Mandango (0:39), 3:17 y suicidio real (19:30): los world/suicidio HUMANOS también crean evento (2026-11-08)

    // El dueño (un solo Player por guid — NUNCA duplicados por nick: pollacaballo,
    // admin y TESTPROBE comparten guid y colapsan por el upsert sobre guid @unique).
    const admin = await prisma.player.findUnique({ where: { guid: ADMIN_DEC } });
    expect(admin).not.toBeNull();
    expect(await prisma.player.count({ where: { guid: ADMIN_DEC } })).toBe(1);
    expect(admin?.kills).toBe(1); // killer en 3:04 (2º bloque); en 3:17 y 19:30 es víctima/suicidio
    expect(admin?.deaths).toBe(2); // muerto por bot8 (3:17) + suicidio (19:30)
    expect(admin?.damageDealt).toBe(40);
    expect(admin?.damageTaken).toBe(56 + 191);

    // Mandango real: su muerte por caída es LEGÍTIMA (1 death, 0 kills).
    const mandango = await prisma.player.findUnique({ where: { guid: MANDANGO_DEC } });
    expect(mandango?.deaths).toBe(1);
    expect(mandango?.kills).toBe(0);
    expect(mandango?.damageTaken).toBe(100);

    // Los dos nombres del dueño quedan como ALIASES del MISMO guid (no players nuevos).
    const adminAliases = await prisma.playerAlias.findMany({ where: { guid: ADMIN_DEC } });
    expect(adminAliases.map((a) => a.name).sort()).toEqual(['admin', 'pollacaballo']);
    expect(await prisma.player.count()).toBe(4); // Mandango + dueño + bot5 + bot8 (world no crea player)
  });

  it('expone headshots + hsRatio (ratio 2 dec) en el perfil; hsRatio es null con 0 kills', async () => {
    writeLog([
      '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
      '  2:52 J;c103bb7531742427;14;admin',
      '  0:04 J;b94be6deca6c750c;4;Mandango ProMax',
      // HEADSHOT REAL (MOD_HEAD_SHOT): admin (2º bloque) mata con headshot.
      '  1:52 K;bot4;3;allies;/dev/console;c103bb7531742427;14;axis;admin;ump45_eotech_mp;55;MOD_HEAD_SHOT;head',
      // Kill sin headshot del mismo killer → hsRatio = 1/2 = 0.5.
      '  1:53 K;bot8;7;allies;/dev/urandom;c103bb7531742427;14;axis;admin;famas_gl_mp;77;MOD_HEAD_SHOT;torso_lower\n',
    ]);
    await ingestGameLog(LOG_PATH, SERVER_LABEL);

    const adminRes = await req().get(`/api/players/${ADMIN_DEC}`);
    expect(adminRes.status).toBe(200);
    const adminBody = adminRes.body as { player: { kills: number; headshots: number; hsRatio: number | null; headshotPct: number } };
    expect(adminBody.player.kills).toBe(2);
    expect(adminBody.player.headshots).toBe(1);
    expect(adminBody.player.hsRatio).toBe(0.5); // 1/2, 2 decimales
    expect(adminBody.player.headshotPct).toBe(50); // % equivalente (campo preexistente)

    // Mandango: 0 kills → hsRatio null (sin división por cero).
    const mandangoRes = await req().get(`/api/players/${MANDANGO_DEC}`);
    expect(mandangoRes.status).toBe(200);
    const mandangoBody = mandangoRes.body as { player: { kills: number; headshots: number; hsRatio: number | null } };
    expect(mandangoBody.player.kills).toBe(0);
    expect(mandangoBody.player.hsRatio).toBeNull();
  });
});

// ── KNIFE STATS (MOD_MELEE) + FEED ENRIQUECIDO + DAÑO DE POR VIDA ───────────

describe('knifeKills/knifeDeaths (MOD_MELEE) y feed enriquecido del perfil', () => {
  // Línea REAL del log del dueño: cuchillada/golpe con el arma en la mano → el
  // juego la marca MOD_MELEE (fixture real: Colt Anaconda a 138, right_arm_upper).
  const KNIFE_LINE = `  0:10 K;${HEX_A};0;allies;Alpha^7;${HEX_B};1;axis;Bravo;coltanaconda_tactical_mp;138;MOD_MELEE;right_arm_upper`;
  const RIFLE_LINE = `  0:12 K;${HEX_B};1;axis;Bravo;${HEX_A};0;allies;Alpha^7;ak47;120;MOD_RIFLE_BULLET;head`;

  it('cuenta la cuchillada: knifeKills del killer (2º bloque) y knifeDeaths de la víctima (1º bloque); persiste el mod', async () => {
    writeLog([
      '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
      `  0:04 J;${HEX_A};0;Alpha^7`,
      `  0:05 J;${HEX_B};1;Bravo`,
      KNIFE_LINE,
      '\n',
    ]);
    const result = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(result.ok).toBe(true);
    expect(result.killEventsSynced).toBe(1);

    // ESTA build: Alpha (1er bloque) = VÍCTIMA; Bravo (2º bloque) = KILLER.
    // Agregados del Player: el kill/death es campo persistido...
    const bravoRow = await prisma.player.findUniqueOrThrow({ where: { guid: DEC_B } });
    expect(bravoRow.kills).toBe(1);
    const alphaRow = await prisma.player.findUniqueOrThrow({ where: { guid: DEC_A } });
    expect(alphaRow.deaths).toBe(1);

    // ...pero knifeKills/knifeDeaths son COMPUTADOS AL VUELO (opción "sin schema
    // en Player"): se leen del perfil GET /api/players/:guid.
    const bravoRes = await req().get(`/api/players/${DEC_B}`);
    expect(bravoRes.status).toBe(200);
    const bravoBody = bravoRes.body as { player: { knifeKills: number; knifeDeaths: number } };
    expect(bravoBody.player.knifeKills).toBe(1);
    expect(bravoBody.player.knifeDeaths).toBe(0);
    const alphaRes = await req().get(`/api/players/${DEC_A}`);
    expect(alphaRes.status).toBe(200);
    const alphaBody = alphaRes.body as { player: { knifeKills: number; knifeDeaths: number } };
    expect(alphaBody.player.knifeDeaths).toBe(1);
    expect(alphaBody.player.knifeKills).toBe(0);

    // El evento persiste el mod crudo del log (semántica DB stock: origin=killer).
    const event = await prisma.killEvent.findFirstOrThrow();
    expect(event).toMatchObject({
      originGuid: DEC_B,
      targetGuid: DEC_A,
      weapon: 'coltanaconda_tactical_mp',
      mod: 'MOD_MELEE',
      hitloc: 'right_arm_upper',
      damage: 138,
    });
  });

  it('un kill normal (MOD_RIFLE_BULLET) NO incrementa knifeKills/knifeDeaths', async () => {
    writeLog([
      '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
      `  0:04 J;${HEX_A};0;Alpha^7`,
      `  0:05 J;${HEX_B};1;Bravo`,
      RIFLE_LINE,
      '\n',
    ]);
    await ingestGameLog(LOG_PATH, SERVER_LABEL);

    // ESTA build: Bravo (1er bloque) = VÍCTIMA; Alpha (2º bloque) = KILLER.
    // knifeKills/knifeDeaths son computados al vuelo → se leen del perfil.
    const alphaRes = await req().get(`/api/players/${DEC_A}`);
    expect(alphaRes.status).toBe(200);
    const alphaBody = alphaRes.body as { player: { kills: number; knifeKills: number; knifeDeaths: number } };
    expect(alphaBody.player.kills).toBe(1);
    expect(alphaBody.player.knifeKills).toBe(0);
    expect(alphaBody.player.knifeDeaths).toBe(0);
    const bravoRes = await req().get(`/api/players/${DEC_B}`);
    expect(bravoRes.status).toBe(200);
    const bravoBody = bravoRes.body as { player: { deaths: number; knifeKills: number; knifeDeaths: number } };
    expect(bravoBody.player.deaths).toBe(1);
    expect(bravoBody.player.knifeDeaths).toBe(0);
    expect(bravoBody.player.knifeKills).toBe(0);
  });

  it('expone knifeKills/knifeDeaths/damagePerKill en el perfil y feed con headshot/isKnife/weaponCode/weaponName/hitloc', async () => {
    writeLog([
      '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
      `  0:03 J;${HEX_C};2;Charlie`,
      `  0:04 J;${HEX_A};0;Alpha^7`,
      `  0:05 J;${HEX_B};1;Bravo`,
      // D no letal: Alpha RECIBE 50 de Bravo → damageDealt de Bravo SIN kill.
      `  0:06 D;${HEX_A};0;allies;Alpha^7;${HEX_B};1;axis;Bravo;ak47;50;MOD_RIFLE_BULLET;chest`,
      KNIFE_LINE, // Bravo cuchillea a Alpha (138)
      RIFLE_LINE, // Alpha mata a Bravo con rifle + headshot (120)
      // Charlie muere por world: crea evento world (targetGuid='') SOLO para el
      // skill; knifeDeaths/feed/armas lo excluyen (targetGuid != '').
      `  0:20 K;${HEX_C};2;axis;Charlie;;-1;world;;none;100;MOD_FALLING;none`,
      '\n',
    ]);
    await ingestGameLog(LOG_PATH, SERVER_LABEL);

    interface FeedEvent {
      direction: string;
      isKnife: boolean;
      headshot: boolean;
      weaponCode: string | null;
      weaponName: string | null;
      hitloc: string | null;
      damage: number;
    }
    interface ProfileBody {
      player: {
        knifeKills: number;
        knifeDeaths: number;
        damageDealt: number;
        damageTaken: number;
        kills: number;
        damagePerKill: number | null;
      };
      recentEvents: FeedEvent[];
    }

    // Bravo: 1 knifeKill (138) + 50 de daño no letal → damageDealt 188; murió por rifle (120).
    const bravoRes = await req().get(`/api/players/${DEC_B}`);
    expect(bravoRes.status).toBe(200);
    const bravoBody = bravoRes.body as ProfileBody;
    expect(bravoBody.player.knifeKills).toBe(1);
    expect(bravoBody.player.knifeDeaths).toBe(0);
    expect(bravoBody.player.damageDealt).toBe(188); // 138 (K) + 50 (D no letal): los D cuentan aunque no maten
    expect(bravoBody.player.damageTaken).toBe(120);
    expect(bravoBody.player.damagePerKill).toBe(188); // 188/1 kill

    // Feed de Bravo: su baja a cuchillo Y su muerte por rifle headshot, ambos enriquecidos.
    const knifeEvent = bravoBody.recentEvents.find((event) => event.isKnife);
    expect(knifeEvent).toMatchObject({
      direction: 'kill',
      isKnife: true,
      headshot: false,
      weaponCode: 'coltanaconda_tactical_mp',
      weaponName: 'Colt Anaconda + Cuchillo táctico',
      hitloc: 'right_arm_upper',
      damage: 138,
    });
    const deathEvent = bravoBody.recentEvents.find((event) => event.direction === 'death');
    expect(deathEvent).toMatchObject({
      direction: 'death',
      isKnife: false,
      headshot: true,
      weaponCode: 'ak47',
      weaponName: 'AK-47',
      hitloc: 'head',
      damage: 120,
    });

    // Alpha: murió a cuchillo (knifeDeaths=1); daño recibido 50 (D) + 138 (K) = 188.
    const alphaRes = await req().get(`/api/players/${DEC_A}`);
    expect(alphaRes.status).toBe(200);
    const alphaBody = alphaRes.body as ProfileBody;
    expect(alphaBody.player.knifeKills).toBe(0);
    expect(alphaBody.player.knifeDeaths).toBe(1);
    expect(alphaBody.player.damageTaken).toBe(188);
    expect(alphaBody.player.damagePerKill).toBe(120); // daño infligido 120 / 1 kill

    // Charlie: 0 kills (solo deaths) → damagePerKill null (sin división por cero).
    const charlieRes = await req().get(`/api/players/${DEC_C}`);
    expect(charlieRes.status).toBe(200);
    const charlieBody = charlieRes.body as ProfileBody;
    expect(charlieBody.player.kills).toBe(0);
    expect(charlieBody.player.knifeKills).toBe(0);
    expect(charlieBody.player.knifeDeaths).toBe(0);
    expect(charlieBody.player.damagePerKill).toBeNull();
  });
});

// ── WORLD/SUICIDIO → KillEvent + WORLD_LOSS (2026-11-08) ────────────────────
// Antes la muerte por world/suicidio solo hacía deaths++ SIN crear KillEvent:
// el skill NUNCA se enteraba (el reporte «40 kills → 1375.39; 1 muerte → sigue
// 1375.39» venía de exactamente eso). Ahora el reader crea el evento con
// originGuid = víctima y targetGuid = '' (marcador de "sin atacante"): el motor
// skill aplica la pérdida plana SKILL.WORLD_LOSS=4 × SKILL_VICTIM_LOSS_SCALE
// (balance 2026-11-10: 4 × 0.5 = −2 efectivos) sin tocar skill/.
// Los consumidores de stats (feed/armas/mapas/streak) filtran targetGuid == ''
// → el evento world SOLO mueve skill, nada más.
describe('world/suicidio → KillEvent (targetGuid="") + skill −2', () => {
  it('muerte por WORLD (humano): crea KillEvent originGuid=víctima targetGuid="" y aplica −2 al skill (4×0.5)', async () => {
    // Fixture = caso REAL del dueño (0:39, MOD_FALLING, killer world sin guid).
    writeLog([
      '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
      `  0:04 J;${HEX_A};0;Alpha`,
      `  0:39 K;${HEX_A};0;allies;Alpha;;-1;world;;none;100;MOD_FALLING;none\n`,
    ]);
    const result = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(result.ok).toBe(true);
    expect(result.killEventsSynced).toBe(1); // el world AHORA crea evento

    // Counters clásicos intactos: deaths++ y daño recibido, sin kills.
    const alpha = await prisma.player.findUniqueOrThrow({ where: { guid: DEC_A } });
    expect(alpha.deaths).toBe(1);
    expect(alpha.damageTaken).toBe(100);
    expect(alpha.kills).toBe(0);
    expect(alpha.bestStreak).toBe(0); // morir por world NO es kill (ni suma ni resetea racha)

    // KillEvent: originGuid = víctima, targetGuid = '' (marcador world).
    const event = await prisma.killEvent.findFirstOrThrow();
    expect(event).toMatchObject({
      originGuid: DEC_A,
      targetGuid: '',
      isKill: true,
      isTeamkill: false,
      headshot: false,
      weapon: 'none',
      mod: 'MOD_FALLING',
      damage: 100,
      map: 'mp_rust',
      gametype: 'war',
      server: SERVER_LABEL,
      skillProcessed: false, // pendiente para processSkillUpdates
    });

    // El motor skill aplica WORLD_LOSS × SKILL_VICTIM_LOSS_SCALE (sin tocar skill/).
    await processSkillUpdates();
    const after = await prisma.player.findUniqueOrThrow({ where: { guid: DEC_A } });
    expect(after.skillElo).toBe(SKILL.START - SKILL.WORLD_LOSS * env.skillVictimLossScale); // 1000 − 4×0.5 = 998
    expect(after.skill).toBe(SKILL.START - SKILL.WORLD_LOSS * env.skillVictimLossScale); // bestStreak 0 → sin bonus
    const processed = await prisma.killEvent.findFirstOrThrow();
    expect(processed.skillProcessed).toBe(true); // la línea quedó skillProcessed=1

    // El evento world NO contamina stats: feed sin entradas y ranking de armas
    // sin la pseudo-arma "none" del log.
    const profileRes = await req().get(`/api/players/${DEC_A}`);
    expect(profileRes.status).toBe(200);
    const profile = profileRes.body as { player: { kills: number; knifeKills: number }; recentEvents: unknown[] };
    expect(profile.player.kills).toBe(0);
    expect(profile.player.knifeKills).toBe(0);
    expect(profile.recentEvents).toHaveLength(0); // world filtrado del feed
    const weapons = await getWeaponsRanking({ sort: 'kills', order: 'desc' });
    expect(weapons.total).toBe(0); // "none" del world NO entra al ranking global
  });

  it('SUICIDIO (humano): mismo tratamiento — evento con targetGuid="" y skill −2 (4×0.5)', async () => {
    // Fixture = suicidio REAL del dueño (19:30, semtex, mismo guid en ambos bloques).
    writeLog([
      '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
      `  0:04 J;${HEX_B};1;Bravo`,
      `  0:16 K;${HEX_B};1;axis;Bravo;${HEX_B};1;axis;Bravo;semtex;300;MOD_GRENADE;none\n`,
    ]);
    const result = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(result.ok).toBe(true);
    expect(result.killEventsSynced).toBe(1);

    // deaths++ se mantiene (UNA sola vez: el evento nuevo no re-cuenta la muerte).
    const bravo = await prisma.player.findUniqueOrThrow({ where: { guid: DEC_B } });
    expect(bravo.deaths).toBe(1);
    expect(bravo.damageTaken).toBe(300);
    expect(bravo.kills).toBe(0); // el suicidio NO suma kill

    const event = await prisma.killEvent.findFirstOrThrow();
    expect(event).toMatchObject({ originGuid: DEC_B, targetGuid: '', damage: 300, mod: 'MOD_GRENADE', skillProcessed: false });

    await processSkillUpdates();
    const after = await prisma.player.findUniqueOrThrow({ where: { guid: DEC_B } });
    expect(after.skillElo).toBe(SKILL.START - SKILL.WORLD_LOSS * env.skillVictimLossScale); // 1000 − 2 = 998
    const processed = await prisma.killEvent.findFirstOrThrow();
    expect(processed.skillProcessed).toBe(true);
  });

  it('BOT que muere por world/suicidio: SOLO counters (deaths++/daño), NINGÚN evento ni skill −2', async () => {
    const BOT6 = BigInt('0xb07000000000006').toString(10);
    writeLog([
      '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
      '  0:04 J;bot6;16;BotSix',
      '  0:16 K;bot6;16;allies;BotSix;;-1;world;;none;100;MOD_FALLING;none', // world de BOT
      '  0:18 K;bot6;16;allies;BotSix;bot6;16;allies;BotSix;semtex;300;MOD_GRENADE;none\n', // suicidio de BOT
    ]);
    const result = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(result.ok).toBe(true);
    expect(result.killEventsSynced).toBe(0); // bots excluidos: sin eventos
    expect(await prisma.killEvent.count()).toBe(0);

    // Los counters del bot se mantienen EXACTAMENTE como antes del fix.
    const bot = await prisma.player.findUniqueOrThrow({ where: { guid: BOT6 } });
    expect(bot.deaths).toBe(2); // world + suicidio
    expect(bot.damageTaken).toBe(400); // 100 + 300
    expect(bot.kills).toBe(0);

    // El skill del bot NO recibe la pérdida world (queda en el START inicial).
    await processSkillUpdates();
    const after = await prisma.player.findUniqueOrThrow({ where: { guid: BOT6 } });
    expect(after.skillElo).toBe(SKILL.START);
  });

  it('RECOMPUTE determinista con eventos world: replay desde cero → mismo skill final', async () => {
    // Dos muertes world del mismo humano: −2 efectivas cada una (4×0.5). El
    // recompute:skill solo
    // recorre KillEvent YA almacenados (los eventos viejos del log NO se
    // re-leen: el cursor los consumió) → fix-forward sin reset, como se acordó.
    writeLog([
      '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
      `  0:04 J;${HEX_C};2;Charlie`,
      `  0:39 K;${HEX_C};2;axis;Charlie;;-1;world;;none;100;MOD_FALLING;none`,
      `  1:10 K;${HEX_C};2;axis;Charlie;;-1;world;;none;100;MOD_TRIGGER_HURT;none\n`,
    ]);
    await ingestGameLog(LOG_PATH, SERVER_LABEL);
    await processSkillUpdates();
    const before = await prisma.player.findUniqueOrThrow({ where: { guid: DEC_C } });
    expect(before.skillElo).toBe(SKILL.START - 2 * SKILL.WORLD_LOSS * env.skillVictimLossScale); // 996

    // Flujo EXACTO de npm run recompute:skill.
    await prisma.killEvent.updateMany({ where: {}, data: { skillProcessed: false } });
    await prisma.player.updateMany({ where: {}, data: { skillElo: 0, skill: 0 } });
    await processSkillUpdates();
    const after = await prisma.player.findUniqueOrThrow({ where: { guid: DEC_C } });
    expect(after.skillElo).toBe(before.skillElo);
    expect(after.skill).toBe(before.skill);
    expect(await prisma.killEvent.count()).toBe(2);
    const rows = await prisma.killEvent.findMany();
    expect(rows.every((e) => e.skillProcessed)).toBe(true);
  });
});
