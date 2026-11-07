import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { prisma } from '../src/lib/prisma.js';
import { runSync } from '../src/services/sync/sync.service.js';
import { SKILL } from '../src/services/skill/elo.js';
import { registerUser, req, resetDb } from './helpers.js';

beforeAll(async () => {
  expect(env.iw4madminDbPath, 'IW4MADMIN_DB_PATH debe apuntar al mock generado en global-setup').toBeTruthy();
  expect(existsSync(env.iw4madminDbPath), 'la DB mock de IW4MAdmin no existe').toBe(true);
  await resetDb();
});

describe('Sync desde IW4MAdmin (defensivo, read-only)', () => {
  it('importa jugadores y kill events del mock', async () => {
    const result = await runSync();

    expect(result.ok).toBe(true);
    expect(result.playersSynced).toBe(12);
    expect(result.killEventsSynced).toBe(300);
    expect(await prisma.player.count()).toBe(12);
    expect(await prisma.killEvent.count()).toBe(300);
  });

  it('calcula agregaciones consistentes por jugador', async () => {
    const players = await prisma.player.findMany();
    expect(players.length).toBeGreaterThan(0);

    let killsSum = 0;
    let deathsSum = 0;
    for (const player of players) {
      const expectedKd = player.deaths > 0 ? player.kills / player.deaths : player.kills;
      expect(player.kd).toBeCloseTo(Math.round(expectedKd * 100) / 100, 2);
      expect(player.skill).toBeGreaterThan(0);
      expect(player.connections).toBeGreaterThan(0);
      expect(player.timePlayed).toBeGreaterThanOrEqual(0);
      expect(player.lastConnection).not.toBeNull();
      killsSum += player.kills;
      deathsSum += player.deaths;
    }
    // Los eventos con IsKill=0 (~5%) no cuentan como kills ni deaths.
    expect(killsSum).toBeLessThanOrEqual(300);
    expect(deathsSum).toBeLessThanOrEqual(300);
    expect(killsSum).toBeGreaterThan(0);
  });

  it('es incremental: un segundo sync no duplica kill events', async () => {
    const before = await prisma.killEvent.count();
    const result = await runSync();
    const after = await prisma.killEvent.count();

    expect(result.killEventsSynced).toBe(0);
    expect(after).toBe(before);
    // Re-sincroniza stats sin romper nada.
    expect(result.playersSynced).toBe(12);
  });

  it('GET /api/sync/status es público y expone lastSyncAt', async () => {
    // Sin token: ahora es un endpoint público.
    const res = await req().get('/api/sync/status');
    expect(res.status).toBe(200);

    const body = res.body as { lastSyncAt: string | null; configured: boolean; intervalMinutes: number; windowMinutes: number };
    expect(body.configured).toBe(true);
    expect(body.intervalMinutes).toBe(0);
    expect(body.windowMinutes).toBe(10);
    // Ya hubo un sync exitoso en este archivo → lastSyncAt no es null.
    expect(body.lastSyncAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(body.lastSyncAt as string))).toBe(false);
  });

  it('lastSyncAt es null en una base sin sincronizaciones exitosas', async () => {
    await prisma.syncRun.deleteMany();
    const res = await req().get('/api/sync/status');
    expect(res.status).toBe(200);
    expect((res.body as { lastSyncAt: string | null }).lastSyncAt).toBeNull();
    // Deja un sync exitoso para los tests siguientes.
    await runSync();
  });

  it('el sync inicializa el skill ELO de TODOS los players (nuevo modelo, ver docs/API.md "skill ELO")', async () => {
    // Tras el sync + processSkillUpdates, ningún player queda con skill 0:
    // los que participan en eventos reciben su ELO real; el resto arranca en START.
    const players = await prisma.player.findMany({ select: { skill: true, skillElo: true } });
    expect(players.length).toBeGreaterThan(0);
    for (const player of players) {
      expect(player.skillElo).toBeGreaterThanOrEqual(SKILL.FLOOR);
      expect(player.skillElo).toBeLessThanOrEqual(SKILL.CAP);
      // skill expuesto = skillElo + bonus de racha (≥ skillElo siempre).
      expect(player.skill).toBeGreaterThanOrEqual(player.skillElo);
    }
    // El mock genera kills → al menos un player superó el START (el ELO se movió).
    expect(players.some((p) => p.skillElo !== SKILL.START)).toBe(true);
  });
});

describe('GET /api/leaderboard', () => {
  it('ordena por kills desc y pagina', async () => {
    const res = await req().get('/api/leaderboard?sort=kills&order=desc&page=1&pageSize=5');
    expect(res.status).toBe(200);

    const body = res.body as {
      total: number;
      totalPages: number;
      page: number;
      sort: string;
      players: Array<{ rank: number; kills: number; linked: boolean }>;
    };
    expect(body.sort).toBe('kills');
    expect(body.total).toBe(12);
    expect(body.page).toBe(1);
    expect(body.players).toHaveLength(5);
    const kills = body.players.map((player) => player.kills);
    expect([...kills].sort((a, b) => b - a)).toEqual(kills);
    expect(body.players[0]?.rank).toBe(1);
    expect(body.players[4]?.rank).toBe(5);
    // Campo nuevo: linked (en tests, el mock no tiene cuentas vinculadas aún).
    expect(body.players.every((player) => typeof player.linked === 'boolean')).toBe(true);
    expect(body.players[0]?.linked).toBe(false);
  });

  it('rank es SIEMPRE la posición global, incluso con búsqueda y paginación', async () => {
    const all = await req().get('/api/leaderboard?sort=kills&order=desc&pageSize=100');
    const list = (all.body as { players: Array<{ guid: string; name: string; rank: number }> }).players;
    const target = list[5]; // 6º del ranking global (índice 0-based)
    expect(target).toBeDefined();

    // Con búsqueda activa: aunque haya un único match, su rank NO pasa a ser 1.
    const search = await req().get(`/api/leaderboard?search=${encodeURIComponent(target.name)}&pageSize=100`);
    expect(search.status).toBe(200);
    const found = (search.body as { players: Array<{ guid: string; rank: number }> }).players;
    const matched = found.find((player) => player.guid === target.guid);
    expect(matched).toBeDefined();
    expect(matched?.rank).toBe(6);

    // Paginación: la página 2 arranca en el rank global 6 (continuo, no 1,2,3...).
    const page2 = await req().get('/api/leaderboard?sort=kills&order=desc&pageSize=5&page=2');
    const firstOfPage2 = (page2.body as { players: Array<{ guid: string; rank: number }> }).players[0];
    expect(firstOfPage2?.guid).toBe(target.guid);
    expect(firstOfPage2?.rank).toBe(6);
  });

  it('ordena por kd y timePlayed', async () => {
    const kdRes = await req().get('/api/leaderboard?sort=kd&order=desc&pageSize=100');
    const kdList = (kdRes.body as { players: Array<{ kd: number }> }).players.map((player) => player.kd);
    expect([...kdList].sort((a, b) => b - a)).toEqual(kdList);

    const timeRes = await req().get('/api/leaderboard?sort=timePlayed&order=asc&pageSize=100');
    const times = (timeRes.body as { players: Array<{ timePlayed: number }> }).players.map((player) => player.timePlayed);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('busca por nombre (case-insensitive)', async () => {
    const all = await req().get('/api/leaderboard?pageSize=100');
    const firstName = (all.body as { players: Array<{ name: string }> }).players[0]?.name ?? '';
    const fragment = firstName.slice(0, 5);
    expect(fragment.length).toBeGreaterThan(0);

    const res = await req().get(`/api/leaderboard?search=${encodeURIComponent(fragment)}&pageSize=100`);
    expect(res.status).toBe(200);
    const names = (res.body as { players: Array<{ name: string }> }).players.map((player) => player.name);
    expect(names.length).toBeGreaterThanOrEqual(1);
    expect(names.every((name) => name.toLowerCase().includes(fragment.toLowerCase()))).toBe(true);
  });

  it('filtra por minMatches (connections)', async () => {
    const all = await req().get('/api/leaderboard?pageSize=100');
    const total = (all.body as { total: number }).total;

    const filtered = await req().get('/api/leaderboard?minMatches=100000&pageSize=100');
    expect(filtered.status).toBe(200);
    expect((filtered.body as { total: number }).total).toBe(0);

    const loose = await req().get('/api/leaderboard?minMatches=1&pageSize=100');
    expect((loose.body as { total: number }).total).toBe(total);
  });

  it('rechaza sort inválido con 400', async () => {
    const res = await req().get('/api/leaderboard?sort=hacks');
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/players/:guid', () => {
  it('devuelve perfil con rank global, eventos recientes y resumen por servidor', async () => {
    const lb = await req().get('/api/leaderboard?sort=kills&order=desc&pageSize=3');
    const ranked = (lb.body as { players: Array<{ guid: string; name: string; kills: number }> }).players;
    expect(ranked.length).toBeGreaterThanOrEqual(2);

    const res = await req().get(`/api/players/${ranked[0].guid}`);
    expect(res.status).toBe(200);

    const body = res.body as {
      player: { guid: string; name: string; kills: number; linked: boolean };
      rank: number | null;
      recentEvents: Array<{ direction: string; opponentGuid: string; time: string }>;
      byServer: Array<{ server: string; kills: number; deaths: number }>;
    };
    expect(body.player.guid).toBe(ranked[0].guid);
    expect(body.player.name).toBe(ranked[0].name);
    expect(body.player.kills).toBe(ranked[0].kills);
    // Rank global con el criterio por defecto del leaderboard (kills desc, nombre asc).
    expect(body.rank).toBe(1);

    const second = await req().get(`/api/players/${ranked[1].guid}`);
    expect(second.status).toBe(200);
    expect((second.body as { rank: number | null }).rank).toBe(2);

    expect(body.recentEvents.length).toBeLessThanOrEqual(20);
    for (const event of body.recentEvents) {
      expect(['kill', 'death']).toContain(event.direction);
      expect(event.opponentGuid).not.toBe(ranked[0].guid);
    }
    expect(body.byServer.length).toBeGreaterThanOrEqual(0);
  });

  it('404 PLAYER_NOT_FOUND para GUID numérico desconocido', async () => {
    const res = await req().get('/api/players/111111111111111111');
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('PLAYER_NOT_FOUND');
  });

  it('400 VALIDATION_ERROR para GUID no numérico', async () => {
    const res = await req().get('/api/players/not-a-guid');
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/players/:guid/history', () => {
  it('devuelve series temporales con zero-fill de N días', async () => {
    const lb = await req().get('/api/leaderboard?sort=kills&order=desc&pageSize=1');
    const top = (lb.body as { players: Array<{ guid: string }> }).players[0];
    expect(top).toBeDefined();

    const res = await req().get(`/api/players/${top.guid}/history?days=14`);
    expect(res.status).toBe(200);

    const body = res.body as { guid: string; days: number; series: Array<{ date: string; kills: number; deaths: number }> };
    expect(body.guid).toBe(top.guid);
    expect(body.days).toBe(14);
    expect(body.series).toHaveLength(14);
    const dates = body.series.map((point) => point.date);
    expect([...dates].sort()).toEqual(dates);
    const killsSum = body.series.reduce((acc, point) => acc + point.kills, 0);
    expect(killsSum).toBeGreaterThanOrEqual(0);
    expect(killsSum).toBeLessThanOrEqual(300);
  });

  it('rechaza days fuera de rango con 400 (contrato: 1..90)', async () => {
    const lb = await req().get('/api/leaderboard?pageSize=1');
    const top = (lb.body as { players: Array<{ guid: string }> }).players[0];

    const tooMany = await req().get(`/api/players/${top?.guid}/history?days=200`);
    expect(tooMany.status).toBe(400);
    expect((tooMany.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');

    const tooFew = await req().get(`/api/players/${top?.guid}/history?days=0`);
    expect(tooFew.status).toBe(400);
  });

  it('usa days=30 por defecto si no se envía', async () => {
    const lb = await req().get('/api/leaderboard?pageSize=1');
    const top = (lb.body as { players: Array<{ guid: string }> }).players[0];

    const res = await req().get(`/api/players/${top?.guid}/history`);
    expect(res.status).toBe(200);
    const body = res.body as { days: number; series: unknown[] };
    expect(body.days).toBe(30);
    expect(body.series).toHaveLength(30);
  });
});

describe('POST /api/sync (endpoint protegido)', () => {
  it('responde 401 sin token', async () => {
    const res = await req().post('/api/sync');
    expect(res.status).toBe(401);
  });

  it('corre el sync con token y devuelve result ok', async () => {
    const { token } = await registerUser('syncer@test.local');
    const res = await req().post('/api/sync').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const result = (res.body as { result: { ok: boolean; playersSynced: number } }).result;
    expect(result.ok).toBe(true);
    expect(result.playersSynced).toBe(12);
  });
});

describe('GET /api/leaderboard?sort=headshots (campo nuevo)', () => {
  it('ordena por headshots desc y expone el campo headshots en cada entrada', async () => {
    // Siembra headshots DISTINTOS en 3 players del mock para que el orden sea
    // observable (se restauran los valores originales al salir).
    const seeded = await prisma.player.findMany({ orderBy: [{ guid: 'asc' }], take: 3, select: { guid: true, headshots: true } });
    expect(seeded).toHaveLength(3);
    const originals = seeded.map((p) => ({ guid: p.guid, headshots: p.headshots }));
    try {
      await prisma.player.update({ where: { guid: originals[0]!.guid }, data: { headshots: 7 } });
      await prisma.player.update({ where: { guid: originals[1]!.guid }, data: { headshots: 3 } });
      await prisma.player.update({ where: { guid: originals[2]!.guid }, data: { headshots: 0 } });

      const res = await req().get('/api/leaderboard?sort=headshots&order=desc&pageSize=100');
      expect(res.status).toBe(200);
      const body = res.body as { sort: string; order: string; players: Array<{ guid: string; headshots: number; kills: number }> };
      expect(body.sort).toBe('headshots');
      expect(body.order).toBe('desc');
      expect(body.players[0]?.guid).toBe(originals[0]!.guid); // 7 headshots primero
      expect(body.players[0]?.headshots).toBe(7);
      const headshots = body.players.map((p) => p.headshots);
      expect([...headshots].sort((a, b) => b - a)).toEqual(headshots);

      // asc también funciona.
      const asc = await req().get('/api/leaderboard?sort=headshots&order=asc&pageSize=100');
      const ascList = (asc.body as { players: Array<{ headshots: number }> }).players.map((p) => p.headshots);
      expect([...ascList].sort((a, b) => a - b)).toEqual(ascList);
    } finally {
      // Restaura para no perturbar los rankings por kills de otros tests.
      for (const original of originals) {
        await prisma.player.update({ where: { guid: original.guid }, data: { headshots: original.headshots } });
      }
    }
  });

  it('sort inválido sigue rechazándose con 400 (headshots ahora es válido)', async () => {
    const res = await req().get('/api/leaderboard?sort=hs');
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });
});
