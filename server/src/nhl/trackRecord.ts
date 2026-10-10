// El historial en vivo de la NHL: lo que la app dijo ANTES de cada partido que enseñó, y cómo le fue.
//
// El mismo contrato que los otros cinco deportes: la predicción se escribe la PRIMERA vez que se sirve,
// antes del partido, y no se reescribe (`ON CONFLICT DO NOTHING` y los triggers del libro mayor). El
// resultado se anota cuando llega al archivo (`update-data:nhl`).

import { stampPredictionVersions } from '../versions.ts';
import { getDb } from '../db.ts';
import type { NhlPrediction } from './predict.ts';
import type { NhlUpcomingRow } from './repo.ts';

/** Un partido aplazado se busca hasta dos días después de su hora. */
const VENTANA_DIAS = 2;

/** La fecha del partido en Nueva York, que es la del calendario de la NHL. */
export function fechaNhl(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/**
 * La clave de un partido: fecha (en Nueva York) y los dos equipos. Los mismos dos equipos juegan hasta
 * cuatro veces por temporada, así que la fecha va dentro; la del calendario y la de la casa de apuestas
 * son el mismo instante, así que dan la misma clave y el partido no se registra dos veces.
 */
export function matchKey(row: Pick<NhlUpcomingRow, 'commence_time' | 'home_id' | 'away_id' | 'home_name' | 'away_name'>): string {
  return `nhl|${fechaNhl(row.commence_time)}|${row.away_id ?? row.away_name}|${row.home_id ?? row.home_name}`;
}

export function logNhlPrediction(row: NhlUpcomingRow, p: NhlPrediction): void {
  if (!row.home_id || !row.away_id) return;
  const mk = matchKey(row);
  const ins = getDb()
    .prepare(
      `INSERT INTO nhl_prediction_log
         (match_key, league, upcoming_id, commence_time, season, home_id, away_id, home_name, away_name,
          prob_home, prob_draw60, shown_home, market_prob_home, expected_home_goals, expected_away_goals,
          total_line, prob_over, reliability, predicted_at)
       VALUES (?, 'nhl', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (match_key) DO NOTHING`,
    )
    .run(
      mk,
      row.id,
      row.commence_time,
      row.season,
      row.home_id,
      row.away_id,
      row.home_name,
      row.away_name,
      p.model.home,
      p.regulation.draw,
      p.final.home,
      p.market.market?.home ?? null,
      p.goals.home,
      p.goals.away,
      p.total.line,
      p.total.over,
      p.reliability.level,
      new Date().toISOString(),
    );
  stampPredictionVersions('nhl_prediction_log', 'match_key', mk, 'nhl', ins);
  // El partido puede cambiar de fila: del calendario ('nhl-…') a la de la casa ('odds-…') cuando
  // llega el precio. La predicción NO cambia (la primera manda); solo el puntero a dónde está el
  // partido ahora, que es como lo encuentran «Hoy», Destacados y el banco de papel.
  if (Number(ins.changes) === 0) {
    getDb().prepare('UPDATE nhl_prediction_log SET upcoming_id = ? WHERE match_key = ? AND resolved_at IS NULL AND upcoming_id IS NOT ?').run(row.id, mk, row.id);
  }
}

/** Anota el resultado de las predicciones cuyo partido ya está en el archivo. */
export function resolveNhlPredictions(): { resolved: number } {
  const d = getDb();
  const pendientes = d.prepare('SELECT match_key, home_id, away_id, commence_time FROM nhl_prediction_log WHERE resolved_at IS NULL').all() as {
    match_key: string;
    home_id: string;
    away_id: string;
    commence_time: string | null;
  }[];
  if (!pendientes.length) return { resolved: 0 };
  const buscar = d.prepare('SELECT id, home_goals, away_goals FROM nhl_games WHERE home_id = ? AND away_id = ? AND game_date BETWEEN ? AND ? ORDER BY game_date LIMIT 1');
  const anotar = d.prepare('UPDATE nhl_prediction_log SET home_goals = ?, away_goals = ?, game_id = ?, resolved_at = ? WHERE match_key = ?');
  let resolved = 0;
  for (const p of pendientes) {
    if (!p.commence_time || Number.isNaN(Date.parse(p.commence_time))) continue;
    const desde = fechaNhl(p.commence_time);
    const hasta = fechaNhl(new Date(Date.parse(p.commence_time) + VENTANA_DIAS * 86_400_000).toISOString());
    const g = buscar.get(p.home_id, p.away_id, desde, hasta) as { id: number; home_goals: number; away_goals: number } | undefined;
    if (!g) continue;
    anotar.run(g.home_goals, g.away_goals, g.id, new Date().toISOString(), p.match_key);
    resolved++;
  }
  return { resolved };
}

export interface NhlTrackRecord {
  resolved: number;
  pending: number;
  accuracy: number | null;
  brier: number | null;
  logLoss: number | null;
  /** Error medio absoluto del total de goles esperado (marcador del acta). */
  totalMae: number | null;
  calibration: { label: string; n: number; predicted: number; observed: number }[];
  vsMarket: { n: number; modelBrier: number; marketBrier: number; modelAccuracy: number; marketAccuracy: number } | null;
  recent: { date: string | null; home: string | null; away: string | null; probHome: number; homeGoals: number; awayGoals: number; hit: boolean }[];
}

export function getNhlTrackRecord(): NhlTrackRecord {
  const d = getDb();
  const pending = (d.prepare('SELECT COUNT(*) AS n FROM nhl_prediction_log WHERE resolved_at IS NULL').get() as { n: number }).n;
  const filas = d
    .prepare(
      `SELECT commence_time, home_name, away_name, prob_home, prob_draw60, shown_home, market_prob_home, expected_home_goals, expected_away_goals, home_goals, away_goals
       FROM nhl_prediction_log WHERE resolved_at IS NOT NULL ORDER BY commence_time DESC`,
    )
    .all() as {
    commence_time: string | null;
    home_name: string | null;
    away_name: string | null;
    prob_home: number;
    prob_draw60: number | null;
    shown_home: number | null;
    market_prob_home: number | null;
    expected_home_goals: number | null;
    expected_away_goals: number | null;
    home_goals: number;
    away_goals: number;
  }[];
  if (!filas.length) return { resolved: 0, pending, accuracy: null, brier: null, logLoss: null, totalMae: null, calibration: [], vsMarket: null, recent: [] };
  let aciertos = 0;
  let brier = 0;
  let ll = 0;
  let totAbs = 0;
  let totN = 0;
  const bandas = [
    { label: '50-60%', lo: 0.5, hi: 0.6 },
    { label: '60-70%', lo: 0.6, hi: 0.7 },
    { label: '70-100%', lo: 0.7, hi: 1.01 },
  ].map((b) => ({ ...b, n: 0, predicted: 0, observed: 0 }));
  const m = { n: 0, modelo: 0, mercado: 0, aModelo: 0, aMercado: 0 };
  for (const r of filas) {
    // Lo que se enseñó (igual que la cruda: la NHL no tiene post-proceso).
    const p = r.shown_home ?? r.prob_home;
    const y = r.home_goals > r.away_goals ? 1 : 0;
    const acierta = (p >= 0.5 ? 1 : 0) === y;
    if (acierta) aciertos++;
    brier += (p - y) ** 2;
    ll -= Math.log(Math.max(1e-9, y ? p : 1 - p));
    if (r.expected_home_goals != null && r.expected_away_goals != null && r.prob_draw60 != null) {
      // El acta suma un gol si se llegó empatado a la prórroga: lo esperado en el acta es λ + λ' + P(empate a 60).
      totAbs += Math.abs(r.expected_home_goals + r.expected_away_goals + r.prob_draw60 - (r.home_goals + r.away_goals));
      totN++;
    }
    const pFav = Math.max(p, 1 - p);
    const favGana = p >= 0.5 ? y : 1 - y;
    const b = bandas.find((x) => pFav >= x.lo && pFav < x.hi);
    if (b) {
      b.n++;
      b.predicted += pFav;
      b.observed += favGana;
    }
    if (r.market_prob_home != null) {
      m.n++;
      m.modelo += (p - y) ** 2;
      m.mercado += (r.market_prob_home - y) ** 2;
      if (acierta) m.aModelo++;
      if ((r.market_prob_home >= 0.5 ? 1 : 0) === y) m.aMercado++;
    }
  }
  const n = filas.length;
  return {
    resolved: n,
    pending,
    accuracy: aciertos / n,
    brier: Number((brier / n).toFixed(4)),
    logLoss: Number((ll / n).toFixed(4)),
    totalMae: totN ? Number((totAbs / totN).toFixed(2)) : null,
    calibration: bandas.filter((b) => b.n).map((b) => ({ label: b.label, n: b.n, predicted: Number((b.predicted / b.n).toFixed(3)), observed: Number((b.observed / b.n).toFixed(3)) })),
    vsMarket: m.n
      ? { n: m.n, modelBrier: Number((m.modelo / m.n).toFixed(4)), marketBrier: Number((m.mercado / m.n).toFixed(4)), modelAccuracy: Number((m.aModelo / m.n).toFixed(3)), marketAccuracy: Number((m.aMercado / m.n).toFixed(3)) }
      : null,
    recent: filas.slice(0, 10).map((r) => {
      const p = r.shown_home ?? r.prob_home;
      return { date: r.commence_time, home: r.home_name, away: r.away_name, probHome: p, homeGoals: r.home_goals, awayGoals: r.away_goals, hit: (p >= 0.5 ? 1 : 0) === (r.home_goals > r.away_goals ? 1 : 0) };
    }),
  };
}
