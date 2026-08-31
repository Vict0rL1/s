// ¿Se gana cada feature su sitio? Log loss fuera de muestra, o fuera.
//
// ===========================================================================
// LA REGLA
// ===========================================================================
// Una feature existe si mejora el log loss FUERA DE MUESTRA. Si no, se borra. No
// vale que suene razonable, ni que la use todo el mundo, ni que la vista pinte bonita
// con ella.
//
// Log loss y no acierto: el acierto es una regla de puntuación impropia —se optimiza
// mintiendo hacia el favorito— y esta app publica probabilidades, no apuestas. Log
// loss castiga exactamente lo que hay que castigar, la confianza equivocada.
//
// ===========================================================================
// QUÉ SIGNIFICA «FUERA DE MUESTRA» AQUÍ
// ===========================================================================
// Dos cosas distintas, y las dos hacen falta:
//
//   1. WALK-FORWARD por construcción. `replayMatches` es el mismo motor que usa la
//      app: cuando llega a un partido, los ratings solo han visto los anteriores.
//      Ningún partido se puntúa con información suya ni posterior.
//
//   2. TEMPORADAS RESERVADAS. Lo anterior no protege de la otra fuga, la de quien
//      elige los parámetros: si miro el agregado, ajusto, y vuelvo a mirar el
//      agregado, acabo ajustando al archivo entero. Así que se reporta también solo
//      2025–2026, las últimas temporadas, que es donde una feature sobreajustada se
//      cae.
//
// ===========================================================================
// CÓMO SE LEE LA TABLA
// ===========================================================================
// Cada fila apaga UNA cosa del modelo que se publica y enseña cuánto empeora. Un
// número POSITIVO significa que apagarla empeora, o sea que la feature sirve. Un
// número CERO O NEGATIVO significa que apagarla no duele o incluso ayuda: esa feature
// no se está ganando el sitio.
//
// Al revés para las candidatas nuevas: se encienden, y sirve si el log loss BAJA.

import {
  scoreDistribution,
  outcomeProbabilities,
  DIXON_COLES_RHO,
} from '../football/model.ts';
import { loadMatches, replayMatches, type ReplayOptions } from '../football/ratings.ts';
import { footballConfig } from '../config.ts';
import { getDb } from '../db.ts';

interface Result {
  ll: number;
  llRecent: number;
  n: number;
  nRecent: number;
  /**
   * El log loss de CADA partido reservado, en orden estable.
   *
   * Guardado partido a partido y no solo su media porque la pregunta «¿esta mejora se
   * distingue de cero?» solo se puede contestar EMPAREJANDO: las dos configuraciones
   * predicen los mismos partidos, así que casi toda la varianza es común y comparar
   * dos medias sueltas la cuenta entera como si fuera ruido de la diferencia. Con la
   * diferencia por partido, esa varianza común se cancela.
   */
  perMatch: number[];
}

/** Todas las ligas con historial, en una pasada. */
const LEAGUES = footballConfig.leagues.map((l) => l.id);

/**
 * Log loss del modelo a tres bandas bajo una configuración.
 *
 * El calentamiento no es cosmético: los primeros partidos de cada equipo los predice
 * un Elo de 1500 puesto por defecto, y esa parte es igual para TODAS las
 * configuraciones. Incluirla mete ruido común que aplasta las diferencias que se
 * quieren medir, que es justo lo contrario de lo que hace falta.
 */
function evaluate(opts: ReplayOptions, warmup = 10): Result {
  let ll = 0;
  let n = 0;
  let llRecent = 0;
  let nRecent = 0;
  const perMatch: number[] = [];
  for (const league of LEAGUES) {
    const matches = loadMatches(league as never, 0);
    if (matches.length === 0) continue;
    replayMatches(matches, {
      ...opts,
      onMatch: ({ match, home, away, lambda }) => {
        if (home.matches < warmup || away.matches < warmup) return;
        const p = outcomeProbabilities(scoreDistribution(lambda.home, lambda.away, DIXON_COLES_RHO));
        const actual =
          match.home_goals > match.away_goals
            ? p.home
            : match.home_goals === match.away_goals
              ? p.draw
              : p.away;
        const q = Math.min(Math.max(actual, 1e-9), 1);
        ll -= Math.log(q);
        n++;
        if (Number(match.season) >= 2025) {
          llRecent -= Math.log(q);
          nRecent++;
          perMatch.push(-Math.log(q));
        }
      },
    });
  }
  return { ll: ll / n, llRecent: llRecent / nRecent, n, nRecent, perMatch };
}


/**
 * ¿La diferencia emparejada se distingue de cero?
 *
 * Bootstrap sobre las diferencias por partido. Se hace con el conjunto RESERVADO y
 * solo después de haber elegido el parámetro con el otro, que es lo que hace que el
 * intervalo signifique algo.
 *
 * Devuelve el intervalo del 95 % de la diferencia media (b − a): si contiene el cero,
 * no hay mejora que defender por muy bonito que sea el punto estimado.
 */
function pairedCI(a: number[], b: number[]): { mean: number; lo: number; hi: number } {
  const d = a.map((x, i) => b[i] - x);
  const mean = d.reduce((s, x) => s + x, 0) / d.length;
  let seed = 987654321;
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const means: number[] = [];
  for (let i = 0; i < 400; i++) {
    let s = 0;
    for (let k = 0; k < d.length; k++) s += d[(rnd() * d.length) | 0];
    means.push(s / d.length);
  }
  means.sort((x, y) => x - y);
  return { mean, lo: means[10], hi: means[389] };
}

const base = evaluate({});
console.log(
  `Base: ${base.n.toLocaleString('es')} partidos · log loss ${base.ll.toFixed(5)}` +
    `   ·   2025–26: ${base.nRecent.toLocaleString('es')} partidos, ${base.llRecent.toFixed(5)}\n`,
);

function row(label: string, opts: ReplayOptions): void {
  const r = evaluate(opts);
  const d = r.ll - base.ll;
  const dr = r.llRecent - base.llRecent;
  const verdict = d > 0.0005 ? 'sirve' : d < -0.0005 ? '← ESTORBA' : 'no aporta';
  console.log(
    `  ${label.padEnd(34)} ${(d >= 0 ? '+' : '') + d.toFixed(5)}   ` +
      `${(dr >= 0 ? '+' : '') + dr.toFixed(5)}   ${verdict}`,
  );
}

console.log('APAGANDO LO QUE YA ESTÁ  (positivo = apagarlo empeora = la feature sirve)');
console.log('  feature                             todo      2025–26   veredicto');
row('sin decay entre temporadas', { carryover: 1 });
row('sin margen de victoria', { goalWeight: 0 });
row('sin ataque/defensa por equipo', { strengthAlpha: 0 });
row('sin forma reciente', { momentumWeight: 0 });
row('sin descanso / congestión', { restWeight: 0 });
row('sin ancla de goles móvil', { anchorAlpha: 0 });

// ===========================================================================
// EL DECAY, ELEGIDO SIN MIRAR EL EXAMEN
// ===========================================================================
// Aquí es donde un barrido se convierte en sobreajuste sin darse cuenta. Si miro las
// dos columnas, elijo la mejor y luego cito la segunda como «fuera de muestra», estoy
// citando un número que YA usé para elegir. Deja de ser fuera de muestra en el momento
// en que lo miro.
//
// Así que la elección se hace SOLO con las temporadas hasta 2024, y 2025–26 no se
// toca hasta que el valor ya está decidido. La segunda columna es entonces lo que
// dice ser: qué pasó en partidos que no participaron en la decisión.
console.log('\nEL DECAY ENTRE TEMPORADAS  (1 = sin decay; se publica 0.85)');
console.log('  carryover        hasta 2024 (decide)   2025–26 (reservado)');
let bestC = 0;
let bestTrain = Infinity;
const decayRows: [number, number, number][] = [];
for (const c of [0.7, 0.75, 0.8, 0.85, 0.9, 0.92, 0.95, 0.98, 1]) {
  const r = evaluate({ carryover: c });
  // El log loss de las temporadas de entrenamiento sale del total y del reservado:
  // total·n = train·nTrain + recent·nRecent.
  const nTrain = r.n - r.nRecent;
  const train = (r.ll * r.n - r.llRecent * r.nRecent) / nTrain;
  decayRows.push([c, train, r.llRecent]);
  if (train < bestTrain) {
    bestTrain = train;
    bestC = c;
  }
}
const baseTrain = (base.ll * base.n - base.llRecent * base.nRecent) / (base.n - base.nRecent);
for (const [c, train, recent] of decayRows) {
  const mark = c === bestC ? '  ← elegido' : c === 0.85 ? '  (actual)' : '';
  console.log(
    `  ${String(c).padEnd(16)} ${(train - baseTrain >= 0 ? '+' : '') + (train - baseTrain).toFixed(5)}` +
      `              ${(recent - base.llRecent >= 0 ? '+' : '') + (recent - base.llRecent).toFixed(5)}${mark}`,
  );
}
// Y la pregunta que decide si se toca el código: ¿esa mejora se distingue de cero?
// El punto estimado por sí solo no vale — es del orden de 5 diezmilésimas.
const chosenRun = evaluate({ carryover: bestC });
const ci = pairedCI(base.perMatch, chosenRun.perMatch);
console.log(
  `\n  Elegido con datos hasta 2024: carryover = ${bestC}.` +
    `\n  En las ${base.nRecent.toLocaleString('es')} reservadas, diferencia emparejada contra 0.85:` +
    `\n    ${ci.mean.toFixed(5)} de log loss   IC 95 % [${ci.lo.toFixed(5)}, ${ci.hi.toFixed(5)}]`,
);
console.log(
  ci.hi < 0
    ? '    → el intervalo entero por debajo de cero: la mejora es real, se cambia.'
    : ci.lo > 0
      ? '    → empeora de forma significativa: no se toca.'
      : '    → el intervalo CONTIENE el cero: no hay mejora que defender, se deja 0.85.',
);

console.log('\nEL DESCANSO, BARRIDO  (Elo perdidos con la peor congestión)');
console.log('  restWeight                          todo      2025–26');
for (const w of [0, 10, 20, 30, 40, 60]) {
  const r = evaluate({ restWeight: w });
  const d = r.ll - base.ll;
  const dr = r.llRecent - base.llRecent;
  console.log(
    `  ${String(w).padEnd(34)} ${(d >= 0 ? '+' : '') + d.toFixed(5)}   ` +
      `${(dr >= 0 ? '+' : '') + dr.toFixed(5)}`,
  );
}
// ===========================================================================
// CANDIDATAS QUE SE MIDIERON Y NO SE QUEDARON
// ===========================================================================
// El código de las dos está BORRADO, no comentado ni apagado con una constante a
// cero. Lo que queda es esto: qué se probó, con qué número salió y por qué no está.
// Sin la nota, dentro de seis meses alguien las vuelve a proponer; con el código
// dentro, el modelo carga con una rama muerta que hay que mantener y explicar.
//
// ---------------------------------------------------------------------------
// RD estilo Glicko — BORRADA
// ---------------------------------------------------------------------------
// Un rating no es un número, es un número con una desviación: dos equipos mal
// conocidos con el mismo hueco de Elo deberían dar una predicción más plana que dos
// bien conocidos. La RD no se inventó — se usó la σ(n) = 105/√(n+1) medida en
// `npm run study:sigma` más el término de inactividad, o sea la misma incertidumbre
// que la app ya publica como «± pp» en cada tarjeta. Encogía la diferencia de Elo por
// el factor g(RD) de Glicko.
//
//     peso    hasta 2024   2025–26
//     0.25     +0.00002    +0.00001
//     0.50     +0.00004    +0.00002
//     0.75     +0.00006    +0.00003
//     1.00     +0.00008    +0.00004
//
// Todos POSITIVOS y monótonos: cuanto más se aplica, peor. No hizo falta ni sacar el
// conjunto reservado, porque no había nada que llevar allí. La razón de que el efecto
// sea diminuto también es informativa: con el calentamiento de 10 partidos, casi
// todos los equipos tienen una RD pequeña y g ≈ 1, así que lo único que la feature
// llegaba a tocar eran los casos raros — y ahí los tocaba mal.
//
// ---------------------------------------------------------------------------
// Distancia de viaje — NO CONSTRUIDA
// ---------------------------------------------------------------------------
// Antes de meterla en el motor se hizo el cribado barato: ¿explica la distancia algo
// del error que el modelo YA comete? Sobre los 6.024 partidos con los dos estadios
// localizados, residuo del visitante por distancia:
//
//     < 50 km      539   +0.0345
//     50–150 km   1399   +0.0478
//     150–300 km  2490   +0.0365
//     300–500 km  1257   +0.0219
//     > 500 km     339   −0.0063
//
//     pendiente −0.0687 de puntuación por cada 1.000 km, error estándar 0.0327,
//     t = −2.10
//
// O sea que SÍ hay señal, y del orden de 48 Elo por cada 1.000 km. No se construyó de
// todas formas, y el motivo no es el t marginal: es la COBERTURA. La única fuente de
// coordenadas alcanzable desde aquí cubre 198 nombres y deja fuera cinco ligas
// enteras —Serie A, Serie B, Primeira, Eredivisie, Liga MX, Argentina, todas al 0 %—
// y llega al 21 % de los partidos del archivo. Los que cubre son los clubes grandes,
// así que la muestra donde se mediría está sesgada justo en la dirección que importa.
//
// Una feature que se aplica a un quinto de los partidos y se valida en un trozo
// sesgado no es una feature, es una inconsistencia que la app tendría que explicar en
// cada tarjeta. Para construirla hace falta una lista de estadios que cubra las 14
// ligas; con eso, el cribado dice que merece la pena volver.

getDb();
