// npm run benchmark:report — modelo contra baselines sencillos y contra el mercado, con
// TODOS los periodos del walk-forward. Ninguno se elige: el resumen cuenta cuántos gana
// cada uno, también los que pierde el modelo.
//
// Lee experiments/walkforward/<deporte>.json, que escribe cada backtest de referencia
// (npm run backtest, backtest:fb, backtest:bb, backtest:bsb, backtest:naf). Si un fichero
// falta, lo dice y sigue; no lo rellena con nada.

import { SPORT_IDS } from '../sports.ts';
import { leerWalkForward } from '../evaluation/walkforward.ts';
import type { Informe } from '../evaluation/metrics.ts';

const NOMBRE: Record<string, string> = { tennis: 'TENIS', football: 'FÚTBOL', basketball: 'NBA', baseball: 'MLB', nfl: 'NFL', nhl: 'NHL', ufc: 'UFC' };
const f4 = (x: number | null | undefined) => (x == null ? '   —  ' : x.toFixed(4));

export function informeBenchmark(log: (s: string) => void = console.log): number {
  let faltan = 0;
  log('BENCHMARK: modelo · baselines sencillos · mercado (log loss y Brier; más bajo es mejor)');
  log('Todos los periodos del walk-forward, sin elegir. El holdout final no entra.\n');
  for (const sport of SPORT_IDS) {
    const r = leerWalkForward(sport);
    log(`${NOMBRE[sport]}`);
    if (!r) {
      faltan++;
      log(`  sin walk-forward guardado: corre el backtest de referencia de ${sport}.\n`);
      continue;
    }
    log(`  ${r.global.modelo.n} partidos en ${r.periodos.length} periodos · ${r.model_version} · datos ${r.data_version}`);
    const fila = (nombre: string, i: Informe | null) =>
      i && i.n ? log(`  ${nombre.padEnd(30)} log loss ${f4(i.logLoss)}   Brier ${f4(i.brier)}   n ${i.n}`) : null;
    fila('Modelo', r.global.modelo);
    fila('Modelo recalibrado (solo pasado)', r.global.recalibrado);
    for (const [b, i] of Object.entries(r.global.baselines)) fila(b, i);
    if (r.global.mercado && r.global.modelo.mercado) {
      const m = r.global.modelo.mercado;
      log(`  ${'Mercado (cierre, sin margen)'.padEnd(30)} log loss ${f4(m.logLoss)}   Brier ${f4(m.brier)}   n ${m.n}`);
      log(`  ${'  …y el modelo, mismos partidos'.padEnd(30)} log loss ${f4(m.modeloLogLoss)}   Brier ${f4(m.modeloBrier)}`);
      log(m.modeloLogLoss < m.logLoss ? '  → el modelo le gana al mercado en el agregado.' : '  → EL MERCADO ES MEJOR que el modelo en el agregado.');
    } else {
      log('  Mercado: el histórico de este deporte no tiene cuotas; no hay comparación posible.');
    }
    for (const [rival, c] of Object.entries(r.resumen)) {
      log(`  periodos contra ${rival}: modelo ${c.ganaModelo} · ${rival} ${c.ganaRival} (de ${c.periodos})`);
    }
    // Régimen y segmentos: solo los que tienen ≥ MIN_SEGMENTO partidos (el resto no se publica).
    const seg = (titulo: string, g: Record<string, { n: number; modelo: Informe; mercado: Informe | null }>) => {
      const ks = Object.keys(g);
      if (!ks.length) return;
      log(`  ${titulo}:`);
      for (const k of ks) {
        const x = g[k];
        const m = x.modelo.mercado;
        log(
          `    ${k.padEnd(34)} n ${String(x.n).padStart(6)} · log loss ${f4(x.modelo.logLoss)} · Brier ${f4(x.modelo.brier)}` +
            (m ? ` · mercado ${f4(m.logLoss)} (${m.modeloLogLoss < m.logLoss ? 'gana el modelo' : 'gana el mercado'})` : ''),
        );
      }
    };
    seg('por régimen', r.porRegimen);
    for (const [dim, g] of Object.entries(r.porSegmento)) seg(`por ${dim}`, g);
    if (r.cobertura.length) {
      log('  cobertura contra rendimiento (por profundidad de datos; el Brier baja también por ser partidos más fáciles):');
      for (const c of r.cobertura) {
        log(`    ${String(Math.round(c.cobertura * 100)).padStart(3)} %  n ${String(c.n).padStart(6)} · log loss ${f4(c.modelo.logLoss)} · Brier ${f4(c.modelo.brier)} · ECE ${c.modelo.ece == null ? '—' : (c.modelo.ece * 100).toFixed(2) + ' pp'}`);
      }
    }
    log('');
  }
  return faltan;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const faltan = informeBenchmark();
  if (faltan) console.log(`${faltan} deporte(s) sin walk-forward guardado.`);
}
