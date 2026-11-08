/**
 * LIMPIEZA one-off: borra AccountLinks apuntando a GUIDs de BOT (rango 0xb07…).
 * Los bots no son cuentas: el link user 36 → guid 794603859254181900 es basura
 * (mapping "botN" del log). Guard: SOLO borra si el guid PASA isBotGuid, y si
 * se pasa --dry no escribe nada (solo imprime el plan).
 *
 * Uso: npx tsx scripts/remove-bot-link.ts [--dry] [--guid=<guid decimal>]
 */
import '../src/config/env.js'; // dotenv antes de leer process.env
import { prisma } from '../src/lib/prisma.js';
import { isBotGuid } from '../src/services/alias.service.js';

const BOT_LINK_GUID = '794603859254181900'; // reportado: user 36 → guid de bot (rango 0xB07…)

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const guidArg = args.find((a) => a.startsWith('--guid='))?.slice('--guid='.length) ?? BOT_LINK_GUID;

async function main(): Promise<void> {
  const isBot = isBotGuid(guidArg);
  console.log(`[cleanup] guid=${guidArg} isBotGuid=${isBot}`);

  const links = await prisma.accountLink.findMany({
    where: { guid: guidArg },
    include: { user: { select: { id: true, email: true, displayName: true } } },
  });
  console.log(`[cleanup] AccountLinks encontrados: ${links.length}`);
  for (const link of links) {
    console.log(`  - link#${link.id} user#${link.user.id} (${link.user.email} / "${link.user.displayName}")`);
  }

  if (!isBot) {
    console.log('[cleanup] ABORTADO: el guid NO es de bot (guard de seguridad). No se borra nada.');
    return;
  }
  if (links.length === 0) {
    console.log('[cleanup] Nada que borrar.');
    return;
  }
  if (dry) {
    console.log('[cleanup] --dry: plan listado arriba, sin cambios.');
    return;
  }

  const deleted = await prisma.accountLink.deleteMany({ where: { guid: guidArg } });
  console.log(`[cleanup] BORRADOS ${deleted.count} AccountLink(s) del guid de bot ${guidArg}.`);
}

void main()
  .catch((err) => {
    console.error('[cleanup] ERROR:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
