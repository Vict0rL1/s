// La vida entera de una apuesta de papel, y todo lo que NO se le puede hacer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { getDb } = await import('../db.ts');
const { place, settle, captureClosing, resumen, DIAS_CANCELACION } = await import('./bankroll.ts');
const { recordOddsResponse } = await import('../odds/snapshots.ts');

const db = getDb();
const H = 3_600_000;
const ahora = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const INICIO = iso(ahora + 48 * H);

/** Una respuesta del proveedor para el partido, con la cuota del local que se pase. */
function snapshot(at: number, local: number) {
  recordOddsResponse('soccer_epl', 'h2h', {
    fetchedAt: iso(at),
    events: [
      {
        id: 'epl-arsenal-chelsea',
        sport_key: 'soccer_epl',
        commence_time: INICIO,
        home_team: 'Arsenal',
        away_team: 'Chelsea',
        bookmakers: [
          { key: 'pinnacle', title: 'P', markets: [{ key: 'h2h', outcomes: [{ name: 'Arsenal', price: local }, { name: 'Draw', price: 3.4 }, { name: 'Chelsea', price: 3.0 }] }] },
        ],
      },
    ],
  });
}

// El partido: fila de próximos con cuotas REALES, y la predicción registrada por el modelo.
snapshot(ahora - 3 * H, 2.6); // apertura
snapshot(ahora - 1 * H, 2.5); // cuando el modelo registró su predicción
db.prepare(
  `INSERT INTO fb_upcoming (id, league, commence_time, home_name, away_name, home_id, away_id, odds_home, odds_draw, odds_away, books, source, updated_at)
   VALUES ('epl-arsenal-chelsea', 'epl', ?, 'Arsenal', 'Chelsea', 'ars', 'che', 2.5, 3.4, 3.0, 6, 'live', ?)`,
).run(INICIO, iso(ahora - 30 * 60_000));
db.prepare(
  `INSERT INTO fb_prediction_log (match_key, league, upcoming_id, commence_time, home_id, away_id, home_name, away_name,
     prob_home, prob_draw, prob_away, shown_home, shown_draw, shown_away,
     market_prob_home, market_prob_draw, market_prob_away, reliability, predicted_at)
   VALUES ('epl|ars|che|x', 'epl', 'epl-arsenal-chelsea', ?, 'ars', 'che', 'Arsenal', 'Chelsea',
     0.54, 0.24, 0.22, 0.52, 0.25, 0.23, 0.385, 0.283, 0.332, 'high', ?)`,
).run(INICIO, iso(ahora - 1 * H));

const apuesta = () => db.prepare("SELECT * FROM paper_bets WHERE event_id = 'epl-arsenal-chelsea'").get() as Record<string, unknown>;

test('se registra con TODO lo que se sabía al apostar', () => {
  const r = place();
  assert.equal(r.colocadas, 1, JSON.stringify(r));
  const a = apuesta();
  assert.equal(a.selection, 'Arsenal');
  assert.equal(a.provider_selection, 'Arsenal');
  assert.equal(a.odds, 2.5);
  assert.equal(a.model_probability_calibrated, 0.52, 'se decide con la probabilidad ENSEÑADA');
  assert.equal(a.model_probability_raw, 0.54);
  assert.equal(a.p_model, 0.52);
  assert.equal(a.market_probability_no_vig, 0.385);
  assert.ok(Math.abs((a.market_probability_raw as number) - 0.4) < 1e-12);
  assert.ok((a.edge as number) > 0);
  assert.equal(a.opening_odds, 2.6, 'apertura: el primer snapshot');
  assert.equal(a.signal_odds, 2.5, 'señal: el mercado cuando el modelo registró la predicción');
  assert.equal(a.kelly_fraction_used, 0.25);
  assert.ok((a.kelly_raw as number) > 0);
  assert.ok((a.stake_pct_bankroll as number) > 0 && (a.stake_pct_bankroll as number) <= 0.02, 'tope del 2 % por evento');
  assert.equal(a.bankroll_at, 1000);
  for (const c of ['model_version', 'model_config_version', 'calibration_version', 'data_version', 'strategy_version', 'prediction_timestamp', 'odds_timestamp']) {
    assert.ok(a[c], `falta ${c}`);
  }
  assert.match(String(a.model_version), /^football-[0-9a-f]{12}$/);
  assert.equal(a.status, 'pending');
  assert.equal(a.closing_odds, null, 'el cierre no puede conocerse al apostar');
});

test('no se vuelve a apostar el mismo partido', () => {
  assert.equal(place().colocadas, 0);
});

// ---------------------------------------------------------------------------
// TESTS NEGATIVOS: lo que la base de datos NO permite
// ---------------------------------------------------------------------------
for (const [campo, valor] of [
  ['odds', 3.1],
  ['p_model', 0.9],
  ['model_probability_calibrated', 0.9],
  ['stake', 500],
  ['model_version', 'football-otro'],
  ['opening_odds', 9],
  ['placed_at', '2020-01-01T00:00:00Z'],
] as const) {
  test(`no se puede cambiar ${campo} de una apuesta registrada`, () => {
    assert.throws(
      () => db.prepare(`UPDATE paper_bets SET ${campo} = ? WHERE event_id = 'epl-arsenal-chelsea'`).run(valor),
      /congelados/,
    );
  });
}

test('una apuesta registrada no se borra', () => {
  assert.throws(() => db.prepare("DELETE FROM paper_bets WHERE event_id = 'epl-arsenal-chelsea'").run(), /no se borra/);
});

test('no se registra una apuesta después del inicio, ni con datos del futuro', () => {
  const alta = (placed: string, extra = '') =>
    db
      .prepare(
        `INSERT INTO paper_bets (placed_at, sport, match_key, event_id, label, selection, p_model, p_market, odds, stake, bankroll_at, commence_time${extra ? ', closing_odds' : ''})
         VALUES (?, 'football', 'k', ?, 'x', 'y', 0.5, 0.4, 2.0, 10, 1000, ?${extra ? ', 1.9' : ''})`,
      )
      .run(placed, `tarde-${placed}-${extra}`, INICIO);
  assert.throws(() => alta(iso(ahora + 49 * H)), /alta inválida/);
  assert.throws(() => alta(iso(ahora), 'cierre'), /alta inválida/, 'una apuesta no puede nacer con la cuota de cierre');
});

// ---------------------------------------------------------------------------
// Cierre y liquidación
// ---------------------------------------------------------------------------
test('el cierre sale de los snapshots y NO toca la cuota apostada', () => {
  snapshot(Date.parse(INICIO) - 10 * 60_000, 2.3); // la línea se movió a favor del Arsenal
  assert.equal(captureClosing(new Date(ahora)).fijados, 0, 'antes del inicio no hay cierre');
  captureClosing(new Date(Date.parse(INICIO) + H));
  const a = apuesta();
  assert.equal(a.closing_odds, 2.3);
  assert.equal(a.odds, 2.5, 'la cuota de la apuesta sigue siendo la de entonces');
  assert.ok(Math.abs((a.clv as number) - (2.5 / 2.3 - 1)) < 1e-12, 'CLV positivo: se apostó mejor que el cierre');
  assert.throws(() => db.prepare("UPDATE paper_bets SET closing_odds = 2.0 WHERE event_id = 'epl-arsenal-chelsea'").run(), /una sola vez/);
});

test('se liquida UNA vez, aunque pierda sigue constando la buena línea', () => {
  db.prepare("UPDATE fb_prediction_log SET home_goals = 0, away_goals = 1, resolved_at = ? WHERE match_key = 'epl|ars|che|x'").run(iso(ahora));
  const r = settle(new Date(Date.parse(INICIO) + 3 * H));
  assert.equal(r.liquidadas, 1);
  const a = apuesta();
  assert.equal(a.status, 'lost');
  assert.equal(a.profit, -(a.stake as number));
  assert.equal(a.roi, -1);
  assert.equal(a.event_result, 'Arsenal 0-1 Chelsea');
  assert.equal(a.bankroll_after, Math.round((1000 - (a.stake as number)) * 100) / 100);
  assert.ok((a.clv as number) > 0, 'perdió, y aun así consiguió mejor precio que el cierre');
  assert.throws(() => db.prepare("UPDATE paper_bets SET status = 'won', profit = 10 WHERE event_id = 'epl-arsenal-chelsea'").run(), /no se vuelve a liquidar/);
  const s = resumen();
  assert.equal(s.conCierre, 1);
  assert.ok(s.clvMedio != null && s.clvMedio > 0);
});

test('sin resultado mucho después del inicio: cancelada y se devuelve el importe', () => {
  const inicio = iso(ahora - (DIAS_CANCELACION + 2) * 24 * H);
  db.prepare(
    `INSERT INTO paper_bets (placed_at, sport, match_key, event_id, label, selection, p_model, p_market, odds, stake, bankroll_at, commence_time)
     VALUES (?, 'football', 'nadie|x', 'fantasma', 'A vs B', 'A', 0.5, 0.4, 2.0, 10, 1000, ?)`,
  ).run(iso(Date.parse(inicio) - H), inicio);
  settle(new Date(ahora));
  const a = db.prepare("SELECT status, profit FROM paper_bets WHERE event_id = 'fantasma'").get() as { status: string; profit: number };
  assert.deepEqual({ ...a }, { status: 'cancelled', profit: 0 });
});

test('un estado que no existe se rechaza', () => {
  db.prepare(
    `INSERT INTO paper_bets (placed_at, sport, match_key, event_id, label, selection, p_model, p_market, odds, stake, bankroll_at)
     VALUES (?, 'nfl', 'k2', 'estado', 'x', 'y', 0.5, 0.4, 2.0, 10, 1000)`,
  ).run(iso(ahora));
  assert.throws(() => db.prepare("UPDATE paper_bets SET status = 'ganada' WHERE event_id = 'estado'").run(), /estado desconocido/);
});

// ---------------------------------------------------------------------------
// Las predicciones: lo que el modelo dijo no desaparece ni se reescribe
// ---------------------------------------------------------------------------
test('una predicción registrada no se reescribe ni se borra', () => {
  assert.throws(() => db.prepare("UPDATE fb_prediction_log SET prob_home = 0.9 WHERE match_key = 'epl|ars|che|x'").run(), /no se reescribe/);
  assert.throws(() => db.prepare("UPDATE fb_prediction_log SET shown_home = 0.9 WHERE match_key = 'epl|ars|che|x'").run(), /no se reescribe/);
  assert.throws(() => db.prepare("DELETE FROM fb_prediction_log WHERE match_key = 'epl|ars|che|x'").run(), /no se borra/);
  // Lo que SÍ se puede: anotar el resultado (ya se hizo arriba) sin tocar la predicción.
  const p = db.prepare("SELECT prob_home, home_goals FROM fb_prediction_log WHERE match_key = 'epl|ars|che|x'").get() as { prob_home: number; home_goals: number };
  assert.deepEqual({ ...p }, { prob_home: 0.54, home_goals: 0 });
});

// ---------------------------------------------------------------------------
// Señales de edge: todo lo evaluado, apostado o no
// ---------------------------------------------------------------------------
test('la apuesta dejó su señal «apostada», con el cierre y el CLV fijados', () => {
  const s = db.prepare("SELECT * FROM edge_signals WHERE event_id = 'epl-arsenal-chelsea'").all() as Record<string, unknown>[];
  assert.equal(s.length, 1);
  assert.equal(s[0].decision, 'apostada');
  assert.equal(s[0].selection, 'Arsenal');
  assert.ok(s[0].paper_bet_id != null);
  assert.equal(s[0].closing_odds, 2.3, 'settle() también cierra las señales');
  assert.ok(Math.abs((s[0].clv as number) - (2.5 / 2.3 - 1)) < 1e-12);
});

test('un partido rechazado deja señal «rechazada» con el motivo, y no se duplica', () => {
  const inicio = iso(ahora + 30 * H);
  db.prepare(
    `INSERT INTO fb_upcoming (id, league, commence_time, home_name, away_name, home_id, away_id, odds_home, odds_draw, odds_away, books, source, updated_at)
     VALUES ('sin-ventaja', 'epl', ?, 'Leeds', 'Fulham', 'lee', 'ful', 2.05, 3.4, 3.8, 5, 'live', ?)`,
  ).run(inicio, iso(ahora));
  // El modelo coincide con el mercado: no hay ventaja que apostar.
  db.prepare(
    `INSERT INTO fb_prediction_log (match_key, league, upcoming_id, commence_time, home_id, away_id, home_name, away_name,
       prob_home, prob_draw, prob_away, market_prob_home, market_prob_draw, market_prob_away, reliability, predicted_at)
     VALUES ('epl|lee|ful|x', 'epl', 'sin-ventaja', ?, 'lee', 'ful', 'Leeds', 'Fulham', 0.47, 0.28, 0.25, 0.48, 0.28, 0.24, 'high', ?)`,
  ).run(inicio, iso(ahora - H));
  place();
  place(); // la misma evaluación dos veces: una sola señal
  const s = db.prepare("SELECT decision, reason, stake FROM edge_signals WHERE event_id = 'sin-ventaja'").all() as Record<string, unknown>[];
  assert.equal(s.length, 1);
  assert.equal(s[0].decision, 'rechazada');
  assert.equal(s[0].reason, 'ventaja insuficiente');
  assert.equal(s[0].stake, 0);
});

test('una señal registrada no se reescribe ni se borra', () => {
  assert.throws(() => db.prepare("UPDATE edge_signals SET odds = 9 WHERE event_id = 'sin-ventaja'").run(), /congelada/);
  assert.throws(() => db.prepare("UPDATE edge_signals SET decision = 'apostada' WHERE event_id = 'sin-ventaja'").run(), /congelada/);
  assert.throws(() => db.prepare("DELETE FROM edge_signals WHERE event_id = 'sin-ventaja'").run(), /no se borra/);
});
