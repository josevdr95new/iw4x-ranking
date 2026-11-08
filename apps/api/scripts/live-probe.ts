/**
 * Probe READ-ONLY del server IW4x (verificación de formato de lecturas rcon).
 * NO envía ninguna escritura. Uso: npx tsx scripts/live-probe.ts
 */
import '../src/config/env.js'; // carga dotenv (apps/api/.env) ANTES de leer process.env
import { getSharedRcon, isRconConfigured, stripColorCodes } from '../src/lib/rcon/iw4x-rcon.js';

const DVAR_LINE = /^\s*"([^"]+)"\s+is:\s+"([^"]*)"(?:\s+default:\s+"([^"]*)")?/;

function parseDvarReply(payload: string): { name: string | null; value: string | null; default: string | null } {
  const line = payload.split(/\r?\n/).find((l) => DVAR_LINE.test(l));
  if (!line) return { name: null, value: null, default: null };
  const m = DVAR_LINE.exec(line)!;
  return {
    name: m[1] ?? null,
    value: m[2] !== undefined ? stripColorCodes(m[2]) : null,
    default: m[3] !== undefined ? stripColorCodes(m[3]) : null,
  };
}

async function main(): Promise<void> {
  if (!isRconConfigured()) {
    console.log('[probe] RCON_PASSWORD no configurado: abortando (sin lecturas).');
    return;
  }
  const rcon = getSharedRcon();
  try {
    const status = await rcon.status();
    const humans = status.players.filter((p) => !p.connecting && !p.isBot);
    const bots = status.players.filter((p) => !p.connecting && p.isBot);
    const connecting = status.players.filter((p) => p.connecting);
    console.log(`[probe] status: map=${status.map} humanos=${humans.length} bots=${bots.length} conectando=${connecting.length}`);
    for (const p of status.players) {
      console.log(`  slot=${p.cid} ping=${p.ping} guid=${p.guid} bot=${p.isBot} cnct=${p.connecting} name="${p.name}"`);
    }
    const info = await rcon.getinfo();
    console.log(`[probe] getinfo: hostname="${info.hostname}" mapname=${info.mapname} gametype=${info.gametype} sv_maxclients=${info.sv_maxclients}`);

    for (const dvar of ['sv_randomBotNames', 'sv_replaceBots', 'bots_skill', 'bots_skill_min', 'bots_skill_max', 'bots_manage_fill', 'bots_manage_fill_mode', 'bots_manage_fill_kick', 'bots_manage_add']) {
      try {
        const payload = await rcon.exec(dvar);
        const parsed = parseDvarReply(payload);
        console.log(`[probe] dvar ${dvar} → raw=${JSON.stringify(payload)} parsed=${JSON.stringify(parsed)}`);
      } catch (err) {
        console.log(`[probe] dvar ${dvar} → ERROR: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── Servicios NUEVOS del panel (SOLO LECTURAS) ──────────────────────────
    const { getMapsOverview } = await import('../src/services/server-maps.service.js');
    const maps = await getMapsOverview();
    console.log(`[probe] getMapsOverview: current=${maps.current} catalog=${maps.maps.length} mapas (${maps.maps.filter((m) => m.group === 'base').length} base + ${maps.maps.filter((m) => m.group === 'dlc').length} dlc)`);
    console.log(`[probe] ids: ${maps.maps.map((m) => m.id).join(' ')}`);

    const { getBotsOverview } = await import('../src/services/server-bots.service.js');
    const overview = await getBotsOverview();
    console.log(`[probe] getBotsOverview: count=${overview.count} difficulty=${JSON.stringify(overview.difficulty)}`);
    console.log(`[probe] dvars: ${JSON.stringify(overview.dvars)}`);
  } finally {
    rcon.close();
  }
}

void main();
