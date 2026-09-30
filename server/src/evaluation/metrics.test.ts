import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { logLoss, brier, accuracy, ece, evaluate } = await import('./metrics.ts');
const { evaluacionEnVivo } = await import('./live.ts');
const { getDb } = await import('../db.ts');

const cerca = (a: number | null, b: number, tol = 1e-12) => assert.ok(a != null && Math.abs(a - b) < tol, `${a} ≠ ${b}`);

test('binario: el Brier es EXACTAMENTE el clásico (p − y)², el que publican los backtests', () => {
  const xs = [
    { p: [0.7, 0.3], y: 0 },
    { p: [0.7, 0.3], y: 1 },
    { p: [0.4, 0.6], y: 1 },
  ];
  cerca(brier(xs), ((0.7 - 1) ** 2 + (0.7 - 0) ** 2 + (0.4 - 0) ** 2) / 3);
  cerca(logLoss(xs), -(Math.log(0.7) + Math.log(0.3) + Math.log(0.6)) / 3);
});

test('referencias: 50/50 da Brier 0,25 y log loss ln 2; uniforme a tres, ln 3', () => {
  cerca(brier([{ p: [0.5, 0.5], y: 0 }]), 0.25);
  cerca(logLoss([{ p: [0.5, 0.5], y: 1 }]), Math.log(2));
  cerca(logLoss([{ p: [1 / 3, 1 / 3, 1 / 3], y: 2 }]), Math.log(3));
  cerca(brier([{ p: [1 / 3, 1 / 3, 1 / 3], y: 2 }]), 1 / 3);
  cerca(brier([{ p: [0, 0, 1], y: 0 }]), 1, 1e-12);
});

test('el acierto no distingue 51 % de 90 %; el log loss sí (por eso no es la principal)', () => {
  const tibio = [{ p: [0.51, 0.49], y: 1 }];
  const osado = [{ p: [0.9, 0.1], y: 1 }];
  assert.equal(accuracy(tibio), accuracy(osado));
  assert.ok(logLoss(osado) > logLoss(tibio) * 3);
  assert.equal(accuracy([{ p: [0.5, 0.5], y: 0 }]), 0.5, 'un empate de probabilidad cuenta medio');
});

test('ECE: un modelo que dice 70 % y acierta 7 de 10 está calibrado', () => {
  const xs = Array.from({ length: 10 }, (_, i) => ({ p: [0.7, 0.3], y: i < 7 ? 0 : 1 }));
  cerca(ece(xs), 0, 1e-9);
});

// TESTS NEGATIVOS: una predicción mal formada no se puntúa en silencio.
test('probabilidades que no suman 1 o un resultado fuera de rango se rechazan', () => {
  assert.throws(() => evaluate('live', 'x', [{ p: [0.7, 0.7], y: 0 }]), /probabilidades inválidas/);
  assert.throws(() => evaluate('live', 'x', [{ p: [0.5, 0.5], y: 2 }]), /fuera de rango/);
  assert.throws(() => evaluate('live', 'x', [{ p: [1.2, -0.2], y: 0 }]), /probabilidades inválidas/);
});

test('sin partidos: nulos, nunca ceros', () => {
  const r = evaluate('live', 'tennis', []);
  assert.equal(r.n, 0);
  assert.equal(r.logLoss, null);
  assert.equal(r.accuracy, null);
});

test('contra el mercado sobre los MISMOS partidos', () => {
  const r = evaluate('backtest', 'nfl', [
    { p: [0.6, 0.4], y: 0, mercado: [0.7, 0.3] },
    { p: [0.6, 0.4], y: 0, mercado: null },
  ]);
  assert.equal(r.mercado?.n, 1);
  cerca(r.mercado!.logLoss, -Math.log(0.7));
  cerca(r.mercado!.modeloLogLoss, -Math.log(0.6));
  cerca(r.logLossUniforme, Math.log(2));
  cerca(r.brierUniforme, 0.25);
});

// La referencia tiene que ser lo que saca de verdad quien reparte a partes iguales: con tres
// resultados eso es 1/3, no el 0,25 de dos (el texto viejo del fútbol decía 0,25).
test('la referencia de «no saber nada» es la que obtiene el reparto uniforme', () => {
  for (const k of [2, 3]) {
    const u = Array(k).fill(1 / k);
    const r = evaluate('backtest', 'x', Array.from({ length: k }, (_, y) => ({ p: u, y })));
    cerca(r.brier, r.brierUniforme!);
    cerca(r.logLoss, r.logLossUniforme!);
  }
  assert.notEqual(evaluate('backtest', 'football', [{ p: [1 / 3, 1 / 3, 1 / 3], y: 0 }]).brierUniforme, 0.25);
});

test('en vivo: solo partidos resueltos, con la probabilidad ENSEÑADA, y origen live', () => {
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO naf_prediction_log (match_key, league, upcoming_id, commence_time, home_id, away_id, home_name, away_name,
       prob_home, shown_home, market_prob_home, reliability, predicted_at, home_points, away_points, resolved_at)
     VALUES (?, 'nfl', 'u', '2026-09-20T17:00:00Z', 'a', 'b', 'A', 'B', ?, ?, ?, 'high', '2026-09-19T10:00:00Z', ?, ?, ?)`,
  );
  ins.run('r1', 0.4, 0.7, 0.72, 24, 17, '2026-09-21T00:00:00Z'); // la cruda decía B; la enseñada, A; ganó A
  ins.run('r2', 0.6, 0.65, 0.66, 10, 20, '2026-09-21T00:00:00Z');
  ins.run('empate', 0.5, 0.5, 0.5, 20, 20, '2026-09-21T00:00:00Z'); // empate: fuera
  ins.run('pendiente', 0.5, 0.5, 0.5, null, null, null); // sin resultado: fuera
  const nfl = evaluacionEnVivo().find((r) => r.deporte === 'nfl')!;
  assert.equal(nfl.origen, 'live');
  assert.equal(nfl.n, 2);
  cerca(nfl.logLoss, -(Math.log(0.7) + Math.log(0.35)) / 2);
  assert.equal(nfl.accuracy, 0.5);
  assert.equal(nfl.mercado?.n, 2);
  // Anteriores al versionado: un solo grupo, sin versión inventada.
  assert.deepEqual(nfl.porVersion.map((v) => [v.version, v.n]), [[null, 2]]);
});

test('en vivo: cada versión del modelo se mide sobre SUS predicciones, sin mezclarse', () => {
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO bsb_prediction_log (match_key, league, upcoming_id, commence_time, home_id, away_id, home_name, away_name,
       prob_home, market_prob_home, reliability, predicted_at, home_runs, away_runs, resolved_at,
       model_version, model_config_version, calibration_version, data_version, git_commit)
     VALUES (?, 'mlb', 'u', '2026-09-20T17:00:00Z', 'a', 'b', 'A', 'B', ?, 0.5, 'high', '2026-09-19T10:00:00Z', ?, ?, '2026-09-21T00:00:00Z',
       ?, 'c', 'k', 'd', 'g')`,
  );
  ins.run('v1-a', 0.8, 5, 2, 'baseball-111111111111'); // la vieja: 0,8 y acierta
  ins.run('v1-b', 0.8, 1, 3, 'baseball-111111111111'); //          0,8 y falla
  ins.run('v2-a', 0.6, 5, 2, 'baseball-222222222222'); // la nueva: 0,6 y acierta
  const bsb = evaluacionEnVivo().find((r) => r.deporte === 'baseball')!;
  assert.equal(bsb.n, 3);
  const [v1, v2] = bsb.porVersion;
  assert.equal(v1.version, 'baseball-111111111111');
  assert.equal(v2.version, 'baseball-222222222222');
  assert.equal(v1.n + v2.n, bsb.n);
  cerca(v1.logLoss, -(Math.log(0.8) + Math.log(0.2)) / 2);
  // TEST NEGATIVO: si las versiones se mezclaran, la nueva cargaría con el fallo de la vieja.
  cerca(v2.logLoss, -Math.log(0.6));
  assert.notEqual(v2.logLoss, bsb.logLoss);
});
