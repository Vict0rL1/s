// Instantáneas pre-partido: qué decía el modelo a T-24h, T-6h, T-1h y justo antes de
// empezar, y por qué cambió. Esquema y garantías en prematch/schema.ts.
//
// ===========================================================================
// CUÁNDO SE GUARDA UNA FILA
// ===========================================================================
// Como los snapshots de cuotas: solo lo que cambia. Una fila nueva cuando
//   · es la primera de ese partido;
//   · alguna probabilidad (del modelo o del mercado) se movió 0,1 pp o más;
//   · cambió una de las entradas que el modelo usa (abridor, QB, bajas, ratings…);
//   · cambió la versión del modelo o de los datos;
//   · o se cruzó una marca (24 h, 6 h, 1 h antes) desde la última fila, aunque nada
//     cambiara: así cada marca tiene una observación propia que prueba que a esa hora
//     el modelo seguía diciendo lo mismo, en vez de suponerlo.
//
// ===========================================================================
// «A T-24h» SIGNIFICA «LO ÚLTIMO CAPTURADO ANTES DE T-24h»
// ===========================================================================
// Nunca la fila más cercana, que podría ser posterior. Y cada fila declara de cuándo son
// sus cuotas y sus datos, y la base rechaza que sean posteriores a la captura. Las dos
// cosas juntas impiden que la predicción de T-24h use algo que se supo a T-1h.

import { getDb } from '../db.ts';
import { versionsFor } from '../versions.ts';
import { devig } from '../market/devig.ts';
import type { SportId } from '../sports.ts';
import { emitirAlerta } from '../alerts/engine.ts';
import { deInstantanea } from '../alerts/detectors.ts';

/** Una entrada del modelo con nombre legible, para poder decir QUÉ cambió. */
export interface Entrada {
  etiqueta: string;
  valor: string | number | boolean | null;
}

export interface Instantanea {
  sport: SportId;
  matchKey: string;
  eventId: string | null;
  commence: string;
  /** Nombres de los resultados, en el orden de `probs`. */
  outcomes: string[];
  /** La probabilidad ENSEÑADA (la calibrada o mezclada, donde la hay). */
  probs: number[];
  /** La del modelo antes de calibrar o mezclar. */
  probsRaw: number[] | null;
  /** Cuotas de consenso de la fila de próximos, mismo orden que `outcomes`. */
  odds: number[] | null;
  /** Cuándo se descargaron esas cuotas. */
  oddsAt: string | null;
  /** Hasta qué fecha llegan los datos que usó el modelo. Por defecto, la de data_version. */
  dataAsOf?: string | null;
  /** ¿La probabilidad enseñada incluye el precio? (NFL y fútbol mezclan con el mercado). */
  usaMercado: boolean;
  entradas: Record<string, Entrada>;
}

export interface FilaInstantanea {
  id: number;
  sport: string;
  match_key: string;
  event_id: string | null;
  commence_time: string;
  captured_at: string;
  outcomes: string[];
  probs: number[];
  probs_raw: number[] | null;
  market_probs: number[] | null;
  odds: number[] | null;
  odds_at: string | null;
  data_as_of: string | null;
  usaMercado: boolean;
  entradas: Record<string, Entrada>;
  model_version: string | null;
  data_version: string | null;
}

/** Las marcas, de más lejana a más cercana. */
export const MARCAS = [
  { etiqueta: 'T-24h', horas: 24 },
  { etiqueta: 'T-6h', horas: 6 },
  { etiqueta: 'T-1h', horas: 1 },
] as const;

/** Movimiento mínimo que cuenta como cambio: 0,1 pp. */
export const CAMBIO_MIN = 0.001;

/** Meta con la hora del último ciclo pre-partido completo (prematch/job.ts): el latido
 *  que lee `npm run doctor`. Vive aquí y no en job.ts para no arrastrar las rutas. */
export const META_CICLO = 'prematch_cycle_at';

const H = 3_600_000;

/** «20250928·15394» → «2025-09-28T00:00:00.000Z»: hasta dónde llegan los datos. */
export function fechaDeDatos(dataVersion: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(dataVersion);
  return m ? `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z` : null;
}

function leerFila(r: Record<string, unknown>): FilaInstantanea {
  const inputs = JSON.parse(String(r.inputs)) as { usaMercado: boolean; entradas: Record<string, Entrada> };
  const j = (x: unknown) => (x == null ? null : (JSON.parse(String(x)) as number[]));
  return {
    id: Number(r.id),
    sport: String(r.sport),
    match_key: String(r.match_key),
    event_id: (r.event_id as string | null) ?? null,
    commence_time: String(r.commence_time),
    captured_at: String(r.captured_at),
    outcomes: JSON.parse(String(r.outcomes)) as string[],
    probs: JSON.parse(String(r.probs)) as number[],
    probs_raw: j(r.probs_raw),
    market_probs: j(r.market_probs),
    odds: j(r.odds),
    odds_at: (r.odds_at as string | null) ?? null,
    data_as_of: (r.data_as_of as string | null) ?? null,
    usaMercado: inputs.usaMercado,
    entradas: inputs.entradas,
    model_version: (r.model_version as string | null) ?? null,
    data_version: (r.data_version as string | null) ?? null,
  };
}

export function instantaneas(sport: string, matchKey: string): FilaInstantanea[] {
  return (
    getDb()
      .prepare('SELECT * FROM prediction_snapshots WHERE sport = ? AND match_key = ? ORDER BY captured_at, id')
      .all(sport, matchKey) as Record<string, unknown>[]
  ).map(leerFila);
}

/** Lo último capturado EN o ANTES de `at`. Nunca algo posterior. */
export function aFecha(sport: string, matchKey: string, at: string): FilaInstantanea | null {
  const r = getDb()
    .prepare(
      `SELECT * FROM prediction_snapshots WHERE sport = ? AND match_key = ? AND captured_at <= ?
        ORDER BY captured_at DESC, id DESC LIMIT 1`,
    )
    .get(sport, matchKey, at) as Record<string, unknown> | undefined;
  return r ? leerFila(r) : null;
}

const distinto = (a: number[] | null, b: number[] | null) =>
  (a == null) !== (b == null) || (a != null && b != null && (a.length !== b.length || a.some((x, i) => Math.abs(x - b[i]) >= CAMBIO_MIN)));

/** ¿Se cruzó alguna marca entre la última fila y ahora? */
function cruzaMarca(commence: string, desde: string, hasta: string): boolean {
  const inicio = Date.parse(commence);
  return MARCAS.some((m) => {
    const marca = inicio - m.horas * H;
    return Date.parse(desde) < marca && marca <= Date.parse(hasta);
  });
}

export type ResultadoRegistro = 'nueva' | 'igual' | 'empezado' | 'rechazada';

/**
 * Registra la predicción de ahora si aporta algo (ver arriba). Nunca lanza: guardar una
 * instantánea no puede romper servir una predicción.
 */
export function recordSnapshot(s: Instantanea, now = new Date()): ResultadoRegistro {
  const captured = now.toISOString();
  if (Date.parse(s.commence) <= now.getTime()) return 'empezado';
  try {
    const v = versionsFor(s.sport);
    const marketProbs = s.odds && s.odds.every((o) => o > 1) ? devig(s.odds).probs : null;
    const dataAsOf = s.dataAsOf !== undefined ? s.dataAsOf : fechaDeDatos(v.data_version);
    const ultimas = instantaneas(s.sport, s.matchKey);
    const u = ultimas[ultimas.length - 1];
    const inputs = JSON.stringify({ usaMercado: s.usaMercado, entradas: s.entradas });
    if (
      u &&
      !distinto(u.probs, s.probs) &&
      !distinto(u.market_probs, marketProbs) &&
      JSON.stringify({ usaMercado: u.usaMercado, entradas: u.entradas }) === inputs &&
      u.model_version === v.model_version &&
      u.data_version === v.data_version &&
      !cruzaMarca(s.commence, u.captured_at, captured)
    ) {
      return 'igual';
    }
    getDb()
      .prepare(
        `INSERT INTO prediction_snapshots (sport, match_key, event_id, commence_time, captured_at, outcomes, probs, probs_raw,
           market_probs, odds, odds_at, data_as_of, inputs, model_version, calibration_version, data_version, git_commit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.sport, s.matchKey, s.eventId, s.commence, captured, JSON.stringify(s.outcomes), JSON.stringify(s.probs),
        s.probsRaw ? JSON.stringify(s.probsRaw) : null, marketProbs ? JSON.stringify(marketProbs) : null,
        s.odds ? JSON.stringify(s.odds) : null, s.oddsAt, dataAsOf, inputs,
        v.model_version, v.calibration_version, v.data_version, v.git_commit,
      );
    // Alertas: cambios grandes de predicción o de mercado, alineaciones, abridores, QB.
    if (u) {
      const partido = s.outcomes.filter((o) => o !== 'Empate').join(' vs ');
      for (const a of deInstantanea(u, { ...s, market_probs: marketProbs }, partido)) emitirAlerta({ ...a, sport: s.sport, matchKey: s.matchKey }, now);
    }
    return 'nueva';
  } catch {
    return 'rechazada';
  }
}

export interface Horizonte {
  etiqueta: string;
  /** La hora de la marca. */
  marca: string;
  fila: FilaInstantanea | null;
  /** Cuánto antes de la marca se capturó la fila usada (null sin fila). */
  minutosAntesDeLaMarca: number | null;
  /**
   * Con fila, `ok`; sin ella, `pendiente` si la marca aún no ha llegado y `sin_observacion` si
   * llegó sin nada anterior. Lo decide el mismo reloj que decide la fila (G1b): la web lo volvía
   * a deducir con el suyo, y un segundo de desfase cambiaba un estado por el otro.
   */
  estado: 'ok' | 'pendiente' | 'sin_observacion';
}

/** T-24h, T-6h, T-1h y la final pre-partido, cada una «a fecha» de su marca. */
export function horizontes(sport: string, matchKey: string, commence: string, ahora: Date = new Date()): Horizonte[] {
  const inicio = Date.parse(commence);
  // Una marca que aún no ha llegado está PENDIENTE (G1, lote G): la última instantánea anterior a
  // una marca futura es la de hoy, no la de T-1h, y enseñarla como T-1h era decir algo falso.
  const llegada = (marca: number) => marca <= ahora.getTime();
  const out: Horizonte[] = MARCAS.map((m) => {
    const marca = new Date(inicio - m.horas * H).toISOString();
    const llego = llegada(inicio - m.horas * H);
    const fila = llego ? aFecha(sport, matchKey, marca) : null;
    return { etiqueta: m.etiqueta, marca, fila, minutosAntesDeLaMarca: fila ? Math.round((Date.parse(marca) - Date.parse(fila.captured_at)) / 60_000) : null, estado: fila ? 'ok' : llego ? 'sin_observacion' : 'pendiente' };
  });
  // La final: lo último ANTES del inicio (la base ya impide que haya algo después).
  const empezo = llegada(inicio);
  const ultima = empezo ? aFecha(sport, matchKey, new Date(inicio - 1).toISOString()) : null;
  out.push({
    etiqueta: 'Final pre-partido',
    marca: commence,
    fila: ultima,
    minutosAntesDeLaMarca: ultima ? Math.round((inicio - Date.parse(ultima.captured_at)) / 60_000) : null,
    estado: ultima ? 'ok' : empezo ? 'sin_observacion' : 'pendiente',
  });
  return out;
}

// ---------------------------------------------------------------------------
// CONGELAR: la final pre-partido de cada partido que ya empezó
// ---------------------------------------------------------------------------

/** De dónde sacar la predicción de cada deporte cuando no hay instantáneas. */
const LOGS: { sport: SportId; tabla: string; clave: string; outcomes: string; probs: string; mercado: string }[] = [
  { sport: 'tennis', tabla: 'prediction_log', clave: 'match_key', outcomes: "json_array(p1_name, p2_name)", probs: 'json_array(prob1, 1 - prob1)', mercado: 'CASE WHEN market_prob1 IS NULL THEN NULL ELSE json_array(market_prob1, 1 - market_prob1) END' },
  {
    sport: 'football', tabla: 'fb_prediction_log', clave: 'match_key', outcomes: "json_array(home_name, 'Empate', away_name)",
    probs: 'json_array(COALESCE(shown_home, prob_home), COALESCE(shown_draw, prob_draw), COALESCE(shown_away, prob_away))',
    mercado: 'CASE WHEN market_prob_home IS NULL THEN NULL ELSE json_array(market_prob_home, market_prob_draw, market_prob_away) END',
  },
  { sport: 'basketball', tabla: 'bb_prediction_log', clave: 'game_key', outcomes: 'json_array(home_name, away_name)', probs: 'json_array(prob_home, 1 - prob_home)', mercado: 'CASE WHEN market_prob_home IS NULL THEN NULL ELSE json_array(market_prob_home, 1 - market_prob_home) END' },
  { sport: 'baseball', tabla: 'bsb_prediction_log', clave: 'match_key', outcomes: 'json_array(home_name, away_name)', probs: 'json_array(prob_home, 1 - prob_home)', mercado: 'CASE WHEN market_prob_home IS NULL THEN NULL ELSE json_array(market_prob_home, 1 - market_prob_home) END' },
  {
    sport: 'nfl', tabla: 'naf_prediction_log', clave: 'match_key', outcomes: 'json_array(home_name, away_name)',
    probs: 'json_array(COALESCE(shown_home, prob_home), 1 - COALESCE(shown_home, prob_home))',
    mercado: 'CASE WHEN market_prob_home IS NULL THEN NULL ELSE json_array(market_prob_home, 1 - market_prob_home) END',
  },
  {
    sport: 'nhl', tabla: 'nhl_prediction_log', clave: 'match_key', outcomes: 'json_array(home_name, away_name)',
    probs: 'json_array(COALESCE(shown_home, prob_home), 1 - COALESCE(shown_home, prob_home))',
    mercado: 'CASE WHEN market_prob_home IS NULL THEN NULL ELSE json_array(market_prob_home, 1 - market_prob_home) END',
  },
  {
    sport: 'ufc', tabla: 'ufc_prediction_log', clave: 'match_key', outcomes: 'json_array(home_name, away_name)',
    probs: 'json_array(COALESCE(shown_home, prob_home), 1 - COALESCE(shown_home, prob_home))',
    mercado: 'CASE WHEN market_prob_home IS NULL THEN NULL ELSE json_array(market_prob_home, 1 - market_prob_home) END',
  },
];

/**
 * Congela la final pre-partido de todo partido que ya empezó y aún no la tiene. Primero
 * desde las instantáneas; si el servidor no tomó ninguna, desde el registro de
 * predicciones (que también es anterior al partido y tampoco se reescribe).
 */
export function freezeFinals(now = new Date()): { congeladas: number } {
  const db = getDb();
  const ahora = now.toISOString();
  const desdeInstantaneas = db
    .prepare(
      `INSERT OR IGNORE INTO prematch_final (sport, match_key, commence_time, frozen_at, source, snapshot_id, captured_at, outcomes, probs, market_probs, model_version)
       SELECT s.sport, s.match_key, s.commence_time, ?, 'snapshot', s.id, s.captured_at, s.outcomes, s.probs, s.market_probs, s.model_version
         FROM prediction_snapshots s
        WHERE s.commence_time <= ?
          AND s.id = (SELECT id FROM prediction_snapshots x WHERE x.sport = s.sport AND x.match_key = s.match_key
                       ORDER BY x.captured_at DESC, x.id DESC LIMIT 1)`,
    )
    .run(ahora, ahora);
  let congeladas = Number(desdeInstantaneas.changes);
  for (const l of LOGS) {
    try {
      const r = db
        .prepare(
          `INSERT OR IGNORE INTO prematch_final (sport, match_key, commence_time, frozen_at, source, snapshot_id, captured_at, outcomes, probs, market_probs, model_version)
           SELECT '${l.sport}', ${l.clave}, commence_time, ?, 'prediction_log', NULL, predicted_at, ${l.outcomes}, ${l.probs}, ${l.mercado}, model_version
             FROM ${l.tabla}
            WHERE commence_time IS NOT NULL AND commence_time <= ? AND predicted_at < commence_time`,
        )
        .run(ahora, ahora);
      congeladas += Number(r.changes);
    } catch {
      // Un deporte sin tabla todavía no impide congelar los demás.
    }
  }
  return { congeladas };
}

export interface FinalPrePartido {
  sport: string;
  match_key: string;
  commence_time: string;
  frozen_at: string;
  source: 'snapshot' | 'prediction_log';
  captured_at: string;
  outcomes: string[];
  probs: number[];
  market_probs: number[] | null;
  model_version: string | null;
}

export function finalPrePartido(sport: string, matchKey: string): FinalPrePartido | null {
  const r = getDb().prepare('SELECT * FROM prematch_final WHERE sport = ? AND match_key = ?').get(sport, matchKey) as
    | Record<string, unknown>
    | undefined;
  if (!r) return null;
  return {
    sport: String(r.sport),
    match_key: String(r.match_key),
    commence_time: String(r.commence_time),
    frozen_at: String(r.frozen_at),
    source: r.source as FinalPrePartido['source'],
    captured_at: String(r.captured_at),
    outcomes: JSON.parse(String(r.outcomes)) as string[],
    probs: JSON.parse(String(r.probs)) as number[],
    market_probs: r.market_probs == null ? null : (JSON.parse(String(r.market_probs)) as number[]),
    model_version: (r.model_version as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// CAMBIOS: cuánto se movió y, solo si consta, por qué
// ---------------------------------------------------------------------------

export interface Cambio {
  desde: string;
  hasta: string;
  /** Movimiento de cada resultado, en puntos porcentuales. */
  deltaPp: number[];
  /** Lo que consta que cambió entre las dos filas. */
  causas: string[];
  /**
   * Qué se puede decir del reparto:
   *  · «única causa registrada»: todo el movimiento va a esa causa, suponiendo que no hubo
   *    otra que el registro no ve;
   *  · «varias causas: reparto exacto no disponible»;
   *  · «Causa exacta no disponible»: se movió y no consta ningún cambio de entradas.
   */
  atribucion: string;
}

const fmt = (v: Entrada['valor']) => (v == null ? 'sin dato' : typeof v === 'boolean' ? (v ? 'sí' : 'no') : String(v));

export function cambios(sport: string, matchKey: string): Cambio[] {
  const filas = instantaneas(sport, matchKey);
  const out: Cambio[] = [];
  for (let i = 1; i < filas.length; i++) {
    const a = filas[i - 1];
    const b = filas[i];
    const deltaPp = b.probs.map((p, k) => Math.round((p - (a.probs[k] ?? p)) * 1000) / 10);
    const movio = deltaPp.some((d) => Math.abs(d) >= CAMBIO_MIN * 100);
    const causas: string[] = [];
    for (const k of new Set([...Object.keys(a.entradas), ...Object.keys(b.entradas)])) {
      const va = a.entradas[k]?.valor ?? null;
      const vb = b.entradas[k]?.valor ?? null;
      if (va !== vb) causas.push(`${(b.entradas[k] ?? a.entradas[k]).etiqueta}: ${fmt(va)} → ${fmt(vb)}`);
    }
    // El mercado solo es causa si el número enseñado lo incluye.
    if (b.usaMercado && distinto(a.market_probs, b.market_probs)) causas.push('actualización del mercado (la probabilidad enseñada incluye el precio)');
    if (a.model_version !== b.model_version) causas.push(`nueva versión del modelo: ${a.model_version} → ${b.model_version}`);
    if (a.data_version !== b.data_version) causas.push(`datos actualizados: ${a.data_version} → ${b.data_version}`);
    if (!movio && causas.length === 0) continue; // fila de marca: confirma que nada cambió
    out.push({
      desde: a.captured_at,
      hasta: b.captured_at,
      deltaPp,
      causas,
      atribucion: !movio
        ? 'sin movimiento de la probabilidad'
        : causas.length === 0
          ? 'Causa exacta no disponible'
          : causas.length === 1
            ? 'única causa registrada'
            : 'varias causas: reparto exacto no disponible',
    });
  }
  return out;
}
