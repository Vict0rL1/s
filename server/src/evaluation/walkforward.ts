// Walk-forward por periodos: el mismo backtest, contado periodo a periodo, contra
// baselines sencillos, y con la recalibración ajustada SOLO con el pasado.
//
// ===========================================================================
// LO QUE YA ERA TEMPORAL Y LO QUE NO
// ===========================================================================
// Los cinco backtests reproducen los partidos en orden y predicen cada uno con los ratings
// de ANTES de jugarlo: ningún rating futuro entra en una predicción. Eso ya estaba bien.
//
// Lo que no era temporal: las constantes globales (la escala de calibración del tenis, la
// curva margen→probabilidad de la NFL, las ventajas de campo) se ajustaron con todo el
// histórico y después se evaluaron sobre ese mismo histórico. Aquí no se re-ajusta el
// modelo —eso sería otro modelo—, pero se añade una pieza que sí es estrictamente
// temporal y que mide cuánto importa: una recalibración Platt (dos resultados) o de
// potencia (tres) ajustada al inicio de cada periodo con TODOS los partidos anteriores y
// ninguno posterior. Si la recalibrada gana periodo a periodo, la calibración global
// tenía un sesgo que el pasado ya mostraba; si no, la constante global no estaba
// escondiendo nada.
//
// ===========================================================================
// LOS BASELINES, Y POR QUÉ ASÍ DE SIMPLES
// ===========================================================================
//   Elo básico   K y ventaja de campo de manual (los de FiveThirtyEight para NBA, MLB y
//                NFL; K 32 sin campo en tenis; K 20 y 60 de campo en fútbol), sin margen
//                de victoria, sin superficie, sin forma, sin nada. Se calcula aquí, con
//                los mismos partidos en el mismo orden.
//   Campo        la frecuencia histórica de victorias locales (y de empates en fútbol),
//                con los partidos anteriores al que se predice.
//   Ranking ATP  tenis: logística sobre log(ranking rival / ranking propio), con su
//                pendiente ajustada al inicio de cada periodo con el pasado.
//   Mercado      la cuota de cierre sin margen, donde el histórico la tiene.
// Ninguno se ajusta con el periodo que se evalúa, ni con el holdout final.
//
// ===========================================================================
// ROI Y CLV
// ===========================================================================
// ROI: una unidad a la selección del modelo con ventaja ≥ la mínima de la política
// (DEFAULT_CONFIG.minEdge) contra la cuota de cierre histórica. Es la única cuota que
// tiene el histórico, y apostar al cierre es por definición CLV cero: el CLV histórico NO
// SE PUEDE CALCULAR con estos datos y aparece como null, no como 0.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.ts';
import { evaluate, type Informe, type Prediccion } from './metrics.ts';
import { DEFAULT_CONFIG } from '../staking/policy.ts';
import { versionsFor } from '../versions.ts';
import { isFinalHoldout, type EvaluationSport } from '../experiments/holdout.ts';
import type { SportId } from '../sports.ts';
import { roiDe } from './roi.ts';

/** Un partido del histórico, en orden. `modelo` es null en los de calentamiento. */
export interface Juego {
  /** YYYY-MM-DD o YYYYMMDD. */
  fecha: string;
  temporada?: number;
  /** Identificadores de los dos lados. `a` es el local cuando `local` es true. */
  a: string;
  b: string;
  local: boolean;
  /** Índice del resultado: [a, b] o [a, empate, b]. */
  y: number;
  K: 2 | 3;
  modelo: number[] | null;
  mercado?: number[] | null;
  cuotas?: number[] | null;
  /** Tenis: ranking oficial de cada lado al jugar. */
  rango?: { a: number | null; b: number | null };
  /** Contexto para segmentar (superficie, liga, descanso…). */
  segmento?: Record<string, string>;
  /** Régimen: pretemporada, inicio de temporada, regular, playoffs… */
  regimen?: string;
  /** Cuánto respaldo tiene la predicción (partidos del lado con menos historia). */
  profundidad?: number;
  /** Baselines publicados por terceros para ese partido (p. ej. FiveThirtyEight en la NBA). */
  externos?: Record<string, number[]>;
  /** Dos resultados y acabó en empate (NFL): no se puntúa, y el Elo básico lo cuenta como medio. */
  empate?: boolean;
  /** Fútbol: Pinnacle temprano y de cierre, mismo orden. Para el CLV del histórico de estrategias (Fase 6.1). */
  pinnacle?: { temprana: number[]; cierre: number[] } | null;
}

/** Elo básico de manual, por deporte. */
export const ELO_BASICO: Record<SportId, { k: number; campo: number }> = {
  tennis: { k: 32, campo: 0 },
  football: { k: 20, campo: 60 },
  basketball: { k: 20, campo: 100 },
  baseball: { k: 4, campo: 24 },
  nfl: { k: 20, campo: 65 },
  nhl: { k: 20, campo: 35 },
  ufc: { k: 32, campo: 0 },
};

/** El periodo de un partido. Distinto por deporte, porque sus calendarios lo son. */
export function periodoDe(sport: SportId, j: Pick<Juego, 'fecha' | 'temporada'>): string {
  const f = j.fecha.replace(/-/g, '');
  const anio = Number(f.slice(0, 4));
  const mes = Number(f.slice(4, 6));
  switch (sport) {
    case 'tennis':
      return `${anio}-T${Math.ceil(mes / 3)}`; // trimestres: la temporada es el año entero
    case 'football':
      // Medias temporadas europeas: agosto–diciembre y enero–julio.
      return mes >= 8 ? `${anio}/${String((anio + 1) % 100).padStart(2, '0')} ida` : `${anio - 1}/${String(anio % 100).padStart(2, '0')} vuelta`;
    case 'basketball':
      return mes >= 8 ? `${anio}/${String((anio + 1) % 100).padStart(2, '0')} oct–dic` : `${anio - 1}/${String(anio % 100).padStart(2, '0')} ene–jun`;
    case 'baseball':
      return mes <= 6 ? `${anio} mar–jun` : `${anio} jul–oct`;
    case 'nfl':
      return `${j.temporada ?? (mes >= 8 ? anio : anio - 1)}`;
    case 'nhl':
      // Medias temporadas: octubre–diciembre y enero–junio (con los playoffs).
      return mes >= 8 ? `${anio}/${String((anio + 1) % 100).padStart(2, '0')} oct–dic` : `${anio - 1}/${String(anio % 100).padStart(2, '0')} ene–jun`;
    case 'ufc':
      // Medio año: la UFC pelea todo el año, sin temporadas.
      return mes <= 6 ? `${anio} ene–jun` : `${anio} jul–dic`;
  }
}

const logit = (p: number) => Math.log(Math.max(p, 1e-9) / Math.max(1 - p, 1e-9));
const sigm = (x: number) => 1 / (1 + Math.exp(-x));

/** Platt (a + b·logit p) por Newton sobre el pasado. Dos resultados. */
export function ajustarPlatt(xs: { p: number; y: number }[]): { a: number; b: number } {
  let a = 0;
  let b = 1;
  for (let it = 0; it < 50; it++) {
    let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
    for (const x of xs) {
      const z = logit(x.p);
      const q = sigm(a + b * z);
      const r = q - x.y;
      const w = q * (1 - q);
      ga += r; gb += r * z;
      haa += w; hab += w * z; hbb += w * z * z;
    }
    const det = haa * hbb - hab * hab;
    if (!(Math.abs(det) > 1e-12)) break;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    a -= da; b -= db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  return { a, b };
}

/** Potencia (q_k ∝ p_k^t) por búsqueda en una rejilla fina. Tres resultados. */
export function ajustarPotencia(xs: { p: number[]; y: number }[]): number {
  const ll = (t: number) => {
    let s = 0;
    for (const x of xs) {
      const w = x.p.map((v) => Math.max(v, 1e-9) ** t);
      const z = w.reduce((u, v) => u + v, 0);
      s -= Math.log(w[x.y] / z);
    }
    return s;
  };
  let mejor = 1;
  let mejorLl = ll(1);
  for (let t = 0.5; t <= 2.0001; t += 0.01) {
    const v = ll(t);
    if (v < mejorLl) { mejorLl = v; mejor = t; }
  }
  return Math.round(mejor * 100) / 100;
}

const aplicarPotencia = (p: number[], t: number) => {
  const w = p.map((v) => Math.max(v, 1e-9) ** t);
  const z = w.reduce((u, v) => u + v, 0);
  return w.map((v) => v / z);
};

/** Mínimo de partidos pasados para ajustar la recalibración; por debajo, identidad. */
export const MIN_PASADO = 300;

export interface MetricasPeriodo {
  periodo: string;
  n: number;
  desde: string;
  hasta: string;
  modelo: Informe;
  /** El modelo con la recalibración ajustada SOLO con periodos anteriores. */
  recalibrado: Informe & { parametros: string };
  baselines: Record<string, Informe>;
  /** Sobre los partidos con precio: modelo contra mercado. */
  mercado: Informe | null;
  roi: { apuestas: number; roi: number | null; roiRecalibrado: number | null } | null;
  /** Siempre null: el histórico solo tiene la cuota de cierre (ver arriba). */
  clv: null;
}

export interface ResultadoWalkForward {
  sport: SportId;
  generado: string;
  model_version: string;
  data_version: string;
  /** Qué partidos se dejaron fuera por ser holdout final. */
  holdoutExcluido: number;
  ventanas: string;
  periodos: MetricasPeriodo[];
  /** Cuántos periodos gana el modelo a cada rival en log loss (sobre los mismos partidos). */
  resumen: Record<string, { periodos: number; ganaModelo: number; ganaRival: number }>;
  global: { modelo: Informe; recalibrado: Informe; baselines: Record<string, Informe>; mercado: Informe | null };
  porRegimen: Record<string, { n: number; modelo: Informe; mercado: Informe | null }>;
  porSegmento: Record<string, Record<string, { n: number; modelo: Informe; mercado: Informe | null }>>;
  cobertura: { cobertura: number; n: number; modelo: Informe; mercado: Informe | null }[];
  /**
   * Pérdidas por partido (modelo y recalibrado, mismo orden) de los tramos fuera de muestra,
   * para el bootstrap emparejado del experimento de recalibración (Fase 4.1). No se guarda
   * en el JSON: `guardarWalkForward` lo quita.
   */
  pares?: { modelo: number[]; recalibrado: number[] };
}

/** Segmentos con menos partidos que esto no se publican: serían ruido con etiqueta. */
export const MIN_SEGMENTO = 300;

/**
 * Reproduce el flujo, calcula los baselines con los partidos anteriores y puntúa cada
 * periodo. Los de calentamiento (`modelo` null) alimentan los baselines y no se puntúan.
 */
export function walkForward(sport: SportId, juegos: Juego[]): ResultadoWalkForward {
  const conHoldout = sport === 'football' || sport === 'nfl' || sport === 'nhl' || sport === 'ufc';
  const elo = new Map<string, number>();
  const cfg = ELO_BASICO[sport];
  let partidosCampo = 0;
  let resultadosCampo = [0, 0, 0];
  const puntuados: (Juego & { periodo: string; baselines: Record<string, number[]> })[] = [];
  let holdoutExcluido = 0;

  for (const j of juegos) {
    const ra = elo.get(j.a) ?? 1500;
    const rb = elo.get(j.b) ?? 1500;
    const campo = j.local ? cfg.campo : 0;
    const eA = 1 / (1 + 10 ** (-(ra + campo - rb) / 400));
    const enHoldout = conHoldout && j.temporada != null && isFinalHoldout(sport as EvaluationSport, j.temporada);
    if (enHoldout) holdoutExcluido++;
    if (j.modelo && !enHoldout && !j.empate) {
      const baselines: Record<string, number[]> = {};
      const fd = partidosCampo > 0 ? resultadosCampo.map((c) => c / partidosCampo) : null;
      if (j.K === 2) {
        baselines['Elo básico'] = [eA, 1 - eA];
        if (j.local && fd) baselines['Gana el local'] = [fd[0], 1 - fd[0]];
      } else {
        const d = fd ? fd[1] : 0.26;
        baselines['Elo básico'] = [(1 - d) * eA, d, (1 - d) * (1 - eA)];
        if (j.local && fd) baselines['Gana el local'] = fd;
      }
      Object.assign(baselines, j.externos ?? {});
      puntuados.push({ ...j, periodo: periodoDe(sport, j), baselines });
    }
    // Actualizar DESPUÉS de predecir.
    const sa = j.K === 3 ? (j.y === 0 ? 1 : j.y === 1 ? 0.5 : 0) : j.empate ? 0.5 : j.y === 0 ? 1 : 0;
    elo.set(j.a, ra + cfg.k * (sa - eA));
    elo.set(j.b, rb + cfg.k * (1 - sa - (1 - eA)));
    if (j.local && !j.empate) {
      partidosCampo++;
      if (j.K === 3) resultadosCampo[j.y]++;
      else resultadosCampo = [resultadosCampo[0] + (j.y === 0 ? 1 : 0), 0, resultadosCampo[2] + (j.y === 1 ? 1 : 0)];
    }
  }

  // Periodos en orden de aparición (el flujo es cronológico).
  const periodos = [...new Set(puntuados.map((j) => j.periodo))];
  const out: MetricasPeriodo[] = [];
  const recalTodos: Prediccion[] = [];
  const pares: { modelo: number[]; recalibrado: number[] } = { modelo: [], recalibrado: [] };
  let pasado: typeof puntuados = [];
  const minEdge = DEFAULT_CONFIG.minEdge;

  for (const per of periodos) {
    const xs = puntuados.filter((j) => j.periodo === per);
    // Recalibración con el pasado y solo el pasado.
    let recal: (p: number[]) => number[] = (p) => p;
    let parametros = 'identidad (menos de ' + MIN_PASADO + ' partidos anteriores)';
    if (pasado.length >= MIN_PASADO) {
      if (xs[0].K === 2) {
        const { a, b } = ajustarPlatt(pasado.map((j) => ({ p: (j.modelo as number[])[0], y: j.y === 0 ? 1 : 0 })));
        recal = (p) => {
          const q = sigm(a + b * logit(p[0]));
          return [q, 1 - q];
        };
        parametros = `Platt a=${a.toFixed(3)} b=${b.toFixed(3)} (con ${pasado.length} partidos anteriores)`;
      } else {
        const t = ajustarPotencia(pasado.map((j) => ({ p: j.modelo as number[], y: j.y })));
        recal = (p) => aplicarPotencia(p, t);
        parametros = `potencia t=${t.toFixed(2)} (con ${pasado.length} partidos anteriores)`;
      }
    }
    // Ranking ATP: pendiente ajustada con el pasado (un parámetro, sin intercepto).
    if (sport === 'tennis') {
      const conRango = pasado.filter((j) => j.rango?.a && j.rango?.b);
      const beta = conRango.length >= MIN_PASADO
        ? ajustarPlatt(conRango.map((j) => ({ p: sigm(Math.log((j.rango!.b as number) / (j.rango!.a as number))), y: j.y === 0 ? 1 : 0 }))).b
        : null;
      if (beta != null) {
        for (const j of xs) {
          if (j.rango?.a && j.rango?.b) {
            const q = sigm(beta * Math.log(j.rango.b / j.rango.a));
            j.baselines['Ranking ATP'] = [q, 1 - q];
          }
        }
      }
    }
    const pred = (j: Juego, p: number[]): Prediccion => ({ p, y: j.y, mercado: j.mercado ?? null });
    const modelo = evaluate('backtest', sport, xs.map((j) => pred(j, j.modelo as number[])));
    const recalXs = xs.map((j) => pred(j, recal(j.modelo as number[])));
    recalTodos.push(...recalXs);
    if (pasado.length >= MIN_PASADO) {
      for (let i = 0; i < xs.length; i++) {
        pares.modelo.push(-Math.log(Math.max((xs[i].modelo as number[])[xs[i].y], 1e-15)));
        pares.recalibrado.push(-Math.log(Math.max(recalXs[i].p[recalXs[i].y], 1e-15)));
      }
    }
    const baselines: Record<string, Informe> = {};
    for (const nombre of new Set(xs.flatMap((j) => Object.keys(j.baselines)))) {
      const con = xs.filter((j) => j.baselines[nombre]);
      baselines[nombre] = evaluate('backtest', sport, con.map((j) => pred(j, j.baselines[nombre])));
    }
    const conMercado = xs.filter((j) => j.mercado);
    const mercado = conMercado.length ? evaluate('backtest', sport, conMercado.map((j) => pred(j, j.mercado as number[]))) : null;

    // ROI contra la cuota de cierre histórica: una unidad a la mejor selección con ventaja.
    let roi: MetricasPeriodo['roi'] = null;
    const conCuotas = xs.filter((j) => j.cuotas && j.cuotas.every((o) => o > 1));
    if (conCuotas.length) {
      const apuesta = (p: number[], j: Juego) => {
        let mejor = -1;
        let ev = minEdge;
        (j.cuotas as number[]).forEach((o, k) => {
          const e = p[k] * o - 1;
          if (e >= ev) { ev = e; mejor = k; }
        });
        return mejor < 0 ? null : mejor === j.y ? (j.cuotas as number[])[mejor] - 1 : -1;
      };
      const r1 = conCuotas.map((j) => apuesta(j.modelo as number[], j)).filter((x): x is number => x != null);
      const r2 = conCuotas.map((j) => apuesta(recal(j.modelo as number[]), j)).filter((x): x is number => x != null);
      // Una unidad por apuesta: lo arriesgado es el número de apuestas.
      roi = {
        apuestas: r1.length,
        roi: roiDe(r1.reduce((u, v) => u + v, 0), r1.length),
        roiRecalibrado: roiDe(r2.reduce((u, v) => u + v, 0), r2.length),
      };
    }

    out.push({
      periodo: per,
      n: xs.length,
      desde: xs[0].fecha,
      hasta: xs[xs.length - 1].fecha,
      modelo,
      recalibrado: { ...evaluate('backtest', sport, recalXs), parametros },
      baselines,
      mercado,
      roi,
      clv: null,
    });
    pasado = pasado.concat(xs);
  }

  // Resumen: periodos ganados en log loss, SIEMPRE sobre los mismos partidos.
  const resumen: ResultadoWalkForward['resumen'] = {};
  const cuenta = (rival: string, gana: boolean | null) => {
    if (gana == null) return;
    const r = (resumen[rival] ??= { periodos: 0, ganaModelo: 0, ganaRival: 0 });
    r.periodos++;
    if (gana) r.ganaModelo++;
    else r.ganaRival++;
  };
  for (const per of periodos) {
    const xs = puntuados.filter((j) => j.periodo === per);
    const m = out.find((o) => o.periodo === per)!;
    cuenta('Recalibrado (solo pasado)', m.modelo.logLoss != null && m.recalibrado.logLoss != null ? m.modelo.logLoss < m.recalibrado.logLoss : null);
    for (const nombre of Object.keys(m.baselines)) {
      const con = xs.filter((j) => j.baselines[nombre]);
      const mod = evaluate('backtest', sport, con.map((j) => ({ p: j.modelo as number[], y: j.y })));
      cuenta(nombre, mod.logLoss != null && m.baselines[nombre].logLoss != null ? mod.logLoss < (m.baselines[nombre].logLoss as number) : null);
    }
    if (m.modelo.mercado) cuenta('Mercado (cierre)', m.modelo.mercado.modeloLogLoss < m.modelo.mercado.logLoss);
  }

  const todos = puntuados.map((j) => ({ p: j.modelo as number[], y: j.y, mercado: j.mercado ?? null }));
  const globalBaselines: Record<string, Informe> = {};
  for (const nombre of new Set(puntuados.flatMap((j) => Object.keys(j.baselines)))) {
    const con = puntuados.filter((j) => j.baselines[nombre]);
    globalBaselines[nombre] = evaluate('backtest', sport, con.map((j) => ({ p: j.baselines[nombre], y: j.y })));
  }
  const conMercado = puntuados.filter((j) => j.mercado);

  // Régimen y segmentos: solo con muestra suficiente.
  const agrupa = (clave: (j: Juego) => string | undefined) => {
    const g = new Map<string, Juego[]>();
    for (const j of puntuados) {
      const k = clave(j);
      if (k == null) continue;
      const xs = g.get(k) ?? [];
      xs.push(j);
      g.set(k, xs);
    }
    const r: Record<string, { n: number; modelo: Informe; mercado: Informe | null }> = {};
    for (const [k, xs] of g) {
      if (xs.length < MIN_SEGMENTO) continue;
      const cm = xs.filter((j) => j.mercado);
      r[k] = {
        n: xs.length,
        modelo: evaluate('backtest', sport, xs.map((j) => ({ p: j.modelo as number[], y: j.y, mercado: j.mercado ?? null }))),
        mercado: cm.length ? evaluate('backtest', sport, cm.map((j) => ({ p: j.mercado as number[], y: j.y }))) : null,
      };
    }
    return r;
  };
  const porSegmento: ResultadoWalkForward['porSegmento'] = {};
  for (const dim of new Set(puntuados.flatMap((j) => Object.keys(j.segmento ?? {})))) {
    porSegmento[dim] = agrupa((j) => j.segmento?.[dim]);
  }
  // Segmentos genéricos (Fase 4.4), iguales en los cinco deportes: favorito, banda de
  // probabilidad, mes y día de la semana. Derivados del propio partido, no de la etiqueta.
  for (const [dim, clave] of Object.entries(SEGMENTOS_GENERICOS)) porSegmento[dim] = agrupa(clave);

  // Cobertura contra rendimiento: participar solo en las predicciones con más respaldo.
  // El orden lo da la PROFUNDIDAD de datos (no la probabilidad: ordenar por probabilidad
  // extrema bajaría el Brier por pura aritmética). Al lado, el mercado sobre los mismos
  // partidos, que es la comparación que no depende de lo «fácil» del subconjunto.
  const cobertura: ResultadoWalkForward['cobertura'] = [];
  const ordenados = puntuados.filter((j) => j.profundidad != null).sort((x, y) => (y.profundidad as number) - (x.profundidad as number));
  if (ordenados.length >= MIN_SEGMENTO) {
    for (const c of [1, 0.75, 0.5, 0.25]) {
      const xs = ordenados.slice(0, Math.round(ordenados.length * c));
      const cm = xs.filter((j) => j.mercado);
      cobertura.push({
        cobertura: c,
        n: xs.length,
        modelo: evaluate('backtest', sport, xs.map((j) => ({ p: j.modelo as number[], y: j.y, mercado: j.mercado ?? null }))),
        mercado: cm.length ? evaluate('backtest', sport, cm.map((j) => ({ p: j.mercado as number[], y: j.y }))) : null,
      });
    }
  }

  const v = versionsFor(sport);
  return {
    sport,
    generado: new Date().toISOString(),
    model_version: v.model_version,
    data_version: v.data_version,
    holdoutExcluido,
    ventanas: `ventana creciente: cada periodo se evalúa con todo lo anterior; periodos de ${
      { tennis: 'un trimestre', football: 'media temporada', basketball: 'media temporada', baseball: 'media temporada', nfl: 'una temporada', nhl: 'media temporada', ufc: 'medio año' }[sport]
    }`,
    periodos: out,
    resumen,
    global: {
      modelo: evaluate('backtest', sport, todos),
      recalibrado: evaluate('backtest', sport, recalTodos),
      baselines: globalBaselines,
      mercado: conMercado.length ? evaluate('backtest', sport, conMercado.map((j) => ({ p: j.mercado as number[], y: j.y }))) : null,
    },
    porRegimen: agrupa((j) => j.regimen),
    porSegmento,
    cobertura,
    pares,
  };
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** Banda de la probabilidad máxima: «50–60 %», …, «90 %+». */
export function bandaDe(p: number[]): string {
  const m = Math.max(...p);
  if (m >= 0.9) return '90 %+';
  const lo = Math.floor(m * 10) * 10;
  return `${lo}–${lo + 10} %`;
}

export const SEGMENTOS_GENERICOS: Record<string, (j: Juego) => string | undefined> = {
  favorito: (j) => {
    if (!j.modelo) return undefined;
    const i = j.modelo.indexOf(Math.max(...j.modelo));
    return i === 0 ? (j.local ? 'local favorito' : 'primero favorito') : i === j.modelo.length - 1 ? (j.local ? 'visitante favorito' : 'segundo favorito') : 'empate favorito';
  },
  'banda de probabilidad': (j) => (j.modelo ? bandaDe(j.modelo) : undefined),
  mes: (j) => MESES[Number(j.fecha.replace(/-/g, '').slice(4, 6)) - 1],
  'día de la semana': (j) => {
    const f = j.fecha.replace(/-/g, '');
    const d = new Date(Date.UTC(Number(f.slice(0, 4)), Number(f.slice(4, 6)) - 1, Number(f.slice(6, 8))));
    return Number.isFinite(d.getTime()) ? DIAS[d.getUTCDay()] : undefined;
  },
};

export const WALKFORWARD_DIR = path.join(ROOT, 'experiments', 'walkforward');

/** Guarda el resultado (uno por deporte, versionado en git como el resto de experiments/). */
export function guardarWalkForward(r: ResultadoWalkForward): string {
  fs.mkdirSync(WALKFORWARD_DIR, { recursive: true });
  const f = path.join(WALKFORWARD_DIR, `${r.sport}.json`);
  const redondeo = (_k: string, v: unknown) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e6) / 1e6 : v);
  const { pares: _pares, ...sinPares } = r;
  void _pares;
  fs.writeFileSync(f, JSON.stringify(sinPares, redondeo, 1) + '\n');
  return f;
}

export function leerWalkForward(sport: SportId): ResultadoWalkForward | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(WALKFORWARD_DIR, `${sport}.json`), 'utf8')) as ResultadoWalkForward;
  } catch {
    return null;
  }
}

const f4 = (x: number | null | undefined) => (x == null ? '—' : x.toFixed(4));

/** El bloque que imprime cada backtest al final. */
export function imprimirWalkForward(r: ResultadoWalkForward, log: (s: string) => void = console.log): void {
  log(`\n── Walk-forward por periodos (${r.periodos.length} periodos; ${r.ventanas}) ──`);
  if (r.holdoutExcluido) log(`  ${r.holdoutExcluido} partidos del holdout final excluidos.`);
  const ancho = (b: string) => Math.max(10, b.length + 2);
  log('  periodo            n     modelo  recalib.  ' + Object.keys(r.global.baselines).map((b) => b.padEnd(ancho(b))).join('') + 'mercado   ROI');
  for (const p of r.periodos) {
    log(
      `  ${p.periodo.padEnd(16)} ${String(p.n).padStart(5)}  ${f4(p.modelo.logLoss)}  ${f4(p.recalibrado.logLoss)}  ` +
        Object.keys(r.global.baselines).map((b) => f4(p.baselines[b]?.logLoss).padEnd(ancho(b))).join('') +
        `${p.mercado ? f4(p.mercado.logLoss) : '—     '}  ` +
        (p.roi?.roi != null ? `${(p.roi.roi * 100).toFixed(1)} % (${p.roi.apuestas})` : '—'),
    );
  }
  log('  (log loss; más bajo es mejor. El mercado, sobre sus partidos con precio.)');
  for (const [rival, c] of Object.entries(r.resumen)) {
    log(`  contra ${rival}: el modelo gana ${c.ganaModelo} de ${c.periodos} periodos; el rival, ${c.ganaRival}.`);
  }
  log('  CLV: no calculable con el histórico (una sola cuota por partido, la de cierre).');
}
