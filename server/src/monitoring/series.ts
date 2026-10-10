// Monitorización del modelo en vivo (Fase 4.5).
//
// Tres cosas, por deporte y por día:
//   · log loss y Brier en ventana móvil de 4 semanas (28 días) sobre las predicciones
//     puntuadas en vivo: la misma definición que la capa común (evaluation/metrics.ts);
//   · Todo con lo que dijo el MODELO (`pModelo`, antes de calibrar y mezclar con el mercado),
//     que es lo que midió el backtest; comparar lo publicado con lo crudo era comparar dos
//     cosas distintas (lote C, C4).
//   · PSI (population stability index) de la distribución de probabilidades dichas, vivo
//     contra el backtest: si el modelo empieza a decir cosas que en el backtest no decía
//     (todo 50/50, o todo 90 %), el PSI lo ve antes que el acierto;
//   · la alerta `deriva`, cuando el PSI supera 0,25 o el log loss de la ventana se aleja
//     del backtest más de dos errores típicos. Nunca con menos de 100 predicciones en la
//     ventana: por debajo no hay conclusión, hay ruido (evaluation/sample.ts).
//
// La serie se guarda en `monitoring_series` (history) para graficarla; se reconstruye entera
// cada vez, así que no hay nada que migrar a mano si cambia la definición. Lo que NO hace:
// tocar el modelo. Avisa; decidir es de quien lee.

import { getDb } from '../db.ts';
import { predicciones, type PrediccionEnVivo } from '../evaluation/live.ts';
import { leerDiagramasBacktest, CUBETAS } from '../evaluation/reliability.ts';
import { leerMetricasBacktest } from '../evaluation/report.ts';
import { avisoMuestra, UMBRALES_MUESTRA, type AvisoMuestra } from '../evaluation/sample.ts';
import { emitirAlerta } from '../alerts/engine.ts';
import { SPORT_IDS, type SportId } from '../sports.ts';

export const VENTANA_DIAS = 28;
export const PSI_ALERTA = 0.25;
export const ERRORES_TIPICOS = 2;
export const MIN_VENTANA = UMBRALES_MUESTRA.predicciones.insuficiente;

export interface PuntoSerie {
  dia: string;
  n: number;
  logLoss: number | null;
  brier: number | null;
  psi: number | null;
}

export interface Deriva {
  hay: boolean;
  motivos: string[];
  /** Cuántas predicciones había en la ventana al decidir. */
  n: number;
  aviso: AvisoMuestra;
}

export interface Monitorizacion {
  deporte: SportId;
  ventanaDias: number;
  serie: PuntoSerie[];
  /** La ventana que acaba hoy. */
  actual: PuntoSerie | null;
  referencia: { logLoss: number | null; brier: number | null; n: number } | null;
  deriva: Deriva;
  umbrales: { psi: number; erroresTipicos: number; minVentana: number };
  generado: string;
}

/** PSI entre dos distribuciones en cubetas (proporciones). Suavizado para que ln(0) no explote. */
export function psi(referencia: number[], actual: number[], eps = 1e-4): number {
  let s = 0;
  for (let i = 0; i < referencia.length; i++) {
    const p = Math.max(referencia[i] ?? 0, eps);
    const q = Math.max(actual[i] ?? 0, eps);
    s += (q - p) * Math.log(q / p);
  }
  return s;
}

/** Lo que dijo el modelo: es lo que midió el backtest, y por eso lo que se compara (lote C, C4). */
const delModelo = (x: PrediccionEnVivo): number[] => x.pModelo ?? x.p;

/** Proporción de probabilidades del modelo que cae en cada cubeta de 10 puntos. */
export function distribucion(xs: PrediccionEnVivo[], cubetas = CUBETAS): number[] {
  const c = new Array<number>(cubetas).fill(0);
  let total = 0;
  for (const x of xs) {
    for (const pk of delModelo(x)) {
      c[Math.min(cubetas - 1, Math.max(0, Math.floor(pk * cubetas)))]++;
      total++;
    }
  }
  return total ? c.map((v) => v / total) : c;
}

const dia = (iso: string) => iso.slice(0, 10);
const perdida = (x: PrediccionEnVivo) => -Math.log(Math.max(delModelo(x)[x.y], 1e-15));
const brierDe = (x: PrediccionEnVivo) => delModelo(x).reduce((s, pk, k) => s + (pk - (k === x.y ? 1 : 0)) ** 2, 0) / 2;

/** Las predicciones cuya fecha cae en los `dias` días que acaban en `hasta` (inclusive). */
export function ventana(xs: PrediccionEnVivo[], hasta: string, dias = VENTANA_DIAS): PrediccionEnVivo[] {
  const fin = Date.parse(`${hasta}T23:59:59.999Z`);
  const inicio = fin - dias * 86_400_000;
  return xs.filter((x) => {
    if (!x.cuando) return false;
    const t = Date.parse(x.cuando);
    return t > inicio && t <= fin;
  });
}

export function punto(xs: PrediccionEnVivo[], diaFin: string, referencia: number[] | null): PuntoSerie {
  const w = ventana(xs, diaFin);
  const n = w.length;
  return {
    dia: diaFin,
    n,
    logLoss: n ? w.reduce((s, x) => s + perdida(x), 0) / n : null,
    brier: n ? w.reduce((s, x) => s + brierDe(x), 0) / n : null,
    psi: n && referencia ? psi(referencia, distribucion(w)) : null,
  };
}

/** Un punto por día desde la primera predicción con fecha hasta `hoy`. */
export function serie(xs: PrediccionEnVivo[], hoy: string, referencia: number[] | null): PuntoSerie[] {
  const fechas = xs.map((x) => x.cuando).filter((t): t is string => !!t).sort();
  if (!fechas.length) return [];
  const out: PuntoSerie[] = [];
  const fin = Date.parse(`${hoy}T00:00:00Z`);
  for (let t = Date.parse(`${dia(fechas[0])}T00:00:00Z`); t <= fin; t += 86_400_000) {
    out.push(punto(xs, new Date(t).toISOString().slice(0, 10), referencia));
  }
  return out;
}

/** ¿Hay deriva? Solo se concluye con muestra; por debajo, `hay: false` y el aviso lo dice. */
export function evaluarDeriva(w: PrediccionEnVivo[], referenciaLogLoss: number | null, referenciaDist: number[] | null): Deriva {
  const n = w.length;
  const aviso = avisoMuestra(n, 'predicciones');
  const motivos: string[] = [];
  if (n >= MIN_VENTANA) {
    if (referenciaDist) {
      const v = psi(referenciaDist, distribucion(w));
      if (v > PSI_ALERTA) motivos.push(`PSI ${v.toFixed(3)} > ${PSI_ALERTA}: la distribución de probabilidades dichas no se parece a la del backtest`);
    }
    if (referenciaLogLoss != null) {
      const perdidas = w.map(perdida);
      const media = perdidas.reduce((a, b) => a + b, 0) / n;
      const sd = Math.sqrt(perdidas.reduce((a, b) => a + (b - media) ** 2, 0) / Math.max(1, n - 1));
      const se = sd / Math.sqrt(n);
      if (se > 0 && media - referenciaLogLoss > ERRORES_TIPICOS * se) {
        motivos.push(`log loss ${media.toFixed(4)} frente a ${referenciaLogLoss.toFixed(4)} del backtest: ${((media - referenciaLogLoss) / se).toFixed(1)} errores típicos peor`);
      }
    }
  }
  return { hay: motivos.length > 0, motivos, n, aviso };
}

function referenciaDe(deporte: SportId): { dist: number[] | null; logLoss: number | null; brier: number | null; n: number } {
  const d = leerDiagramasBacktest()[deporte];
  const m = leerMetricasBacktest()[deporte];
  const total = d ? d.cubetas.reduce((s, c) => s + c.n, 0) : 0;
  return {
    dist: d && total ? d.cubetas.map((c) => c.n / total) : null,
    logLoss: m?.logLoss ?? null,
    brier: m?.brier ?? null,
    n: m?.n ?? 0,
  };
}

/** Calcula la monitorización de un deporte (sin escribir nada). */
export function monitorizacion(deporte: SportId, ahora = new Date(), xs: PrediccionEnVivo[] = predicciones(deporte)): Monitorizacion {
  const hoy = dia(ahora.toISOString());
  const ref = referenciaDe(deporte);
  const s = serie(xs, hoy, ref.dist);
  const actual = s.length ? s[s.length - 1] : null;
  return {
    deporte,
    ventanaDias: VENTANA_DIAS,
    serie: s,
    actual,
    referencia: ref.logLoss == null && ref.brier == null ? null : { logLoss: ref.logLoss, brier: ref.brier, n: ref.n },
    deriva: evaluarDeriva(ventana(xs, hoy), ref.logLoss, ref.dist),
    umbrales: { psi: PSI_ALERTA, erroresTipicos: ERRORES_TIPICOS, minVentana: MIN_VENTANA },
    generado: ahora.toISOString(),
  };
}

/** Reconstruye la serie guardada de un deporte y emite la alerta si hay deriva. */
export function monitorizar(deporte: SportId, ahora = new Date()): Monitorizacion {
  const m = monitorizacion(deporte, ahora);
  const db = getDb();
  const up = db.prepare('INSERT OR REPLACE INTO monitoring_series (day, sport, metric, value, computed_at) VALUES (?, ?, ?, ?, ?)');
  const tx = () => {
    for (const p of m.serie) {
      up.run(p.dia, deporte, 'logloss_4s', p.logLoss, m.generado);
      up.run(p.dia, deporte, 'brier_4s', p.brier, m.generado);
      up.run(p.dia, deporte, 'n_4s', p.n, m.generado);
      up.run(p.dia, deporte, 'psi', p.psi, m.generado);
    }
  };
  db.exec('BEGIN');
  try {
    tx();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (m.deriva.hay) {
    emitirAlerta(
      {
        type: 'deriva',
        severity: 'aviso',
        sport: deporte,
        title: `Deriva en ${deporte}: el modelo en vivo se aleja del backtest`,
        body: m.deriva.motivos.join('. ') + '. No cambia nada por sí sola: revisar antes de seguir apostando.',
        data: { n: m.deriva.n, actual: m.actual, referencia: m.referencia },
      },
      ahora,
    );
  }
  return m;
}

/** El trabajo diario: los cinco deportes, sin que uno tumbe a los demás. */
export function cicloMonitorizacion(log: (m: string) => void = () => {}, ahora = new Date()): { deportes: number; conDeriva: string[] } {
  const conDeriva: string[] = [];
  let deportes = 0;
  for (const s of SPORT_IDS) {
    try {
      const m = monitorizar(s, ahora);
      deportes++;
      if (m.deriva.hay) conDeriva.push(s);
      log(`monitorización ${s}: ${m.actual ? `${m.actual.n} predicciones en ${VENTANA_DIAS} días` : 'sin predicciones puntuadas'}${m.deriva.hay ? ' · DERIVA' : ''}`);
    } catch (e) {
      log(`monitorización ${s}: ${(e as Error).message}`);
    }
  }
  return { deportes, conDeriva };
}

/** La serie guardada (para graficar sin recalcular). */
export function serieGuardada(deporte: SportId): PuntoSerie[] {
  const filas = getDb()
    .prepare('SELECT day, metric, value FROM monitoring_series WHERE sport = ? ORDER BY day')
    .all(deporte) as { day: string; metric: string; value: number | null }[];
  const por = new Map<string, PuntoSerie>();
  for (const f of filas) {
    const p = por.get(f.day) ?? { dia: f.day, n: 0, logLoss: null, brier: null, psi: null };
    if (f.metric === 'n_4s') p.n = f.value ?? 0;
    else if (f.metric === 'logloss_4s') p.logLoss = f.value;
    else if (f.metric === 'brier_4s') p.brier = f.value;
    else if (f.metric === 'psi') p.psi = f.value;
    por.set(f.day, p);
  }
  return [...por.values()];
}
