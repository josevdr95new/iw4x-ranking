// CLI: LIMPIEZA de datos de prueba del dev.db actual (idempotente, re-ejecutable).
// Borra SOLO artefactos conocidos de pruebas, en orden seguro de FKs, e imprime
// un resumen de filas borradas por tabla + directorios de storage eliminados.
//
// Objetivos (claves EXPLÍCITAS — nada de borrado "por patrones"):
//   - Player(s) TESTPROBE: guid 13908166186265486375 (alias "pollacaballo" y
//     "TESTPROBE" del probe del 6/11) y el guid c103bb7531742427 que aparece en
//     notas históricas (hoy inexistente; se incluye por si reaparece) + TODO lo
//     dependiente: PlayerAlias, Session, KillEvent (como origen o víctima),
//     AccountLink.
//   - Usuarios de prueba: cloudtest-420@test.local, cloudtest-8885@test.local,
//     moder-test-2@test.local, launcher-test@test.local (+ LinkAttempt,
//     IdentityAlert, AccountLink y Player ligados → si un Player real quedara
//     ligado, se des-liga poniendo el vínculo a null vía delete del AccountLink,
//     NUNCA se borra el Player).
//   - Directorios de storage <PROFILE_STORAGE_DIR>/<userId> de esos usuarios y
//     cualquier directorio huérfano (userId sin fila User).
//
// NUNCA toca: bots (isBot=true), jugadores reales del log (p.ej. Mandango guid
// 13352019364823201036), partidas/kill-events de jugadores reales, el admin por
// defecto (nick ADMIN_NICK / email ADMIN_EMAIL) ni el resto de cuentas.
//
// Uso: npm run db:clean  (desde la raíz del monorepo o de apps/api)
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '../src/lib/prisma.js';
import { env } from '../src/config/env.js';
import { normalizeDisplayName } from '../src/services/alias.service.js';

// Guid(s) del probe de pruebas del 6/11. El TESTPROBE real conectó con
// 13908166186265486375 (alias "pollacaballo"); c103bb7531742427 es la
// referencia de la nota original (idempotente: si no existe, borra 0).
const TESTPROBE_GUIDS = ['13908166186265486375', 'c103bb7531742427'];

// Usuarios de prueba a eliminar (por email, case-insensitive).
const TEST_USER_EMAILS = [
  'cloudtest-420@test.local',
  'cloudtest-8885@test.local',
  'moder-test-2@test.local',
  'launcher-test@test.local',
];

const summary: Array<{ tabla: string; borradas: number }> = [];
function record(table: string, deleted: number): void {
  summary.push({ tabla: table, borradas: deleted });
}

// ── Protecciones: el admin por defecto y los bots JAMÁS se borran ──────────
const adminNickNormalized = normalizeDisplayName(env.adminNick);
const protectedEmails = new Set([env.adminEmail.toLowerCase()]);

async function main(): Promise<void> {
  console.log('[db:clean] Limpieza de datos de prueba (idempotente). Objetivos EXPLÍCITOS:');
  console.log(`[db:clean]   guids TESTPROBE: ${TESTPROBE_GUIDS.join(', ')}`);
  console.log(`[db:clean]   usuarios: ${TEST_USER_EMAILS.join(', ')}`);
  console.log(`[db:clean]   PROTEGIDOS: bots, players reales, admin por defecto (${env.adminNick} / ${env.adminEmail})`);

  // 1. KillEvent del probe (origen o víctima). Hoy los 6 eventos del DB tienen
  //    al TESTPROBE como víctima y bots como atacantes.
  const killEvents = await prisma.killEvent.deleteMany({
    where: { OR: [{ originGuid: { in: TESTPROBE_GUIDS } }, { targetGuid: { in: TESTPROBE_GUIDS } }] },
  });
  record('KillEvent', killEvents.count);

  // 2. Session del probe (FK → Player, cascade, pero borramos explícito para el resumen).
  const sessions = await prisma.session.deleteMany({ where: { guid: { in: TESTPROBE_GUIDS } } });
  record('Session', sessions.count);

  // 3. Alias del probe.
  const aliases = await prisma.playerAlias.deleteMany({ where: { guid: { in: TESTPROBE_GUIDS } } });
  record('PlayerAlias', aliases.count);

  // 4. Resolver usuarios de prueba (email, case-insensitive) SIN tocar al admin.
  const testUsers = await prisma.user.findMany({
    where: { email: { in: TEST_USER_EMAILS.map((e) => e.toLowerCase()) } },
    select: { id: true, email: true, role: true },
  });
  const deletableUsers = testUsers.filter((u) => !protectedEmails.has(u.email.toLowerCase()));
  const userIds = deletableUsers.map((u) => u.id);
  for (const u of deletableUsers) {
    console.log(`[db:clean]   usuario de prueba encontrado: id ${u.id} ${u.email} (role ${u.role})`);
  }

  // 5. AccountLink: del probe Y de los usuarios de prueba. Al des-ligar NUNCA se
  //    borra el Player: si el guid fuera de un jugador real, simplemente pierde
  //    el vínculo con la cuenta de prueba (el Player y sus stats siguen ahí).
  const links = await prisma.accountLink.deleteMany({
    where: { OR: [{ guid: { in: TESTPROBE_GUIDS } }, ...(userIds.length > 0 ? [{ userId: { in: userIds } }] : [])] },
  });
  record('AccountLink', links.count);

  // 6. Intentos de vinculación y alertas de identidad de esos usuarios.
  const attempts = userIds.length > 0
    ? await prisma.linkAttempt.deleteMany({ where: { userId: { in: userIds } } })
    : { count: 0 };
  record('LinkAttempt', attempts.count);

  const alerts = userIds.length > 0
    ? await prisma.identityAlert.deleteMany({ where: { ownerUserId: { in: userIds } } })
    : { count: 0 };
  record('IdentityAlert', alerts.count);

  // 7. Player del probe. CINTURÓN Y TIRANTES: re-verifica que el guid a borrar
  //    NO sea un bot ni el jugador real Mandango antes de borrar.
  const probePlayers = await prisma.player.findMany({
    where: { guid: { in: TESTPROBE_GUIDS } },
    select: { guid: true, name: true, isBot: true },
  });
  const MANDANGO_GUID = '13352019364823201036'; // jugador REAL del pool del server — jamás se borra
  const deletableGuids: string[] = [];
  for (const p of probePlayers) {
    if (p.isBot) {
      console.warn(`[db:clean]   OMITIDO (es bot): ${p.guid} "${p.name}"`);
      continue;
    }
    if (p.guid === MANDANGO_GUID) {
      console.warn(`[db:clean]   OMITIDO (jugador real protegido): ${p.guid} "${p.name}"`);
      continue;
    }
    deletableGuids.push(p.guid);
    console.log(`[db:clean]   player de prueba a borrar: ${p.guid} "${p.name}"`);
  }
  const players = deletableGuids.length > 0
    ? await prisma.player.deleteMany({ where: { guid: { in: deletableGuids } } })
    : { count: 0 };
  record('Player', players.count);

  // 8. Usuarios de prueba (al final: sin dependientes vivos).
  const users = userIds.length > 0
    ? await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    : { count: 0 };
  record('User', users.count);

  // 9. Storage de cloud save: <dir>/<userId> de los usuarios borrados + huérfanos.
  const storageRoot = env.profileStorageDir;
  const removedDirs: string[] = [];
  if (existsSync(storageRoot)) {
    const liveUserIds = new Set(
      (await prisma.user.findMany({ select: { id: true } })).map((u) => String(u.id)),
    );
    const deletableSet = new Set(userIds.map(String));
    for (const entry of readdirSync(storageRoot)) {
      const full = join(storageRoot, entry);
      try {
        if (!statSync(full).isDirectory() || !/^\d+$/.test(entry)) continue;
      } catch {
        continue;
      }
      if (deletableSet.has(entry) || !liveUserIds.has(entry)) {
        rmSync(full, { recursive: true, force: true });
        removedDirs.push(entry);
        console.log(`[db:clean]   storage eliminado: ${full}${deletableSet.has(entry) ? '' : ' (huérfano)'}`);
      }
    }
  }

  // ── Resumen ────────────────────────────────────────────────────────────────
  console.log('\n[db:clean] RESUMEN (filas borradas por tabla):');
  for (const row of summary) console.log(`[db:clean]   ${row.tabla}: ${row.borradas}`);
  console.log(`[db:clean]   storage/profiles dirs: ${removedDirs.length}${removedDirs.length > 0 ? ` (${removedDirs.join(', ')})` : ''}`);
  console.log('[db:clean] Listo. Re-ejecutar es seguro: una segunda pasada borra 0 filas.');
}

main()
  .catch((err) => {
    console.error('[db:clean] ERROR:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
