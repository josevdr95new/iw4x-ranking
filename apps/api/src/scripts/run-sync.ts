// CLI: corre una sincronización manual sin levantar el servidor.
// Uso: npm run sync  (desde la raíz del monorepo)
import { runSync } from '../services/sync/sync.service.js';

const result = await runSync();
console.log(JSON.stringify(result, null, 2));
if (!result.ok) {
  process.exitCode = 1;
}
