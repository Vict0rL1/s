// El bloque ESTÁNDAR que imprime cada backtest, con la capa común de métricas, y su
// registro en experiments/backtest_metrics.json.
//
// Cada backtest sigue imprimiendo sus métricas propias (RPS del fútbol, margen de la NBA,
// over/under del béisbol…), que miden cosas de ese deporte. Esto añade, al final, las
// MISMAS cuatro métricas con la MISMA definición para los cinco: así un 0,613 del tenis y
// un 0,592 de la NBA significan lo mismo, y se pueden poner al lado de la evaluación en
// vivo sin preguntarse si se calcularon igual.
//
// El fichero es SOLO de backtests (origen 'backtest'). La evaluación en vivo nunca se
// guarda aquí: se calcula de los registros de predicciones cada vez que se pide.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.ts';
import { evaluate, type Informe, type Prediccion } from './metrics.ts';
import { versionsFor } from '../versions.ts';
import { OUTCOMES, isSportId, type SportId } from '../sports.ts';
import { guardarDiagramaBacktest } from './reliability.ts';

export const BACKTEST_METRICS_PATH = path.join(ROOT, 'experiments', 'backtest_metrics.json');

export type BacktestMetrics = Record<string, Informe & { medidoEn: string; model_version: string; data_version: string; mercadoFuente?: string | null }>;

export function leerMetricasBacktest(): BacktestMetrics {
  try {
    return JSON.parse(fs.readFileSync(BACKTEST_METRICS_PATH, 'utf8')) as BacktestMetrics;
  } catch {
    return {};
  }
}

/**
 * Lo que haría que la ficha mintiera. Vacío = bien. Lo usa verify:data.
 *
 * Lo grave es el origen: una fila 'live' aquí mezclaría el en vivo con el backtest, que es
 * justo lo que la separación existe para impedir. Lo demás son fichas rotas o a medias.
 */
export function problemasMetricasBacktest(m: BacktestMetrics): string[] {
  const out: string[] = [];
  for (const [k, r] of Object.entries(m)) {
    if (r.origen !== 'backtest') out.push(`${k}: origen «${r.origen}», no 'backtest' — el en vivo no se guarda aquí`);
    if (r.deporte !== k) out.push(`${k}: guardado bajo otro deporte (${r.deporte})`);
    if (!isSportId(k)) out.push(`${k}: deporte desconocido`);
    if (!(r.n > 0)) out.push(`${k}: sin partidos`);
    for (const [nombre, x] of [['logLoss', r.logLoss], ['brier', r.brier], ['ece', r.ece]] as const) {
      if (x == null || !Number.isFinite(x) || x < 0) out.push(`${k}: ${nombre} inválido (${x})`);
    }
    const K = isSportId(k) ? OUTCOMES[k] : null;
    if (K && (r.brierUniforme == null || Math.abs(r.brierUniforme - (K - 1) / (2 * K)) > 1e-9)) {
      out.push(`${k}: la referencia del Brier no corresponde a ${K} resultados (${r.brierUniforme})`);
    }
    if (!r.model_version?.startsWith(`${k}-`)) out.push(`${k}: versión de modelo ajena (${r.model_version})`);
  }
  return out;
}

const f = (x: number | null, d = 4) => (x == null ? '—' : x.toFixed(d));

/**
 * Evalúa, imprime el bloque común y lo guarda (mezclando por deporte, como la
 * calibración: un backtest no borra el de otro deporte).
 */
export function informeComun(sport: SportId, xs: Prediccion[], log: (s: string) => void = console.log, guardar = true, fuenteMercado: string | null = null): Informe {
  const r = evaluate('backtest', sport, xs);
  log('\n── Capa común de métricas (backtest, misma definición en los siete deportes) ──');
  log(`  partidos: ${r.n}`);
  log(`  log loss: ${f(r.logLoss)}   (no saber nada: ${f(r.logLossUniforme)})`);
  log(`  Brier:    ${f(r.brier)}   (no saber nada: ${f(r.brierUniforme)})`);
  log(`  ECE:      ${r.ece == null ? '—' : (r.ece * 100).toFixed(2) + ' pp'}`);
  log(`  acierto:  ${r.accuracy == null ? '—' : (r.accuracy * 100).toFixed(1) + ' %'}   (dato secundario)`);
  if (r.mercado) {
    const mejor = r.mercado.modeloLogLoss < r.mercado.logLoss;
    log(
      `  contra el mercado (${r.mercado.n} partidos con precio${fuenteMercado ? `, fuente: ${fuenteMercado}` : ''}): modelo ${f(r.mercado.modeloLogLoss)} · ` +
        `mercado ${f(r.mercado.logLoss)} → ${mejor ? 'el modelo, mejor' : 'el mercado, mejor'}`,
    );
  }
  if (guardar && r.n > 0) {
    const v = versionsFor(sport);
    const todo = { ...leerMetricasBacktest(), [sport]: { ...r, medidoEn: new Date().toISOString(), model_version: v.model_version, data_version: v.data_version, mercadoFuente: r.mercado ? fuenteMercado : null } };
    const ordenado = Object.fromEntries(Object.keys(todo).sort().map((k) => [k, todo[k]]));
    fs.mkdirSync(path.dirname(BACKTEST_METRICS_PATH), { recursive: true });
    fs.writeFileSync(BACKTEST_METRICS_PATH, JSON.stringify(ordenado, null, 2) + '\n');
    // El diagrama de fiabilidad del backtest (Fase 4.3), con las mismas predicciones.
    guardarDiagramaBacktest(sport, xs);
  }
  return r;
}
