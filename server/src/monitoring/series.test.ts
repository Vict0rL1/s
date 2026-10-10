// Monitorización: PSI, ventana móvil, deriva solo con muestra, serie guardada y alerta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { psi, distribucion, ventana, serie, evaluarDeriva, monitorizar, serieGuardada, PSI_ALERTA, MIN_VENTANA, VENTANA_DIAS } = await import('./series.ts');
const { getDb } = await import('../db.ts');

const pred = (p: number, y: number, cuando: string) => ({ p: [p, 1 - p], y, version: null, cuando, liga: null });

test('psi: cero entre distribuciones iguales, grande cuando se mueven', () => {
  const a = [0.1, 0.2, 0.3, 0.4];
  assert.ok(Math.abs(psi(a, a)) < 1e-12);
  assert.ok(psi(a, [0.4, 0.3, 0.2, 0.1]) > PSI_ALERTA);
  assert.ok(psi([0.5, 0.5], [0, 1]) > 0, 'el suavizado evita ln(0)');
});

test('distribucion y ventana: cuentan cada probabilidad dicha y respetan los 28 días', () => {
  const xs = [pred(0.95, 0, '2026-01-01T12:00:00Z'), pred(0.55, 1, '2026-01-20T12:00:00Z'), pred(0.5, 0, '2026-02-10T12:00:00Z')];
  const d = distribucion(xs);
  assert.equal(d.length, 10);
  assert.ok(Math.abs(d.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.equal(ventana(xs, '2026-02-10').length, 2, 'el 1 de enero queda fuera de 28 días');
  assert.equal(ventana(xs, '2026-01-20', VENTANA_DIAS).length, 2);
  const s = serie(xs, '2026-01-03', null);
  assert.equal(s.length, 3);
  assert.equal(s[0].n, 1);
  assert.equal(s[2].psi, null, 'sin referencia no hay PSI');
});

test('evaluarDeriva: nunca concluye con menos de 100; con muestra avisa por PSI o por log loss', () => {
  const pocas = Array.from({ length: MIN_VENTANA - 1 }, () => pred(0.5, 1, '2026-01-01T00:00:00Z'));
  const d0 = evaluarDeriva(pocas, 0.3, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(d0.hay, false);
  assert.equal(d0.aviso.nivel, 'insuficiente');
  // 200 predicciones al 90 % que fallan la mitad: log loss ≈ 1.2, muy por encima de 0.6.
  const malas = Array.from({ length: 200 }, (_, i) => pred(0.9, i % 2, '2026-01-01T00:00:00Z'));
  const d1 = evaluarDeriva(malas, 0.6, null);
  assert.equal(d1.hay, true);
  assert.match(d1.motivos[0], /log loss/);
  // Distribución igual a la referencia y log loss normal: sin deriva.
  const bien = Array.from({ length: 200 }, (_, i) => pred(0.7, i % 10 < 7 ? 0 : 1, '2026-01-01T00:00:00Z'));
  const ref = distribucion(bien);
  const d2 = evaluarDeriva(bien, 0.62, ref);
  assert.equal(d2.hay, false);
  const d3 = evaluarDeriva(bien, null, [0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(d3.hay, true);
  assert.match(d3.motivos[0], /PSI/);
});

test('monitorizar: guarda la serie reconstruible en monitoring_series y no inventa con la base vacía', () => {
  const m = monitorizar('tennis', new Date('2026-05-01T10:00:00Z'));
  assert.equal(m.serie.length, 0);
  assert.equal(m.actual, null);
  assert.equal(m.deriva.hay, false);
  assert.deepEqual(serieGuardada('tennis'), []);
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO monitoring_series (day, sport, metric, value, computed_at) VALUES (?, ?, ?, ?, ?)').run('2026-04-30', 'tennis', 'logloss_4s', 0.61, 'x');
  db.prepare('INSERT OR REPLACE INTO monitoring_series (day, sport, metric, value, computed_at) VALUES (?, ?, ?, ?, ?)').run('2026-04-30', 'tennis', 'n_4s', 150, 'x');
  assert.deepEqual(serieGuardada('tennis'), [{ dia: '2026-04-30', n: 150, logLoss: 0.61, brier: null, psi: null }]);
});

test('C4: la deriva se mide con lo que dijo el MODELO (pModelo), que es lo que midió el backtest, no con lo publicado', () => {
  const x = { p: [0.5, 0.5], pModelo: [0.95, 0.05], y: 0, version: null, cuando: '2026-10-01T12:00:00Z', liga: null };
  const d = distribucion([x]);
  assert.equal(d[9], 0.5, 'la cubeta del 90-100 lleva el 0,95 del modelo');
  assert.equal(d[0], 0.5);
  assert.equal(d[5], 0, 'lo publicado (0,5) no cuenta para la deriva');
});

test('C4: predicciones() trae pModelo distinto de p cuando lo publicado difiere del modelo', async () => {
  const { getDb } = await import('../db.ts');
  const { predicciones } = await import('../evaluation/live.ts');
  getDb()
    .prepare(
      `INSERT INTO fb_prediction_log (match_key, league, upcoming_id, commence_time, home_id, away_id, home_name, away_name,
         prob_home, prob_draw, prob_away, shown_home, shown_draw, shown_away, market_prob_home, market_prob_draw, market_prob_away, reliability, predicted_at, home_goals, away_goals, resolved_at)
       VALUES ('mon|a|b', 'epl', 'mon-1', '2026-10-01T15:00:00Z', 'a', 'b', 'A', 'B', 0.7, 0.2, 0.1, 0.5, 0.3, 0.2, 0.45, 0.3, 0.25, 'high', '2026-09-30T12:00:00Z', 2, 0, '2026-10-01T17:00:00Z')`,
    )
    .run();
  const x = predicciones('football').find((q) => q.liga === 'epl' && q.cuando === '2026-10-01T15:00:00Z');
  assert.ok(x);
  assert.ok(Math.abs(x!.p[0] - 0.5) < 1e-9, 'p es lo publicado');
  assert.ok(Math.abs((x!.pModelo as number[])[0] - 0.7) < 1e-9, 'pModelo es lo que dijo el modelo');
});
