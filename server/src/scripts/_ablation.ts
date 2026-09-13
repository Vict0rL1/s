// CLI: `npm run study:ablation [-- --from 2015 --boots 500]`
//
// ===========================================================================
// ¿SE GANA EL SITIO CADA PIEZA DEL MODELO DE TENIS?
// ===========================================================================
// El modelo de tenis es el buque insignia de esta app y, mirando el registro de
// experimentos, **no tenía ni uno solo registrado sobre predicción**: los 20 que había
// eran de fútbol y de la NFL. Sus parámetros están puestos —superficie 0,7, margen de
// victoria 4, calibración 0,68/0,86, forma, cara a cara, inactividad— y cada uno se
// midió en su momento, pero nada de eso pasó por el registro, por la corrección por
// comparaciones múltiples ni por un intervalo de confianza.
//
// Eso importa por una razón concreta: con seis piezas y sin corrección, el azar produce
// una «mejora significativa» cada tres estudios. Un modelo cuyas piezas se aceptaron una
// a una, cada una con su p<0,05, puede tener dos que no hagan nada.
//
// Así que esto las apaga UNA A UNA y mide cuánto empeora el log loss al quitarlas. La
// lectura es al revés de lo habitual y conviene tenerla clara:
//
//   quitarla EMPEORA mucho  → la pieza sirve, se queda (verdicto `shipped`)
//   quitarla no cambia nada → la pieza no aporta; se queda solo porque no estorba
//   quitarla MEJORA         → la pieza ESTORBA y habría que borrarla
//
// ===========================================================================
// CÓMO SE MIDE, Y POR QUÉ ASÍ
// ===========================================================================
// · WALK-FORWARD. Cada partido se predice con los ratings construidos SOLO con los
//   anteriores, y después se actualizan. Es el mismo recorrido que `npm run backtest`.
// · EMPAREJADO. Las dos configuraciones ven exactamente los mismos partidos, así que la
//   pregunta es la diferencia partido a partido, no dos medias comparadas de lejos.
// · BOOTSTRAP POR BLOQUES DE TORNEO. Los partidos de un mismo torneo no son
//   independientes: comparten superficie, bolas, altura y semana. Remuestrear partidos
//   sueltos trataría 30.000 observaciones como si fueran 30.000 casos independientes e
//   inflaría la significación. Se remuestrean TORNEOS enteros.
// · Y el resultado entra en el registro, donde `npm run experiments` le aplica Bonferroni
//   sobre la familia entera. Seis comparaciones sobre los mismos datos exigen un listón
//   seis veces más alto, y esa es exactamente la corrección que faltaba.

import { getDb } from '../db.ts';
import {
  calibratedExpectedScore,
  expectedScore,
  kFactor,
  surfaceKey,
  INITIAL_ELO,
  MOV_WEIGHT,
  movMultiplier,
  layoffAdjustment,
  calibrationScaleFor,
  REST_MAX_PENALTY,
} from '../model/elo.ts';
import { computeForm, type FormResult } from '../model/form.ts';
import { recordExperiment, bootstrapP } from '../experiments/registry.ts';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]?.startsWith('--') === false ? arr[i + 1] : 'true'] : null))
    .filter(Boolean) as [string, string][],
);
const FROM = args.from ?? '20150101';
const BOOTS = Number(args.boots) || 500;
const WARMUP = 20;

// Los valores publicados. Deben coincidir con model/predict.ts y con backtest.ts, y si
// alguno cambia allí, este estudio deja de medir el modelo que se sirve.
const SURFACE_WEIGHT = 0.7;
const H2H_MAX = 35;
const H2H_SHRINK = 4;

interface Cfg {
  surfaceWeight: number;
  movWeight: number;
  formWeight: number;
  h2hMax: number;
  restPenalty: number;
  /** null = la calibración por formato publicada; un número = uno solo para todo. */
  forcedScale: number | null;
}

const PUBLICADO: Cfg = {
  surfaceWeight: SURFACE_WEIGHT,
  movWeight: MOV_WEIGHT,
  formWeight: 1,
  h2hMax: H2H_MAX,
  restPenalty: REST_MAX_PENALTY,
  forcedScale: null,
};

interface State {
  overall: number;
  hard: number;
  clay: number;
  grass: number;
  nOverall: number;
  nHard: number;
  nClay: number;
  nGrass: number;
  recent: FormResult[];
  lastDate: string | null;
}
const fresh = (): State => ({
  overall: INITIAL_ELO,
  hard: INITIAL_ELO,
  clay: INITIAL_ELO,
  grass: INITIAL_ELO,
  nOverall: 0,
  nHard: 0,
  nClay: 0,
  nGrass: 0,
  recent: [],
  lastDate: null,
});

function daysBetween(from: string | null, to: string): number {
  if (!from || from.length < 8 || to.length < 8) return 0;
  const a = Date.UTC(+from.slice(0, 4), +from.slice(4, 6) - 1, +from.slice(6, 8));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(4, 6) - 1, +to.slice(6, 8));
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

interface Row {
  tourney_date: string;
  tourney_id: string | null;
  surface: string | null;
  winner_id: number;
  loser_id: number;
  score: string | null;
  best_of: number | null;
}

const db = getDb();
const rows = db
  .prepare(
    `SELECT tourney_date, tourney_id, surface, winner_id, loser_id, score, best_of
     FROM matches WHERE tour = 'atp' AND tourney_date >= ?
     ORDER BY tourney_date ASC, id ASC`,
  )
  .all(FROM) as unknown as Row[];

if (rows.length < 5000) {
  console.error(`Solo ${rows.length} partidos desde ${FROM}: muy pocos para medir esto.`);
  process.exit(1);
}

/**
 * Recorre el histórico con una configuración y devuelve el log loss de cada partido.
 *
 * Devuelve la SERIE, no la media: la media no permite un test emparejado, y sin test
 * emparejado una diferencia de 0,001 no se distingue del ruido.
 */
function replay(cfg: Cfg): { perMatch: number[]; bloque: string[] } {
  const states = new Map<number, State>();
  const h2h = new Map<string, { a: number; b: number }>();
  const get = (id: number): State => {
    let s = states.get(id);
    if (!s) {
      s = fresh();
      states.set(id, s);
    }
    return s;
  };
  const key = (x: number, y: number) => (x < y ? `${x}-${y}` : `${y}-${x}`);

  const perMatch: number[] = [];
  const bloque: string[] = [];

  for (const m of rows) {
    const w = get(m.winner_id);
    const l = get(m.loser_id);
    const sk = surfaceKey(m.surface);

    if (w.nOverall >= WARMUP && l.nOverall >= WARMUP) {
      const eff = (s: State) =>
        sk ? cfg.surfaceWeight * s[sk] + (1 - cfg.surfaceWeight) * s.overall : s.overall;
      const form = (s: State) => computeForm(s.recent).delta * cfg.formWeight;

      const k = key(m.winner_id, m.loser_id);
      const rec = h2h.get(k) ?? { a: 0, b: 0 };
      const lowIsWinner = Math.min(m.winner_id, m.loser_id) === m.winner_id;
      const wH = lowIsWinner ? rec.a : rec.b;
      const lH = lowIsWinner ? rec.b : rec.a;
      const tot = wH + lH;
      let h2hDelta = 0;
      if (tot > 0 && cfg.h2hMax > 0) {
        h2hDelta = (wH / tot - 0.5) * (cfg.h2hMax * 2) * (tot / (tot + H2H_SHRINK));
      }
      const layoff = (s: State) =>
        layoffAdjustment(daysBetween(s.lastDate, m.tourney_date), cfg.restPenalty);

      const adjW = eff(w) + form(w) + h2hDelta + layoff(w);
      const adjL = eff(l) + form(l) - h2hDelta + layoff(l);
      const scale = cfg.forcedScale ?? calibrationScaleFor(m.best_of);
      const p = calibratedExpectedScore(adjW, adjL, scale);

      perMatch.push(-Math.log(Math.max(p, 1e-15)));
      // El bloque del bootstrap: la EDICIÓN del torneo. Sin tourney_id se usa la
      // semana, que es la mejor aproximación disponible.
      bloque.push(m.tourney_id ?? m.tourney_date.slice(0, 6));
    }

    // ---- Actualización de ratings: idéntica en todas las configuraciones salvo el
    // margen de victoria, que es justo lo que una de ellas apaga. ----
    const mov = cfg.movWeight === 0 ? 1 : (movMultiplier(m.score, cfg.movWeight) ?? 1);
    const eW = expectedScore(w.overall, l.overall);
    const kW = kFactor(w.nOverall) * mov;
    const kL = kFactor(l.nOverall) * mov;
    w.overall += kW * (1 - eW);
    l.overall -= kL * (1 - eW);
    w.nOverall++;
    l.nOverall++;
    if (sk) {
      const nW = sk === 'hard' ? w.nHard : sk === 'clay' ? w.nClay : w.nGrass;
      const nL = sk === 'hard' ? l.nHard : sk === 'clay' ? l.nClay : l.nGrass;
      const eWs = expectedScore(w[sk], l[sk]);
      w[sk] += kFactor(nW) * mov * (1 - eWs);
      l[sk] -= kFactor(nL) * mov * (1 - eWs);
      if (sk === 'hard') {
        w.nHard++;
        l.nHard++;
      } else if (sk === 'clay') {
        w.nClay++;
        l.nClay++;
      } else {
        w.nGrass++;
        l.nGrass++;
      }
    }
    w.recent.unshift({ won: true, date: m.tourney_date } as FormResult);
    l.recent.unshift({ won: false, date: m.tourney_date } as FormResult);
    if (w.recent.length > 20) w.recent.length = 20;
    if (l.recent.length > 20) l.recent.length = 20;
    w.lastDate = m.tourney_date;
    l.lastDate = m.tourney_date;
    const k2 = key(m.winner_id, m.loser_id);
    const rec2 = h2h.get(k2) ?? { a: 0, b: 0 };
    if (Math.min(m.winner_id, m.loser_id) === m.winner_id) rec2.a++;
    else rec2.b++;
    h2h.set(k2, rec2);
  }
  return { perMatch, bloque };
}

/** mulberry32: el LCG ingenuo desborda 2^53 en float64 y sale sesgado. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Intervalo de la diferencia media, remuestreando TORNEOS enteros.
 *
 * `base` y `alt` vienen del mismo recorrido, así que el partido i es el mismo en las dos.
 */
function pairedCI(
  base: number[],
  alt: number[],
  bloques: string[],
): { mean: number; lo: number; hi: number; p: number } {
  const diff = alt.map((v, i) => v - base[i]);
  const mean = diff.reduce((a, b) => a + b, 0) / diff.length;

  const porBloque = new Map<string, number[]>();
  for (let i = 0; i < diff.length; i++) {
    const b = bloques[i];
    if (!porBloque.has(b)) porBloque.set(b, []);
    porBloque.get(b)!.push(diff[i]);
  }
  const grupos = [...porBloque.values()];
  const r = rng(20260913);
  const medias: number[] = [];
  for (let b = 0; b < BOOTS; b++) {
    let suma = 0;
    let n = 0;
    for (let i = 0; i < grupos.length; i++) {
      const g = grupos[Math.floor(r() * grupos.length)];
      for (const d of g) {
        suma += d;
        n++;
      }
    }
    medias.push(n > 0 ? suma / n : 0);
  }
  medias.sort((a, b) => a - b);
  return {
    mean,
    lo: medias[Math.floor(0.025 * medias.length)],
    hi: medias[Math.floor(0.975 * medias.length)],
    p: bootstrapP(medias),
  };
}

// ===========================================================================
console.log(`\nAblación del modelo de tenis · ATP desde ${FROM} · ${BOOTS} remuestreos\n`);
const base = replay(PUBLICADO);
const mediaBase = base.perMatch.reduce((a, b) => a + b, 0) / base.perMatch.length;
console.log(`Modelo publicado: log loss ${mediaBase.toFixed(5)} sobre ${base.perMatch.length} partidos`);

// ===========================================================================
// ESTA RÉPLICA TIENE QUE SER EL MODELO PUBLICADO, NO UNO PARECIDO
// ===========================================================================
// Todo lo que sigue compara contra esta línea base, así que si la réplica se desvía del
// modelo que se sirve, los seis resultados miden otra cosa — y lo harían en silencio,
// con la misma pinta de tabla seria.
//
// `npm run backtest` recorre el mismo histórico con el mismo warmup y publica 0.6151
// sobre 22.062 partidos. Esta réplica da lo mismo a cinco decimales, y eso es lo que
// permite creerse los NEGATIVOS: «la forma no aporta» solo significa algo si la forma
// que se apaga es la que está en producción.
//
// Si alguien cambia un parámetro del modelo y no lo trae aquí, esto falla en vez de
// publicar una ablación de un modelo que ya no existe.
const BACKTEST_PUBLICADO = 0.6151;
const desvio = Math.abs(mediaBase - BACKTEST_PUBLICADO);
if (desvio > 0.0002) {
  console.error(
    `\n✗ La réplica da ${mediaBase.toFixed(5)} y \`npm run backtest\` publica ` +
      `${BACKTEST_PUBLICADO}.\n\n` +
      '  Se han separado. O el modelo cambió y este estudio no se actualizó, o esta\n' +
      '  réplica tiene un fallo. En cualquiera de los dos casos las ablaciones de abajo\n' +
      '  medirían un modelo que no es el que se sirve, así que no se publican.\n',
  );
  process.exit(1);
}
console.log(`Coincide con \`npm run backtest\` (${BACKTEST_PUBLICADO}) · desvío ${desvio.toFixed(6)}`);
console.log(`Bloques de remuestreo (ediciones de torneo): ${new Set(base.bloque).size}\n`);

console.log(
  '  pieza apagada                      Δ log loss    IC 95 %                 p      veredicto',
);
console.log('  ' + '─'.repeat(94));

// Las hipótesis se redactan en el sentido en que se MIDEN: «quitar X empeora». Escritas
// al revés («X mejora»), la columna de dirección del registro —que lee el signo del
// delta— acababa imprimiendo «el margen de victoria mejora el log loss · EMPEORA», que
// es una frase que se contradice a sí misma y hace dudar del signo.
const PIEZAS: { label: string; hipotesis: string; cfg: Partial<Cfg> }[] = [
  {
    label: 'Elo por superficie',
    hipotesis: 'quitar el Elo por superficie empeora el log loss del ganador (tenis)',
    cfg: { surfaceWeight: 0 },
  },
  {
    label: 'margen de victoria',
    hipotesis: 'quitar el margen de victoria empeora el log loss del ganador (tenis)',
    cfg: { movWeight: 0 },
  },
  {
    label: 'forma reciente',
    hipotesis: 'quitar la forma reciente empeora el log loss del ganador (tenis)',
    cfg: { formWeight: 0 },
  },
  {
    label: 'cara a cara',
    hipotesis: 'quitar el ajuste por cara a cara empeora el log loss del ganador (tenis)',
    cfg: { h2hMax: 0 },
  },
  {
    label: 'penalización por inactividad',
    hipotesis: 'quitar la penalización por inactividad empeora el log loss del ganador (tenis)',
    cfg: { restPenalty: 0 },
  },
  {
    label: 'calibración por formato',
    hipotesis: 'usar un solo factor de calibración en vez de bo3/bo5 empeora el log loss (tenis)',
    cfg: { forcedScale: 0.75 },
  },
];

for (const pieza of PIEZAS) {
  const alt = replay({ ...PUBLICADO, ...pieza.cfg });
  const ci = pairedCI(base.perMatch, alt.perMatch, base.bloque);
  // Δ POSITIVO = quitarla empeora = la pieza sirve.
  const veredicto =
    ci.lo > 0 ? 'SIRVE' : ci.hi < 0 ? '← ESTORBA' : 'no se distingue de cero';
  console.log(
    `  ${pieza.label.padEnd(32)} ${(ci.mean >= 0 ? '+' : '') + ci.mean.toFixed(5)}   ` +
      `[${ci.lo >= 0 ? '+' : ''}${ci.lo.toFixed(5)}, ${ci.hi >= 0 ? '+' : ''}${ci.hi.toFixed(5)}]   ` +
      `${ci.p.toFixed(4)}   ${veredicto}`,
  );
  recordExperiment({
    hypothesis: pieza.hipotesis,
    dataset: { sport: 'tennis', split: 'validation', n: base.perMatch.length },
    features: Object.keys(pieza.cfg),
    hyperparams: pieza.cfg as Record<string, number | string | boolean>,
    metric: 'logloss',
    baseline: 'modelo publicado',
    result: { delta: ci.mean, ciLo: ci.lo, ciHi: ci.hi, p: ci.p, n: base.perMatch.length },
    // El delta es el de QUITAR la pieza. Si quitarla empeora de forma significativa
    // (intervalo entero por encima de cero), la pieza está justificada.
    verdict: ci.lo > 0 ? 'shipped' : ci.hi < 0 ? 'rejected' : 'inconclusive',
  });
}

console.log(
  '\n  Δ positivo = quitar la pieza EMPEORA = la pieza se gana el sitio.\n' +
    '  Δ negativo = quitarla MEJORA = la pieza estorba y habría que borrarla.\n' +
    `\n  Registrado. \`npm run experiments\` aplica Bonferroni sobre las ${PIEZAS.length}\n` +
    '  comparaciones: con seis sobre los mismos datos, el listón individual del 5 %\n' +
    '  deja pasar una «mejora» falsa cada tres estudios.\n',
);
