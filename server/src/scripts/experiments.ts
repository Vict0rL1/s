// CLI: `npm run experiments`
//
// Lee el registro y contesta la única pregunta que importa cuando llevas muchas
// pruebas encima de los mismos datos: ¿cuáles de estos resultados siguen en pie
// después de tener en cuenta cuántas veces has mirado?

import {
  readRegistry,
  datasetKey,
  bonferroniAlpha,
  benjaminiHochberg,
  REGISTRY_PATH,
  type Experiment,
} from '../experiments/registry.ts';
import { FINAL_HOLDOUT_FROM, VALIDATION_SEASON } from '../experiments/holdout.ts';

const { experiments, unlocks } = readRegistry();

if (experiments.length === 0) {
  console.log('El registro está vacío.');
  console.log(`Se escribe en ${REGISTRY_PATH} desde los scripts de estudio.`);
  process.exit(0);
}

console.log(`${experiments.length} experimentos registrados en total.\n`);

// ---------------------------------------------------------------------------
console.log('EL HOLDOUT FINAL');
console.log('  deporte    entrenamiento      validación        holdout (cerrado)');
for (const [sport, from] of Object.entries(FINAL_HOLDOUT_FROM)) {
  const val = VALIDATION_SEASON[sport as keyof typeof VALIDATION_SEASON];
  console.log(
    `  ${sport.padEnd(10)} hasta ${String(val - 1).padEnd(12)} ${String(val).padEnd(16)} ${from} en adelante`,
  );
}
if (unlocks.length === 0) {
  console.log('  El candado NUNCA se ha abierto. El holdout sigue limpio.');
} else {
  console.log(`  ⚠ ABIERTO ${unlocks.length} vez/veces:`);
  for (const u of unlocks) console.log(`    ${u.date.slice(0, 10)} — ${u.reason}`);
  console.log('    A partir de la primera apertura, el holdout ya no es un holdout.');
}

// ---------------------------------------------------------------------------
// El conteo por conjunto, que es lo que fija el listón.
const families = new Map<string, Experiment[]>();
for (const e of experiments) {
  const k = datasetKey(e.dataset);
  families.set(k, [...(families.get(k) ?? []), e]);
}

console.log('\nEXPERIMENTOS POR CONJUNTO DE DATOS');
console.log('  conjunto              nº   α de Bonferroni   (α nominal 0.05)');
for (const [key, fam] of [...families].sort()) {
  const k = fam.length;
  console.log(
    `  ${key.padEnd(20)} ${String(k).padStart(3)}   ${bonferroniAlpha(k).toFixed(5)}` +
      `           ÷${k}`,
  );
}

// ---------------------------------------------------------------------------
for (const [key, fam] of [...families].sort()) {
  const k = fam.length;
  const alpha = bonferroniAlpha(k);
  const ps = fam.map((e) => e.result.p);
  const bh = benjaminiHochberg(ps, 0.05);

  console.log(`\n${'='.repeat(96)}`);
  console.log(`${key} — ${k} experimentos`);
  console.log('='.repeat(96));
  console.log(
    '  hipótesis                                       métrica    delta     dirección     p   nominal Bonf.  BH   veredicto',
  );
  fam.forEach((e, i) => {
    const nominal = e.result.p < 0.05 ? ' sí ' : ' no ';
    const bonf = e.result.p < alpha ? ' sí ' : ' no ';
    const bhOk = bh.has(i) ? ' sí ' : ' no ';
    // La dirección va aparte del p, y hace falta: el p bilateral no distingue «mejora
    // mucho» de «empeora mucho», así que sin esta columna un rechazo rotundo se lee
    // igual que un acierto rotundo. Le pasó al experimento de Glicko: p = 0.005, dos
    // «sí» en las columnas de significancia, y lo que decía era que la feature
    // empeoraba de forma inequívoca.
    const dir =
      e.result.p >= 0.05
        ? '   —      '
        : e.result.delta < 0
          ? ' mejora   '
          : ' EMPEORA  ';
    const delta =
      Math.abs(e.result.delta) >= 1
        ? (e.result.delta >= 0 ? '+' : '') + e.result.delta.toFixed(1)
        : (e.result.delta >= 0 ? '+' : '') + e.result.delta.toFixed(5);
    console.log(
      `  ${e.hypothesis.slice(0, 45).padEnd(46)} ${e.metric.padEnd(8)} ${delta.padStart(9)} ` +
        `${dir} ${e.result.p.toFixed(4)}  ${nominal}  ${bonf}  ${bhOk}  ${e.verdict}`,
    );
  });

  // ---- lo que hay que leerse ----
  // Solo cuentan los que mejoran: «pasa el listón» significa «hay evidencia de que
  // esto AYUDA», no «hay evidencia de que esto es distinto de cero en algún sentido».
  const improves = (e: Experiment) => e.result.delta < 0;
  const nominalHits = fam.filter((e) => e.result.p < 0.05 && improves(e)).length;
  const bonfHits = fam.filter((e) => e.result.p < alpha && improves(e)).length;
  const bhHits = fam.filter((e, i) => bh.has(i) && improves(e)).length;
  console.log(
    `\n  Mejoras con evidencia: ${nominalHits} al listón nominal del 5 %, ` +
      `${bonfHits} tras Bonferroni, ${bhHits} tras Benjamini–Hochberg.`,
  );
  // El número que pone las cosas en su sitio: cuántos falsos esperas por puro azar.
  const expectedFalse = k * 0.05;
  console.log(
    `  Con ${k} comparaciones sobre los mismos datos, el azar produce ~${expectedFalse.toFixed(1)} ` +
      `resultados «significativos» al 5 %.`,
  );
  if (nominalHits > 0 && nominalHits <= expectedFalse) {
    console.log(
      '  → Hay tantos aciertos nominales como los que daría el ruido. Ninguno se sostiene solo.',
    );
  }
  const shippedButWeak = fam.filter((e) => e.verdict === 'shipped' && e.result.p >= alpha);
  if (shippedButWeak.length > 0) {
    console.log(
      `\n  ⚠ ${shippedButWeak.length} cosa(s) EN PRODUCCIÓN no pasan Bonferroni en esta familia:`,
    );
    for (const e of shippedButWeak) {
      console.log(`    · ${e.hypothesis}  (p = ${e.result.p.toFixed(4)}, hace falta < ${alpha.toFixed(5)})`);
    }
    console.log('    No significa que estén mal. Significa que esta evidencia no las sostiene');
    console.log('    y que el sitio donde se deciden es el holdout final, no aquí.');
  }
}

console.log(`\nRegistro: ${REGISTRY_PATH}`);
