/**
 * Tests de los endpoints de IDENTIDAD por guid.dat (contrato del launcher) y
 * del tightening anti herencia cruzada del auto-link por sesión:
 *
 *  POST /api/identity/guid-from-file  🔒JWT → deriva el GUID de un guid.dat y
 *    dice si es de la cuenta del token (ownedByMe) o de quién es (ownerNick).
 *  POST /api/identity/claim-fresh     🔒JWT → cuarentena: la cuenta espera una
 *    identidad NUEVA (one-shot para el auto-link; limpia el session.guid).
 *
 * Ramas nuevas del auto-link (tryAutoLinkBySession):
 *  - cuenta CON guids + guid nuevo distinto + sin claim-fresh → NO linkea.
 *  - cuenta CON guids + claim-fresh + guid nuevo + sesión activa → SÍ linkea
 *    (one-shot: la marca se consume).
 *  - cuenta CON guids + claim-fresh + sesión expirada → NO linkea.
 *  - claim-fresh limpia el PlaySession.guid colgante (guid de otra cuenta).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { registerUser, req, resetDb } from './helpers.js';
import { deriveGuidFromGuidDat } from '../src/lib/identity/derive-guid.js';
import { tryAutoLinkBySession } from '../src/services/play-session.service.js';
import { makeGuidDatFixture } from './fixtures/build-guid-dat.js';

/** Dos guid.dat sintéticos con guids derivados DISTINTOS y estables. */
const DAT1 = makeGuidDatFixture(1);
const DAT2 = makeGuidDatFixture(2);

beforeAll(async () => {
  await resetDb();
});

beforeEach(async () => {
  await resetDb();
});

// ── POST /api/identity/guid-from-file ───────────────────────────────────────

describe('POST /api/identity/guid-from-file', () => {
  it('sin JWT → 401', async () => {
    const res = await req().post('/api/identity/guid-from-file').send({ dataBase64: DAT1.data.toString('base64') });
    expect(res.status).toBe(401);
  });

  it('dataBase64 inválido (no base64) → 400 VALIDATION_ERROR', async () => {
    const user = await registerUser('guidfile-b64@test.local');
    const res = await req().post('/api/identity/guid-from-file').set('Authorization', `Bearer ${user.token}`).send({ dataBase64: 'no!!es-base64##' });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('payload decodificado fuera del sanity 64B..4KB → 400', async () => {
    const user = await registerUser('guidfile-size@test.local');
    const tooSmall = Buffer.alloc(8, 7).toString('base64');
    const tooBig = Buffer.alloc(4097, 7).toString('base64');
    const resSmall = await req().post('/api/identity/guid-from-file').set('Authorization', `Bearer ${user.token}`).send({ dataBase64: tooSmall });
    const resBig = await req().post('/api/identity/guid-from-file').set('Authorization', `Bearer ${user.token}`).send({ dataBase64: tooBig });
    expect(resSmall.status).toBe(400);
    expect(resBig.status).toBe(400);
  });

  it('guid.dat NO derivable (basura en rango de tamaño) → 200 con guid:null y ownedByMe:false', async () => {
    const user = await registerUser('guidfile-null@test.local');
    const junk = Buffer.alloc(128, 0x5a); // en rango de tamaño, no es un guid.dat
    const res = await req().post('/api/identity/guid-from-file').set('Authorization', `Bearer ${user.token}`).send({ dataBase64: junk.toString('base64') });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ guid: null, guidDecimal: null, ownedByMe: false, ownerNick: null });
  });

  it('guid.dat sintético válido → guid hex + decimal, ownedByMe:false, ownerNick:null (guid libre)', async () => {
    const user = await registerUser('guidfile-free@test.local');
    const res = await req().post('/api/identity/guid-from-file').set('Authorization', `Bearer ${user.token}`).send({ dataBase64: DAT1.data.toString('base64') });
    expect(res.status).toBe(200);
    const body = res.body as { guid: string | null; guidDecimal: string | null; ownedByMe: boolean; ownerNick: string | null };
    // El guid derivado por el ENDPOINT coincide con el derivado por la LIB en el test:
    expect(body.guid).toBe(deriveGuidFromGuidDat(DAT1.data));
    expect(body.guid).toBe(DAT1.guidHex);
    expect(body.guidDecimal).toBe(DAT1.guidDecimal);
    expect(body.ownedByMe).toBe(false);
    expect(body.ownerNick).toBeNull();
  });

  it('el guid derivado está vinculado a OTRA cuenta → ownedByMe:false + ownerNick = displayName del dueño real', async () => {
    const user = await registerUser('guidfile-thief@test.local');
    const owner = await registerUser('guidfile-owner@test.local', 'supersecret123', 'Dueño Real');
    await prisma.player.create({ data: { guid: DAT1.guidDecimal, name: 'Dueño Real' } });
    await prisma.accountLink.create({ data: { userId: owner.id, guid: DAT1.guidDecimal } });

    const res = await req().post('/api/identity/guid-from-file').set('Authorization', `Bearer ${user.token}`).send({ dataBase64: DAT1.data.toString('base64') });
    expect(res.status).toBe(200);
    const body = res.body as { ownedByMe: boolean; ownerNick: string | null };
    expect(body.ownedByMe).toBe(false);
    expect(body.ownerNick).toBe('Dueño Real');
  });

  it('el guid derivado es MÍO → ownedByMe:true, ownerNick:null', async () => {
    const user = await registerUser('guidfile-mine@test.local');
    await prisma.player.create({ data: { guid: DAT1.guidDecimal, name: 'yo' } });
    await prisma.accountLink.create({ data: { userId: user.id, guid: DAT1.guidDecimal } });

    const res = await req().post('/api/identity/guid-from-file').set('Authorization', `Bearer ${user.token}`).send({ dataBase64: DAT1.data.toString('base64') });
    expect(res.status).toBe(200);
    const body = res.body as { ownedByMe: boolean; ownerNick: string | null };
    expect(body.ownedByMe).toBe(true);
    expect(body.ownerNick).toBeNull();
  });
});

// ── POST /api/identity/claim-fresh ──────────────────────────────────────────

describe('POST /api/identity/claim-fresh', () => {
  it('sin JWT → 401', async () => {
    const res = await req().post('/api/identity/claim-fresh');
    expect(res.status).toBe(401);
  });

  it('marca claimFreshAt + limpia el session.guid colgante (guid vinculado a OTRA cuenta)', async () => {
    const user = await registerUser('claimfresh@test.local');
    const other = await registerUser('claimfresh-other@test.local', 'supersecret123', 'Otro Dueño');
    await prisma.player.create({ data: { guid: DAT2.guidDecimal, name: 'Otro Dueño' } });
    await prisma.accountLink.create({ data: { userId: other.id, guid: DAT2.guidDecimal } });
    await prisma.playSession.create({
      data: { userId: user.id, nick: 'claimfresh', guid: DAT2.guidDecimal, lastSeen: new Date(), expiresAt: new Date(Date.now() + 5 * 60_000) },
    });

    const res = await req().post('/api/identity/claim-fresh').set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; claimFreshAt: string; clearedSessionGuid: string | null; linkedGuids: string[] };
    expect(body.ok).toBe(true);
    expect(body.clearedSessionGuid).toBe(DAT2.guidDecimal);
    expect(typeof body.claimFreshAt).toBe('string');

    const me = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(me.claimFreshAt).not.toBeNull();
    const session = await prisma.playSession.findUniqueOrThrow({ where: { userId: user.id } });
    expect(session.guid).toBeNull(); // deja de matchear por el guid viejo/ajeno
  });

  it('NO borra AccountLinks (la decisión es del usuario/admin): linkedGuids intactos', async () => {
    const user = await registerUser('claimfresh-links@test.local');
    await prisma.player.create({ data: { guid: DAT1.guidDecimal, name: 'x' } });
    await prisma.accountLink.create({ data: { userId: user.id, guid: DAT1.guidDecimal } });

    const res = await req().post('/api/identity/claim-fresh').set('Authorization', `Bearer ${user.token}`);
    const body = res.body as { linkedGuids: string[] };
    expect(body.linkedGuids).toEqual([DAT1.guidDecimal]);
    expect(await prisma.accountLink.count()).toBe(1);
  });
});

// ── Ramas nuevas del auto-link (tightening + claim-fresh one-shot) ──────────

describe('tryAutoLinkBySession: tightening anti herencia cruzada', () => {
  async function activeSession(userId: number, nick: string, guid: string | null = null): Promise<void> {
    await prisma.playSession.create({
      data: { userId, nick, guid, lastSeen: new Date(), expiresAt: new Date(Date.now() + 5 * 60_000) },
    });
  }

  it('cuenta CON guids + guid NUEVO distinto + sin claim-fresh → NO linkea (1 guid principal por cuenta)', async () => {
    const owner = await registerUser('tighten-owner@test.local', 'supersecret123', 'Tighten Owner');
    await prisma.player.create({ data: { guid: DAT2.guidDecimal, name: 'Tighten Owner' } });
    await prisma.accountLink.create({ data: { userId: owner.id, guid: DAT2.guidDecimal } });
    await activeSession(owner.id, 'Tighten Owner', DAT2.guidDecimal);

    const result = await tryAutoLinkBySession({ guid: DAT1.guidDecimal, name: 'Tighten Owner', when: new Date() });
    expect(result).toEqual({ outcome: 'skipped', reason: 'cuenta-con-guids' });
    expect(await prisma.accountLink.findUnique({ where: { guid: DAT1.guidDecimal } })).toBeNull();
    // su session.guid propio NO se toca
    const session = await prisma.playSession.findUniqueOrThrow({ where: { userId: owner.id } });
    expect(session.guid).toBe(DAT2.guidDecimal);
  });

  it('cuenta CON guids + claim-fresh + guid NUEVO + sesión activa → SÍ linkea, sella session y CONSUME la marca (one-shot)', async () => {
    const owner = await registerUser('fresh-accept@test.local', 'supersecret123', 'Fresh Accept');
    await prisma.player.create({ data: { guid: DAT2.guidDecimal, name: 'Fresh Accept' } });
    await prisma.accountLink.create({ data: { userId: owner.id, guid: DAT2.guidDecimal } });
    await activeSession(owner.id, 'Fresh Accept', DAT2.guidDecimal); // guid viejo sellado
    await prisma.user.update({ where: { id: owner.id }, data: { claimFreshAt: new Date() } });

    const result = await tryAutoLinkBySession({ guid: DAT1.guidDecimal, name: 'Fresh Accept', when: new Date() });
    expect(result).toEqual({ outcome: 'linked' });

    const link = await prisma.accountLink.findUniqueOrThrow({ where: { guid: DAT1.guidDecimal } });
    expect(link.userId).toBe(owner.id); // el guid nuevo NACIÓ vinculado a su dueño
    const me = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(me.claimFreshAt).toBeNull(); // one-shot
    const session = await prisma.playSession.findUniqueOrThrow({ where: { userId: owner.id } });
    expect(session.guid).toBe(DAT1.guidDecimal); // sellado al guid nuevo
  });

  it('claim-fresh consumido: un segundo guid nuevo vuelve a ser rechazado (cuenta-con-guids)', async () => {
    const owner = await registerUser('fresh-oneshot@test.local', 'supersecret123', 'Fresh One Shot');
    await prisma.player.create({ data: { guid: DAT2.guidDecimal, name: 'Fresh One Shot' } });
    await prisma.accountLink.create({ data: { userId: owner.id, guid: DAT2.guidDecimal } });
    await activeSession(owner.id, 'Fresh One Shot');
    await prisma.user.update({ where: { id: owner.id }, data: { claimFreshAt: new Date() } });

    await tryAutoLinkBySession({ guid: DAT1.guidDecimal, name: 'Fresh One Shot', when: new Date() });
    const DAT3 = makeGuidDatFixture(3);
    const second = await tryAutoLinkBySession({ guid: DAT3.guidDecimal, name: 'Fresh One Shot', when: new Date() });
    expect(second).toEqual({ outcome: 'skipped', reason: 'cuenta-con-guids' });
    expect(await prisma.accountLink.findUnique({ where: { guid: DAT3.guidDecimal } })).toBeNull();
  });

  it('claim-fresh + sesión EXPIRADA → NO linkea y la marca se conserva', async () => {
    const owner = await registerUser('fresh-expired@test.local', 'supersecret123', 'Fresh Expired');
    await prisma.player.create({ data: { guid: DAT2.guidDecimal, name: 'Fresh Expired' } });
    await prisma.accountLink.create({ data: { userId: owner.id, guid: DAT2.guidDecimal } });
    await prisma.playSession.create({
      data: { userId: owner.id, nick: 'Fresh Expired', guid: null, lastSeen: new Date(Date.now() - 30 * 60_000), expiresAt: new Date(Date.now() - 20 * 60_000) },
    });
    await prisma.user.update({ where: { id: owner.id }, data: { claimFreshAt: new Date() } });

    const result = await tryAutoLinkBySession({ guid: DAT1.guidDecimal, name: 'Fresh Expired', when: new Date() });
    expect(result).toEqual({ outcome: 'skipped', reason: 'sin-sesion-activa' });
    expect(await prisma.accountLink.findUnique({ where: { guid: DAT1.guidDecimal } })).toBeNull();
    const me = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(me.claimFreshAt).not.toBeNull();
  });

  it('cuenta SIN guids + sesión activa (regresión) → sigue linkeando normal', async () => {
    const owner = await registerUser('fresh-regression@test.local', 'supersecret123', 'Fresh Regression');
    await activeSession(owner.id, 'Fresh Regression');

    const result = await tryAutoLinkBySession({ guid: DAT1.guidDecimal, name: 'Fresh Regression', when: new Date() });
    expect(result).toEqual({ outcome: 'linked' });
    const link = await prisma.accountLink.findUniqueOrThrow({ where: { guid: DAT1.guidDecimal } });
    expect(link.userId).toBe(owner.id);
  });

  it('claim-fresh + guid que ya está vinculado a OTRA cuenta → skip (nunca re-asignamos)', async () => {
    const owner = await registerUser('fresh-steal@test.local', 'supersecret123', 'Fresh Steal');
    const other = await registerUser('fresh-steal-other@test.local', 'supersecret123', 'Fresh Steal Other');
    await prisma.player.create({ data: { guid: DAT1.guidDecimal, name: 'Fresh Steal Other' } });
    await prisma.accountLink.create({ data: { userId: other.id, guid: DAT1.guidDecimal } });
    await prisma.player.create({ data: { guid: DAT2.guidDecimal, name: 'Fresh Steal' } });
    await prisma.accountLink.create({ data: { userId: owner.id, guid: DAT2.guidDecimal } });
    await activeSession(owner.id, 'Fresh Steal');
    await prisma.user.update({ where: { id: owner.id }, data: { claimFreshAt: new Date() } });

    const result = await tryAutoLinkBySession({ guid: DAT1.guidDecimal, name: 'Fresh Steal', when: new Date() });
    expect(result).toEqual({ outcome: 'skipped', reason: 'guid-ya-vinculado' });
    const link = await prisma.accountLink.findUniqueOrThrow({ where: { guid: DAT1.guidDecimal } });
    expect(link.userId).toBe(other.id); // intacto
    const me = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(me.claimFreshAt).not.toBeNull(); // la marca NO se consume en skip
  });
});
