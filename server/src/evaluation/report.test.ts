import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { informeComun, leerMetricasBacktest, problemasMetricasBacktest } = await import('./report.ts');

test('la ficha de backtests del repositorio está bien', () => {
  const m = leerMetricasBacktest();
  assert.deepEqual(problemasMetricasBacktest(m), []);
  for (const r of Object.values(m)) assert.equal(r.origen, 'backtest');
});

const buena = () => ({
  origen: 'backtest' as const, deporte: 'football', n: 100, logLoss: 1.01, brier: 0.3, accuracy: 0.49, ece: 0.01, mercado: null,
  logLossUniforme: Math.log(3), brierUniforme: 1 / 3, medidoEn: '2026-09-29T00:00:00Z', model_version: 'football-abc', data_version: 'x',
});

// TESTS NEGATIVOS: cada error que la auditoría existe para cazar, cazado.
test('una fila en vivo metida en la ficha de backtests se detecta', () => {
  assert.deepEqual(problemasMetricasBacktest({ football: buena() }), []);
  const p = problemasMetricasBacktest({ football: { ...buena(), origen: 'live' as never } });
  assert.match(p.join('\n'), /origen «live»/);
});

test('la referencia del Brier de dos resultados en un deporte de tres se detecta', () => {
  assert.match(problemasMetricasBacktest({ football: { ...buena(), brierUniforme: 0.25 } }).join('\n'), /3 resultados/);
});

test('métricas rotas, deporte cruzado o versión ajena se detectan', () => {
  assert.match(problemasMetricasBacktest({ football: { ...buena(), logLoss: Number.NaN } }).join('\n'), /logLoss inválido/);
  assert.match(problemasMetricasBacktest({ nfl: buena() }).join('\n'), /otro deporte/);
  assert.match(problemasMetricasBacktest({ football: { ...buena(), model_version: 'nfl-abc' } }).join('\n'), /versión de modelo ajena/);
  assert.match(problemasMetricasBacktest({ football: { ...buena(), n: 0 } }).join('\n'), /sin partidos/);
});

test('el bloque impreso da la referencia de su número de resultados, y sin guardar no escribe', () => {
  const antes = JSON.stringify(leerMetricasBacktest());
  const lineas: string[] = [];
  informeComun('football', [{ p: [0.5, 0.3, 0.2], y: 0 }, { p: [0.2, 0.3, 0.5], y: 1 }], (s) => lineas.push(s), false);
  const texto = lineas.join('\n');
  assert.match(texto, /no saber nada: 0\.3333/);
  assert.doesNotMatch(texto, /0\.2500/);
  assert.equal(JSON.stringify(leerMetricasBacktest()), antes);
});
