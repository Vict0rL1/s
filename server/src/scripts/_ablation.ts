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
  CALIBRATION_SCALE,
  CALIBRATION_SCALE_BO3,
  CALIBRATION_SCALE_BO5,
  REST_MAX_PENALTY,
} from '../model/elo.ts';
import { FORM_MAX_DELTA, type FormResult } from '../model/form.ts';
import { recordExperiment, bootstrapP } from '../experiments/registry.ts';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]?.startsWith('--') === false ? arr[i + 1] : 'true'] : null))
    .filter(Boolean) as [string, string][],
);
const FROM = args.from ?? '20150101';
const BOOTS = Number(args.boots) || 1000;

// ===========================================================================
// POCOS REMUESTREOS NO PUEDEN ENTRAR AL REGISTRO
// ===========================================================================
// El p del bootstrap tiene un SUELO: con B remuestreos, lo mínimo que puede salir es
// 2/(B+1). Con 200 eso es 0,00995 — por encima del listón de Bonferroni para seis
// comparaciones (0,00833)—, así que ningún resultado podría pasar la corrección por
// fuerte que fuera el efecto. Y con 100 el suelo sube a 0,0198, que además hace que
// piezas con efecto nulo salgan «significativas» al 5 % solo por llegar al suelo.
//
// Ya pasó: una pasada con 100 remuestreos marcó la forma reciente como SIRVE (p=0,0396)
// cuando con 1.000 sale en 0,1079. Un número peor medido del mismo efecto no es
// información adicional, es ruido con aspecto de dato.
const MIN_BOOTS_PARA_REGISTRAR = 500;
const WARMUP = 20;

// Los valores publicados. Deben coincidir con model/predict.ts y con backtest.ts, y si
// alguno cambia allí, este estudio deja de medir el modelo que se sirve.
const SURFACE_WEIGHT = 0.5;
const H2H_MAX = 35;
const H2H_SHRINK = 4;
// Estas dos están privadas en model/form.ts, así que se replican con su valor y la
// guarda de fidelidad se encarga de avisar si allí cambian.
const FORM_WINDOW = 10;
const FORM_DECAY = 0.85;

interface Cfg {
  surfaceWeight: number;
  movWeight: number;
  formWeight: number;
  h2hMax: number;
  restPenalty: number;
  /** null = la calibración por formato publicada; un número = uno solo para todo. */
  forcedScale: number | null;
  // ===========================================================================
  // LOS QUE NUNCA SE HABÍAN MEDIDO
  // ===========================================================================
  // Los cinco de arriba han pasado por la ablación. Estos cinco están puestos a mano
  // desde el primer día y nadie los ha tocado desde entonces — exactamente la situación
  // en la que estaba el peso de superficie antes de medirlo, que resultó estar mal y dar
  // una mejora real de 0,0019 al corregirlo. Un número elegido a ojo no es sospechoso
  // por ser redondo; es sospechoso por no haber sido medido nunca.
  /** Encogimiento del cara a cara: n/(n+k). Publicado k=4. */
  h2hShrink: number;
  /** Cuántos partidos entran en la forma reciente. Publicado 10. */
  formWindow: number;
  /** Peso que pierde cada partido al alejarse. Publicado 0,85. */
  formDecay: number;
  /** Tope en puntos Elo del ajuste por forma. Publicado 40. */
  formCap: number;
  /** Factor de calibración al mejor de 3. Publicado 0,68. */
  bo3Scale: number;
  /** Factor de calibración al mejor de 5. Publicado 0,86. */
  bo5Scale: number;
  // ===========================================================================
  // DOS SEÑALES QUE EL MODELO HOY NO VE
  // ===========================================================================
  // Los diez parámetros de arriba están en su óptimo: el barrido y la búsqueda conjunta
  // lo dicen, y volver a moverlos no puede dar nada. Lo único que queda para mejorar de
  // verdad es INFORMACIÓN NUEVA, y estas dos se pueden derivar de lo que ya hay guardado
  // sin descargar una sola fila más.
  //
  // Publicadas a CERO, que es como está el modelo hoy: así la réplica sigue dando
  // 0,61331 y la guarda de fidelidad puede comprobarlo. Un candidato que ya viniera
  // encendido en el punto de partida haría imposible medir cuánto aporta.
  /**
   * Castigo en puntos Elo por llegar de otra superficie.
   *
   * El tenis cambia de suelo tres veces al año y el ajuste tarda. Un jugador que sale de
   * la gira de tierra y juega su primer partido en hierba no es el mismo que uno que
   * lleva un mes en hierba, y el Elo por superficie NO lo capta: ese sabe lo bueno que
   * es en hierba en general, no que acaba de llegar.
   */
  surfaceSwitch: number;
  /**
   * Castigo en puntos Elo por partido jugado en los últimos 7 días, a partir del segundo.
   *
   * El modelo ya penaliza el exceso de DESCANSO (`restPenalty`, para vueltas de lesión)
   * y no tiene nada para lo contrario. En un Masters se juegan cinco partidos en siete
   * días, y el quinto no se juega con las piernas del primero.
   */
  fatiguePerMatch: number;
}

const PUBLICADO: Cfg = {
  surfaceWeight: SURFACE_WEIGHT,
  movWeight: MOV_WEIGHT,
  formWeight: 1,
  h2hMax: H2H_MAX,
  restPenalty: REST_MAX_PENALTY,
  forcedScale: null,
  h2hShrink: H2H_SHRINK,
  formWindow: FORM_WINDOW,
  formDecay: FORM_DECAY,
  formCap: FORM_MAX_DELTA,
  bo3Scale: CALIBRATION_SCALE_BO3,
  bo5Scale: CALIBRATION_SCALE_BO5,
  surfaceSwitch: 0,
  fatiguePerMatch: 0,
};

/**
 * La forma reciente, replicada aquí para poder barrer sus tres constantes.
 *
 * `computeForm` las tiene dentro y no las acepta como argumento, así que con ella no se
 * pueden medir. Esta réplica tiene que dar EXACTAMENTE lo mismo con los valores
 * publicados, y la guarda de fidelidad de más abajo es lo que lo comprueba: si se
 * separan, el estudio aborta en vez de medir un modelo que no se sirve.
 */
function formaDelta(recent: FormResult[], window: number, decay: number, cap: number): number {
  const w = recent.slice(0, window);
  if (w.length === 0) return 0;
  let weightedWins = 0;
  let weightTotal = 0;
  w.forEach((r, i) => {
    const peso = Math.pow(decay, i);
    if (r.won) weightedWins += peso;
    weightTotal += peso;
  });
  const tasa = weightTotal > 0 ? weightedWins / weightTotal : 0.5;
  const raw = (tasa - 0.5) * (cap * 2);
  return Math.min(cap, Math.max(-cap, raw));
}

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
  /** La superficie del partido anterior, para saber si acaba de cambiar. */
  lastSurface: string | null;
  /** Fechas de los últimos partidos, para contar la carga reciente. */
  recentDates: string[];
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
  lastSurface: null,
  recentDates: [],
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
function replay(cfg: Cfg): { perMatch: number[]; bloque: string[]; fecha: string[] } {
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
  const fecha: string[] = [];

  for (const m of rows) {
    const w = get(m.winner_id);
    const l = get(m.loser_id);
    const sk = surfaceKey(m.surface);

    if (w.nOverall >= WARMUP && l.nOverall >= WARMUP) {
      const eff = (s: State) =>
        sk ? cfg.surfaceWeight * s[sk] + (1 - cfg.surfaceWeight) * s.overall : s.overall;
      const form = (s: State) =>
        formaDelta(s.recent, cfg.formWindow, cfg.formDecay, cfg.formCap) * cfg.formWeight;

      const k = key(m.winner_id, m.loser_id);
      const rec = h2h.get(k) ?? { a: 0, b: 0 };
      const lowIsWinner = Math.min(m.winner_id, m.loser_id) === m.winner_id;
      const wH = lowIsWinner ? rec.a : rec.b;
      const lH = lowIsWinner ? rec.b : rec.a;
      const tot = wH + lH;
      let h2hDelta = 0;
      if (tot > 0 && cfg.h2hMax > 0) {
        h2hDelta = (wH / tot - 0.5) * (cfg.h2hMax * 2) * (tot / (tot + cfg.h2hShrink));
      }
      const layoff = (s: State) =>
        layoffAdjustment(daysBetween(s.lastDate, m.tourney_date), cfg.restPenalty);

      // ---- Las dos señales nuevas, ambas NEGATIVAS por construcción ----
      // Restan o no hacen nada; nunca suman. Un «castigo» que con un valor negativo se
      // convierte en premio mediría otra hipótesis distinta de la que se enunció, y el
      // barrido la encontraría encantado si la rejilla se lo permitiera.
      const cambioSuperficie = (s: State): number => {
        if (cfg.surfaceSwitch <= 0 || !sk || !s.lastSurface) return 0;
        // 21 días: más que eso y ya ha tenido tiempo de adaptarse, así que dejaría de
        // ser «viene de otra superficie» para ser «lleva parado», que es `restPenalty`.
        if (daysBetween(s.lastDate, m.tourney_date) > 21) return 0;
        return s.lastSurface === sk ? 0 : -cfg.surfaceSwitch;
      };
      const fatiga = (s: State): number => {
        if (cfg.fatiguePerMatch <= 0) return 0;
        const recientes = s.recentDates.filter(
          (d) => daysBetween(d, m.tourney_date) <= 7,
        ).length;
        // A partir del SEGUNDO: jugar un partido en una semana es lo normal y no cansa.
        return -Math.max(0, recientes - 1) * cfg.fatiguePerMatch;
      };

      const adjW = eff(w) + form(w) + h2hDelta + layoff(w) + cambioSuperficie(w) + fatiga(w);
      const adjL = eff(l) + form(l) - h2hDelta + layoff(l) + cambioSuperficie(l) + fatiga(l);
      const scale =
        cfg.forcedScale ??
        (m.best_of === 5 ? cfg.bo5Scale : m.best_of === 3 ? cfg.bo3Scale : CALIBRATION_SCALE);
      const p = calibratedExpectedScore(adjW, adjL, scale);

      perMatch.push(-Math.log(Math.max(p, 1e-15)));
      // El bloque del bootstrap: la EDICIÓN del torneo. Sin tourney_id se usa la
      // semana, que es la mejor aproximación disponible.
      bloque.push(m.tourney_id ?? m.tourney_date.slice(0, 6));
      fecha.push(m.tourney_date);
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
    // La superficie y la carga se actualizan SIEMPRE, también en los partidos que no se
    // puntúan por warmup: si solo se guardaran los puntuados, un jugador llegaría a su
    // primer partido evaluado con el historial de carga vacío.
    for (const s of [w, l]) {
      s.lastSurface = sk;
      s.recentDates.push(m.tourney_date);
      // Diez caben de sobra para una ventana de siete días y evitan que esto crezca sin
      // límite a lo largo de veinte años de partidos.
      if (s.recentDates.length > 10) s.recentDates.shift();
    }
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
  return { perMatch, bloque, fecha };
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
console.log(`\nAblación del modelo de tenis · ATP desde ${FROM} · ${BOOTS} remuestreos`);
if (BOOTS < MIN_BOOTS_PARA_REGISTRAR) {
  console.log(
    `  (por debajo de ${MIN_BOOTS_PARA_REGISTRAR} NO se registra: el suelo del p, 2/(B+1) = ` +
      `${(2 / (BOOTS + 1)).toFixed(4)}, deja la corrección de Bonferroni fuera de alcance)`,
  );
}
console.log('');
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
// `npm run backtest` recorre el mismo histórico con el mismo warmup y publica 0.6133
// sobre 22.062 partidos. Esta réplica da lo mismo a cinco decimales, y eso es lo que
// permite creerse los NEGATIVOS: «la forma no aporta» solo significa algo si la forma
// que se apaga es la que está en producción.
//
// Si alguien cambia un parámetro del modelo y no lo trae aquí, esto falla en vez de
// publicar una ablación de un modelo que ya no existe.
const BACKTEST_PUBLICADO = 0.6133;
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
  if (BOOTS < MIN_BOOTS_PARA_REGISTRAR) continue;
  recordExperiment({
    hypothesis: pieza.hipotesis,
    dataset: { sport: 'tennis', split: 'validation', n: base.perMatch.length },
    features: Object.keys(pieza.cfg),
    // El número de remuestreos ENTRA en la entrada. Sin él, dos medidas del mismo
    // efecto con distinta resolución son indistinguibles en el registro, y no hay forma
    // de decidir cuál vale cuando discrepan — que es exactamente lo que pasó al medir
    // esto con 100, 200 y 1.000.
    hyperparams: { ...pieza.cfg, boots: BOOTS } as Record<string, number | string | boolean>,
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

// ===========================================================================
// MODO BARRIDO: `npm run study:ablation -- --sweep`
// ===========================================================================
// La ablación contesta «¿sirve esta pieza?». El barrido contesta la siguiente: «¿está
// en su mejor valor?». Y tiene una trampa que hay que desactivar explícitamente.
//
// ELEGIR Y MEDIR SOBRE LOS MISMOS PARTIDOS NO VALE. Con siete valores probados sobre el
// mismo histórico, el mejor de los siete gana por una mezcla de efecto real y de ruido
// que le vino de cara, y su ventaja medida ahí es optimista SIEMPRE. Es el mismo
// mecanismo que hace que el mejor de seis experimentos parezca significativo sin serlo.
//
// Así que se parte por fecha: se elige en 2015–2022 y se MIDE en 2023 en adelante, que
// no participó en la elección. Si el ganador del primer periodo también gana en el
// segundo, la ventaja es del parámetro. Si no, era ruido — y eso también se publica.
if (args.sweep) {
  const CORTE = '20230101';
  console.log(`\n\nBarrido de parámetros · elige en <${CORTE} · mide en >=${CORTE}\n`);

  const media = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const partir = (r: { perMatch: number[]; fecha: string[] }) => {
    const eleccion: number[] = [];
    const prueba: number[] = [];
    for (let i = 0; i < r.perMatch.length; i++) {
      (r.fecha[i] < CORTE ? eleccion : prueba).push(r.perMatch[i]);
    }
    return { eleccion: media(eleccion), prueba: media(prueba), nPrueba: prueba.length };
  };

  const barridos: { nombre: string; valores: number[]; aplica: (v: number) => Partial<Cfg> }[] = [
    // Recentrado alrededor del 0,5 publicado, no del 0,7 antiguo: un barrido cuyo
    // óptimo cae en el borde de la rejilla no ha terminado de buscar.
    { nombre: 'peso de superficie', valores: [0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7], aplica: (v) => ({ surfaceWeight: v }) },
    { nombre: 'peso del margen de victoria', valores: [0, 2, 3, 4, 5, 6, 8], aplica: (v) => ({ movWeight: v }) },
    { nombre: 'tope del cara a cara', valores: [0, 15, 25, 35, 50, 70], aplica: (v) => ({ h2hMax: v }) },
    { nombre: 'penalización por inactividad', valores: [0, 30, 45, 60, 80, 110], aplica: (v) => ({ restPenalty: v }) },
    // Los cinco que nunca se habían medido.
    { nombre: 'encogimiento del cara a cara (k)', valores: [1, 2, 4, 6, 10, 16], aplica: (v) => ({ h2hShrink: v }) },
    { nombre: 'ventana de la forma', valores: [3, 5, 8, 10, 15, 20, 30], aplica: (v) => ({ formWindow: v }) },
    { nombre: 'decaimiento de la forma', valores: [0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1], aplica: (v) => ({ formDecay: v }) },
    { nombre: 'tope de la forma', valores: [0, 10, 20, 40, 60, 90], aplica: (v) => ({ formCap: v }) },
    { nombre: 'calibración al mejor de 3', valores: [0.58, 0.62, 0.65, 0.68, 0.71, 0.75, 0.8], aplica: (v) => ({ bo3Scale: v }) },
    { nombre: 'calibración al mejor de 5', valores: [0.74, 0.8, 0.86, 0.9, 0.94, 1], aplica: (v) => ({ bo5Scale: v }) },
    // Las dos señales nuevas. Empiezan en 0 —el modelo de hoy— así que el barrido mide
    // literalmente cuánto aporta encenderlas.
    { nombre: 'castigo por cambio de superficie', valores: [0, 5, 10, 20, 30, 45, 60], aplica: (v) => ({ surfaceSwitch: v }) },
    { nombre: 'fatiga por partido en 7 días', valores: [0, 2, 5, 8, 12, 18, 25], aplica: (v) => ({ fatiguePerMatch: v }) },
  ];

  for (const b of barridos) {
    console.log(`  ${b.nombre}`);
    console.log(`    ${'valor'.padEnd(8)} ${'elección'.padStart(10)} ${'prueba'.padStart(10)}`);
    const filas = b.valores.map((v) => {
      const r = replay({ ...PUBLICADO, ...b.aplica(v) });
      return { v, ...partir(r) };
    });
    const mejorEleccion = filas.reduce((a, x) => (x.eleccion < a.eleccion ? x : a));
    const mejorPrueba = filas.reduce((a, x) => (x.prueba < a.prueba ? x : a));
    const publicado = filas.find((x) => {
      const cfg = b.aplica(x.v);
      const k = Object.keys(cfg)[0] as keyof Cfg;
      return cfg[k] === PUBLICADO[k];
    });
    for (const f of filas) {
      const marcas =
        (f === mejorEleccion ? ' ←mejor en elección' : '') +
        (f === mejorPrueba ? ' ←mejor en prueba' : '') +
        (f === publicado ? ' (publicado)' : '');
      console.log(
        `    ${String(f.v).padEnd(8)} ${f.eleccion.toFixed(5).padStart(10)} ${f.prueba.toFixed(5).padStart(10)}${marcas}`,
      );
    }
    // ===========================================================================
    // EL CRITERIO, QUE LA PRIMERA VERSIÓN TENÍA MAL
    // ===========================================================================
    // Exigía que el ganador de la elección fuera TAMBIÉN el argmax de la prueba, y eso
    // descarta mejoras reales: cuando la curva es plana cerca del óptimo, cuál de dos
    // valores casi empatados sale primero en el segundo periodo es puro azar. Con el
    // peso de superficie descartó un 0,5 que mejora 0,0019 sobre el publicado porque en
    // prueba el argmax era 0,3 — y 0,3 y 0,5 se llevaban 0,00007 entre ellos.
    //
    // La pregunta correcta no es «¿es el mismo argmax?», es «el valor que elegí SIN VER
    // el segundo periodo, ¿le gana allí al publicado?». Eso es lo que mide una mejora
    // real, y es inmune a que dos valores vecinos se intercambien el primer puesto.
    const gananciaVsPublicado = publicado ? publicado.prueba - mejorEleccion.prueba : 0;
    if (!publicado) {
      console.log('    (el valor publicado no está en la lista barrida)');
    } else if (mejorEleccion === publicado) {
      console.log('    → el valor publicado ya es el mejor del barrido.');
    } else if (gananciaVsPublicado > 0.0005) {
      console.log(
        `    → CANDIDATO: ${mejorEleccion.v}, elegido sin ver el segundo periodo, mejora ` +
          `${gananciaVsPublicado.toFixed(5)} sobre el publicado (${publicado.v}) ALLÍ.` +
          (mejorEleccion !== mejorPrueba
            ? ` (El argmax de prueba es ${mejorPrueba.v}, a ${(mejorEleccion.prueba - mejorPrueba.prueba).toFixed(5)}: la curva es plana ahí.)`
            : ''),
      );
    } else {
      console.log(
        `    → sin candidato: ${mejorEleccion.v} gana al elegir pero solo mejora ` +
          `${gananciaVsPublicado.toFixed(5)} en prueba, por debajo del umbral de 0.0005.`,
      );
    }
    console.log('');
  }
}

// ===========================================================================
// VALIDAR UN CANDIDATO: `npm run study:ablation -- --candidato surfaceWeight=0.5`
// ===========================================================================
// El barrido propone; esto decide. Coge el candidato, lo compara contra el publicado
// SOLO en el periodo que no participó en la elección, y le aplica el mismo bootstrap
// emparejado por bloques de torneo que las ablaciones.
//
// Es un paso aparte y no el final del barrido a propósito: el barrido mira ocho valores
// y el mejor de ocho siempre parece bueno. Aquí hay UNA comparación, declarada de
// antemano, entre dos configuraciones concretas — que es la única forma de que el p
// signifique lo que dice.
if (typeof args.candidato === 'string') {
  const [clave, valorTexto] = args.candidato.split('=');
  const valor = Number(valorTexto);
  if (!(clave in PUBLICADO) || !Number.isFinite(valor)) {
    console.error(`\n✗ --candidato espera «clave=valor», con clave de: ${Object.keys(PUBLICADO).join(', ')}`);
    process.exit(1);
  }
  const CORTE = '20230101';
  const cfgCand = { ...PUBLICADO, [clave]: valor } as Cfg;
  const rBase = replay(PUBLICADO);
  const rCand = replay(cfgCand);

  // Solo el periodo de prueba. Los índices coinciden porque las dos configuraciones
  // puntúan exactamente los mismos partidos: el warmup no depende de ningún parámetro
  // barrido, así que las dos series están alineadas posición a posición.
  const idx: number[] = [];
  for (let i = 0; i < rBase.fecha.length; i++) if (rBase.fecha[i] >= CORTE) idx.push(i);
  if (rBase.perMatch.length !== rCand.perMatch.length) {
    console.error('\n✗ Las dos series no tienen la misma longitud: no se pueden emparejar.');
    process.exit(1);
  }
  const base2 = idx.map((i) => rBase.perMatch[i]);
  const cand2 = idx.map((i) => rCand.perMatch[i]);
  const bloq2 = idx.map((i) => rBase.bloque[i]);
  const media = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  // Ojo con el signo: aquí `alt` es el CANDIDATO, así que un delta NEGATIVO es una
  // mejora (menos log loss). Es al revés que en las ablaciones, donde `alt` era el
  // modelo mutilado. Se dice porque confundirlo invierte la conclusión entera.
  const ci = pairedCI(base2, cand2, bloq2);
  console.log(`\n\nCandidato ${clave} = ${valor} · medido SOLO en >=${CORTE}\n`);
  console.log(`  partidos:            ${idx.length}  (${new Set(bloq2).size} ediciones de torneo)`);
  console.log(`  publicado (${String(PUBLICADO[clave as keyof Cfg])}):      ${media(base2).toFixed(5)}`);
  console.log(`  candidato (${valor}):      ${media(cand2).toFixed(5)}`);
  console.log(`  diferencia:          ${ci.mean >= 0 ? '+' : ''}${ci.mean.toFixed(5)}  [${ci.lo.toFixed(5)}, ${ci.hi.toFixed(5)}]   p=${ci.p.toFixed(4)}`);
  const mejora = ci.hi < 0;
  console.log(
    mejora
      ? `\n  → MEJORA: el intervalo entero está por debajo de cero. Publicable.`
      : ci.lo > 0
        ? `\n  → EMPEORA: el candidato es peor. No se publica.`
        : `\n  → No se distingue de cero. No se publica: cambiar un parámetro publicado\n` +
          `    por una diferencia que no se distingue del ruido es moverlo por moverlo.`,
  );
  // ===========================================================================
  // ESTO ES VALIDACIÓN, NO HOLDOUT, Y LA DIFERENCIA NO ES DE VOCABULARIO
  // ===========================================================================
  // La primera versión registraba esto como `split: 'holdout'` y `npm run verify:data`
  // lo tumbó: «1 entradas sobre el holdout y ninguna apertura registrada». Tenía razón.
  // El holdout final de este proyecto (`experiments/holdout.ts`) está definido para
  // fútbol y NFL, se abre con `unlockFinalHoldout()` y esa apertura queda escrita. El
  // tenis no tiene ninguno.
  //
  // Lo que hay aquí es una separación TEMPORAL dentro de la validación: el valor se
  // elige mirando solo lo anterior a 2023 y se comprueba solo en lo posterior. Eso
  // basta para que la comprobación no esté contaminada por la elección —que es el
  // fallo que se quería evitar—, pero NO es un conjunto que se mire una sola vez, y
  // llamarlo holdout habría inflado lo que el número promete.
  recordExperiment({
    hypothesis: `${clave} = ${valor} mejora el log loss sobre el publicado (${String(PUBLICADO[clave as keyof Cfg])}) en tenis`,
    dataset: { sport: 'tennis', split: 'validation', n: idx.length },
    notes:
      `Separación temporal dentro de la validación: el valor se eligió mirando solo ` +
      `partidos anteriores a ${CORTE} y este número se mide solo en los posteriores. No es ` +
      `el holdout final del proyecto —el tenis no tiene— sino una comprobación no ` +
      `contaminada por la elección. Delta NEGATIVO = el candidato mejora.`,
    features: [clave],
    hyperparams: { [clave]: valor, boots: BOOTS, desde: CORTE },
    metric: 'logloss',
    baseline: `modelo publicado (${clave}=${String(PUBLICADO[clave as keyof Cfg])})`,
    result: { delta: ci.mean, ciLo: ci.lo, ciHi: ci.hi, p: ci.p, n: idx.length },
    verdict: mejora ? 'shipped' : ci.lo > 0 ? 'rejected' : 'inconclusive',
  });
}

// ===========================================================================
// MODO CONJUNTO: `npm run study:ablation -- --conjunto`
// ===========================================================================
// El barrido mueve un parámetro cada vez y ninguno solo llega al umbral. Eso no zanja
// la pregunta: varias mejoras de 0,0002 pueden sumar una de 0,0008, y una de 0,0008 sí
// se mide. Es una hipótesis distinta de las diez anteriores y merece su propia prueba.
//
// LO QUE HACE QUE ESTO NO SEA HACER TRAMPA
// ===========================================================================
// Buscar la mejor combinación entre cientos y luego medirla en los mismos partidos es
// la forma más rápida que existe de publicar ruido: con bastantes combinaciones, alguna
// gana por azar, y su ventaja medida ahí es optimista SIEMPRE.
//
// Así que la búsqueda entera —descenso por coordenadas, tantas pasadas como haga falta—
// ocurre SOLO sobre los partidos anteriores a 2023. El segundo periodo no participa en
// ninguna decisión: se mira UNA vez, al final, con la configuración ya cerrada. Si la
// combinación elegida a ciegas también gana allí, la ventaja es del modelo.
//
// Y el veredicto lo da el intervalo de confianza, no el signo de la diferencia. Con el
// intervalo cruzando el cero se publica «no se distingue», por bonita que sea la media.
if (args.conjunto) {
  const CORTE = '20230101';
  const media = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const soloEleccion = (r: { perMatch: number[]; fecha: string[] }) =>
    media(r.perMatch.filter((_, i) => r.fecha[i] < CORTE));

  // La misma rejilla del barrido. Un parámetro que no esté aquí no se toca, y eso es
  // deliberado: `formWeight` y `movWeight` a cero son ABLACIONES, no ajustes.
  const rejilla: { clave: keyof Cfg; nombre: string; valores: number[] }[] = [
    { clave: 'surfaceWeight', nombre: 'peso de superficie', valores: [0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7] },
    { clave: 'movWeight', nombre: 'peso del margen', valores: [2, 3, 4, 5, 6, 8] },
    { clave: 'h2hMax', nombre: 'tope cara a cara', valores: [15, 25, 35, 50, 70] },
    { clave: 'h2hShrink', nombre: 'encogimiento cara a cara', valores: [1, 2, 4, 6, 10, 16] },
    { clave: 'restPenalty', nombre: 'penalización inactividad', valores: [30, 45, 60, 80, 110] },
    { clave: 'formWindow', nombre: 'ventana de forma', valores: [3, 5, 8, 10, 15, 20, 30] },
    { clave: 'formDecay', nombre: 'decaimiento de forma', valores: [0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1] },
    { clave: 'formCap', nombre: 'tope de forma', valores: [10, 20, 40, 60, 90] },
    { clave: 'bo3Scale', nombre: 'calibración bo3', valores: [0.58, 0.62, 0.65, 0.68, 0.71, 0.75] },
    { clave: 'bo5Scale', nombre: 'calibración bo5', valores: [0.74, 0.8, 0.86, 0.9, 0.94, 1] },
  ];

  console.log(`\n\nBúsqueda conjunta · SOLO con partidos anteriores a ${CORTE}\n`);
  let actual: Cfg = { ...PUBLICADO };
  let mejor = soloEleccion(replay(actual));
  const base = mejor;
  console.log(`  punto de partida (el publicado): ${base.toFixed(5)}`);

  const PASADAS = 3;
  let evaluaciones = 1;
  for (let pasada = 1; pasada <= PASADAS; pasada++) {
    let cambio = false;
    for (const p of rejilla) {
      for (const v of p.valores) {
        if ((actual[p.clave] as number) === v) continue;
        const cand = { ...actual, [p.clave]: v } as Cfg;
        const s = soloEleccion(replay(cand));
        evaluaciones++;
        if (s < mejor - 1e-9) {
          mejor = s;
          actual = cand;
          cambio = true;
          console.log(`    pasada ${pasada}: ${p.nombre} → ${v}   ${s.toFixed(5)}`);
        }
      }
    }
    // Sin cambios en una pasada entera, otra pasada daría exactamente lo mismo.
    if (!cambio) {
      console.log(`  pasada ${pasada}: sin cambios, la búsqueda ha convergido.`);
      break;
    }
  }

  console.log(`\n  ${evaluaciones} configuraciones evaluadas, todas en el periodo de elección.`);
  console.log(`  elección: ${base.toFixed(5)} → ${mejor.toFixed(5)}  (mejora ${(base - mejor).toFixed(5)})`);
  const cambios = (Object.keys(PUBLICADO) as (keyof Cfg)[])
    .filter((k) => actual[k] !== PUBLICADO[k])
    .map((k) => `${k}: ${String(PUBLICADO[k])} → ${String(actual[k])}`);
  console.log(cambios.length ? `\n  Cambia: ${cambios.join(' · ')}` : '\n  No cambia nada.');

  if (cambios.length === 0) {
    console.log('\n  → El modelo publicado ya es el óptimo de esta rejilla. Nada que probar.\n');
  } else {
    // ===========================================================================
    // Y AHORA, POR PRIMERA VEZ, EL SEGUNDO PERIODO
    // ===========================================================================
    const rBase = replay(PUBLICADO);
    const rCand = replay(actual);
    const idx: number[] = [];
    for (let i = 0; i < rBase.fecha.length; i++) if (rBase.fecha[i] >= CORTE) idx.push(i);
    const b2 = idx.map((i) => rBase.perMatch[i]);
    const c2 = idx.map((i) => rCand.perMatch[i]);
    const bl2 = idx.map((i) => rBase.bloque[i]);
    const ci = pairedCI(b2, c2, bl2);

    console.log(`\n  Medido SOLO en >=${CORTE}, que no ha participado en nada de lo anterior:\n`);
    console.log(`    partidos:      ${idx.length}  (${new Set(bl2).size} ediciones de torneo)`);
    console.log(`    publicado:     ${media(b2).toFixed(5)}`);
    console.log(`    conjunto:      ${media(c2).toFixed(5)}`);
    console.log(
      `    diferencia:    ${ci.mean >= 0 ? '+' : ''}${ci.mean.toFixed(5)}  ` +
        `[${ci.lo.toFixed(5)}, ${ci.hi.toFixed(5)}]   p=${ci.p.toFixed(4)}`,
    );
    const mejora = ci.hi < 0;
    console.log(
      mejora
        ? '\n    → MEJORA CONCLUYENTE: el intervalo entero por debajo de cero. Publicable.'
        : ci.lo > 0
          ? '\n    → EMPEORA en el periodo que no vio. La búsqueda encontró ruido.'
          : '\n    → NO CONCLUYENTE: el intervalo cruza el cero. La mejora de la elección no\n' +
            '      se sostiene fuera, así que no se publica — cambiar diez parámetros por una\n' +
            '      diferencia que no se distingue del ruido es moverlos por moverlos.',
    );
    if (BOOTS >= MIN_BOOTS_PARA_REGISTRAR) {
      recordExperiment({
        hypothesis:
          'la mejor combinación conjunta de los 10 parámetros mejora el log loss sobre el publicado (tenis)',
        dataset: { sport: 'tennis', split: 'validation', n: idx.length },
        features: rejilla.map((r) => String(r.clave)),
        hyperparams: { boots: BOOTS, desde: CORTE, evaluaciones, cambios: cambios.length },
        metric: 'logloss',
        baseline: 'modelo publicado',
        notes:
          `Descenso por coordenadas (${PASADAS} pasadas máximo, ${evaluaciones} configuraciones) ` +
          `sobre partidos ANTERIORES a ${CORTE}; el periodo posterior no participó en ninguna ` +
          `decisión y se miró una sola vez. Cambios elegidos: ${cambios.join(' · ')}. ` +
          'Delta NEGATIVO = el conjunto mejora.',
        result: { delta: ci.mean, ciLo: ci.lo, ciHi: ci.hi, p: ci.p, n: idx.length },
        verdict: mejora ? 'shipped' : ci.lo > 0 ? 'rejected' : 'inconclusive',
      });
      console.log('\n    Registrado en experiments/registry.jsonl.');
    }
    console.log('');
  }
}
