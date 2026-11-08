/**
 * Tests del parser del blob `iw4x.stat` (unit + integración upload→parse→perfil).
 *
 * Los blobs sintéticos se CONSTRUYEN con tests/fixtures/build-stat-blob.ts
 * (usa la MISMA fórmula índice→offset que el parser → los roundtrips validan
 * la fórmula de punta a punta). Layout verificado: iw4x-client r5318.
 */
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import {
  CAREER_INDEXES,
  CLASS_BLOCK_OFFSET,
  CLASSES_PER_PROFILE,
  LEVEL_XP_TABLE,
  levelFromXp,
  levelProgressFromXp,
  parseStatBlob,
  readStatInt32,
  statIndexOffset,
} from '../src/lib/save-parser/parse-stat-blob.js';
import { buildStatBlob, writeStatIndex } from './fixtures/build-stat-blob.js';
import { registerUser, req, resetDb, type TestUser } from './helpers.js';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function putSaveFile(user: TestUser, content: Buffer, path = 'iw4x.stat'): Promise<{ status: number; saved: boolean }> {
  const res = await req()
    .put('/api/profile/save')
    .set('Authorization', `Bearer ${user.token}`)
    .send({ files: [{ path, dataBase64: content.toString('base64'), sha256: sha256(content) }] });
  return { status: res.status, saved: (res.body as { saved?: boolean }).saved ?? false };
}

describe('fórmula índice→offset (confianza ALTA)', () => {
  it('región de bytes [0..1999] → offset 4+i', () => {
    expect(statIndexOffset(0)).toBe(4);
    expect(statIndexOffset(1)).toBe(5);
    expect(statIndexOffset(1999)).toBe(2003);
  });

  it('región de int32LE [2000..3497] → offset 2004+4*(i-2000)', () => {
    expect(statIndexOffset(2000)).toBe(2004);
    expect(statIndexOffset(2300)).toBe(3204); // "experience"
    expect(statIndexOffset(2325)).toBe(3304); // prestigio
    expect(statIndexOffset(3497)).toBe(7992);
    // Los int32 de 4 bytes siempre caen dentro del archivo de 8192.
    expect((statIndexOffset(3497) as number) + 4).toBeLessThanOrEqual(8192);
  });

  it('fuera del mapa → null (nunca inventar offsets)', () => {
    expect(statIndexOffset(-1)).toBeNull();
    expect(statIndexOffset(3500)).toBeNull();
    expect(statIndexOffset(1.5)).toBeNull();
  });

  it('roundtrip byte↔parser: escribo con la fórmula, leo con el parser', () => {
    const buf = Buffer.alloc(8192);
    writeStatIndex(buf, 2300, 1234567);
    writeStatIndex(buf, 3497, -1); // negativo también roundtripea (el sanity del parser lo filtra)
    expect(readStatInt32(buf, 2300)).toBe(1234567);
    expect(readStatInt32(buf, 3497)).toBe(-1);
  });

  it('readStatInt32 solo lee la región int32 (byte-region y fuera de mapa → null)', () => {
    const buf = Buffer.alloc(8192);
    expect(readStatInt32(buf, 1999)).toBeNull();
    expect(readStatInt32(buf, 3500)).toBeNull();
  });
});

describe('nivel desde xp (tabla MW2 L1..L70)', () => {
  it('casos de la spec: 0→L1, 500→L2, 2516000→L70, fuera de rango→null', () => {
    expect(levelFromXp(0)).toBe(1);
    expect(levelFromXp(500)).toBe(2);
    expect(levelFromXp(2_516_000)).toBe(70);
    expect(levelFromXp(2_516_001)).toBeNull();
    expect(levelFromXp(-1)).toBeNull();
    expect(levelFromXp(1.5)).toBeNull();
  });

  it('umbrales intermedios exactos y frontera -1', () => {
    expect(levelFromXp(499)).toBe(1);
    expect(levelFromXp(1699)).toBe(2);
    expect(levelFromXp(1700)).toBe(3);
    // L70 se alcanza al entrar en el último tramo (2434700) y sigue en 70 hasta el cap.
    expect(levelFromXp(2_434_700)).toBe(70);
    expect(levelFromXp(2_515_999)).toBe(70);
  });

  it('la tabla cubre exactamente 70 umbrales crecientes', () => {
    expect(LEVEL_XP_TABLE).toHaveLength(70);
    for (let i = 1; i < LEVEL_XP_TABLE.length; i += 1) {
      expect(LEVEL_XP_TABLE[i]).toBeGreaterThan(LEVEL_XP_TABLE[i - 1]);
    }
  });

  it('levelProgress: tramo current/next/pct; L70 (max) → null', () => {
    // xp=1000 → L2 (500≤1000<1700): tramo 500→1700 → current 500 de 1200 → 42%.
    expect(levelProgressFromXp(1000, levelFromXp(1000) as number)).toEqual({ current: 500, next: 1200, pct: 42 });
    // Exactamente en el umbral de entrada al nivel → 0%.
    expect(levelProgressFromXp(1700, 3)).toEqual({ current: 0, next: 1900, pct: 0 });
    // Nivel máximo sin "next" → null.
    expect(levelProgressFromXp(2_516_000, 70)).toBeNull();
    expect(levelProgressFromXp(0, 0)).toBeNull();
  });
});

describe('parseStatBlob roundtrip con fixture sintético', () => {
  it('blob v155 completo: version/layout/xp/level/prestige/career', () => {
    const blob = buildStatBlob({
      version: 155,
      xp: 40_000,
      prestige: 3,
      career: { kills: 1234, deaths: 567, wins: 89, losses: 12, ties: 3, assists: 456, headshots: 78, timePlayedTotal: 9999 },
    });
    const parsed = parseStatBlob(blob);
    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBe(155);
    expect(parsed?.layout).toBe('v155-iw4x');
    expect(parsed?.xp).toBe(40_000);
    expect(parsed?.level).toBe(11); // 36500 ≤ 40000 < 44300
    expect(parsed?.levelProgress).toEqual({ current: 3500, next: 7800, pct: 45 }); // 40000-36500 de 44300-36500
    expect(parsed?.prestige).toBe(3);
    expect(parsed?.career).toEqual({
      kills: 1234,
      deaths: 567,
      wins: 89,
      losses: 12,
      ties: 3,
      assists: 456,
      headshots: 78,
      timePlayedTotal: 9999,
    });
  });

  it('los índices career del parser coinciden uno a uno con lo escrito por el builder', () => {
    const written = { kills: 111, deaths: 222, wins: 333, losses: 444, ties: 555, assists: 666, headshots: 777, timePlayedTotal: 888 };
    const blob = buildStatBlob({ career: written });
    for (const [key, index] of Object.entries(CAREER_INDEXES) as Array<[keyof typeof CAREER_INDEXES, number]>) {
      expect(readStatInt32(blob, index)).toBe(written[key]);
    }
  });

  it('clases: name null-padded decodificado, slots vacíos libres, 15 slots siempre', () => {
    const blob = buildStatBlob({ classes: ['Rusher', 'Sniper  ACOG', null, null] });
    const parsed = parseStatBlob(blob);
    expect(parsed?.classes).toHaveLength(CLASSES_PER_PROFILE);
    expect(parsed?.classes[0]).toEqual({ slot: 0, name: 'Rusher', inUse: true });
    expect(parsed?.classes[1]).toEqual({ slot: 1, name: 'Sniper  ACOG', inUse: true });
    for (let slot = 2; slot < CLASSES_PER_PROFILE; slot += 1) {
      expect(parsed?.classes[slot]).toEqual({ slot, name: null, inUse: false });
    }
  });

  it('clase con basura no imprimible → name null, inUse false, rawHex presente (defensivo)', () => {
    // 0x01 NO es imprimible y está antes del primer null → el nombre no decodifica
    // limpio; como el slot tiene bytes no-cero, se expone rawHex para diagnóstico.
    const garbage = Buffer.concat([Buffer.from([0x01, 0x41, 0x42, 0x00]), Buffer.alloc(60)]);
    const blob = buildStatBlob({ classes: [{ raw: garbage }] });
    const parsed = parseStatBlob(blob);
    expect(parsed?.classes[0]?.name).toBeNull();
    expect(parsed?.classes[0]?.inUse).toBe(false);
    expect(parsed?.classes[0]?.rawHex).toBe(garbage.toString('hex'));
    // Slot 1 en ceros puros → sin rawHex (slot libre real).
    expect(parsed?.classes[1]).toEqual({ slot: 1, name: null, inUse: false });
  });

  it('v159: bloque de clases en 3963 (bifurca por versión; v155 usa 3643)', () => {
    expect(CLASS_BLOCK_OFFSET[155]).toBe(3643);
    expect(CLASS_BLOCK_OFFSET[159]).toBe(3963);
    const blob159 = buildStatBlob({ version: 159, classes: ['ModClass'] });
    const parsed = parseStatBlob(blob159);
    expect(parsed?.version).toBe(159);
    expect(parsed?.layout).toBe('v159');
    expect(parsed?.classes[0]).toEqual({ slot: 0, name: 'ModClass', inUse: true });
    // El nombre se escribió en el offset de v159 y NO en el de v155.
    expect(blob159.readUInt8(CLASS_BLOCK_OFFSET[159])).toBe('M'.charCodeAt(0));
    expect(blob159.readUInt8(CLASS_BLOCK_OFFSET[155])).toBe(0);
  });

  it('blobs inválidos → null: tamaño ≠ 8192, versión 200 (futuro), versión 154 (desconocida)', () => {
    expect(parseStatBlob(buildStatBlob({ size: 8191 }))).toBeNull();
    expect(parseStatBlob(buildStatBlob({ size: 8193 }))).toBeNull();
    expect(parseStatBlob(Buffer.alloc(0))).toBeNull();
    expect(parseStatBlob(buildStatBlob({ version: 200 }))).toBeNull();
    expect(parseStatBlob(buildStatBlob({ version: 154 }))).toBeNull();
  });
});

describe('sanity checks MEDIA: campo inválido → null individual', () => {
  it('xp fuera de 0..2516000 → xp/level/levelProgress null, resto intacto', () => {
    const over = parseStatBlob(buildStatBlob({ xp: 2_516_001, prestige: 1 }));
    expect(over?.xp).toBeNull();
    expect(over?.level).toBeNull();
    expect(over?.levelProgress).toBeNull();
    expect(over?.prestige).toBe(1);
    expect(over?.career.kills).toBe(0); // blob en ceros → 0 pasa sanity (entero ≥ 0)
  });

  it('prestigio fuera de 0..10 → null', () => {
    expect(parseStatBlob(buildStatBlob({ prestige: 11 }))?.prestige).toBeNull();
    expect(parseStatBlob(buildStatBlob({ prestige: -1 }))?.prestige).toBeNull();
    expect(parseStatBlob(buildStatBlob({ prestige: 10 }))?.prestige).toBe(10);
  });

  it('career fuera de 0..10M → null SOLO ese campo', () => {
    const blob = buildStatBlob({ career: { kills: -5, deaths: 10_000_001, wins: 7 } });
    const parsed = parseStatBlob(blob);
    expect(parsed?.career.kills).toBeNull();
    expect(parsed?.career.deaths).toBeNull();
    expect(parsed?.career.wins).toBe(7);
    expect(parsed?.career.losses).toBe(0);
  });
});

describe('integración: upload → parse → perfil/leaderboard', () => {
  const GUID = '1111111111111111111';
  const GUID_NO_SAVE = '2222222222222222222';
  let user: TestUser;

  beforeAll(async () => {
    await resetDb();
    user = await registerUser('statparse@test.local', 'supersecret123', 'StatTester');
    await prisma.player.create({ data: { guid: GUID, name: 'StatTester IG' } });
    await prisma.player.create({ data: { guid: GUID_NO_SAVE, name: 'NoSave IG' } });
    const link = await req().post('/api/link/complete').set('Authorization', `Bearer ${user.token}`).send({ guid: GUID });
    expect(link.status).toBe(200);
  });

  it('PUT de un iw4x.stat válido parsea y el perfil expone save{level,prestige,xp,parsedAt}', async () => {
    const blob = buildStatBlob({ xp: 40_000, prestige: 3, career: { kills: 500, headshots: 60 } });
    const put = await putSaveFile(user, blob);
    expect(put.status).toBe(200);
    expect(put.saved).toBe(true);

    const profile = await req().get(`/api/players/${GUID}`);
    expect(profile.status).toBe(200);
    const save = (profile.body as { player: { save: { level: number | null; prestige: number | null; xp: number | null; parsedAt: string } | null } }).player.save;
    expect(save).not.toBeNull();
    expect(save?.level).toBe(11);
    expect(save?.prestige).toBe(3);
    expect(save?.xp).toBe(40_000);
    expect(new Date(save?.parsedAt ?? '').toISOString()).toBe(save?.parsedAt);
  });

  it('PUT de un blob NO parseable (tamaño ≠ 8192) → save null en el perfil (latest wins)', async () => {
    const junk = Buffer.alloc(100, 0x41);
    const put = await putSaveFile(user, junk);
    expect(put.status).toBe(200);
    expect(put.saved).toBe(true); // el upload NUNCA falla por el parse

    const profile = await req().get(`/api/players/${GUID}`);
    expect((profile.body as { player: { save: unknown } }).player.save).toBeNull();
  });

  it('snapshot SIN iw4x.stat raíz no toca el save (no-op)', async () => {
    const cfg = Buffer.from('seta name "x"\n');
    const put = await putSaveFile(user, cfg, 'iw4x_config.cfg');
    expect(put.status).toBe(200);
    const profile = await req().get(`/api/players/${GUID}`);
    expect((profile.body as { player: { save: unknown } }).player.save).toBeNull();
  });

  it('leaderboard expone level por entrada y sort=level ordena (nulls al final en desc)', async () => {
    // Restaurar un save válido (el último PUT fue cfg-only → save sigue null).
    const blob = buildStatBlob({ xp: 502_700, prestige: 1 }); // L35
    await putSaveFile(user, blob);

    const res = await req().get('/api/leaderboard').query({ sort: 'level', order: 'desc' });
    expect(res.status).toBe(200);
    const body = res.body as { sort: string; players: Array<{ guid: string; level: number | null }> };
    expect(body.sort).toBe('level');
    const withLevel = body.players.filter((p) => p.level !== null);
    expect(withLevel).toHaveLength(1);
    expect(withLevel[0]?.guid).toBe(GUID);
    expect(withLevel[0]?.level).toBe(35);
    // desc → el que tiene level va antes que los null (SQLite ordena nulls último en desc).
    expect(body.players.findIndex((p) => p.guid === GUID)).toBeLessThan(body.players.findIndex((p) => p.guid === GUID_NO_SAVE));

    // asc → nulls primero (SQLite), el level queda al final.
    const asc = await req().get('/api/leaderboard').query({ sort: 'level', order: 'asc' });
    const playersAsc = (asc.body as { players: Array<{ guid: string; level: number | null }> }).players;
    expect(playersAsc[playersAsc.length - 1]?.guid).toBe(GUID);
  });

  it('cuenta sin GUIDs vinculados: PUT válido → 200 y sin efectos (upload nunca falla)', async () => {
    const loner = await registerUser('statparse-loner@test.local', 'supersecret123', 'StatLoner');
    const blob = buildStatBlob({ xp: 1000, prestige: 0 });
    const put = await putSaveFile(loner, blob);
    expect(put.status).toBe(200);
    expect(put.saved).toBe(true);
  });
});
