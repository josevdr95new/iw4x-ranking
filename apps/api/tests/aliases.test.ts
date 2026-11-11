import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ingestGameLog } from '../src/services/sync/gamelog.reader.js';
import { aliasKey, rebuildAliases, stripColorCodes, upsertPlayerAlias } from '../src/services/alias.service.js';
import { prisma } from '../src/lib/prisma.js';
import { registerUser, req, resetDb } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));

const HEX_A = 'a1b2c3d4e5f60718';
const HEX_B = '0f1e2d3c4b5a6978';
const HEX_C = 'deadbeefcafebabe';
const DEC_A = BigInt(`0x${HEX_A}`).toString(10);
const DEC_B = BigInt(`0x${HEX_B}`).toString(10);
const DEC_C = BigInt(`0x${HEX_C}`).toString(10);
const SERVER_LABEL = '192.168.3.99:28961';

const LOG_PATH = resolve(here, 'data', 'test-alias-games_mp.log');

function writeLog(lines: string[]): void {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  rmSync(LOG_PATH, { force: true });
  writeFileSync(LOG_PATH, lines.map((l) => `${l}\n`).join(''), 'utf8');
}

beforeAll(async () => {
  await resetDb();
});

beforeEach(async () => {
  await resetDb();
  rmSync(LOG_PATH, { force: true });
});

describe('limpieza de nombres (cleanName para comparar)', () => {
  it('stripColorCodes quita los códigos ^X de Quake/IW', () => {
    expect(stripColorCodes('Alpha^7')).toBe('Alpha');
    expect(stripColorCodes('^1Red^7 ^3Clan^0')).toBe('Red Clan');
    expect(stripColorCodes('sin-codigo')).toBe('sin-codigo');
    expect(stripColorCodes('^')).toBe('^'); // ^ suelto sin carácter: se queda
  });

  it('aliasKey es case-insensitive y normaliza códigos + espacios', () => {
    expect(aliasKey('Snake^7')).toBe(aliasKey('SNAKE'));
    expect(aliasKey('  Mandango ProMax ')).toBe('mandango promax');
    expect(aliasKey('')).toBe('');
  });
});

describe('upsertPlayerAlias (primera vez / repetición)', () => {
  it('la primera vez crea con occurrences=1 y firstSeen=lastSeen', async () => {
    const when = new Date('2026-11-01T10:00:00Z');
    await prisma.player.create({ data: { guid: DEC_A, name: 'Alpha' } });

    const created = await upsertPlayerAlias({ guid: DEC_A, name: 'Alpha^7', server: SERVER_LABEL, when });
    expect(created).toBe(true);

    const row = await prisma.playerAlias.findUnique({
      where: { guid_name: { guid: DEC_A, name: 'Alpha^7' } },
    });
    expect(row).not.toBeNull();
    expect(row?.occurrences).toBe(1);
    expect(row?.firstSeenAt.toISOString()).toBe(when.toISOString());
    expect(row?.lastSeenAt.toISOString()).toBe(when.toISOString());
    expect(row?.lastServer).toBe(SERVER_LABEL);
  });

  it('la repetición incrementa occurrences y avanza lastSeenAt (firstSeen intacto)', async () => {
    const t1 = new Date('2026-11-01T10:00:00Z');
    const t2 = new Date('2026-11-02T12:30:00Z');
    const t3 = new Date('2026-11-03T08:15:00Z');
    await prisma.player.create({ data: { guid: DEC_A, name: 'Alpha' } });

    await upsertPlayerAlias({ guid: DEC_A, name: 'Alpha', server: SERVER_LABEL, when: t1 });
    await upsertPlayerAlias({ guid: DEC_A, name: 'Alpha', server: 'otro-server:1', when: t2 });
    await upsertPlayerAlias({ guid: DEC_A, name: 'Alpha', server: null, when: t3 }); // server null NO pisa lastServer

    const row = await prisma.playerAlias.findUnique({ where: { guid_name: { guid: DEC_A, name: 'Alpha' } } });
    expect(row?.occurrences).toBe(3);
    expect(row?.firstSeenAt.toISOString()).toBe(t1.toISOString());
    expect(row?.lastSeenAt.toISOString()).toBe(t3.toISOString());
    expect(row?.lastServer).toBe('otro-server:1'); // quedó el último no-null
    expect(await prisma.playerAlias.count({ where: { guid: DEC_A } })).toBe(1); // sin filas duplicadas
  });

  it('ignora nombres sin identidad (vacío, "unknown") y NO crea fila', async () => {
    await prisma.player.create({ data: { guid: DEC_A, name: 'unknown' } });
    expect(await upsertPlayerAlias({ guid: DEC_A, name: '', server: null, when: new Date() })).toBe(false);
    expect(await upsertPlayerAlias({ guid: DEC_A, name: 'unknown', server: null, when: new Date() })).toBe(false);
    expect(await prisma.playerAlias.count()).toBe(0);
  });
});

describe('alias durante la ingesta del games_mp.log', () => {
  it('cada J crea/repite alias del guid; K genera alias de atacante Y víctima real', async () => {
    writeLog([
      '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
      `  0:04 J;${HEX_A};0;Alpha^7`,
      `  0:05 J;${HEX_B};1;Bravo`,
      `  0:10 K;${HEX_A};0;allies;Alpha^7;${HEX_B};1;axis;Bravo;ak47;120;MOD_RIFLE_BULLET;head`,
      `  0:12 J;${HEX_A};0;Alpha^7\n`, // reconexión: mismo (guid, name) → occurrences+1
    ]);
    const result = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(result.ok).toBe(true);
    expect(result.aliasesUpserted).toBe(5); // 3 J + atacante + víctima del K

    const alpha = await prisma.playerAlias.findUnique({ where: { guid_name: { guid: DEC_A, name: 'Alpha^7' } } });
    const bravo = await prisma.playerAlias.findUnique({ where: { guid_name: { guid: DEC_B, name: 'Bravo' } } });
    expect(alpha?.occurrences).toBe(3); // 2 J + 1 K como atacante
    expect(alpha?.lastServer).toBe(SERVER_LABEL);
    expect(bravo?.occurrences).toBe(2); // 1 J + 1 K como víctima
    expect(await prisma.playerAlias.count()).toBe(2);
  });

  it('BOTS excluidos (2026-11-11): J y K de botN NO crean alias del bot; el humano sí', async () => {
    const BOT5 = BigInt('0xb07000000000005').toString(10);
    writeLog([
      '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
      '  0:04 J;bot5;15;Laupetin',
      `  0:10 K;bot5;15;axis;Laupetin;${HEX_A};0;axis;Alpha;ak47;120;MOD_RIFLE_BULLET;head\n`,
    ]);
    const result = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(result.ok).toBe(true);
    // Cero alias del bot (sin Player row, la FK de PlayerAlias lo impediría igual).
    expect(await prisma.playerAlias.findUnique({ where: { guid_name: { guid: BOT5, name: 'Laupetin' } } })).toBeNull();
    expect(await prisma.playerAlias.count({ where: { guid: BOT5 } })).toBe(0);
    // El humano del evento conserva su alias (K como killer, sin J previa).
    expect((await prisma.playerAlias.findUnique({ where: { guid_name: { guid: DEC_A, name: 'Alpha' } } }))?.occurrences).toBe(1);
  });

  it('K con víctima world (sin guid) → SOLO alias del atacante, nunca "world"', async () => {
    writeLog([`  0:39 K;${HEX_A};4;axis;Mandango ProMax;;-1;world;;none;100;MOD_FALLING;none\n`]);
    const result = await ingestGameLog(LOG_PATH, SERVER_LABEL);
    expect(result.ok).toBe(true);
    expect(result.aliasesUpserted).toBe(1); // solo atacante
    const rows = await prisma.playerAlias.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.guid).toBe(DEC_A);
    expect(rows[0]?.name).toBe('Mandango ProMax');
    expect(rows.some((r) => r.name.toLowerCase() === 'world')).toBe(false);
  });

  it('suicidio (origin == target) cuenta UNA sola aparición del alias', async () => {
    writeLog([`  0:16 K;${HEX_C};2;axis;Charlie;${HEX_C};2;axis;Charlie;semtex;300;MOD_GRENADE;none\n`]);
    await ingestGameLog(LOG_PATH, SERVER_LABEL);
    const rows = await prisma.playerAlias.findMany({ where: { guid: DEC_C } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurrences).toBe(1); // no duplicado por aparecer dos veces en la línea
  });
});

describe('perfil GET /api/players/:guid → aliases (campo aditivo)', () => {
  it('expone el historial SIN el nombre actual, orden lastSeenAt desc y cap 10', async () => {
    // Renombre real: Alpha jugó antes como "AlphaOld" y "AlphaOldest"; hoy es "Alpha^7".
    writeLog([
      '  0:00 InitGame: \\g_gametype\\war\\map\\mp_rust\\',
      `  0:04 J;${HEX_A};0;AlphaOldest`,
      `  0:10 Q;${HEX_A};0;AlphaOldest\n`,
    ]);
    await ingestGameLog(LOG_PATH, SERVER_LABEL);
    writeLog([`  0:04 J;${HEX_A};0;AlphaOld\n`]);
    await ingestGameLog(LOG_PATH, SERVER_LABEL); // rotación: nombre histórico 2
    writeLog([`  0:04 J;${HEX_A};0;Alpha^7\n`]);
    await ingestGameLog(LOG_PATH, SERVER_LABEL); // rotación: nombre ACTUAL

    const res = await req().get(`/api/players/${DEC_A}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      player: { name: string };
      aliases: Array<{ name: string; firstSeenAt: string; lastSeenAt: string; occurrences: number }>;
    };
    // Shape ADDITIVO: el resto del perfil sigue igual (player/rank/recentEvents/byServer).
    expect('player' in body && 'rank' in body && 'recentEvents' in body && 'byServer' in body).toBe(true);
    expect(body.player.name).toBe('Alpha^7');
    expect(body.aliases.map((a) => a.name)).toEqual(['AlphaOld', 'AlphaOldest']); // excluye actual, más reciente primero
    for (const alias of body.aliases) {
      expect(typeof alias.occurrences).toBe('number');
      expect(Number.isNaN(Date.parse(alias.firstSeenAt))).toBe(false);
      expect(Number.isNaN(Date.parse(alias.lastSeenAt))).toBe(false);
    }

    // Cap 10: 12 alias históricos → solo 10 en el perfil.
    await resetDb();
    await prisma.player.create({ data: { guid: DEC_B, name: 'Actual' } });
    const base = new Date('2026-01-01T00:00:00Z');
    for (let i = 0; i < 12; i += 1) {
      await prisma.playerAlias.create({
        data: {
          guid: DEC_B,
          name: `hist-${String(i).padStart(2, '0')}`,
          firstSeenAt: base,
          lastSeenAt: new Date(base.getTime() + i * 60_000),
          occurrences: 1,
        },
      });
    }
    const capped = await req().get(`/api/players/${DEC_B}`);
    const cappedBody = capped.body as { aliases: Array<{ name: string }> };
    expect(cappedBody.aliases).toHaveLength(10);
    expect(cappedBody.aliases[0]?.name).toBe('hist-11'); // lastSeenAt desc
  });
});

// ── Detección de conflictos (GET /api/admin/alias-conflicts) ─────────────────

async function promoteToAdmin(email: string): Promise<void> {
  await prisma.user.update({ where: { email }, data: { role: 'ADMIN' } });
}

async function seedPlayersAndAliases(): Promise<void> {
  // G1 y G2 comparten displayName "Snake" (PCs distintas o imitador);
  // G3 es un perfil compartido con 2 nombres históricos; G4 solo 1 (normal).
  await prisma.player.create({ data: { guid: DEC_A, name: 'Snake', connections: 3 } });
  await prisma.player.create({ data: { guid: DEC_B, name: 'Snake^7', connections: 5 } });
  await prisma.player.create({ data: { guid: DEC_C, name: 'Main', connections: 2 } });
  const now = new Date();
  await prisma.playerAlias.create({ data: { guid: DEC_A, name: 'Snake', firstSeenAt: now, lastSeenAt: now, occurrences: 9 } });
  await prisma.playerAlias.create({ data: { guid: DEC_B, name: 'Snake^7', firstSeenAt: now, lastSeenAt: now, occurrences: 4 } });
  await prisma.playerAlias.create({ data: { guid: DEC_C, name: 'Main', firstSeenAt: now, lastSeenAt: now, occurrences: 2 } });
  await prisma.playerAlias.create({ data: { guid: DEC_C, name: 'Old1', firstSeenAt: now, lastSeenAt: now, occurrences: 3 } });
  await prisma.playerAlias.create({ data: { guid: DEC_C, name: 'Old2', firstSeenAt: now, lastSeenAt: now, occurrences: 1 } });
  await prisma.playerAlias.create({ data: { guid: DEC_A, name: 'HistSolo', firstSeenAt: now, lastSeenAt: now, occurrences: 1 } }); // G1: 1 alias histórico (normal)
}

describe('GET /api/admin/alias-conflicts (anti-confusión, read-only)', () => {
  it('exige ADMIN: 401 sin token, 403 con token USER', async () => {
    expect((await req().get('/api/admin/alias-conflicts')).status).toBe(401);
    const user = await registerUser('conf-user@test.local');
    expect((await req().get('/api/admin/alias-conflicts').set('Authorization', `Bearer ${user.token}`)).status).toBe(403);
  });

  it('detecta colisión de nombre (case-insensitive, sin ^X) en 2 guids y ordena graves primero', async () => {
    await seedPlayersAndAliases();
    const admin = await registerUser('conf-admin@test.local');
    await promoteToAdmin('conf-admin@test.local');

    // Sin links: colisión "snake" existe pero es severity 'low'.
    const res = await req().get('/api/admin/alias-conflicts').set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      nameCollisions: Array<{ nameKey: string; displayName: string; distinctAccounts: number; severity: 'high' | 'low'; guids: Array<{ guid: string; name: string; linked: boolean; linkedAccountId: number | null; linkedEmail: string | null; lastSeenAt: string; occurrences: number }> }>;
      sharedGuids: Array<{ guid: string; name: string; aliasCount: number; aliases: Array<{ name: string }> }>;
      generatedAt: string;
    };

    const snake = body.nameCollisions.find((c) => c.nameKey === 'snake');
    expect(snake).toBeDefined();
    expect(snake?.severity).toBe('low');
    expect(snake?.distinctAccounts).toBe(0);
    expect(snake?.guids.map((g) => g.guid).sort()).toEqual([DEC_A, DEC_B].sort());
    // Variantes del mismo nombre por guid, con nombre EXACTO más reciente.
    expect(snake?.guids.find((g) => g.guid === DEC_A)?.name).toBe('Snake');
    expect(snake?.guids.find((g) => g.guid === DEC_B)?.name).toBe('Snake^7');
    expect(snake?.guids.every((g) => g.linked === false && g.linkedAccountId === null && g.linkedEmail === null)).toBe(true);

    // Tipo 2: G3 tiene 2 alias históricos ≠ nombre actual ("Main"); G4/G1 (1 alias) NO aparecen.
    const shared = body.sharedGuids.find((g) => g.guid === DEC_C);
    expect(shared).toBeDefined();
    expect(shared?.name).toBe('Main');
    expect(shared?.aliasCount).toBe(2);
    expect(shared?.aliases.map((a) => a.name).sort()).toEqual(['Old1', 'Old2']);
    expect(body.sharedGuids.some((g) => g.guid === DEC_A)).toBe(false);
  });

  it('guids linked a cuentas DISTINTAS → severity high, listados primero y expone email (admin)', async () => {
    await seedPlayersAndAliases();
    const admin = await registerUser('conf-admin2@test.local');
    await promoteToAdmin('conf-admin2@test.local');
    const userA = await registerUser('link-a@test.local');
    const userB = await registerUser('link-b@test.local');
    await prisma.accountLink.create({ data: { userId: userA.id, guid: DEC_A } });
    await prisma.accountLink.create({ data: { userId: userB.id, guid: DEC_B } });

    const res = await req().get('/api/admin/alias-conflicts').set('Authorization', `Bearer ${admin.token}`);
    const body = res.body as { nameCollisions: Array<{ nameKey: string; severity: string; distinctAccounts: number; guids: Array<{ guid: string; linked: boolean; linkedEmail: string | null }> }> };

    const snake = body.nameCollisions.find((c) => c.nameKey === 'snake');
    expect(snake?.severity).toBe('high'); // 2 cuentas distintas en el mismo displayName
    expect(snake?.distinctAccounts).toBe(2);
    expect(snake?.guids.every((g) => g.linked)).toBe(true);
    expect(snake?.guids.map((g) => g.linkedEmail).sort()).toEqual(['link-a@test.local', 'link-b@test.local'].sort());
    // Es el único conflicto → está primero; con más de uno, high iría antes que low.
    expect(body.nameCollisions[0]?.nameKey).toBe('snake');
  });

  it('la misma cuenta en 2 guids con el mismo nombre NO es high (PC compartida declarada)', async () => {
    await prisma.player.create({ data: { guid: DEC_A, name: 'Duo' } });
    await prisma.player.create({ data: { guid: DEC_B, name: 'Duo' } });
    const now = new Date();
    await prisma.playerAlias.create({ data: { guid: DEC_A, name: 'Duo', firstSeenAt: now, lastSeenAt: now, occurrences: 1 } });
    await prisma.playerAlias.create({ data: { guid: DEC_B, name: 'Duo', firstSeenAt: now, lastSeenAt: now, occurrences: 1 } });
    const user = await registerUser('same-account@test.local');
    await prisma.accountLink.create({ data: { userId: user.id, guid: DEC_A } });
    await prisma.accountLink.create({ data: { userId: user.id, guid: DEC_B } });

    const admin = await registerUser('conf-admin3@test.local');
    await promoteToAdmin('conf-admin3@test.local');
    const res = await req().get('/api/admin/alias-conflicts').set('Authorization', `Bearer ${admin.token}`);
    const body = res.body as { nameCollisions: Array<{ nameKey: string; severity: string; distinctAccounts: number }> };
    const duo = body.nameCollisions.find((c) => c.nameKey === 'duo');
    expect(duo?.severity).toBe('low'); // misma cuenta → no hay 2 personas distintas
    expect(duo?.distinctAccounts).toBe(1);
  });
});

describe('bootstrap rebuildAliases (idempotente)', () => {
  it('pasada A: siembra el nombre actual de cada player con occurrences≈connections; re-ejecutar no infla', async () => {
    await prisma.player.create({ data: { guid: DEC_A, name: 'Bravo', connections: 5, kills: 2, deaths: 1 } });
    await prisma.player.create({ data: { guid: DEC_B, name: 'unknown', connections: 0 } }); // sin identidad → no alias

    const first = await rebuildAliases({ logPath: null });
    expect(first.playersScanned).toBe(2);
    expect(first.aliasesFromPlayers).toBe(1); // 'unknown' se salta
    let row = await prisma.playerAlias.findUnique({ where: { guid_name: { guid: DEC_A, name: 'Bravo' } } });
    expect(row?.occurrences).toBe(5);

    // IDEMPOTENCIA: segunda pasada con los mismos datos → sin cambios.
    const second = await rebuildAliases({ logPath: null });
    expect(second.aliasesFromPlayers).toBe(1);
    row = await prisma.playerAlias.findUnique({ where: { guid_name: { guid: DEC_A, name: 'Bravo' } } });
    expect(row?.occurrences).toBe(5); // no doble conteo
    expect(await prisma.playerAlias.count()).toBe(1);

    // Nunca regresa un valor ya incrementado por la ingesta viva (monótono max).
    await prisma.playerAlias.update({ where: { guid_name: { guid: DEC_A, name: 'Bravo' } }, data: { occurrences: 9 } });
    await rebuildAliases({ logPath: null });
    row = await prisma.playerAlias.findUnique({ where: { guid_name: { guid: DEC_A, name: 'Bravo' } } });
    expect(row?.occurrences).toBe(9);
  });

  it('pasada B (log crudo desde byte 0): descubre nombres históricos y es idempotente', async () => {
    // Historial simulado: G1 jugó como "OldName" (K como víctima) y hoy es "Bravo".
    await prisma.player.create({ data: { guid: DEC_A, name: 'Bravo', connections: 2 } });
    await prisma.player.create({ data: { guid: DEC_B, name: 'Killer', connections: 1 } });
    writeLog([
      `  0:04 J;${HEX_A};0;Bravo`,
      `  0:09 K;${HEX_B};1;axis;Killer;${HEX_A};0;allies;OldName;ak47;40;MOD_RIFLE_BULLET;head`,
      `  0:39 K;${HEX_A};4;axis;Bravo;;-1;world;;none;100;MOD_FALLING;none\n`,
    ]);

    const first = await rebuildAliases({ logPath: LOG_PATH });
    expect(first.logScanned).toBe(true);
    expect(first.logLinesParsed).toBe(3);
    expect(first.aliasesFromLog).toBe(1); // 'OldName' (histórico de G1) es nuevo

    const bravo = await prisma.playerAlias.findUnique({ where: { guid_name: { guid: DEC_A, name: 'Bravo' } } });
    expect(bravo?.occurrences).toBe(2); // max(2 de connections, 2 del log: J + K world) → 2
    const oldName = await prisma.playerAlias.findUnique({ where: { guid_name: { guid: DEC_A, name: 'OldName' } } });
    expect(oldName?.occurrences).toBe(1); // víctima histórica real del K

    // La víctima world no genera alias.
    expect(await prisma.playerAlias.count({ where: { name: 'world' } })).toBe(0);

    // IDEMPOTENCIA: re-ejecutar con el mismo log → cero alias nuevos y valores estables.
    const second = await rebuildAliases({ logPath: LOG_PATH });
    expect(second.aliasesFromLog).toBe(0);
    expect(await prisma.playerAlias.count()).toBe(3); // Bravo, OldName, Killer
    expect((await prisma.playerAlias.findUnique({ where: { guid_name: { guid: DEC_A, name: 'Bravo' } } }))?.occurrences).toBe(2);
    expect((await prisma.playerAlias.findUnique({ where: { guid_name: { guid: DEC_A, name: 'OldName' } } }))?.occurrences).toBe(1);
  });

  it('log inaccesible → no lanza, deja el bootstrap mínimo de la pasada A', async () => {
    await prisma.player.create({ data: { guid: DEC_A, name: 'Solo' } });
    const result = await rebuildAliases({ logPath: resolve(here, 'data', 'no-existe-rebuild.log') });
    expect(result.logScanned).toBe(false);
    expect(result.aliasesFromPlayers).toBe(1);
    expect(await prisma.playerAlias.count()).toBe(1);
  });
});
