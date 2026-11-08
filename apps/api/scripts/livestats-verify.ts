/**
 * Verificación END-TO-END de la ingesta live (read/write SOLO sobre el
 * snapshot; DB = la misma dev.db que la API). Uso:
 *   npx tsx scripts/livestats-verify.ts
 *
 * 1) Construye un fixture con el formato EXACTO del GSC (guid;xp;prestigio;
 *    kills;deaths;headshots;timePlayed;name) con el guid REAL del owner
 *    (hex d318d2bc06dc1f6c → decimal, como lo emite getguid()).
 * 2) Escribe el fixture en el snapshot real (LIVE_STATS_FILE), corre un tick
 *    REAL del servicio (runLiveStatsTick) y muestra el resultado del detector.
 * 3) Verifica en DB la fila Player (saveXp/saveLevel/savePrestige) del guid.
 * 4) Restaura el snapshot a cabecera-only (estado actual del server vacío).
 */
import '../src/config/env.js'; // dotenv ANTES de leer env
import { readFileSync, writeFileSync } from 'node:fs';
import { prisma } from '../src/lib/prisma.js';
import { levelFromXp } from '../src/lib/save-parser/parse-stat-blob.js';
import { parseLiveStatsText, runLiveStatsTick } from '../src/services/livestats.service.js';

const FILE = process.env.LIVE_STATS_FILE ?? '';
if (!FILE) {
  console.error('[verify] LIVE_STATS_FILE no configurado.');
  process.exit(1);
}

/** Guid real del owner (nuevo, post-reset) según games_mp.log del server. */
const OWNER_HEX = 'd318d2bc06dc1f6c';
const OWNER_DEC = BigInt(`0x${OWNER_HEX}`).toString(10);

async function main(): Promise<void> {
  const original = (() => {
    try { return readFileSync(FILE, 'utf8'); } catch { return ''; }
  })();
  console.log(`[verify] snapshot actual: ${JSON.stringify(original)} (${Buffer.byteLength(original)}B)`);

  // ── 1. Fixture con formato EXACTO del GSC v2 ──────────────────────────────
  const lines = [
    '#iw4x-ranking v1',
    `${OWNER_DEC};1200000;0;350;210;45;620;admin`,   // humano (guid decimal)
    `${OWNER_HEX};990000;0;300;180;40;580;adminHex`,  // humano (guid HEX → se normaliza)
    'bot4;500;0;10;5;1;30;Jimbo',                     // bot "botN" → rechazado
    'línea-basura-sin-campos',                        // → rechazada
  ];
  const fixture = lines.join('\n');
  writeFileSync(FILE, fixture, 'utf8');

  // Parser offline primero (tolerancia: bots, hex, basura).
  const parsed = parseLiveStatsText(fixture);
  console.log(`[verify] parseLiveStatsText → entradas=${parsed.length} (esperadas: 2, bots/basura fuera)`);
  for (const e of parsed) console.log(`  guid=${e.guid} name=${e.name} xp=${e.xp}`);

  // ── 2. Tick REAL del servicio contra el snapshot real ─────────────────────
  const result = await runLiveStatsTick();
  console.log(`[verify] tick: read=${result.read} entries=${result.entries} playersUpdated=${result.playersUpdated} suspicious=${result.suspicious} kicked=${result.kicked}`);

  // ── 3. Fila Player del owner en DB ────────────────────────────────────────
  const player = await prisma.player.findUnique({
    where: { guid: OWNER_DEC },
    select: { guid: true, name: true, saveXp: true, saveLevel: true, savePrestige: true, saveParsedAt: true },
  });
  if (player?.saveXp !== null && player?.saveXp !== undefined) {
    console.log('[verify] Player OK:');
    console.log(`  guid=${player.guid} name=${player.name}`);
    console.log(`  saveXp=${player.saveXp} saveLevel=${player.saveLevel} (levelFromXp=${levelFromXp(player.saveXp)}) savePrestige=${player.savePrestige}`);
    console.log(`  saveParsedAt=${player.saveParsedAt?.toISOString()}`);
  } else {
    console.error('[verify] FALLO: fila Player sin saveXp.');
  }

  // ── 4. Restaurar snapshot (el server lo reescribe igual cada ~60s) ────────
  writeFileSync(FILE, original || '#iw4x-ranking v1', 'utf8');
  console.log('[verify] snapshot restaurado a estado previo.');

  await prisma.$disconnect();
}

void main();
