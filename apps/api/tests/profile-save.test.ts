import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { registerUser, req, resetDb, type TestUser } from './helpers.js';

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

interface SaveFileBody {
  path: string;
  dataBase64: string;
  sha256: string;
}

function fileEntry(path: string, content: string | Buffer): SaveFileBody {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return { path, dataBase64: buf.toString('base64'), sha256: sha256(buf) };
}

/** Blob binario determinista con todos los valores de byte (roundtrip fiel). */
function binaryBlob(seed: number, size = 1024): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * seed + seed) % 256;
  return buf;
}

const STAT_PATH = 'iw4x.stat';
const CFG_PATH = 'iw4x_config.cfg';
const MOD_PATH = 'mods/mpu_iw4x/iw4x.stat';

let userA: TestUser;
let userB: TestUser;

beforeAll(async () => {
  await resetDb();
  userA = await registerUser('cloudsave-a@test.local', 'supersecret123', 'CloudTester A');
  userB = await registerUser('cloudsave-b@test.local', 'supersecret123', 'CloudTester B');
});

describe('GET /api/profile/save (sin save previo)', () => {
  it('sin auth → 401', async () => {
    const res = await req().get('/api/profile/save');
    expect(res.status).toBe(401);
  });

  it('cuenta que nunca subió → 200 {exists:false} (decisión: NO 404)', async () => {
    const res = await req().get('/api/profile/save').set('Authorization', `Bearer ${userA.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exists: false });
  });
});

describe('PUT + GET roundtrip binario fiel', () => {
  it('PUT guarda y responde manifiesto; GET /save lo expone', async () => {
    const stat = binaryBlob(7, 2048);
    const cfg = Buffer.from('// config del jugador\nseta name "CloudTester A"\n');
    const mod = binaryBlob(9, 512);

    const res = await req()
      .put('/api/profile/save')
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ build: 'iw4x-r4783', files: [fileEntry(STAT_PATH, stat), fileEntry(CFG_PATH, cfg), fileEntry(MOD_PATH, mod)] });

    expect(res.status).toBe(200);
    const body = res.body as { saved: boolean; version: number; updatedAt: string; files: Array<{ path: string; sha256: string; size: number; updatedAt: string }>; pruned: number };
    expect(body.saved).toBe(true);
    expect(body.pruned).toBe(0);
    expect(typeof body.version).toBe('number');
    expect(new Date(body.updatedAt).toISOString()).toBe(body.updatedAt);
    const byPath = new Map(body.files.map((f) => [f.path, f]));
    expect(byPath.get(STAT_PATH)).toMatchObject({ sha256: sha256(stat), size: stat.length });
    expect(byPath.get(MOD_PATH)).toMatchObject({ sha256: sha256(mod), size: mod.length });

    const manifest = await req().get('/api/profile/save').set('Authorization', `Bearer ${userA.token}`);
    expect(manifest.status).toBe(200);
    const m = manifest.body as { exists: boolean; version: number; build?: string; updatedAt: string; files: unknown[] };
    expect(m.exists).toBe(true);
    expect(m.version).toBe(body.version);
    expect(m.build).toBe('iw4x-r4783');
    expect(m.files).toHaveLength(3);
  });

  it('GET /save/file sirve el binario BYTE-EXACTO con X-Save-Sha256 correcto', async () => {
    const stat = binaryBlob(11, 3000);
    await req().put('/api/profile/save').set('Authorization', `Bearer ${userA.token}`).send({ files: [fileEntry(STAT_PATH, stat)] });

    const res = await req()
      .get('/api/profile/save/file')
      .query({ path: STAT_PATH })
      .set('Authorization', `Bearer ${userA.token}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
    expect(res.headers['x-save-sha256']).toBe(sha256(stat));
    // supertest parsea binario como Buffer: comparación byte a byte fiel
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.equals(stat)).toBe(true);
  });

  it('GET /save/file?version=<ts> recupera la versión exacta (rollback)', async () => {
    const v1 = binaryBlob(21, 400);
    const first = await req().put('/api/profile/save').set('Authorization', `Bearer ${userA.token}`).send({ files: [fileEntry(STAT_PATH, v1)] });
    const version1 = (first.body as { version: number }).version;

    const v2 = binaryBlob(22, 400);
    await req().put('/api/profile/save').set('Authorization', `Bearer ${userA.token}`).send({ files: [fileEntry(STAT_PATH, v2)] });

    const latest = await req().get('/api/profile/save/file').query({ path: STAT_PATH }).set('Authorization', `Bearer ${userA.token}`);
    expect(latest.body.equals(v2)).toBe(true);

    const old = await req()
      .get('/api/profile/save/file')
      .query({ path: STAT_PATH, version: String(version1) })
      .set('Authorization', `Bearer ${userA.token}`);
    expect(old.status).toBe(200);
    expect(old.body.equals(v1)).toBe(true);
    expect(old.headers['x-save-sha256']).toBe(sha256(v1));
  });

  it('mods/<mod>/iw4x.stat acepta mod names whitelisted', async () => {
    const res = await req()
      .put('/api/profile/save')
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ files: [fileEntry('mods/My-Mod_2/iw4x.stat', binaryBlob(31, 128))] });
    expect(res.status).toBe(200);
  });
});

describe('guid.dat y mods/<mod>/iw4x_config.cfg (identidad + config por mod)', () => {
  const GUID_PATH = 'guid.dat';
  const MOD_CFG_PATH = 'mods/mpu_iw4x/iw4x_config.cfg';

  it('guid.dat roundtrip byte-exacto con X-Save-Sha256', async () => {
    const user = await registerUser('cloudsave-guid@test.local', 'supersecret123', 'CloudTester Guid');
    const guidBlob = binaryBlob(91, 152); // clave ECC real ~<4KB; dummy aquí

    const put = await req()
      .put('/api/profile/save')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ files: [fileEntry(GUID_PATH, guidBlob)] });
    expect(put.status).toBe(200);
    expect((put.body as { saved: boolean }).saved).toBe(true);

    const res = await req().get('/api/profile/save/file').query({ path: GUID_PATH }).set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(200);
    expect(res.headers['x-save-sha256']).toBe(sha256(guidBlob));
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.equals(guidBlob)).toBe(true);

    const manifest = await req().get('/api/profile/save').set('Authorization', `Bearer ${user.token}`);
    const files = (manifest.body as { files: Array<{ path: string }> }).files;
    expect(files.map((f) => f.path)).toContain(GUID_PATH);
  });

  it('mods/<mod>/iw4x_config.cfg roundtrip byte-exacto', async () => {
    const user = await registerUser('cloudsave-modcfg@test.local', 'supersecret123', 'CloudTester ModCfg');
    const cfgContent = Buffer.from('seta name "clan|player"\nseta clan "CLAN"\n', 'utf8');

    const put = await req()
      .put('/api/profile/save')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ files: [fileEntry(MOD_CFG_PATH, cfgContent)] });
    expect(put.status).toBe(200);

    const res = await req().get('/api/profile/save/file').query({ path: MOD_CFG_PATH }).set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(200);
    expect(res.headers['x-save-sha256']).toBe(sha256(cfgContent));
    expect(res.body.equals(cfgContent)).toBe(true);
  });

  it('dedupe unchanged considera guid.dat y mod config (mismo contenido → saved:false; cambia uno → saved:true)', async () => {
    const user = await registerUser('cloudsave-dedupe@test.local', 'supersecret123', 'CloudTester Dedupe');
    const stat = binaryBlob(101, 100);
    const guid = binaryBlob(102, 120);
    const modCfg = Buffer.from('seta name "x"', 'utf8');

    const put1 = await req()
      .put('/api/profile/save')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ files: [fileEntry(STAT_PATH, stat), fileEntry(GUID_PATH, guid), fileEntry(MOD_CFG_PATH, modCfg)] });
    expect((put1.body as { saved: boolean }).saved).toBe(true);
    const version1 = (put1.body as { version: number }).version;

    // Idéntico → unchanged
    const putSame = await req()
      .put('/api/profile/save')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ files: [fileEntry(STAT_PATH, stat), fileEntry(GUID_PATH, guid), fileEntry(MOD_CFG_PATH, modCfg)] });
    expect(putSame.status).toBe(200);
    expect((putSame.body as { saved: boolean; reason?: string }).saved).toBe(false);
    expect((putSame.body as { reason?: string }).reason).toBe('unchanged');

    // Cambia SOLO guid.dat → versión nueva
    const guid2 = binaryBlob(103, 120);
    const put2 = await req()
      .put('/api/profile/save')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ files: [fileEntry(STAT_PATH, stat), fileEntry(GUID_PATH, guid2), fileEntry(MOD_CFG_PATH, modCfg)] });
    expect((put2.body as { saved: boolean }).saved).toBe(true);
    expect((put2.body as { version: number }).version).toBeGreaterThan(version1);
  });

  it('traversal sigue cerrado para los paths nuevos → 400', async () => {
    for (const badPath of ['guid.dat/../iw4x.stat', '../guid.dat', 'guid\\dat', 'mods/mpu/iw4x_config.cfg/../../guid.dat', 'guid.dat.txt', 'GUID.DAT', 'mods/mpu/iw4x_config.cfg.bak']) {
      const res = await req()
        .put('/api/profile/save')
        .set('Authorization', `Bearer ${userA.token}`)
        .send({ files: [{ path: badPath, dataBase64: Buffer.from('x').toString('base64'), sha256: sha256(Buffer.from('x')) }] });
      expect(res.status).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('PUT validación (sha, paths, caps)', () => {
  it('sha256 declarado ≠ contenido → 400 SHA_MISMATCH', async () => {
    const entry = fileEntry(STAT_PATH, binaryBlob(41, 100));
    entry.sha256 = sha256(Buffer.from('otra-cosa'));
    const res = await req().put('/api/profile/save').set('Authorization', `Bearer ${userA.token}`).send({ files: [entry] });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('SHA_MISMATCH');
    expect((res.body as { error: { message: string } }).error.message).toContain(STAT_PATH);
  });

  it('dataBase64 corrupto (decode ≠ hash declarado) → 400 SHA_MISMATCH', async () => {
    const entry = fileEntry(STAT_PATH, binaryBlob(42, 100));
    entry.dataBase64 = entry.dataBase64.slice(0, -4) + 'AAAA'; // mismo largo, contenido distinto
    const res = await req().put('/api/profile/save').set('Authorization', `Bearer ${userA.token}`).send({ files: [entry] });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('SHA_MISMATCH');
  });

  it('path traversal → 400 VALIDATION_ERROR (whitelist)', async () => {
    for (const badPath of ['../iw4x.stat', '../../etc/passwd', 'C:/iw4x.stat', '/iw4x.stat', 'iw4x.stat/../x', 'mods/../../iw4x.stat', 'mods\\mpu/iw4x.stat', 'players/iw4x.stat']) {
      const res = await req()
        .put('/api/profile/save')
        .set('Authorization', `Bearer ${userA.token}`)
        .send({ files: [{ path: badPath, dataBase64: Buffer.from('x').toString('base64'), sha256: sha256(Buffer.from('x')) }] });
      expect(res.status).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('path no whitelisted en GET /save/file → 400', async () => {
    const res = await req()
      .get('/api/profile/save/file')
      .query({ path: '../otro.stat' })
      .set('Authorization', `Bearer ${userA.token}`);
    expect(res.status).toBe(400);
  });

  it('más de 24 archivos → 400', async () => {
    const files: SaveFileBody[] = [];
    for (let i = 1; i <= 25; i++) files.push(fileEntry(`mods/mod_${i}/iw4x.stat`, binaryBlob(i, 32)));
    const res = await req().put('/api/profile/save').set('Authorization', `Bearer ${userA.token}`).send({ files });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('exactamente 24 archivos → 200 (boundary del cap multi-mod)', async () => {
    const user = await registerUser('cloudsave-caps24@test.local', 'supersecret123', 'CloudTester Caps24');
    const files: SaveFileBody[] = [
      fileEntry('guid.dat', binaryBlob(71, 96)),
      fileEntry(STAT_PATH, binaryBlob(72, 96)),
      fileEntry(CFG_PATH, binaryBlob(73, 96)),
    ];
    for (let i = 1; i <= 21; i++) files.push(fileEntry(`mods/cap_mod_${i}/iw4x.stat`, binaryBlob(80 + i, 32)));
    const res = await req().put('/api/profile/save').set('Authorization', `Bearer ${user.token}`).send({ files });
    expect(res.status).toBe(200);
    expect((res.body as { saved: boolean }).saved).toBe(true);
    expect((res.body as { files: unknown[] }).files).toHaveLength(24);
  });

  it('dataBase64 > 256KB → 400', async () => {
    const big = Buffer.alloc(300 * 1024, 0x41);
    const res = await req().put('/api/profile/save').set('Authorization', `Bearer ${userA.token}`).send({ files: [fileEntry(STAT_PATH, big)] });
    expect(res.status).toBe(400);
  });

  it('ruta duplicada en el mismo snapshot → 400', async () => {
    const e = fileEntry(STAT_PATH, binaryBlob(51, 32));
    const res = await req().put('/api/profile/save').set('Authorization', `Bearer ${userA.token}`).send({ files: [e, { ...e }] });
    expect(res.status).toBe(400);
  });

  it('files vacío → 400', async () => {
    const res = await req().put('/api/profile/save').set('Authorization', `Bearer ${userA.token}`).send({ files: [] });
    expect(res.status).toBe(400);
  });
});

describe('Dedupe unchanged', () => {
  it('PUT idéntico al latest → {saved:false, reason:"unchanged"} sin nueva versión', async () => {
    const content = binaryBlob(61, 250);
    const first = await req().put('/api/profile/save').set('Authorization', `Bearer ${userA.token}`).send({ files: [fileEntry(STAT_PATH, content)] });
    expect(first.body.saved).toBe(true);
    const version1 = (first.body as { version: number }).version;

    const second = await req().put('/api/profile/save').set('Authorization', `Bearer ${userA.token}`).send({ files: [fileEntry(STAT_PATH, content)] });
    expect(second.status).toBe(200);
    const body = second.body as { saved: boolean; reason?: string; version: number };
    expect(body.saved).toBe(false);
    expect(body.reason).toBe('unchanged');
    expect(body.version).toBe(version1);

    const versions = await req().get('/api/profile/save/versions').set('Authorization', `Bearer ${userA.token}`);
    const list = (versions.body as { versions: Array<{ version: number }> }).versions;
    expect(list.filter((v) => v.version === version1)).toHaveLength(1);
  });
});

describe('Versiones + poda a 10', () => {
  it('12 PUTs distintos → solo quedan las 10 más nuevas (dirs + endpoint)', async () => {
    // Usuario dedicado para que la poda no dependa de otros tests
    const user = await registerUser('cloudsave-prune@test.local', 'supersecret123', 'CloudTester Prune');
    let lastPruned = -1;
    const versionsSeen: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await req()
        .put('/api/profile/save')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ files: [fileEntry(STAT_PATH, Buffer.from(`prune-run-${i}-${Date.now()}`))] });
      expect(res.body.saved).toBe(true);
      lastPruned = (res.body as { pruned: number }).pruned;
      versionsSeen.push((res.body as { version: number }).version);
    }
    // uploads 11 y 12 podan 1 cada uno (11 y 12 dirs → cap 10)
    expect(lastPruned).toBe(1);

    const userDir = resolve(env.profileStorageDir, String(user.id));
    expect(existsSync(userDir)).toBe(true);
    const dirs = readdirSync(userDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    expect(dirs).toHaveLength(10);

    const res = await req().get('/api/profile/save/versions').set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(200);
    const versions = (res.body as { versions: Array<{ version: number; updatedAt: string; files: unknown[] }> }).versions;
    expect(versions).toHaveLength(10);
    // nueva primero y SIN las dos más viejas
    const newest = versionsSeen[versionsSeen.length - 1] ?? 0;
    const oldest = versionsSeen[0] ?? 0;
    expect(versions[0]?.version).toBe(newest);
    expect(versions.find((v) => v.version === oldest)).toBeUndefined();
    for (const v of versions) {
      expect(typeof v.updatedAt).toBe('string');
      expect(v.files.length).toBeGreaterThan(0);
    }
  });

  it('GET /save/file con versión podada o inexistente → 404 SAVE_VERSION_NOT_FOUND', async () => {
    const user = await registerUser('cloudsave-podado@test.local', 'supersecret123', 'CloudTester Podado');
    const first = await req().put('/api/profile/save').set('Authorization', `Bearer ${user.token}`).send({ files: [fileEntry(STAT_PATH, Buffer.from('vieja'))] });
    const oldVersion = (first.body as { version: number }).version;
    for (let i = 0; i < 10; i++) {
      await req().put('/api/profile/save').set('Authorization', `Bearer ${user.token}`).send({ files: [fileEntry(STAT_PATH, Buffer.from(`nueva-${i}`))] });
    }
    const gone = await req()
      .get('/api/profile/save/file')
      .query({ path: STAT_PATH, version: String(oldVersion) })
      .set('Authorization', `Bearer ${user.token}`);
    expect(gone.status).toBe(404);
    expect((gone.body as { error: { code: string } }).error.code).toBe('SAVE_VERSION_NOT_FOUND');

    const missing = await req()
      .get('/api/profile/save/file')
      .query({ path: STAT_PATH, version: '9999999999999' })
      .set('Authorization', `Bearer ${user.token}`);
    expect(missing.status).toBe(404);
    expect((missing.body as { error: { code: string } }).error.code).toBe('SAVE_VERSION_NOT_FOUND');
  });
});

describe('Aislamiento entre cuentas', () => {
  it('user B NO ve el save de A: exists:false + file 404 SAVE_NOT_FOUND', async () => {
    const manifestB = await req().get('/api/profile/save').set('Authorization', `Bearer ${userB.token}`);
    expect(manifestB.status).toBe(200);
    expect(manifestB.body).toEqual({ exists: false });

    const fileB = await req().get('/api/profile/save/file').query({ path: STAT_PATH }).set('Authorization', `Bearer ${userB.token}`);
    expect(fileB.status).toBe(404);
    expect((fileB.body as { error: { code: string } }).error.code).toBe('SAVE_NOT_FOUND');

    const versionsB = await req().get('/api/profile/save/versions').set('Authorization', `Bearer ${userB.token}`);
    expect(versionsB.status).toBe(200);
    expect(versionsB.body).toEqual({ versions: [] });
  });
});
