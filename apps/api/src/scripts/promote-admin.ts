// CLI: promueve (o degrada) una cuenta a ADMIN por email.
// Uso:   npm run promote:admin -- <email>
//        npm run promote:admin -- <email> --demote
import { prisma } from '../lib/prisma.js';

const args = process.argv.slice(2);
const demote = args.includes('--demote');
const email = args.find((arg) => !arg.startsWith('--'))?.trim().toLowerCase();

if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('Uso: npm run promote:admin -- <email> [--demote]');
  process.exit(1);
}

const user = await prisma.user.findUnique({ where: { email } });
if (!user) {
  console.error(`No existe ninguna cuenta con email ${email}.`);
  process.exit(1);
}

const role = demote ? 'USER' : 'ADMIN';
await prisma.user.update({ where: { id: user.id }, data: { role } });
console.log(`OK: ${email} ahora es ${role} (antes: ${user.role}).`);
await prisma.$disconnect();
