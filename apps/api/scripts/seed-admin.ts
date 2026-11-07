// CLI: crea (o asegura) el ADMIN POR DEFECTO. Idempotente.
//   - Si NO existe lo crea: nick/email/password por defecto, role ADMIN.
//   - Si YA existe: solo asegura role=ADMIN; la contraseña NUNCA se toca.
// Contrato (defaults overridables por env): ADMIN_NICK, ADMIN_EMAIL, ADMIN_PASSWORD.
// IMPORTANTE: el login es SOLO por NICK — entra con ADMIN_NICK + ADMIN_PASSWORD
// (el email es solo gestión de cuenta, no credencial).
//
// Uso: npm run seed:admin  (desde la raíz del monorepo o de apps/api)
import { prisma } from '../src/lib/prisma.js';
import { seedDefaultAdmin } from '../src/services/seed.service.js';

const result = await seedDefaultAdmin();

if (result.created) {
  console.log(`[seed:admin] OK: admin creado (id ${result.user.id}).`);
  console.log('[seed:admin] Recuerda CAMBIAR la contraseña tras el primer login.');
} else if (result.promoted) {
  console.log(`[seed:admin] OK: cuenta existente promovida a ADMIN (id ${result.user.id}).`);
} else {
  console.log(`[seed:admin] Nada que hacer: el admin ya existe (id ${result.user.id}, role ${result.user.role}). Contraseña intacta.`);
}
console.log('[seed:admin] Login SOLO por nick (el email no es credencial de acceso).');

await prisma.$disconnect();
