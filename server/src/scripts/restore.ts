// `npm run restore -- <fichero>` — restaura una copia como libro mayor. Con el servidor PARADO:
// una conexión abierta seguiría escribiendo en el fichero viejo. Sin argumento, lista las copias.

import { copiasLocales, restaurarCopia } from '../db/backup.ts';
import { ficherosDe, LAYOUT } from '../db/layout.ts';

const C = { bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', amber: '\x1b[33m', off: '\x1b[0m' };
const fichero = process.argv.slice(2).find((a) => !a.startsWith('--'));

if (!fichero) {
  const copias = copiasLocales();
  console.log(`${C.bold}Copias locales${C.off} ${C.dim}(la más nueva primero)${C.off}`);
  if (copias.length === 0) console.log(`${C.dim}  ninguna. Haz una con  npm run backup${C.off}`);
  for (const c of copias) console.log(`  ${c.fichero}  ${C.dim}${(c.bytes / 1048576).toFixed(1)} MB · ${c.mtime}${C.off}`);
  console.log(`\nRestaurar:  ${C.bold}npm run restore -- <fichero>${C.off}   (con el servidor parado)`);
  process.exit(0);
}

if (LAYOUT !== 'split') {
  console.error(`${C.red}✗ En DB_LAYOUT=single no hay ledger.db que restaurar: quita DB_LAYOUT o ponlo en split.${C.off}`);
  process.exit(1);
}

try {
  console.log(`${C.amber}⚠ Asegúrate de que el servidor está parado.${C.off}`);
  const r = restaurarCopia(fichero);
  console.log(`${C.green}✓${C.off} Restaurado en ${r.destino}`);
  if (r.apartado) console.log(`${C.dim}· El libro mayor anterior quedó en ${r.apartado} (bórralo cuando te fíes del restaurado)${C.off}`);
  if (r.aviso) console.log(`${C.amber}⚠ ${r.aviso}${C.off}`);
  console.log(`${C.dim}· Historia intacta en ${ficherosDe().history}. Arranca y pasa  npm run doctor.${C.off}`);
} catch (e) {
  console.error(`${C.red}✗ ${(e as Error).message}${C.off}`);
  process.exit(1);
}
