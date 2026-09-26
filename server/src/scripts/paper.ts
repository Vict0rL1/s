// CLI: `npm run paper` — el banco del modelo, desde la terminal.
//
// Existe porque el resto del proyecto se opera desde aquí y porque este experimento se
// consulta más de lo que se toca: abrir un navegador para leer cuatro cifras es más
// trabajo del que valen. No gasta ni una petición del plan: solo lee la base, liquida lo
// que ya tenga resultado y coloca lo que la política apruebe.

import { place, settle, resumen, BANCO_INICIAL } from '../paper/bankroll.ts';

const C = { bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', amber: '\x1b[33m', off: '\x1b[0m' };
const dinero = (n: number) => `${n >= 0 ? '' : '−'}${Math.abs(n).toFixed(2)}`;

console.log(`\n${C.bold}El modelo apostando solo${C.off}`);

const liq = settle();
if (liq.liquidadas > 0) console.log(`${C.dim}Liquidadas ${liq.liquidadas} apuesta(s) con su resultado real.${C.off}`);

const col = place();
if (col.colocadas > 0) console.log(`${C.green}Colocadas ${col.colocadas} apuesta(s) nueva(s):${C.off}`);
for (const d of col.detalle.slice(0, 12)) console.log(`  ${C.dim}${d}${C.off}`);

const r = resumen(col.motivo);
const signo = r.beneficio > 0 ? C.green : r.beneficio < 0 ? C.red : C.dim;

console.log('\n' + '─'.repeat(62));
console.log(
  `  banco ${C.bold}${signo}${dinero(r.banco)}${C.off} de ${BANCO_INICIAL}` +
    `   ·   beneficio ${signo}${dinero(r.beneficio)}${C.off}` +
    `   ·   ROI ${r.roi === null ? `${C.dim}—${C.off}` : `${signo}${(r.roi * 100).toFixed(1)} %${C.off}`}`,
);
console.log(
  `  ${C.dim}${r.liquidadas} liquidadas (${r.ganadas} ganadas, ${r.perdidas} perdidas) · ` +
    `${r.pendientes} sin resolver · ${dinero(r.expuesto)} comprometidos${C.off}`,
);

if (r.apuestas.length > 0) {
  console.log('');
  for (const a of r.apuestas.slice(0, 15)) {
    const res =
      a.status === 'pending'
        ? `${C.dim}pendiente${C.off}`
        : (a.profit ?? 0) > 0
          ? `${C.green}+${(a.profit ?? 0).toFixed(2)}${C.off}`
          : `${C.red}${(a.profit ?? 0).toFixed(2)}${C.off}`;
    console.log(
      `  ${a.sport.padEnd(8)} ${a.label.slice(0, 34).padEnd(34)} ${a.selection.slice(0, 18).padEnd(18)} ` +
        `@${a.odds.toFixed(2)}  ${a.stake.toFixed(2).padStart(7)}  ${res}`,
    );
  }
}

// La última pasada, con los rechazos agrupados. Es lo que contesta a «¿por qué lleva
// tres semanas sin apostar?», que sin esto no se puede contestar sin leer código.
if (r.ultima && r.ultima.candidatas > 0) {
  console.log(
    `\n  ${C.dim}Última revisión: ${r.ultima.candidatas} partido(s) con cuotas reales, ` +
      `${r.ultima.colocadas} apostado(s).${C.off}`,
  );
  for (const [motivo, n] of Object.entries(r.ultima.rechazos)) {
    console.log(`  ${C.dim}  · ${n} descartado(s) por ${motivo}${C.off}`);
  }
}

// Sin apuestas, el motivo es lo único que hay que leer. Un banco a 1.000 y una tabla
// vacía, sin explicación, se lee como que el experimento está roto.
if (r.apuestas.length === 0 && r.motivo) {
  console.log(`\n  ${C.amber}Todavía no ha apostado nada.${C.off}`);
  for (const linea of r.motivo.match(/.{1,70}(\s|$)/g) ?? [r.motivo]) {
    console.log(`  ${C.dim}${linea.trim()}${C.off}`);
  }
}
console.log('');
