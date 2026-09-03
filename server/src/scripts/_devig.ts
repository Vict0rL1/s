// ¿Qué método de quitar el margen da probabilidades más ciertas?
//
// ===========================================================================
// POR QUÉ ESTE CONJUNTO DE DATOS Y NO OTRO
// ===========================================================================
// Para comparar métodos hacen falta tres cosas a la vez: cuotas REALES de una casa,
// el resultado de lo que se apostaba, y suficientes partidos. En este proyecto eso
// solo lo cumple una tabla: `naf_games` guarda el moneyline de CIERRE de la NFL desde
// 2006 — 5.295 partidos. El fútbol tiene las columnas de cuotas vacías y el tenis
// tampoco las tiene aquí.
//
// El moneyline es además el caso limpio: dos resultados, sin empate que repartir
// (un empate anula la apuesta), así que lo que se mide es el reparto del margen y
// nada más.
//
// ===========================================================================
// CÓMO SE PUNTÚA
// ===========================================================================
// Log loss, que es lo que pide la pregunta: es la regla de puntuación propia que
// castiga la confianza equivocada, y quitar mal el margen se manifiesta exactamente
// como confianza mal repartida.
//
// Se mira además POR TRAMO DE CUOTA, porque ahí es donde los métodos se diferencian:
// si el sesgo favorito–perdedor es real, el multiplicativo tiene que quedarse corto
// en las cuotas altas y ahí es donde Shin debe ganar. Un método que gane en el
// agregado pero por las razones equivocadas no es una mejora, es una casualidad.
//
// Y se incluye el método de POTENCIA, que nadie pidió, como control: si Shin gana,
// hay que poder distinguir «gana por ser Shin» de «gana cualquier cosa que no sea
// proporcional».

import { getDb } from '../db.ts';
import { devigMultiplicative, devigShin, devigPower, americanToDecimal } from '../market/devig.ts';

interface Game {
  oddsHome: number;
  oddsAway: number;
  /** 1 si ganó el local, 0 si el visitante. Los empates quedan fuera. */
  homeWon: number;
}

const db = getDb();
const rows = db
  .prepare(
    `SELECT home_points, away_points, close_ml_home, close_ml_away, season
     FROM naf_games
     WHERE close_ml_home IS NOT NULL AND close_ml_away IS NOT NULL
       AND home_points IS NOT NULL AND away_points IS NOT NULL
     ORDER BY game_date`,
  )
  .all() as unknown as {
  home_points: number;
  away_points: number;
  close_ml_home: number;
  close_ml_away: number;
  season: number;
}[];

const games: (Game & { season: number })[] = [];
for (const r of rows) {
  // Un moneyline se anula en caso de empate: el mercado no le pone precio, así que
  // incluirlo sería puntuar una predicción sobre algo que no se predecía.
  if (r.home_points === r.away_points) continue;
  games.push({
    oddsHome: americanToDecimal(r.close_ml_home),
    oddsAway: americanToDecimal(r.close_ml_away),
    homeWon: r.home_points > r.away_points ? 1 : 0,
    season: r.season,
  });
}

console.log(`${games.length.toLocaleString('es')} partidos de NFL con moneyline de cierre real`);
const ov = games.map((g) => 1 / g.oddsHome + 1 / g.oddsAway);
const meanOv = ov.reduce((a, b) => a + b, 0) / ov.length;
console.log(
  `margen medio del libro: ${((meanOv - 1) * 100).toFixed(2)} %  ` +
    `(mínimo ${((Math.min(...ov) - 1) * 100).toFixed(2)} %, máximo ${((Math.max(...ov) - 1) * 100).toFixed(2)} %)\n`,
);

type Method = { name: string; fn: (odds: number[]) => { probs: number[]; z: number } };
const METHODS: Method[] = [
  { name: 'multiplicativo', fn: devigMultiplicative },
  { name: 'Shin', fn: devigShin },
  { name: 'potencia', fn: devigPower },
];

/** Log loss y Brier de un método sobre un subconjunto. */
function score(method: Method, sample: Game[]): { ll: number; brier: number; n: number } {
  let ll = 0;
  let brier = 0;
  for (const g of sample) {
    const p = method.fn([g.oddsHome, g.oddsAway]).probs[0];
    // Acotado para que un 0 exacto no dé infinito. Con cuotas reales no pasa, pero
    // una métrica que puede explotar no es una métrica.
    const q = Math.min(Math.max(p, 1e-9), 1 - 1e-9);
    ll -= g.homeWon * Math.log(q) + (1 - g.homeWon) * Math.log(1 - q);
    brier += (p - g.homeWon) ** 2;
  }
  return { ll: ll / sample.length, brier: brier / sample.length, n: sample.length };
}

console.log('GLOBAL');
console.log('  método            log loss     Brier');
const baseline = score(METHODS[0], games);
for (const m of METHODS) {
  const s = score(m, games);
  const d = s.ll - baseline.ll;
  console.log(
    `  ${m.name.padEnd(16)} ${s.ll.toFixed(5)}   ${s.brier.toFixed(5)}` +
      (m === METHODS[0] ? '' : `   ${d >= 0 ? '+' : ''}${d.toFixed(5)} vs multiplicativo`),
  );
}

// La z de Shin, que es interpretable: la proporción de dinero informado que el
// modelo necesita suponer para explicar el margen observado.
const zs = games.map((g) => devigShin([g.oddsHome, g.oddsAway]).z);
zs.sort((a, b) => a - b);
console.log(
  `\nz de Shin (proporción de apostantes informados): mediana ${(zs[zs.length >> 1] * 100).toFixed(2)} %` +
    `, p90 ${(zs[Math.floor(zs.length * 0.9)] * 100).toFixed(2)} %`,
);

// ===========================================================================
// DONDE DE VERDAD SE DIFERENCIAN: POR TRAMO DE CUOTA
// ===========================================================================
console.log('\nPOR CUOTA DEL LOCAL (aquí es donde el sesgo favorito–perdedor vive)');
console.log('  tramo               n     multiplicativo        Shin       diferencia');
const bands: [string, (o: number) => boolean][] = [
  ['favorito fuerte <1.3', (o) => o < 1.3],
  ['favorito 1.3–1.7', (o) => o >= 1.3 && o < 1.7],
  ['parejo 1.7–2.3', (o) => o >= 1.7 && o < 2.3],
  ['no favorito 2.3–3.5', (o) => o >= 2.3 && o < 3.5],
  ['tapado >3.5', (o) => o >= 3.5],
];
for (const [label, pred] of bands) {
  const sample = games.filter((g) => pred(g.oddsHome));
  if (sample.length < 50) continue;
  const a = score(METHODS[0], sample);
  const b = score(METHODS[1], sample);
  const d = b.ll - a.ll;
  console.log(
    `  ${label.padEnd(20)} ${String(sample.length).padStart(5)}   ` +
      `${a.ll.toFixed(5)}   ${b.ll.toFixed(5)}   ${d >= 0 ? '+' : ''}${d.toFixed(5)}`,
  );
}

// ===========================================================================
// LA PRUEBA DEL MECANISMO: ¿crece la ventaja con el margen?
// ===========================================================================
// Los tres métodos reparten el MISMO margen de formas distintas, así que cuando no
// hay margen que repartir tienen que coincidir — y el cierre de la NFL tiene un
// 2,72 %, que es de los libros más apretados que existen. Si la diferencia global
// sale casi nula, la pregunta no es «¿da igual el método?» sino «¿da igual AQUÍ?».
//
// Esto lo separa: partiendo por margen del libro, la diferencia entre métodos tiene
// que crecer con él. Si crece, el mecanismo es real y solo pasa que este mercado no
// da margen para lucirse. Si no crece, la diferencia es ruido y da igual cuál se use.
console.log('\nPOR MARGEN DEL LIBRO');
console.log('  margen            n    multiplicativo       Shin    dif log loss   dif media |Δp|');
const margins: [string, (v: number) => boolean][] = [
  ['< 2 %', (v) => v < 0.02],
  ['2–3 %', (v) => v >= 0.02 && v < 0.03],
  ['3–4 %', (v) => v >= 0.03 && v < 0.04],
  ['≥ 4 %', (v) => v >= 0.04],
];
for (const [label, pred] of margins) {
  const sample = games.filter((g) => pred(1 / g.oddsHome + 1 / g.oddsAway - 1));
  if (sample.length < 50) continue;
  const a = score(METHODS[0], sample);
  const b = score(METHODS[1], sample);
  // Cuánto se separan las dos probabilidades publicadas, que es el tamaño del efecto
  // en la unidad que el lector ve en pantalla.
  const dp =
    sample.reduce(
      (acc, g) =>
        acc +
        Math.abs(
          devigShin([g.oddsHome, g.oddsAway]).probs[0] -
            devigMultiplicative([g.oddsHome, g.oddsAway]).probs[0],
        ),
      0,
    ) / sample.length;
  const d = b.ll - a.ll;
  console.log(
    `  ${label.padEnd(12)} ${String(sample.length).padStart(5)}   ${a.ll.toFixed(5)}   ` +
      `${b.ll.toFixed(5)}   ${d >= 0 ? '+' : ''}${d.toFixed(5)}      ${(dp * 100).toFixed(2)} pp`,
  );
}

// Y cuánto se separarían con el margen que de verdad tienen las cuotas de fútbol de
// esta app, que es el mercado donde se va a usar. No es una afirmación sobre cuál
// acierta más ahí —eso no se puede medir sin resultados con cuotas—, sino sobre
// cuánto depende la respuesta del método, que es lo que decide si la elección importa.
console.log('\nCUÁNTO SE SEPARAN LOS DOS MÉTODOS, según el margen (partido a partido)');
console.log('  margen del libro    |Δp| media   |Δp| máxima');
for (const v of [0.027, 0.05, 0.07, 0.1]) {
  let sum = 0;
  let max = 0;
  let n = 0;
  for (const g of games) {
    // Se reescala el libro real a un margen objetivo, manteniendo la forma: así el
    // reparto de favoritos y tapados es el de partidos de verdad y lo único que
    // cambia es cuánto margen hay que repartir.
    const cur = 1 / g.oddsHome + 1 / g.oddsAway;
    const k = (1 + v) / cur;
    const o = [g.oddsHome / k, g.oddsAway / k];
    const d = Math.abs(devigShin(o).probs[0] - devigMultiplicative(o).probs[0]);
    sum += d;
    max = Math.max(max, d);
    n++;
  }
  console.log(
    `  ${(v * 100).toFixed(1)} %`.padEnd(22) +
      `${((sum / n) * 100).toFixed(2)} pp` +
      `        ${(max * 100).toFixed(2)} pp`,
  );
}

// ===========================================================================
// CALIBRACIÓN: ¿pasa lo que dicen que pasa?
// ===========================================================================
console.log('\nCALIBRACIÓN (probabilidad dicha vs. veces que ocurrió)');
console.log('  tramo        n     multiplicativo        Shin        real');
const cuts = [0, 0.2, 0.35, 0.5, 0.65, 0.8, 1];
for (let i = 0; i < cuts.length - 1; i++) {
  const sample = games.filter((g) => {
    const p = devigMultiplicative([g.oddsHome, g.oddsAway]).probs[0];
    return p >= cuts[i] && p < cuts[i + 1];
  });
  if (sample.length < 50) continue;
  const mean = (fn: Method['fn']) =>
    sample.reduce((a, g) => a + fn([g.oddsHome, g.oddsAway]).probs[0], 0) / sample.length;
  const real = sample.reduce((a, g) => a + g.homeWon, 0) / sample.length;
  console.log(
    `  ${(cuts[i] * 100).toFixed(0)}–${(cuts[i + 1] * 100).toFixed(0)}%`.padEnd(14) +
      `${String(sample.length).padStart(5)}   ` +
      `${(mean(devigMultiplicative) * 100).toFixed(2)} %        ` +
      `${(mean(devigShin) * 100).toFixed(2)} %     ${(real * 100).toFixed(2)} %`,
  );
}

// ===========================================================================
// ¿AGUANTA FUERA DE MUESTRA?
// ===========================================================================
// Ninguno de los tres métodos ajusta parámetros sobre el histórico —z y k se
// resuelven partido a partido, solo con las cuotas de ESE partido—, así que en rigor
// todo esto ya es fuera de muestra. Partirlo por temporadas responde otra cosa: si la
// ventaja es estable o vive en un puñado de años.
console.log('\nPOR TEMPORADA (log loss: Shin − multiplicativo; negativo = Shin mejor)');
const seasons = [...new Set(games.map((g) => g.season))].sort();
let wins = 0;
const diffs: string[] = [];
for (const s of seasons) {
  const sample = games.filter((g) => g.season === s);
  const d = score(METHODS[1], sample).ll - score(METHODS[0], sample).ll;
  if (d < 0) wins++;
  diffs.push(`${s}:${d >= 0 ? '+' : ''}${d.toFixed(4)}`);
}
for (let i = 0; i < diffs.length; i += 5) console.log('  ' + diffs.slice(i, i + 5).join('  '));
console.log(`\n  Shin gana en ${wins} de ${seasons.length} temporadas.`);
getDb();
