// ¿Cuánto vale de verdad ELO_SIGMA_C?
//
// ===========================================================================
// LA CONSTANTE QUE NADIE MIDIÓ
// ===========================================================================
// `ELO_SIGMA_C = 240` en football/predict.ts fija el «± X pp» que aparece en TODAS
// las tarjetas de fútbol. Sale de
//
//     σ(n) = C / √(n + 1)
//
// —el error de estimación del Elo de un equipo con n partidos jugados—, se combinan
// los dos equipos, y el resultado se convierte a puntos porcentuales con la pendiente
// de la logística. La NFL tiene su equivalente calibrado contra la línea de cierre.
// Este 240 es un número puesto a mano.
//
// No es cosmético: decide si una tarjeta dice «fiabilidad alta» o «baja» (el umbral
// está en 4 pp), y es una afirmación cuantitativa que la app publica sobre su propia
// precisión sin haberla comprobado nunca.
//
// ===========================================================================
// CÓMO SE MIDE SIN CONOCER LA VERDAD
// ===========================================================================
// El Elo «verdadero» de un equipo no se observa, así que no se puede comparar contra
// el estimado. Pero sí se puede DESCOMPONER LA VARIANZA de lo que sí se observa.
//
// Para cada partido el modelo da una puntuación esperada p (victoria 1, empate 0.5),
// y ocurre una real s. El residuo s − p tiene dos fuentes independientes:
//
//     Var(s − p) = Var_resultado(p)         ← el fútbol es aleatorio aunque el
//                                             Elo sea exacto
//                + (dp/dΔ)² · σ²_gap        ← lo que el Elo estimado se aleja del
//                                             verdadero
//
// La primera se CALCULA, no se estima: con las probabilidades a tres bandas del
// propio modelo (w, d, l), la varianza de s ∈ {0, ½, 1} es w + d/4 − (w + d/2)².
// Y esas probabilidades están bien calibradas — el empate da 27,6 % predicho contra
// 27,8 % real en 24.129 partidos—, así que es un cálculo, no un supuesto.
//
// Restándola queda el segundo término, y ahí es donde vive C:
//
//     σ²_gap = σ²(n_local) + σ²(n_visitante) = C² · (1/(n_l+1) + 1/(n_v+1))
//
// Así que con x = 1/(n_l+1) + 1/(n_v+1) y pendiente = ln10·p(1−p)/400:
//
//     residuo² − Var_resultado  ≈  pendiente² · x · C²
//
// que es una regresión por el origen de una cosa observable contra otra observable.
// C² es la pendiente de esa recta.
//
// ===========================================================================
// LO QUE ESTA MEDIDA INCLUYE A PROPÓSITO
// ===========================================================================
// El residuo sobrante no es solo ruido de muestreo del Elo: se lleva también todo
// aquello en lo que el modelo se equivoca y no sabe (alineaciones, lesiones que no
// ve, rotaciones, partidos sin nada en juego). Eso NO es contaminación, es lo que la
// banda debe cubrir. Una banda que solo contase el error estadístico del Elo estaría
// prometiendo una precisión que el modelo no tiene.
//
// Se imprime C por tramos de partidos jugados además del global, porque si la forma
// C/√(n+1) fuese la equivocada se vería aquí: C saldría creciendo o decreciendo con n
// en vez de quedarse plano.

import {
  scoreDistribution,
  outcomeProbabilities,
  DIXON_COLES_RHO,
} from '../football/model.ts';
import { loadMatches, replayMatches } from '../football/ratings.ts';
import { footballConfig } from '../config.ts';
import { getDb } from '../db.ts';

interface Row {
  /** 1/(n_local+1) + 1/(n_visitante+1). */
  x: number;
  /** Pendiente de la puntuación esperada respecto al Elo, en 1/Elo. */
  slope: number;
  /** Residuo al cuadrado menos la varianza propia del resultado. */
  excess: number;
  minMatches: number;
  league: string;
}

const rows: Row[] = [];
// Sin calentamiento: el tramo de pocos partidos es justo el que decide si la fórmula
// tiene la forma correcta, y descartarlo sería mirar solo donde ya sabemos que va bien.
for (const l of footballConfig.leagues) {
  const matches = loadMatches(l.id, 0);
  if (matches.length === 0) continue;
  replayMatches(matches, {
    onMatch: ({ match, home, away, lambda }) => {
      const dist = scoreDistribution(lambda.home, lambda.away, DIXON_COLES_RHO);
      const p3 = outcomeProbabilities(dist);
      const w = p3.home;
      const d = p3.draw;
      // Puntuación esperada a dos bandas, la misma convención con la que se actualiza
      // el Elo y sobre la que está definida la pendiente.
      const p = w + d / 2;
      if (!(p > 0.001 && p < 0.999)) return;
      const varOutcome = w + d / 4 - p * p;
      const s =
        match.home_goals > match.away_goals ? 1 : match.home_goals === match.away_goals ? 0.5 : 0;
      const resid = s - p;
      const slope = (Math.LN10 * p * (1 - p)) / 400;
      rows.push({
        x: 1 / (home.matches + 1) + 1 / (away.matches + 1),
        slope,
        excess: resid * resid - varOutcome,
        minMatches: Math.min(home.matches, away.matches),
        league: l.id,
      });
    },
  });
}

/**
 * C² por mínimos cuadrados a través del origen: C² = Σ(w·y) / Σ(w²), con
 * w = pendiente²·x e y = exceso.
 *
 * Por el origen y no con ordenada libre porque el modelo dice algo concreto: con
 * infinitos partidos el error de estimación es cero. Dejar una ordenada suelta sería
 * medir otra cosa —y además absorbería justo el término que buscamos.
 */
function fitC(sample: Row[]): { c: number; n: number } {
  let num = 0;
  let den = 0;
  for (const r of sample) {
    const w = r.slope * r.slope * r.x;
    num += w * r.excess;
    den += w * w;
  }
  const c2 = den > 0 ? num / den : 0;
  return { c: c2 > 0 ? Math.sqrt(c2) : 0, n: sample.length };
}

console.log(`${rows.length.toLocaleString('es')} partidos\n`);

const all = fitC(rows);

/**
 * Intervalo por bootstrap, porque el número solo no basta para cambiar una constante.
 *
 * El término que se busca es MINÚSCULO al lado del ruido: con C = 240 y dos equipos
 * de 38 partidos vale 0,006 frente a una varianza del resultado de 0,2 — un 3 %. Con
 * una señal así, un ajuste puntual puede salir bonito y no significar nada, y la
 * pregunta que hay que contestar antes de tocar el código no es «¿cuánto da?» sino
 * «¿se distingue de 240?».
 */
function bootstrapC(sample: Row[], iters = 200): { lo: number; hi: number } {
  const cs: number[] = [];
  // Generador propio y con semilla: dos ejecuciones del mismo script tienen que dar
  // el mismo intervalo, o no se puede citar en un commit.
  //
  // mulberry32, con Math.imul, y eso NO es un detalle de estilo. El primer intento
  // fue el clásico `seed = (seed * 1103515245 + 12345) & 0x7fffffff`, que en C es
  // correcto y en JavaScript no: ese producto llega a 2⁶¹, muy por encima del entero
  // exacto de un double (2⁵³), así que se redondea antes de enmascarar y la secuencia
  // deja de ser uniforme. El síntoma fue inconfundible — el intervalo salió [87, 97]
  // alrededor de un valor puntual de 82, es decir, un intervalo que no contenía a su
  // propia estimación. Math.imul multiplica en 32 bits exactos y no tiene ese
  // problema.
  let seed = 12345;
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < iters; i++) {
    let num = 0;
    let den = 0;
    for (let k = 0; k < sample.length; k++) {
      const r = sample[(rnd() * sample.length) | 0];
      const w = r.slope * r.slope * r.x;
      num += w * r.excess;
      den += w * w;
    }
    const c2 = den > 0 ? num / den : 0;
    cs.push(c2 > 0 ? Math.sqrt(c2) : 0);
  }
  cs.sort((a, b) => a - b);
  return { lo: cs[Math.floor(iters * 0.025)], hi: cs[Math.floor(iters * 0.975)] };
}

const ci = bootstrapC(rows);
console.log(
  `C global: ${all.c.toFixed(0)} Elo   IC 95 % [${ci.lo.toFixed(0)}, ${ci.hi.toFixed(0)}]` +
    `     (en el código: 240)`,
);
console.log(
  240 >= ci.lo && 240 <= ci.hi
    ? '  → 240 CAE DENTRO del intervalo: la medida no lo desmiente, no se toca.'
    : '  → 240 queda FUERA del intervalo.',
);

// ¿Es plana la forma C/√(n+1)? Si C se mueve mucho con n, el problema no es el valor
// sino la fórmula.
console.log('\nPor partidos jugados del equipo con menos (mismo C esperado en todos):');
const bands: [string, (r: Row) => boolean][] = [
  ['0–4', (r) => r.minMatches <= 4],
  ['5–9', (r) => r.minMatches >= 5 && r.minMatches <= 9],
  ['10–19', (r) => r.minMatches >= 10 && r.minMatches <= 19],
  ['20–39', (r) => r.minMatches >= 20 && r.minMatches <= 39],
  ['40+', (r) => r.minMatches >= 40],
];
for (const [label, pred] of bands) {
  const f = fitC(rows.filter(pred));
  console.log(`  ${label.padEnd(7)} n=${String(f.n).padStart(6)}   C ≈ ${f.c.toFixed(0)}`);
}

// ===========================================================================
// LA PRUEBA QUE NO DEPENDE DE LA REGRESIÓN
// ===========================================================================
// La regresión estima C; esto comprueba si el C estimado DESCRIBE los datos mejor
// que el 240 del código, y en la magnitud que de verdad se publica. Para cada tramo
// de partidos jugados se compara el error cuadrático medio observado contra el que
// predice cada valor de C. El que quede más cerca es el que describe el archivo.
console.log('\nError cuadrático medio observado vs. el que predice cada C:');
console.log('  partidos      observado   con C=240   con C medido');
for (const [label, pred] of bands) {
  const sample = rows.filter(pred);
  if (sample.length === 0) continue;
  const obs = sample.reduce((a, r) => a + r.excess, 0) / sample.length;
  const pre = (c: number) =>
    sample.reduce((a, r) => a + r.slope * r.slope * r.x * c * c, 0) / sample.length;
  console.log(
    `  ${label.padEnd(9)} ${obs.toFixed(5).padStart(12)} ${pre(240).toFixed(5).padStart(11)} ` +
      `${pre(all.c).toFixed(5).padStart(14)}`,
  );
}

console.log('\nPor liga:');
for (const l of footballConfig.leagues) {
  const f = fitC(rows.filter((r) => r.league === l.id));
  if (f.n < 300) continue;
  console.log(`  ${l.id.padEnd(13)} n=${String(f.n).padStart(6)}   C ≈ ${f.c.toFixed(0)}`);
}

// Qué significa el cambio donde se nota: la banda publicada de un partido típico.
console.log('\nEfecto en la banda publicada (dos equipos con los mismos partidos):');
console.log('  partidos   ±pp con C=240   ±pp con C medido');
for (const n of [0, 5, 10, 20, 38, 76]) {
  const x = 2 / (n + 1);
  // p = 0.5 es el caso de máxima pendiente: la banda más ancha que se puede publicar.
  const slope = (Math.LN10 * 0.25) / 400;
  const pp = (c: number) => Math.min(Math.sqrt(c * c * x) * slope * 100, 25).toFixed(1);
  console.log(`  ${String(n).padStart(8)}   ${pp(240).padStart(13)}   ${pp(all.c).padStart(15)}`);
}
getDb();
