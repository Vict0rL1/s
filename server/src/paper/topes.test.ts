// A6: el banco de papel ignoraba los topes por día (6 %) y por liga (5 %) de la política: solo
// vivían en `decideBook` (el libro manual). Seis partidos de la misma liga y el mismo día, cada
// uno con ventaja, en un banco de 1.000: colocaba 5 × 20 = 100 donde la política permite 50.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { getDb } = await import('../db.ts');
const { place } = await import('./bankroll.ts');
const { politica } = await import('../staking/policyStore.ts');

const db = getDb();
const H = 3_600_000;
const ahora = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
// Todos el mismo día UTC: a las 12:00 de pasado mañana, con una hora entre uno y otro.
const base = new Date(ahora + 48 * H);
base.setUTCHours(12, 0, 0, 0);
const EQUIPOS = [['Arsenal', 'Chelsea'], ['Liverpool', 'Everton'], ['Spurs', 'Fulham'], ['Leeds', 'Burnley'], ['Wolves', 'Villa'], ['Brighton', 'Palace']];

for (const [i, [local, visitante]] of EQUIPOS.entries()) {
  const id = `epl-${local.toLowerCase()}`;
  const inicio = iso(base.getTime() + i * H);
  const lid = local.slice(0, 3).toLowerCase();
  const vid = visitante.slice(0, 3).toLowerCase();
  db.prepare(
    `INSERT INTO fb_upcoming (id, league, commence_time, home_name, away_name, home_id, away_id, odds_home, odds_draw, odds_away, books, source, updated_at)
     VALUES (?, 'epl', ?, ?, ?, ?, ?, 2.5, 3.4, 3.0, 6, 'live', ?)`,
  ).run(id, inicio, local, visitante, lid, vid, iso(ahora - 30 * 60_000));
  db.prepare(
    `INSERT INTO fb_prediction_log (match_key, league, upcoming_id, commence_time, home_id, away_id, home_name, away_name,
       prob_home, prob_draw, prob_away, shown_home, shown_draw, shown_away,
       market_prob_home, market_prob_draw, market_prob_away, reliability, predicted_at)
     VALUES (?, 'epl', ?, ?, ?, ?, ?, ?, 0.54, 0.24, 0.22, 0.52, 0.25, 0.23, 0.385, 0.283, 0.332, 'high', ?)`,
  ).run(`epl|${lid}|${vid}`, id, inicio, lid, vid, local, visitante, iso(ahora - 1 * H));
  db.prepare(
    `INSERT INTO prediction_assessments (sport, match_key, event_id, commence_time, assessed_at, probs, decision, selection, odds, edge,
       stake_factor, confidence, data_quality, uncertainty_pp, stability, stability_pp, disagreement, disagreement_pp, market_quality,
       edge_vanish, ood, regime, reasons, model_version)
     VALUES ('football', ?, ?, ?, ?, '[0.52,0.25,0.23]', 'BET', 0, 2.5, 0.3, 1, 'ALTA', 90, 3,
       'ALTA', 2, 'BAJO', 2, 'ALTA', 0.01, '[]', 'temporada', '[]', 'football-x')`,
  ).run(`epl|${lid}|${vid}`, id, inicio, iso(ahora - 10 * 60_000));
}

test('A6: el banco de papel respeta los topes por día y por liga de la política', () => {
  const p = politica().staking;
  assert.equal(p.maxExposurePerDay, 0.06);
  assert.equal(p.maxExposurePerLeague, 0.05);
  const r = place();
  const abiertas = db.prepare("SELECT stake, league, commence_time FROM paper_bets WHERE status = 'pending'").all() as { stake: number; league: string; commence_time: string }[];
  const total = abiertas.reduce((s, a) => s + a.stake, 0);
  assert.ok(abiertas.length >= 2, `colocó ${abiertas.length}: ${r.detalle.join(' | ')}`);
  assert.ok(total <= 1000 * p.maxExposurePerLeague + 1e-9, `${total} en la EPL con tope ${1000 * p.maxExposurePerLeague}: ${r.detalle.join(' | ')}`);
  assert.ok(r.detalle.some((d) => /tope por liga/.test(d)), `el motivo se dice: ${r.detalle.join(' | ')}`);
  // Y la pasada lo cuenta entre los rechazos.
  const pasada = db.prepare("SELECT value FROM settings WHERE key = 'paper.ultima_pasada'").get() as { value: string } | undefined;
  if (pasada) assert.match(pasada.value, /tope por liga/);
});
