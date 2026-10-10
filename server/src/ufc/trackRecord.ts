// El historial en vivo de la UFC: lo que la app dijo ANTES de cada pelea que enseñó, y cómo le fue.
//
// El mismo contrato que los otros seis deportes: la predicción se escribe la PRIMERA vez que se sirve,
// antes de la pelea, y no se reescribe (`ON CONFLICT DO NOTHING` y los triggers del libro mayor). El
// resultado se anota cuando la pelea llega al archivo (`update-data:ufc`, que la fuente actualiza cada
// semana: el resultado puede tardar unos días).

import { stampPredictionVersions } from '../versions.ts';
import { getDb } from '../db.ts';
import type { UfcPrediction } from './predict.ts';
import type { UfcUpcomingRow } from './repo.ts';

/** Un evento se busca desde el día anterior (husos: Abu Dabi, Australia…) hasta dos días después. */
const ANTES_DIAS = 1;
const DESPUES_DIAS = 2;

/** La fecha de la pelea en Nueva York: estable aunque la casa mueva la hora unos minutos. */
export function fechaUfc(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/** La clave de una pelea: la fecha y los dos ids en orden canónico (A < B). */
export function matchKey(row: Pick<UfcUpcomingRow, 'commence_time' | 'home_id' | 'away_id' | 'home_name' | 'away_name'>): string {
  return `ufc|${fechaUfc(row.commence_time)}|${row.home_id ?? row.home_name}|${row.away_id ?? row.away_name}`;
}

export function logUfcPrediction(row: UfcUpcomingRow, p: UfcPrediction): void {
  if (!row.home_id || !row.away_id) return;
  const mk = matchKey(row);
  const ins = getDb()
    .prepare(
      `INSERT INTO ufc_prediction_log
         (match_key, league, upcoming_id, commence_time, home_id, away_id, home_name, away_name,
          prob_home, shown_home, market_prob_home, rasgos, reliability, predicted_at)
       VALUES (?, 'ufc', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (match_key) DO NOTHING`,
    )
    .run(
      mk,
      row.id,
      row.commence_time,
      row.home_id,
      row.away_id,
      row.home_name,
      row.away_name,
      p.model.home,
      p.final.home,
      p.market.market?.home ?? null,
      JSON.stringify(p.rasgos),
      p.reliability.level,
      new Date().toISOString(),
    );
  stampPredictionVersions('ufc_prediction_log', 'match_key', mk, 'ufc', ins);
  // La casa puede cambiar el id del evento: la predicción NO cambia (la primera manda); solo el
  // puntero a la fila actual, que es como la encuentran Hoy, Destacados y el banco de papel.
  if (Number(ins.changes) === 0) {
    getDb().prepare('UPDATE ufc_prediction_log SET upcoming_id = ? WHERE match_key = ? AND resolved_at IS NULL AND upcoming_id IS NOT ?').run(row.id, mk, row.id);
  }
}

const desplazar = (ymd: string, dias: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + dias * 86_400_000).toISOString().slice(0, 10);

/** Anota el resultado de las predicciones cuya pelea ya está en el archivo. */
export function resolveUfcPredictions(): { resolved: number } {
  const d = getDb();
  const pendientes = d.prepare('SELECT match_key, home_id, away_id, commence_time FROM ufc_prediction_log WHERE resolved_at IS NULL').all() as {
    match_key: string;
    home_id: string;
    away_id: string;
    commence_time: string | null;
  }[];
  if (!pendientes.length) return { resolved: 0 };
  const buscar = d.prepare(
    `SELECT id, luchador_a, resultado, metodo FROM ufc_fights
      WHERE ambigua = 0 AND ((luchador_a = ? AND luchador_b = ?) OR (luchador_a = ? AND luchador_b = ?)) AND fecha BETWEEN ? AND ?
      ORDER BY fecha LIMIT 1`,
  );
  const anotar = d.prepare('UPDATE ufc_prediction_log SET home_score = ?, away_score = ?, outcome = ?, metodo = ?, fight_id = ?, resolved_at = ? WHERE match_key = ?');
  let resolved = 0;
  for (const p of pendientes) {
    if (!p.commence_time || Number.isNaN(Date.parse(p.commence_time))) continue;
    const dia = fechaUfc(p.commence_time);
    const f = buscar.get(p.home_id, p.away_id, p.away_id, p.home_id, desplazar(dia, -ANTES_DIAS), desplazar(dia, DESPUES_DIAS)) as
      | { id: string; luchador_a: string; resultado: 'A' | 'B' | 'EMPATE' | 'NC'; metodo: string | null }
      | undefined;
    if (!f) continue;
    // `outcome` desde el lado de la predicción: A es home_id.
    let outcome: 'A' | 'B' | 'EMPATE' | 'NC' = f.resultado;
    if ((f.resultado === 'A' || f.resultado === 'B') && f.luchador_a !== p.home_id) outcome = f.resultado === 'A' ? 'B' : 'A';
    const [hs, as] = outcome === 'A' ? [1, 0] : outcome === 'B' ? [0, 1] : [0, 0];
    anotar.run(hs, as, outcome, f.metodo?.trim() || null, f.id, new Date().toISOString(), p.match_key);
    resolved++;
  }
  return { resolved };
}

export interface UfcTrackRecord {
  resolved: number;
  /** De las resueltas, empates y «sin resultado»: no se puntúan. */
  sinGanador: number;
  pending: number;
  accuracy: number | null;
  brier: number | null;
  logLoss: number | null;
  calibration: { label: string; n: number; predicted: number; observed: number }[];
  vsMarket: { n: number; modelBrier: number; marketBrier: number; modelAccuracy: number; marketAccuracy: number } | null;
  recent: { date: string | null; home: string | null; away: string | null; probHome: number; outcome: 'A' | 'B'; method: string | null; hit: boolean }[];
}

export function getUfcTrackRecord(): UfcTrackRecord {
  const d = getDb();
  const pending = (d.prepare('SELECT COUNT(*) AS n FROM ufc_prediction_log WHERE resolved_at IS NULL').get() as { n: number }).n;
  const sinGanador = (d.prepare("SELECT COUNT(*) AS n FROM ufc_prediction_log WHERE outcome IN ('EMPATE', 'NC')").get() as { n: number }).n;
  const filas = d
    .prepare(
      `SELECT commence_time, home_name, away_name, prob_home, shown_home, market_prob_home, outcome, metodo
       FROM ufc_prediction_log WHERE outcome IN ('A', 'B') ORDER BY commence_time DESC`,
    )
    .all() as { commence_time: string | null; home_name: string | null; away_name: string | null; prob_home: number; shown_home: number | null; market_prob_home: number | null; outcome: 'A' | 'B'; metodo: string | null }[];
  if (!filas.length) return { resolved: sinGanador, sinGanador, pending, accuracy: null, brier: null, logLoss: null, calibration: [], vsMarket: null, recent: [] };
  let aciertos = 0;
  let brier = 0;
  let ll = 0;
  const bandas = [
    { label: '50-60%', lo: 0.5, hi: 0.6 },
    { label: '60-70%', lo: 0.6, hi: 0.7 },
    { label: '70-100%', lo: 0.7, hi: 1.01 },
  ].map((b) => ({ ...b, n: 0, predicted: 0, observed: 0 }));
  const m = { n: 0, modelo: 0, mercado: 0, aModelo: 0, aMercado: 0 };
  for (const r of filas) {
    const p = r.shown_home ?? r.prob_home;
    const y = r.outcome === 'A' ? 1 : 0;
    const acierta = (p >= 0.5 ? 1 : 0) === y;
    if (acierta) aciertos++;
    brier += (p - y) ** 2;
    ll -= Math.log(Math.max(1e-9, y ? p : 1 - p));
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
    resolved: n + sinGanador,
    sinGanador,
    pending,
    accuracy: aciertos / n,
    brier: Number((brier / n).toFixed(4)),
    logLoss: Number((ll / n).toFixed(4)),
    calibration: bandas.filter((b) => b.n).map((b) => ({ label: b.label, n: b.n, predicted: Number((b.predicted / b.n).toFixed(3)), observed: Number((b.observed / b.n).toFixed(3)) })),
    vsMarket: m.n
      ? { n: m.n, modelBrier: Number((m.modelo / m.n).toFixed(4)), marketBrier: Number((m.mercado / m.n).toFixed(4)), modelAccuracy: Number((m.aModelo / m.n).toFixed(3)), marketAccuracy: Number((m.aMercado / m.n).toFixed(3)) }
      : null,
    recent: filas.slice(0, 10).map((r) => {
      const p = r.shown_home ?? r.prob_home;
      return { date: r.commence_time, home: r.home_name, away: r.away_name, probHome: p, outcome: r.outcome, method: r.metodo, hit: (p >= 0.5 ? 1 : 0) === (r.outcome === 'A' ? 1 : 0) };
    }),
  };
}
