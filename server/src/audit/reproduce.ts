// Reproducir una predicción o apuesta: TODO lo que se guardó en su momento, y qué falta.
//
// No se recalcula nada. Si el código actual es otra versión, se dice; si una entrada del
// modelo no se guardó (las predicciones anteriores a las instantáneas no tienen sus
// entradas), se dice «no guardado» en vez de reconstruirla con los datos de hoy, que
// serían otros y se leerían como si fueran los de entonces.
//
// Identificadores aceptados:
//   apuesta:<id> (o solo el número)   una apuesta de papel
//   senal:<id>                        una señal de edge
//   evaluacion:<id>                   una evaluación de confianza
//   <deporte>:<clave del partido>     la predicción registrada de un partido

import { getDb } from '../db.ts';
import { versionsFor } from '../versions.ts';
import { aFecha } from '../prematch/snapshots.ts';
import { isSportId, type SportId } from '../sports.ts';

export interface Reproduccion {
  encontrado: boolean;
  campos: [string, string][];
  avisos: string[];
}

const NO = 'no guardado';
const pc = (x: unknown) => (x == null ? NO : `${(Number(x) * 100).toFixed(2)} %`);
const v = (x: unknown) => (x == null || x === '' ? NO : String(x));

/** Las entradas del modelo guardadas EN o ANTES de `at` (nunca posteriores). */
function entradasA(sport: string, key: string, at: string): string {
  const f = aFecha(sport, key, at);
  if (!f) return 'no guardadas (sin instantánea anterior a ese momento)';
  return `${Object.values(f.entradas).map((e) => `${e.etiqueta} = ${e.valor ?? 'sin dato'}`).join('; ')} (instantánea de ${f.captured_at})`;
}

function versionActual(sport: string, guardada: unknown, avisos: string[]): void {
  if (!isSportId(sport)) return;
  const actual = versionsFor(sport as SportId).model_version;
  if (guardada && guardada !== actual) {
    avisos.push(`El código actual es otra versión (${actual}). No se reconstruye nada con él: lo de arriba es lo que se guardó.`);
  }
}

export function reproducir(id: string): Reproduccion {
  const db = getDb();
  const avisos: string[] = [];
  const [tipo, ...resto] = id.includes(':') ? id.split(':') : ['apuesta', id];
  const valor = resto.join(':');

  if (tipo === 'apuesta') {
    const b = db.prepare('SELECT * FROM paper_bets WHERE id = ?').get(Number(valor)) as Record<string, unknown> | undefined;
    if (!b) return { encontrado: false, campos: [], avisos: [`No hay apuesta de papel ${valor}.`] };
    versionActual(String(b.sport), b.model_version, avisos);
    if (!b.model_version) avisos.push('Apuesta anterior al versionado: sin versiones guardadas.');
    return {
      encontrado: true,
      campos: [
        ['Prediction ID', `apuesta:${b.id} (partido ${b.sport}:${b.match_key})`],
        ['Event', `${b.label} · inicio ${v(b.commence_time)}`],
        ['Timestamp', `predicción ${v(b.prediction_timestamp)} · cuotas ${v(b.odds_timestamp)} · apuesta ${v(b.placed_at)}`],
        ['Model version', v(b.model_version)],
        ['Calibration version', v(b.calibration_version)],
        ['Data version', v(b.data_version)],
        ['Git commit', v(b.git_commit)],
        ['Features available', entradasA(String(b.sport), String(b.match_key), String(b.placed_at))],
        ['Odds available', `apostada ${v(b.odds)} (${v(b.bookmaker)}, ${v(b.books)} casas) · apertura ${v(b.opening_odds)} · señal ${v(b.signal_odds)} · cierre ${v(b.closing_odds)}`],
        ['Raw prediction', pc(b.model_probability_raw)],
        ['Calibrated prediction', pc(b.model_probability_calibrated ?? b.p_model)],
        ['Market probability', `${pc(b.market_probability_no_vig ?? b.p_market)} sin margen · ${pc(b.market_probability_raw)} con margen`],
        ['Edge', pc(b.edge)],
        ['Risk decision', `Kelly ${pc(b.kelly_raw)} × ${v(b.kelly_fraction_used)} · ${pc(b.stake_pct_bankroll)} del banco · confianza ${v(b.confidence)} (datos ${v(b.data_quality)}/100, recorte ×${v(b.trust_stake_factor)}) · grupos ${v(b.correlation_groups)}`],
        ['Bet/no bet', `BET ${Number(b.stake).toFixed(2)} sobre ${Number(b.bankroll_at).toFixed(2)} · estado ${b.status}${b.profit != null ? ` · ${Number(b.profit).toFixed(2)}` : ''}`],
      ],
      avisos,
    };
  }

  if (tipo === 'senal') {
    const s = db.prepare('SELECT * FROM edge_signals WHERE id = ?').get(Number(valor)) as Record<string, unknown> | undefined;
    if (!s) return { encontrado: false, campos: [], avisos: [`No hay señal ${valor}.`] };
    versionActual(String(s.sport), s.model_version, avisos);
    return {
      encontrado: true,
      campos: [
        ['Prediction ID', `senal:${s.id}`],
        ['Event', `${s.sport} · ${s.event_id} · inicio ${v(s.commence_time)}`],
        ['Timestamp', `señal ${v(s.created_at)} · predicción ${v(s.prediction_timestamp)} · cuotas ${v(s.odds_timestamp)}`],
        ['Model version', v(s.model_version)],
        ['Calibration version', v(s.calibration_version)],
        ['Data version', v(s.data_version)],
        ['Git commit', v(s.git_commit)],
        ['Features available', NO + ' en la señal (ver la instantánea del partido)'],
        ['Odds available', `${v(s.odds)} · cierre ${v(s.closing_odds)} · CLV ${pc(s.clv)}`],
        ['Raw prediction', pc(s.model_probability_raw)],
        ['Calibrated prediction', pc(s.model_probability_calibrated)],
        ['Market probability', pc(s.market_probability_no_vig)],
        ['Edge', pc(s.edge)],
        ['Risk decision', v(s.reason) === NO ? 'pasó la política' : String(s.reason)],
        ['Bet/no bet', `${s.decision === 'apostada' ? 'BET' : 'NO BET'} · importe ${v(s.stake)}`],
      ],
      avisos,
    };
  }

  if (tipo === 'evaluacion') {
    const a = db.prepare('SELECT * FROM prediction_assessments WHERE id = ?').get(Number(valor)) as Record<string, unknown> | undefined;
    if (!a) return { encontrado: false, campos: [], avisos: [`No hay evaluación ${valor}.`] };
    versionActual(String(a.sport), a.model_version, avisos);
    return {
      encontrado: true,
      campos: [
        ['Prediction ID', `evaluacion:${a.id} (partido ${a.sport}:${a.match_key})`],
        ['Event', `inicio ${a.commence_time}`],
        ['Timestamp', String(a.assessed_at)],
        ['Model version', v(a.model_version)],
        ['Features available', entradasA(String(a.sport), String(a.match_key), String(a.assessed_at))],
        ['Odds available', v(a.odds)],
        ['Calibrated prediction', v(a.probs)],
        ['Edge', pc(a.edge)],
        ['Risk decision', `confianza ${a.confidence} · datos ${a.data_quality}/100 · incertidumbre ±${a.uncertainty_pp} pp · estabilidad ${a.stability} · desacuerdo ${a.disagreement} · mercado ${a.market_quality} · razones ${a.reasons}`],
        ['Bet/no bet', `${a.decision} (recorte ×${v(a.stake_factor)})`],
      ],
      avisos,
    };
  }

  if (isSportId(tipo)) {
    const tabla = { tennis: ['prediction_log', 'match_key'], football: ['fb_prediction_log', 'match_key'], basketball: ['bb_prediction_log', 'game_key'], baseball: ['bsb_prediction_log', 'match_key'], nfl: ['naf_prediction_log', 'match_key'], nhl: ['nhl_prediction_log', 'match_key'], ufc: ['ufc_prediction_log', 'match_key'] }[tipo];
    const r = db.prepare(`SELECT * FROM ${tabla[0]} WHERE ${tabla[1]} = ?`).get(valor) as Record<string, unknown> | undefined;
    if (!r) return { encontrado: false, campos: [], avisos: [`No hay predicción registrada de ${tipo}:${valor}.`] };
    versionActual(tipo, r.model_version, avisos);
    if (!r.model_version) avisos.push('Predicción anterior al versionado: sin versiones guardadas.');
    const raw = r.prob1 ?? r.prob_home;
    const cal = r.shown_home ?? raw;
    const mk = r.market_prob1 ?? r.market_prob_home;
    return {
      encontrado: true,
      campos: [
        ['Prediction ID', `${tipo}:${valor}`],
        ['Event', `${v(r.p1_name ?? r.home_name)} vs ${v(r.p2_name ?? r.away_name)} · inicio ${v(r.commence_time)}`],
        ['Timestamp', String(r.predicted_at)],
        ['Model version', v(r.model_version)],
        ['Calibration version', v(r.calibration_version)],
        ['Data version', v(r.data_version)],
        ['Git commit', v(r.git_commit)],
        ['Features available', entradasA(tipo, valor, String(r.predicted_at))],
        ['Odds available', NO + ' en el registro (solo la probabilidad de mercado)'],
        ['Raw prediction', pc(raw)],
        ['Calibrated prediction', pc(cal)],
        ['Market probability', pc(mk)],
        ['Edge', mk == null ? NO : `${((Number(cal) - Number(mk)) * 100).toFixed(2)} pp sobre el mercado`],
        ['Risk decision', 'ver evaluacion:<id> o apuesta:<id> de este partido'],
        ['Bet/no bet', (db.prepare('SELECT COUNT(*) AS n FROM paper_bets WHERE match_key = ?').get(valor) as { n: number }).n ? 'BET (hay apuesta de papel)' : 'sin apuesta de papel'],
      ],
      avisos,
    };
  }
  return { encontrado: false, campos: [], avisos: [`Identificador no reconocido: ${id}. Usa apuesta:<id>, senal:<id>, evaluacion:<id> o <deporte>:<clave>.`] };
}
