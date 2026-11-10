/**
 * Tests de la INGESTA LIVE (snapshot GSC del server) + DETECTOR unlockstats
 * + endpoints /api/admin/server/livestats y /api/admin/server/anti-unlock.
 *
 * Fixture: archivo sintético con los formatos que emite
 * apps/api/gsc/iw4x-ranking.gsc — v4 calibrado (`guid;xp;kills;name`, índices
 * 2266/2059) y v2 legacy de 8 campos — con humanos, bots y líneas basura.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../src/lib/prisma.js';
import { registerUser, req, resetDb } from './helpers.js';
import { resetSharedRcon } from '../src/lib/rcon/iw4x-rcon.js';
import { levelFromXp, LEVEL_XP_TABLE } from '../src/lib/save-parser/parse-stat-blob.js';
import {
  getLiveStatsSnapshot,
  parseLiveStatsText,
  resetLiveStatsState,
  runLiveStatsTick,
  splitLiveStatsFiles,
} from '../src/services/livestats.service.js';
import { FakeRconServer, LIVE_STATUS_FIXTURE } from './fake-rcon.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILE = resolve(here, 'data', 'livestats-snapshot.json');
const FIXTURE_FILE_2 = resolve(here, 'data', 'livestats-snapshot-2.json'); // segunda "sala"
const FIXTURE_FILE_MISSING = resolve(here, 'data', 'livestats-que-no-existe.json'); // nunca se crea

// GUIDs de prueba (decimal = formato Player.guid / getguid() humano).
const LINKED_HEX = 'AB12CD34EF567890'; // el humano del fixture rcon (slot 0)
const LINKED_DEC = BigInt(`0x${LINKED_HEX}`).toString(10);
const UNLINKED_DEC = '12345678901234567';
const HEX_GUID = 'C1A2B3D4E5F60718'; // el snapshot puede traer hex → se normaliza
const HEX_AS_DEC = BigInt(`0x${HEX_GUID}`).toString(10);
const BOT_RANGE_HEX = 'B07000000000001'; // rango dedicado a bots (0xb07…, 15 hex chars)

const KICK_MSG = 'Stats modificados detectados';

function line(guid: string, xp: number, prestige = 0, kills = 10, deaths = 5, headshots = 2, timePlayed = 60, name = 'Player'): string {
  return `${guid};${xp};${prestige};${kills};${deaths};${headshots};${timePlayed};${name}`;
}

function writeSnapshot(lines: string[]): void {
  writeFileSync(FIXTURE_FILE, ['#iw4x-ranking v1', ...lines].join('\n'), 'utf8');
}

/** Escribe un snapshot v4 en un archivo ARBITRARIO (para tests multi-archivo). */
function writeSnapshotTo(file: string, lines: string[]): void {
  writeFileSync(file, ['#iw4x-ranking v4', ...lines].join('\n'), 'utf8');
}

const SAVED_ENV: Record<string, string | undefined> = {
  RCON_HOST: process.env.RCON_HOST,
  RCON_PORT: process.env.RCON_PORT,
  RCON_PASSWORD: process.env.RCON_PASSWORD,
  RCON_SPACING_MS: process.env.RCON_SPACING_MS,
  RCON_RESPONSE_TIMEOUT_MS: process.env.RCON_RESPONSE_TIMEOUT_MS,
};
const PASSWORD = 'test-rcon-pass';

let fake: FakeRconServer;

beforeAll(() => {
  for (const [key, value] of Object.entries(SAVED_ENV)) delete process.env[key];
  mkdirSync(dirname(FIXTURE_FILE), { recursive: true });
});

afterAll(async () => {
  rmSync(FIXTURE_FILE, { force: true });
  rmSync(FIXTURE_FILE_2, { force: true });
  rmSync(FIXTURE_FILE_MISSING, { force: true });
  await resetDb();
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(async () => {
  resetLiveStatsState();
  resetSharedRcon();
  fake = new FakeRconServer({ password: PASSWORD, statusText: LIVE_STATUS_FIXTURE });
  await fake.start();
  process.env.RCON_HOST = '127.0.0.1';
  process.env.RCON_PORT = String(fake.port);
  process.env.RCON_PASSWORD = PASSWORD;
  process.env.RCON_SPACING_MS = '15';
  process.env.RCON_RESPONSE_TIMEOUT_MS = '200';
  await resetDb();
});

// ── Parser (unidad pura) ────────────────────────────────────────────────────

describe('parseLiveStatsText', () => {
  it('parsea líneas válidas, normaliza guids (decimal/hex) y toma el name completo con ";"', () => {
    const entries = parseLiveStatsText(
      ['#iw4x-ranking v1', line(UNLINKED_DEC, 100000, 3, 11, 22, 33, 444, 'Guy;Malone'), '', 'basura sin campos', '# comment'].join('\n'),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ guid: UNLINKED_DEC, xp: 100000, prestige: 3, kills: 11, deaths: 22, headshots: 33, timePlayed: 444, name: 'Guy;Malone' });
  });

  it('convierte guids HEX y RECHAZA bots ("botN" y rango 0xb07…)', () => {
    const entries = parseLiveStatsText([line(HEX_GUID, 1000), line('bot5', 1000), line(BOT_RANGE_HEX, 1000), line(UNLINKED_DEC, 1000)].join('\n'));
    expect(entries.map((e) => e.guid)).toEqual([HEX_AS_DEC, UNLINKED_DEC]);
  });

  it('descarga la línea ENTERA si cualquier campo no pasa sanity', () => {
    const entries = parseLiveStatsText(
      [
        '#iw4x-ranking v1', // cabecera legacy: exige 8 campos (4..7 → fuera)
        line(UNLINKED_DEC, 99999999), // xp > MAX
        line(UNLINKED_DEC, 1000, 99), // prestigio > 10
        line(UNLINKED_DEC, 1000, 0, -5), // kills negativos
        `${UNLINKED_DEC};1000;0;1;1`, // sin campos suficientes (5 < 8)
        line(UNLINKED_DEC, 12345678901234), // kills > cap
        line(UNLINKED_DEC, 1000), // válida
      ].join('\n'),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.xp).toBe(1000);
  });
});

// ── Parser v4 (formato corto guid;xp;kills;name del GSC v4 calibrado) ───────

describe('parseLiveStatsText v4 (guid;xp;kills;name)', () => {
  it('parsea el formato v4 por cabecera y deja null lo que no trae', () => {
    const entries = parseLiveStatsText(['#iw4x-ranking v4', `${UNLINKED_DEC};5120;14;Owner`].join('\n'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      guid: UNLINKED_DEC,
      name: 'Owner',
      xp: 5120,
      kills: 14,
      prestige: null,
      deaths: null,
      headshots: null,
      timePlayed: null,
    });
  });

  it('AUTODETECTA v4 sin cabecera (4 campos) y toma el name completo con ";"', () => {
    const entries = parseLiveStatsText([`${HEX_GUID};5120;14;Guy;Malone`, 'basura', `${UNLINKED_DEC};1;2`].join('\n'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ guid: HEX_AS_DEC, xp: 5120, kills: 14, name: 'Guy;Malone' });
  });

  it('acepta AMBOS formatos mezclados en el mismo snapshot (transición v2→v4)', () => {
    const entries = parseLiveStatsText(
      ['#iw4x-ranking v4', `${UNLINKED_DEC};5120;14;V4Owner`, line(HEX_GUID, 100000, 3, 11, 22, 33, 444, 'Legacy')].join('\n'),
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ guid: UNLINKED_DEC, xp: 5120, kills: 14, prestige: null });
    expect(entries[1]).toMatchObject({ guid: HEX_AS_DEC, xp: 100000, prestige: 3, kills: 11, deaths: 22, headshots: 33, timePlayed: 444 });
  });

  it('rechaza basura v4: sanity XP/kills, <4 campos, name vacío y bots', () => {
    const entries = parseLiveStatsText(
      [
        `${UNLINKED_DEC};${LEVEL_XP_TABLE[LEVEL_XP_TABLE.length - 1] + 1};5;Max`, // xp > 2516000
        `${UNLINKED_DEC};5120;-3;Neg`, // kills negativos
        `${UNLINKED_DEC};5120;14`, // 3 campos: sin name
        `${UNLINKED_DEC};5120;14;`, // name vacío
        `bot5;5120;14;Bot`, // bot por prefijo
        `${UNLINKED_DEC};5120;14;Válido`,
      ].join('\n'),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('Válido');
  });

  it('la cabecera v4 no contamina líneas legacy de 8 campos del mismo archivo y viceversa', () => {
    const entries = parseLiveStatsText(
      ['#iw4x-ranking v4', line(UNLINKED_DEC, 1000, 2, 11, 22, 33, 444, 'OchoCampos')].join('\n'),
    );
    // 8 campos bajo cabecera v4: cae al branch legacy por >= 8 campos → se parsea completo.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ xp: 1000, prestige: 2, kills: 11, timePlayed: 444 });
  });
});

// ── Ingesta v4 → Player ─────────────────────────────────────────────────────

describe('ingesta live v4 (runLiveStatsTick)', () => {
  const T0 = 1_700_000_000_000;

  it('línea v4 real del dueño (xp 5120 → LVL 4 derivado) actualiza saveXp/saveLevel', async () => {
    writeSnapshot(['#iw4x-ranking v4', `${UNLINKED_DEC};5120;14;Owner`]);
    const result = await runLiveStatsTick({ file: FIXTURE_FILE, now: T0 });

    expect(result.read).toBe(true);
    expect(result.entries).toBe(1);
    expect(result.playersUpdated).toBe(1);

    const player = await prisma.player.findUnique({ where: { guid: UNLINKED_DEC } });
    expect(player?.saveXp).toBe(5120);
    expect(player?.saveLevel).toBe(4); // Private First Class, deriva de levelFromXp(5120)
    expect(player?.saveParsedAt).not.toBeNull();

    const view = getLiveStatsSnapshot()?.players[0];
    expect(view).toMatchObject({ guid: UNLINKED_DEC, xp: 5120, kills: 14, level: 4, prestige: 0 });
  });

  it('v4 NO pisa savePrestige existente (el formato no lo trae)', async () => {
    await prisma.player.create({ data: { guid: UNLINKED_DEC, name: 'Con Prestigio', savePrestige: 5, saveXp: 1000, saveParsedAt: new Date(T0 - 60_000) } });
    writeSnapshot(['#iw4x-ranking v4', `${UNLINKED_DEC};5120;14;Owner`]);
    await runLiveStatsTick({ file: FIXTURE_FILE, now: T0 });

    const player = await prisma.player.findUnique({ where: { guid: UNLINKED_DEC } });
    expect(player?.saveXp).toBe(5120); // xp actualizada
    expect(player?.savePrestige).toBe(5); // prestigio intacto
  });

  it('legacy v2 (8 campos) SIGUE pisando savePrestige (regresión del formato viejo)', async () => {
    await prisma.player.create({ data: { guid: UNLINKED_DEC, name: 'Con Prestigio', savePrestige: 5, saveXp: 1000, saveParsedAt: new Date(T0 - 60_000) } });
    writeSnapshot([line(UNLINKED_DEC, 5120, 2)]);
    await runLiveStatsTick({ file: FIXTURE_FILE, now: T0 });

    const player = await prisma.player.findUnique({ where: { guid: UNLINKED_DEC } });
    expect(player?.saveXp).toBe(5120);
    expect(player?.savePrestige).toBe(2); // la línea legacy sí lo trae
  });
});

// ── Multi-archivo (LIVE_STATS_FILE con comas: una ruta por sala) ────────────

describe('ingesta multi-archivo (LIVE_STATS_FILE="p1,p2")', () => {
  const T0 = 1_700_000_000_000;
  const GUID_SALA2_DEC = '98765432109876543'; // humano "de la sala 2"

  it('splitLiveStatsFiles separa por coma, hace trim y descarta vacíos', () => {
    expect(splitLiveStatsFiles('/a/b.json,/c/d.json')).toEqual(['/a/b.json', '/c/d.json']);
    expect(splitLiveStatsFiles(' /a/b.json ,  , /c/d.json ')).toEqual(['/a/b.json', '/c/d.json']);
    expect(splitLiveStatsFiles('/solo/path.json')).toEqual(['/solo/path.json']);
    expect(splitLiveStatsFiles(',,')).toEqual([]);
  });

  it('dedupe: MISMO guid en ambos archivos → 1 entrada, gana el archivo posterior', async () => {
    writeSnapshotTo(FIXTURE_FILE, [`${UNLINKED_DEC};1000;10;Sala1`]);
    writeSnapshotTo(FIXTURE_FILE_2, [`${UNLINKED_DEC};2000;20;Sala2`]);
    const result = await runLiveStatsTick({ file: `${FIXTURE_FILE},${FIXTURE_FILE_2}`, now: T0 });

    expect(result.read).toBe(true);
    expect(result.filesTotal).toBe(2);
    expect(result.filesRead).toBe(2);
    expect(result.entries).toBe(1); // dedupe por guid
    expect(result.playersUpdated).toBe(1);

    const player = await prisma.player.findUnique({ where: { guid: UNLINKED_DEC } });
    expect(player?.saveXp).toBe(2000); // el archivo POSTERIOR (sala2) gana
    expect(player?.name).toBe('Sala2');

    const snapshot = getLiveStatsSnapshot();
    expect(snapshot?.players).toHaveLength(1);
    expect(snapshot?.players[0]).toMatchObject({ guid: UNLINKED_DEC, xp: 2000, name: 'Sala2', kills: 20 });
  });

  it('el archivo posterior gana AUNQUE traiga MENOS xp (orden posterior, no máximo)', async () => {
    writeSnapshotTo(FIXTURE_FILE, [`${UNLINKED_DEC};3000;30;Sala1`]);
    writeSnapshotTo(FIXTURE_FILE_2, [`${UNLINKED_DEC};500;5;Sala2`]);
    const result = await runLiveStatsTick({ file: `${FIXTURE_FILE},${FIXTURE_FILE_2}`, now: T0 });

    expect(result.entries).toBe(1);
    const player = await prisma.player.findUnique({ where: { guid: UNLINKED_DEC } });
    expect(player?.saveXp).toBe(500); // posterior gana, aunque sea menor
  });

  it('guids DISTINTOS → se COMBINAN: ambos players upsertados, snapshot con 2', async () => {
    writeSnapshotTo(FIXTURE_FILE, [`${UNLINKED_DEC};1000;10;Sala1`]);
    writeSnapshotTo(FIXTURE_FILE_2, [`${GUID_SALA2_DEC};4000;40;Sala2`]);
    const result = await runLiveStatsTick({ file: `${FIXTURE_FILE},${FIXTURE_FILE_2}`, now: T0 });

    expect(result.read).toBe(true);
    expect(result.entries).toBe(2);
    expect(result.playersUpdated).toBe(2);

    const sala1 = await prisma.player.findUnique({ where: { guid: UNLINKED_DEC } });
    const sala2 = await prisma.player.findUnique({ where: { guid: GUID_SALA2_DEC } });
    expect(sala1?.saveXp).toBe(1000);
    expect(sala2?.saveXp).toBe(4000);
    expect(getLiveStatsSnapshot()?.players.map((p) => p.guid).sort()).toEqual([GUID_SALA2_DEC, UNLINKED_DEC].sort());
  });

  it('archivo VACÍO (solo cabecera) → aporta 0; el otro archivo alimenta la ingesta', async () => {
    writeSnapshotTo(FIXTURE_FILE, []); // cabecera v4 sin líneas: 0 entradas
    writeSnapshotTo(FIXTURE_FILE_2, [`${GUID_SALA2_DEC};2000;20;Sala2`]);
    const result = await runLiveStatsTick({ file: `${FIXTURE_FILE},${FIXTURE_FILE_2}`, now: T0 });

    expect(result.read).toBe(true);
    expect(result.filesRead).toBe(2);
    expect(result.entries).toBe(1);
    expect(result.playersUpdated).toBe(1);
    const sala2Player = await prisma.player.findUnique({ where: { guid: GUID_SALA2_DEC } });
    expect(sala2Player?.saveXp).toBe(2000);
  });

  it('archivo AUSENTE entre varios → silencioso, aporta 0, el resto se procesa', async () => {
    writeSnapshotTo(FIXTURE_FILE_2, [`${GUID_SALA2_DEC};2500;25;Sala2`]);
    const result = await runLiveStatsTick({ file: `${FIXTURE_FILE_MISSING},${FIXTURE_FILE_2}`, now: T0 });

    expect(result.read).toBe(true); // al menos UNO se leyó
    expect(result.filesTotal).toBe(2);
    expect(result.filesRead).toBe(1); // el ausente no cuenta
    expect(result.entries).toBe(1);
    expect(result.playersUpdated).toBe(1);
    expect(await prisma.player.count()).toBe(1);
  });

  it('TODOS los archivos ausentes → no-op (read=false, DB intacta, sin throw)', async () => {
    const result = await runLiveStatsTick({ file: `${FIXTURE_FILE_MISSING},${FIXTURE_FILE_MISSING}` });
    expect(result.read).toBe(false);
    expect(result.filesTotal).toBe(2);
    expect(result.filesRead).toBe(0);
    expect(result.entries).toBe(0);
    expect(await prisma.player.count()).toBe(0);
  });
});

// ── Ingesta → Player ────────────────────────────────────────────────────────

describe('ingesta live (runLiveStatsTick)', () => {
  it('actualiza saveXp/saveLevel/savePrestige/saveParsedAt del player VINCULADO y crea el player NO vinculado', async () => {
    const owner = await registerUser('live-linked@test.local', 'supersecret123', 'Linked Owner');
    await prisma.player.create({ data: { guid: LINKED_DEC, name: 'Linked' } });
    await prisma.accountLink.create({ data: { userId: owner.id, guid: LINKED_DEC } });

    writeSnapshot([line(LINKED_DEC, 100000, 2), line(UNLINKED_DEC, 2500000, 1)]);
    const result = await runLiveStatsTick({ file: FIXTURE_FILE, now: 1_700_000_000_000 });

    expect(result.read).toBe(true);
    expect(result.entries).toBe(2);
    expect(result.playersUpdated).toBe(2);

    const linked = await prisma.player.findUnique({ where: { guid: LINKED_DEC } });
    expect(linked?.saveXp).toBe(100000);
    expect(linked?.saveLevel).toBe(levelFromXp(100000));
    expect(linked?.savePrestige).toBe(2);
    expect(linked?.saveParsedAt).not.toBeNull();

    const unlinked = await prisma.player.findUnique({ where: { guid: UNLINKED_DEC } });
    expect(unlinked?.saveXp).toBe(2500000);
    expect(unlinked?.saveLevel).toBe(levelFromXp(2500000)); // L70 completo
    expect(unlinked?.saveLevel).toBe(70);
  });

  it('ignora bots y líneas insane: no crea players para ellos', async () => {
    writeSnapshot([line('bot5', 500000), line(BOT_RANGE_HEX, 500000), line(UNLINKED_DEC, 999999999), line(UNLINKED_DEC, 500)]);
    const result = await runLiveStatsTick({ file: FIXTURE_FILE });

    expect(result.entries).toBe(1); // solo la línea válida
    expect(result.playersUpdated).toBe(1);
    const players = await prisma.player.findMany();
    expect(players).toHaveLength(1); // solo el guid humano válido
    const insane = await prisma.player.findMany({ where: { saveXp: 999999999 } });
    expect(insane).toHaveLength(0);
  });

  it('archivo AUSENTE → silencioso (read=false, sin cambios en DB, sin throw)', async () => {
    rmSync(FIXTURE_FILE, { force: true });
    const result = await runLiveStatsTick({ file: FIXTURE_FILE });
    expect(result.read).toBe(false);
    expect(result.entries).toBe(0);
    expect(await prisma.player.count()).toBe(0);
  });

  it('archivo CORRUPTO (binario) → silencioso: read=true, 0 entradas, DB intacta', async () => {
    writeFileSync(FIXTURE_FILE, Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f]));
    const result = await runLiveStatsTick({ file: FIXTURE_FILE });
    expect(result.read).toBe(true);
    expect(result.entries).toBe(0);
    expect(result.playersUpdated).toBe(0);
    expect(await prisma.player.count()).toBe(0);
  });

  it('sin file (env LIVE_STATS_FILE vacía) → no-op', async () => {
    const result = await runLiveStatsTick();
    expect(result.file).toBeNull();
    expect(result.read).toBe(false);
    expect(await prisma.player.count()).toBe(0);
  });
});

// ── Detector unlockstats ────────────────────────────────────────────────────

describe('detector unlockstats', () => {
  const T0 = 1_700_000_000_000;

  it('salto absurdo (>500000 XP) en MENOS de 10 min → suspicious xp-jump', async () => {
    writeSnapshot([line(UNLINKED_DEC, 100000)]);
    await runLiveStatsTick({ file: FIXTURE_FILE, now: T0 });

    writeSnapshot([line(UNLINKED_DEC, 700000)]);
    const result = await runLiveStatsTick({ file: FIXTURE_FILE, now: T0 + 5 * 60_000 });

    expect(result.suspicious).toBe(1);
    const view = getLiveStatsSnapshot()?.players.find((p) => p.guid === UNLINKED_DEC);
    expect(view?.suspicious).toBe(true);
    expect(view?.reason).toBe('xp-jump');
    expect(view?.previousXp).toBe(100000);
    expect(view?.delta).toBe(600000);
  });

  it('salto GRANDE pero LENTO (≥ 10 min) → NO suspicious', async () => {
    writeSnapshot([line(UNLINKED_DEC, 100000)]);
    await runLiveStatsTick({ file: FIXTURE_FILE, now: T0 });

    writeSnapshot([line(UNLINKED_DEC, 700000)]);
    const result = await runLiveStatsTick({ file: FIXTURE_FILE, now: T0 + 11 * 60_000 });

    expect(result.suspicious).toBe(0);
    expect(getLiveStatsSnapshot()?.players[0]?.suspicious).toBe(false);
  });

  it('progreso normal (delta pequeño) → NO suspicious', async () => {
    writeSnapshot([line(UNLINKED_DEC, 100000)]);
    await runLiveStatsTick({ file: FIXTURE_FILE, now: T0 });

    writeSnapshot([line(UNLINKED_DEC, 102000)]);
    const result = await runLiveStatsTick({ file: FIXTURE_FILE, now: T0 + 60_000 });

    expect(result.suspicious).toBe(0);
    expect(getLiveStatsSnapshot()?.players[0]?.suspicious).toBe(false);
  });

  it('primer avistamiento en XP MÁXIMO SIN historial → suspicious max-xp-first-sighting', async () => {
    const maxXp = LEVEL_XP_TABLE[LEVEL_XP_TABLE.length - 1]; // 2516000
    writeSnapshot([line(UNLINKED_DEC, maxXp)]);
    const result = await runLiveStatsTick({ file: FIXTURE_FILE, now: T0 });

    expect(result.suspicious).toBe(1);
    const view = getLiveStatsSnapshot()?.players[0];
    expect(view?.suspicious).toBe(true);
    expect(view?.reason).toBe('max-xp-first-sighting');
    expect(view?.previousXp).toBeNull();
  });

  it('max XP CON historial en DB (saveXp previo) → NO suspicious (legacy legítimo)', async () => {
    const maxXp = LEVEL_XP_TABLE[LEVEL_XP_TABLE.length - 1];
    await prisma.player.create({
      data: { guid: UNLINKED_DEC, name: 'Legacy L70', saveXp: maxXp - 16000, saveParsedAt: new Date(T0 - 30 * 60_000) },
    });
    writeSnapshot([line(UNLINKED_DEC, maxXp)]);
    const result = await runLiveStatsTick({ file: FIXTURE_FILE, now: T0 });

    expect(result.suspicious).toBe(0);
    expect(getLiveStatsSnapshot()?.players[0]?.suspicious).toBe(false);
  });

  it('XP que BAJA (reset de prestigio) → NUNCA suspicious', async () => {
    writeSnapshot([line(UNLINKED_DEC, 700000)]);
    await runLiveStatsTick({ file: FIXTURE_FILE, now: T0 });

    writeSnapshot([line(UNLINKED_DEC, 0)]);
    const result = await runLiveStatsTick({ file: FIXTURE_FILE, now: T0 + 60_000 });
    expect(result.suspicious).toBe(0);

    // Y desde 0 un salto chico no acusa
    writeSnapshot([line(UNLINKED_DEC, 300000)]);
    const result2 = await runLiveStatsTick({ file: FIXTURE_FILE, now: T0 + 120_000 });
    expect(result2.suspicious).toBe(0);
    expect(getLiveStatsSnapshot()?.players[0]?.xp).toBe(300000);
  });

  it('sighting repetida SIN cambios no re-acusa (flag vigente, 0 detecciones nuevas)', async () => {
    const maxXp = LEVEL_XP_TABLE[LEVEL_XP_TABLE.length - 1];
    writeSnapshot([line(UNLINKED_DEC, maxXp)]);
    const first = await runLiveStatsTick({ file: FIXTURE_FILE, now: T0 });
    expect(first.suspicious).toBe(1);

    const second = await runLiveStatsTick({ file: FIXTURE_FILE, now: T0 + 60_000 });
    expect(second.suspicious).toBe(0); // sin transición nueva
    expect(getLiveStatsSnapshot()?.players[0]?.suspicious).toBe(true); // flag sigue vigente
  });
});

// ── Acción: anti_unlock_autokick ────────────────────────────────────────────

describe('acción anti-unlock (autokick)', () => {
  const T0 = 1_700_000_000_000;
  const maxXp = LEVEL_XP_TABLE[LEVEL_XP_TABLE.length - 1];

  it('ON → tell + clientkick al guid suspicious del status (bots exentos), UNA vez', async () => {
    await prisma.setting.create({ data: { key: 'anti_unlock_autokick', value: JSON.stringify({ enabled: true }) } });
    writeSnapshot([line(LINKED_DEC, maxXp), line('bot15', maxXp)]);
    const result = await runLiveStatsTick({ file: FIXTURE_FILE, now: T0 });

    expect(result.suspicious).toBe(1);
    expect(result.kicked).toBe(1);
    const commands = fake.received.map((entry) => entry.command);
    expect(commands).toContain(`tell 0 ${KICK_MSG}`);
    expect(commands).toContain('clientkick 0');
    expect(commands.filter((c) => c.startsWith('clientkick'))).toEqual(['clientkick 0']);
  });

  it('OFF (default) → solo flag: cero comandos rcon', async () => {
    writeSnapshot([line(LINKED_DEC, maxXp)]);
    const result = await runLiveStatsTick({ file: FIXTURE_FILE, now: T0 });

    expect(result.suspicious).toBe(1);
    expect(result.kicked).toBe(0);
    expect(fake.received).toHaveLength(0);
  });

  it('ON + guid NO conectado → flag sin kick y sin crash', async () => {
    await prisma.setting.create({ data: { key: 'anti_unlock_autokick', value: JSON.stringify({ enabled: true }) } });
    writeSnapshot([line(UNLINKED_DEC, maxXp)]); // no está en el fixture de status
    const result = await runLiveStatsTick({ file: FIXTURE_FILE, now: T0 });

    expect(result.suspicious).toBe(1);
    expect(result.kicked).toBe(0);
    expect(fake.commandsWith('status').length).toBeGreaterThan(0); // lo buscó
    expect(fake.commandsWith('clientkick')).toHaveLength(0);
  });
});

// ── Endpoints admin ─────────────────────────────────────────────────────────

describe('endpoints /api/admin/server/livestats y anti-unlock', () => {
  it('401 sin token y 403 con token USER (ambos endpoints)', async () => {
    expect((await req().get('/api/admin/server/livestats')).status).toBe(401);
    expect((await req().get('/api/admin/server/anti-unlock')).status).toBe(401);
    const { token } = await registerUser('live-user@test.local', 'supersecret123', 'Plain User');
    expect((await req().get('/api/admin/server/livestats').set('Authorization', `Bearer ${token}`)).status).toBe(403);
    expect((await req().post('/api/admin/server/anti-unlock').set('Authorization', `Bearer ${token}`).send({ enabled: true })).status).toBe(403);
  });

  it('GET livestats expone el snapshot con el shape documentado', async () => {
    const admin = await registerUser('admin-roles@test.local', 'supersecret123', 'Boss');
    writeSnapshot([line(HEX_GUID, 100000, 3, 111, 22, 33, 444, '^1Live^7Guy')]);
    await runLiveStatsTick({ file: FIXTURE_FILE, now: 1_700_000_000_000 });

    const res = await req().get('/api/admin/server/livestats').set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    const body = res.body as { file: string; updatedAt: string; players: Array<Record<string, unknown>> };
    expect(body.file).toBe(FIXTURE_FILE);
    expect(body.updatedAt).not.toBeNull();
    expect(body.players).toHaveLength(1);
    expect(body.players[0]).toMatchObject({
      guid: HEX_AS_DEC,
      name: '^1Live^7Guy',
      xp: 100000,
      level: levelFromXp(100000),
      prestige: 3,
      kills: 111,
      deaths: 22,
      headshots: 33,
      timePlayed: 444,
      suspicious: false,
      reason: null,
      previousXp: null,
      delta: null,
    });
  });

  it('GET livestats sin ingesta → file:null/updatedAt:null/players:[] (silencioso)', async () => {
    const admin = await registerUser('admin-roles@test.local', 'supersecret123', 'Boss');
    const res = await req().get('/api/admin/server/livestats').set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ file: null, updatedAt: null, players: [] });
  });

  it('anti-unlock GET default false; POST persiste (Setting); body inválido → 400', async () => {
    const admin = await registerUser('admin-roles@test.local', 'supersecret123', 'Boss');
    const auth = { Authorization: `Bearer ${admin.token}` };

    expect((await req().get('/api/admin/server/anti-unlock').set(auth)).body).toEqual({ enabled: false });

    const post = await req().post('/api/admin/server/anti-unlock').set(auth).send({ enabled: true });
    expect(post.status).toBe(200);
    expect(post.body).toEqual({ enabled: true });

    const again = await req().get('/api/admin/server/anti-unlock').set(auth);
    expect(again.body).toEqual({ enabled: true });
    const stored = await prisma.setting.findUnique({ where: { key: 'anti_unlock_autokick' } });
    expect(stored?.value).toBe(JSON.stringify({ enabled: true }));

    expect((await req().post('/api/admin/server/anti-unlock').set(auth).send({})).status).toBe(400);
    expect((await req().post('/api/admin/server/anti-unlock').set(auth).send({ enabled: 'yes' })).status).toBe(400);
    expect((await req().post('/api/admin/server/anti-unlock').set(auth).send({ enabled: true, extra: 1 })).status).toBe(400);
  });

  it('POST anti-unlock ON + tick suspicious → kick vía rcon real del tick (flujo completo)', async () => {
    const admin = await registerUser('admin-roles@test.local', 'supersecret123', 'Boss');
    await req().post('/api/admin/server/anti-unlock').set('Authorization', `Bearer ${admin.token}`).send({ enabled: true });

    writeSnapshot([line(LINKED_DEC, LEVEL_XP_TABLE[LEVEL_XP_TABLE.length - 1])]);
    const result = await runLiveStatsTick({ file: FIXTURE_FILE, now: 1_700_000_000_000 });
    expect(result.kicked).toBe(1);
    expect(fake.commandsWith('clientkick 0')).toHaveLength(1);
  });
});
