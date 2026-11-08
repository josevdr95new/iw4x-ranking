/**
 * Diagnóstico del pipeline live: spawnea UN bot de prueba en el server para
 * ejercitar el camino por-jugador del GSC (entidad en level.players →
 * IsBot() → skip + línea de debug). El bot NO toca la ruta GetStat (solo
 * humanos) y lo filtra la ingesta (gamelog: BOT_GUID_TOKEN; livestats:
 * IsBot/botN). Desaparece en la próxima rotación de mapa.
 *
 * USO: npx tsx scripts/debug-spawnbot.ts [cantidad=1]
 * Es un comando de ESCRITURA rcon (spawnBot): usar solo para diagnosticar.
 */
import '../src/config/env.js';
import { getSharedRcon } from '../src/lib/rcon/iw4x-rcon.js';

const count = Number(process.argv[2] ?? '1') || 1;

async function main(): Promise<void> {
  const rcon = getSharedRcon();
  try {
    const before = await rcon.status();
    console.log(`[spawnbot] antes: players=${before.players.length} map=${before.map}`);
    const reply = await rcon.spawnBot(count);
    console.log(`[spawnbot] spawnBot ${count} → ack: ${JSON.stringify(reply)}`);
    // El bot tarda ~2s en conectar (menuresponse/changeclass a +1s/+2s).
    await new Promise((r) => setTimeout(r, 4000));
    const after = await rcon.status();
    console.log(`[spawnbot] después: players=${after.players.length}`);
    for (const p of after.players) {
      console.log(`  slot=${p.cid} guid=${p.guid} bot=${p.isBot} ping=${p.ping} name="${p.name}"`);
    }
  } finally {
    rcon.close();
  }
}

void main();
