// El banco de papel del modelo: 1.000 de partida y apuestas de verdad, sin dinero.
//
// ===========================================================================
// LA TRAMPA QUE HAY QUE DESACTIVAR ANTES DE NADA
// ===========================================================================
// Cuatro de los cinco deportes se INVENTAN las cuotas cuando no llegan las reales, y las
// inventan a partir del propio modelo con un margen encima. Apostar contra esas cuotas es
// apostar contra uno mismo: el modelo encontraría «valor» en su propio precio, la
// diferencia sería el margen que él mismo añadió, y el banco subiría de forma constante
// por construcción. Un 1.000 → 1.400 así no dice nada del modelo; dice que sabe sumar.
//
// Así que `place` se niega a apostar sobre cualquier fila cuyo `source` sea 'fixture'.
// Con la app en modo demostración, este banco se queda a cero apuestas y lo dice. Un
// experimento que no puede correr tiene que decir que no está corriendo, no dar números.
//
// ===========================================================================
// POR QUÉ ES HACIA DELANTE Y NO UNA SIMULACIÓN DEL PASADO
// ===========================================================================
// Se podría recorrer el histórico y calcular qué habría pasado. Con dos problemas: no
// hay cuotas históricas guardadas para el tenis (solo la probabilidad de mercado del
// momento, que no es un precio), y el log resuelto con precio son 15 partidos de la NFL
// — una muestra con la que cualquier ROI es ruido, y presentarlo como resultado sería
// exactamente el tipo de número bonito que este proyecto evita.
//
// Hacia delante es más lento y es lo único que se puede defender: la apuesta se registra
// ANTES del partido, con el precio de ese momento, y se liquida con el resultado real.
//
// ===========================================================================
// EL SIZING NO SE INVENTA AQUÍ
// ===========================================================================
// Lo decide `staking/policy.ts` —Kelly fraccional a un cuarto, tope del 2 % por evento,
// límites de exposición por día y total, corte por pérdida diaria y semanal— que ya
// existía y está documentado pieza por pieza. Duplicar esas reglas aquí habría creado
// dos políticas que se separan con el primer cambio.

import { getDb, getMeta, setMeta } from '../db.ts';
import { decideEvent, DEFAULT_CONFIG } from '../staking/policy.ts';
import { fullKelly } from '../staking/kelly.ts';
import { closingLine, marketAt, openingLine } from '../odds/snapshots.ts';
import { versionsFor, type SportId } from '../versions.ts';
import { captureSignalClosing, recordSignal } from './signals.ts';

/** El banco inicial del experimento. Se guarda para que cambiarlo sea deliberado. */
export const BANCO_INICIAL = 1000;
const KEY_INICIO = 'paper:startedAt';
const KEY_ULTIMA = 'paper:lastRun';

/**
 * Qué pasó la última vez que se miró, incluidos los RECHAZOS.
 *
 * ===========================================================================
 * UN BANCO QUIETO TIENE QUE PODER EXPLICARSE
 * ===========================================================================
 * Sin esto, tres semanas sin apostar se ven exactamente igual en los tres casos que
 * las producen, y cada uno pide algo distinto:
 *
 *   · no hay partidos por delante            → esperar
 *   · los hay, pero sin cuotas reales         → arreglar las cuotas
 *   · los hay con cuotas y se rechazan todos  → el modelo no ve ventaja, y eso es un
 *                                               RESULTADO, no una avería
 *
 * El tercero es el que más despista: el experimento está corriendo perfectamente y
 * decidiendo no apostar, que es justo lo que se le pide a una política de riesgo. Sin
 * dejarlo escrito, se lee como que está roto.
 *
 * Se guarda en meta y no en una tabla porque solo interesa LA ÚLTIMA pasada: un
 * histórico de rechazos sería un registro que crece sin parar y que nadie leería.
 */
export interface UltimaPasada {
  cuando: string;
  candidatas: number;
  colocadas: number;
  /** Cuántas cayó cada motivo de rechazo. */
  rechazos: Record<string, number>;
}

function guardarPasada(p: UltimaPasada): void {
  setMeta(KEY_ULTIMA, JSON.stringify(p));
}

export function ultimaPasada(): UltimaPasada | null {
  try {
    const raw = getMeta(KEY_ULTIMA);
    return raw ? (JSON.parse(raw) as UltimaPasada) : null;
  } catch {
    // Un meta corrupto no puede tumbar la pantalla del banco.
    return null;
  }
}

export interface ApuestaPapel {
  id: number;
  placed_at: string;
  sport: string;
  match_key: string;
  event_id: string;
  label: string;
  selection: string;
  p_model: number;
  p_market: number;
  odds: number;
  stake: number;
  bankroll_at: number;
  status: string;
  settled_at: string | null;
  profit: number | null;
  // Auditoría (fase 4): ver paper/schema.ts. Opcionales porque las apuestas anteriores
  // a la migración no los tienen, y no se les inventan.
  league?: string | null;
  market?: string | null;
  commence_time?: string | null;
  provider_event_id?: string | null;
  provider_selection?: string | null;
  model_probability_raw?: number | null;
  model_probability_calibrated?: number | null;
  market_probability_raw?: number | null;
  market_probability_no_vig?: number | null;
  edge?: number | null;
  bookmaker?: string | null;
  books?: number | null;
  line?: number | null;
  stake_pct_bankroll?: number | null;
  kelly_raw?: number | null;
  kelly_fraction_used?: number | null;
  bankroll_after?: number | null;
  model_version?: string | null;
  model_config_version?: string | null;
  calibration_version?: string | null;
  data_version?: string | null;
  strategy_version?: string | null;
  git_commit?: string | null;
  prediction_timestamp?: string | null;
  odds_timestamp?: string | null;
  opening_odds?: number | null;
  opening_observed_at?: string | null;
  signal_odds?: number | null;
  signal_observed_at?: string | null;
  closing_odds?: number | null;
  closing_line?: number | null;
  closing_observed_at?: string | null;
  clv?: number | null;
  event_result?: string | null;
  roi?: number | null;
}

export interface Resumen {
  bancoInicial: number;
  banco: number;
  /** Beneficio realizado: solo de apuestas ya liquidadas. */
  beneficio: number;
  /** Dinero comprometido en apuestas sin resolver. */
  expuesto: number;
  liquidadas: number;
  ganadas: number;
  perdidas: number;
  pendientes: number;
  /** Beneficio entre el total arriesgado en apuestas liquidadas. */
  roi: number | null;
  /** Total arriesgado en apuestas liquidadas, que es el denominador del ROI. */
  arriesgado: number;
  empezado: string | null;
  /** Qué pasó la última vez que se miró, rechazos incluidos. */
  ultima: UltimaPasada | null;
  apuestas: ApuestaPapel[];
  /** Por qué no hay apuestas, cuando no hay. */
  motivo: string | null;
  /**
   * CLV medio: cuánto mejor (o peor) que el cierre se apostó. Es la medida de habilidad
   * que no depende de la suerte del resultado; null hasta que haya apuestas con cierre.
   */
  clvMedio: number | null;
  conCierre: number;
  /** Apuestas por estado, con los seis posibles. */
  porEstado: Record<string, number>;
}

function filas(): ApuestaPapel[] {
  return getDb()
    .prepare('SELECT * FROM paper_bets ORDER BY placed_at DESC, id DESC')
    .all() as unknown as ApuestaPapel[];
}

/**
 * El banco AHORA: el inicial más lo realizado. Lo expuesto no se resta.
 *
 * Es la convención de cualquier registro de apuestas y conviene decirla: el banco baja
 * cuando se PIERDE, no cuando se apuesta. Lo comprometido se informa aparte, porque es
 * lo que puede convertirse en pérdida y es justo lo que los topes de exposición miran.
 */
export function bancoActual(): number {
  const r = getDb()
    .prepare("SELECT COALESCE(SUM(profit), 0) p FROM paper_bets WHERE status <> 'pending'")
    .get() as { p: number };
  return BANCO_INICIAL + (r?.p ?? 0);
}

function expuesto(): number {
  const r = getDb()
    .prepare("SELECT COALESCE(SUM(stake), 0) s FROM paper_bets WHERE status = 'pending'")
    .get() as { s: number };
  return r?.s ?? 0;
}

export function resumen(motivo: string | null = null): Resumen {
  const todas = filas();
  const liq = todas.filter((a) => a.status !== 'pending');
  const arriesgado = liq.reduce((s, a) => s + a.stake, 0);
  const beneficio = liq.reduce((s, a) => s + (a.profit ?? 0), 0);
  return {
    bancoInicial: BANCO_INICIAL,
    banco: BANCO_INICIAL + beneficio,
    beneficio,
    expuesto: expuesto(),
    liquidadas: liq.length,
    ganadas: liq.filter((a) => a.status === 'won').length,
    perdidas: liq.filter((a) => a.status === 'lost').length,
    pendientes: todas.length - liq.length,
    // Sin apuestas liquidadas el ROI no es cero: no existe. Enseñar «0 %» invitaría a
    // leerlo como «no gana nada» cuando lo que pasa es que todavía no ha jugado.
    roi: arriesgado > 0 ? beneficio / arriesgado : null,
    arriesgado,
    empezado: getMeta(KEY_INICIO),
    ultima: ultimaPasada(),
    apuestas: todas.slice(0, 50),
    motivo,
    clvMedio: (() => {
      const c = todas.filter((a) => a.clv != null);
      return c.length ? c.reduce((x, a) => x + (a.clv as number), 0) / c.length : null;
    })(),
    conCierre: todas.filter((a) => a.clv != null).length,
    porEstado: todas.reduce<Record<string, number>>((m, a) => ({ ...m, [a.status]: (m[a.status] ?? 0) + 1 }), {}),
  };
}

// ---------------------------------------------------------------------------
// APOSTAR
// ---------------------------------------------------------------------------
/**
 * Una salida posible de un partido, con las dos probabilidades del modelo.
 *
 * `p` es la CALIBRADA —la que se enseña en pantalla y la que miden las bandas de
 * confianza— y es con la que se decide. `pRaw` es la del modelo antes del post-proceso;
 * se guarda para poder auditar qué hizo la capa de calibración con cada apuesta. En
 * tenis, baloncesto y béisbol no hay capa y son la misma.
 *
 * `proveedor` es el nombre de la selección tal cual lo da The Odds API («Draw», no
 * «Empate»): es la clave con la que se buscan sus snapshots de apertura y cierre.
 */
interface Salida {
  label: string;
  proveedor: string;
  p: number;
  pRaw: number;
  odds: number;
  pMarket: number;
}

/**
 * Un partido con sus salidas EXCLUYENTES, sin elegir todavía.
 *
 * Elige la política (`bestSelection` en staking/policy.ts): dos copias de esa regla
 * acabarían discrepando sobre qué lado del mismo partido se juega.
 */
interface Candidato {
  sport: SportId;
  league: string | null;
  match_key: string;
  event_id: string;
  label: string;
  commence: string;
  /** Cuándo registró el modelo la predicción (el log). */
  predictedAt: string | null;
  /** Cuándo se descargaron las cuotas de la fila de próximos. */
  oddsAt: string | null;
  books: number | null;
  salidas: Salida[];
}

const AHORA = () => new Date().toISOString();

/**
 * Candidatas del tenis: del log de predicciones, unido a la fila de próximos.
 *
 * Del log porque ahí está la probabilidad TAL COMO SE MOSTRÓ, con su fecha; recalcularla
 * aquí daría la de hoy, y la apuesta quedaría con una probabilidad que nunca se enseñó.
 */
function candidatasTenis(): Candidato[] {
  const rows = getDb()
    .prepare(
      `SELECT l.match_key, l.upcoming_id, l.p1_name, l.p2_name, l.prob1, l.market_prob1, l.predicted_at,
              l.tournament_name, u.p1_odds, u.p2_odds, u.commence_time, u.updated_at, u.books
         FROM prediction_log l
         JOIN upcoming_matches u ON u.id = l.upcoming_id
        WHERE l.resolved_at IS NULL
          AND l.market_prob1 IS NOT NULL
          AND u.source <> 'fixture'
          AND u.p1_odds IS NOT NULL AND u.p2_odds IS NOT NULL
          AND u.commence_time > ?
          AND l.upcoming_id NOT IN (SELECT event_id FROM paper_bets)`,
    )
    .all(AHORA()) as unknown as {
    match_key: string; upcoming_id: string; p1_name: string; p2_name: string; prob1: number;
    market_prob1: number; predicted_at: string; tournament_name: string | null;
    p1_odds: number; p2_odds: number; commence_time: string; updated_at: string | null; books: number | null;
  }[];

  return rows.map((r) => ({
    // La clave del deporte tiene que ser LA MISMA que la de experiments/calibration.json:
    // `decideStake` la usa para buscar la calibración medida y falla cerrado sin ella.
    sport: 'tennis',
    league: r.tournament_name,
    match_key: r.match_key,
    event_id: r.upcoming_id,
    label: `${r.p1_name} vs ${r.p2_name}`,
    commence: r.commence_time,
    predictedAt: r.predicted_at,
    oddsAt: r.updated_at,
    books: r.books,
    salidas: [
      { label: r.p1_name, proveedor: r.p1_name, p: r.prob1, pRaw: r.prob1, odds: r.p1_odds, pMarket: r.market_prob1 },
      { label: r.p2_name, proveedor: r.p2_name, p: 1 - r.prob1, pRaw: 1 - r.prob1, odds: r.p2_odds, pMarket: 1 - r.market_prob1 },
    ],
  }));
}

/**
 * Candidatas con dos salidas (NFL, baloncesto, béisbol). Solo cambian los NOMBRES de las
 * columnas, y dos copias casi idénticas es donde un arreglo se aplica a una y no a otra.
 *
 * `mostrada` es la columna con la probabilidad enseñada, donde existe (NFL: la final, casi
 * el precio). Sin ella, la calibrada es la cruda.
 */
function candidatasDosSalidas(cfg: {
  sport: SportId;
  tablaLog: string;
  tablaUp: string;
  clave: string;
  resuelto: string;
  oddsCasa: string;
  oddsFuera: string;
  mostrada?: string;
}): Candidato[] {
  const cal = cfg.mostrada ? `COALESCE(l.${cfg.mostrada}, l.prob_home)` : 'l.prob_home';
  const rows = getDb()
    .prepare(
      `SELECT l.${cfg.clave} AS match_key, l.upcoming_id, l.home_name, l.away_name, l.league,
              l.prob_home AS raw, ${cal} AS cal, l.market_prob_home, l.predicted_at,
              u.${cfg.oddsCasa} AS odds_home, u.${cfg.oddsFuera} AS odds_away,
              u.commence_time, u.updated_at, u.books
         FROM ${cfg.tablaLog} l
         JOIN ${cfg.tablaUp} u ON u.id = l.upcoming_id
        WHERE l.${cfg.resuelto} IS NULL
          AND l.market_prob_home IS NOT NULL
          AND u.source <> 'fixture'
          AND u.${cfg.oddsCasa} IS NOT NULL AND u.${cfg.oddsFuera} IS NOT NULL
          AND u.commence_time > ?
          AND l.upcoming_id NOT IN (SELECT event_id FROM paper_bets)`,
    )
    .all(AHORA()) as unknown as {
    match_key: string; upcoming_id: string; home_name: string; away_name: string; league: string | null;
    raw: number; cal: number; market_prob_home: number; predicted_at: string;
    odds_home: number; odds_away: number; commence_time: string; updated_at: string | null; books: number | null;
  }[];

  return rows.map((r) => ({
    sport: cfg.sport,
    league: r.league,
    match_key: r.match_key,
    event_id: r.upcoming_id,
    label: cfg.sport === 'nfl' ? `${r.away_name} @ ${r.home_name}` : `${r.home_name} vs ${r.away_name}`,
    commence: r.commence_time,
    predictedAt: r.predicted_at,
    oddsAt: r.updated_at,
    books: r.books,
    salidas: [
      { label: r.home_name, proveedor: r.home_name, p: r.cal, pRaw: r.raw, odds: r.odds_home, pMarket: r.market_prob_home },
      { label: r.away_name, proveedor: r.away_name, p: 1 - r.cal, pRaw: 1 - r.raw, odds: r.odds_away, pMarket: 1 - r.market_prob_home },
    ],
  }));
}

/**
 * Candidatas del fútbol: TRES salidas. El empate es el resultado de uno de cada cuatro
 * partidos y suele tener la cuota más alta; que compita en igualdad lo decide la política.
 */
function candidatasFutbol(): Candidato[] {
  const rows = getDb()
    .prepare(
      `SELECT l.match_key, l.upcoming_id, l.home_name, l.away_name, l.league, l.predicted_at,
              l.prob_home, l.prob_draw, l.prob_away,
              COALESCE(l.shown_home, l.prob_home) AS cal_home,
              COALESCE(l.shown_draw, l.prob_draw) AS cal_draw,
              COALESCE(l.shown_away, l.prob_away) AS cal_away,
              l.market_prob_home, l.market_prob_draw, l.market_prob_away,
              u.odds_home, u.odds_draw, u.odds_away, u.commence_time, u.updated_at, u.books
         FROM fb_prediction_log l
         JOIN fb_upcoming u ON u.id = l.upcoming_id
        WHERE l.resolved_at IS NULL
          AND l.market_prob_home IS NOT NULL
          AND u.source <> 'fixture'
          AND u.odds_home IS NOT NULL AND u.odds_draw IS NOT NULL AND u.odds_away IS NOT NULL
          AND u.commence_time > ?
          AND l.upcoming_id NOT IN (SELECT event_id FROM paper_bets)`,
    )
    .all(AHORA()) as unknown as {
    match_key: string; upcoming_id: string; home_name: string; away_name: string; league: string | null; predicted_at: string;
    prob_home: number; prob_draw: number; prob_away: number; cal_home: number; cal_draw: number; cal_away: number;
    market_prob_home: number; market_prob_draw: number; market_prob_away: number;
    odds_home: number; odds_draw: number; odds_away: number; commence_time: string; updated_at: string | null; books: number | null;
  }[];

  return rows.map((r) => ({
    sport: 'football',
    league: r.league,
    match_key: r.match_key,
    event_id: r.upcoming_id,
    label: `${r.home_name} vs ${r.away_name}`,
    commence: r.commence_time,
    predictedAt: r.predicted_at,
    oddsAt: r.updated_at,
    books: r.books,
    salidas: [
      { label: r.home_name, proveedor: r.home_name, p: r.cal_home, pRaw: r.prob_home, odds: r.odds_home, pMarket: r.market_prob_home },
      { label: 'Empate', proveedor: 'Draw', p: r.cal_draw, pRaw: r.prob_draw, odds: r.odds_draw, pMarket: r.market_prob_draw },
      { label: r.away_name, proveedor: r.away_name, p: r.cal_away, pRaw: r.prob_away, odds: r.odds_away, pMarket: r.market_prob_away },
    ],
  }));
}

const NFL = {
  sport: 'nfl' as const, tablaLog: 'naf_prediction_log', tablaUp: 'naf_upcoming',
  clave: 'match_key', resuelto: 'home_points', oddsCasa: 'odds_home', oddsFuera: 'odds_away', mostrada: 'shown_home',
};
const BALONCESTO = {
  sport: 'basketball' as const, tablaLog: 'bb_prediction_log', tablaUp: 'bb_upcoming',
  clave: 'game_key', resuelto: 'home_pts', oddsCasa: 'home_odds', oddsFuera: 'away_odds',
};
const BEISBOL = {
  sport: 'baseball' as const, tablaLog: 'bsb_prediction_log', tablaUp: 'bsb_upcoming',
  clave: 'match_key', resuelto: 'home_runs', oddsCasa: 'odds_home', oddsFuera: 'odds_away',
};

/** El id del evento en The Odds API. La NFL lo guarda con prefijo `odds-`. */
export function providerId(eventId: string): string {
  return eventId.replace(/^odds-/, '');
}

export function place(): { colocadas: number; motivo: string | null; detalle: string[] } {
  const db = getDb();
  if (!getMeta(KEY_INICIO)) setMeta(KEY_INICIO, AHORA());

  let candidatas: Candidato[] = [];
  try {
    candidatas = [
      ...candidatasTenis(),
      ...candidatasDosSalidas(NFL),
      ...candidatasFutbol(),
      ...candidatasDosSalidas(BALONCESTO),
      ...candidatasDosSalidas(BEISBOL),
    ];
  } catch (e) {
    return { colocadas: 0, motivo: `no pude leer las candidatas: ${(e as Error).message}`, detalle: [] };
  }
  if (candidatas.length === 0) {
    guardarPasada({ cuando: AHORA(), candidatas: 0, colocadas: 0, rechazos: {} });
    return {
      colocadas: 0,
      // Sin cuotas reales el experimento no puede empezar; con ellas y sin ventaja, ha
      // corrido y ha decidido no apostar, que es un resultado. Piden cosas distintas.
      motivo:
        'no hay ningún partido con CUOTAS REALES por delante. Con cuotas de demostración ' +
        'este banco no apuesta: el modelo encontraría valor en su propio precio y el ' +
        'resultado no diría nada.',
      detalle: [],
    };
  }

  // Ordenadas por la mejor ventaja del partido: si los topes cortan, que corten las peores.
  const ventaja = (c: Candidato) => Math.max(...c.salidas.map((s) => s.p - s.pMarket));
  candidatas.sort((a, b) => ventaja(b) - ventaja(a));

  // Todo lo que se sabía al apostar, en UNA fila. Después, los triggers de paper/schema.ts
  // impiden tocarlo: ni la probabilidad, ni la cuota, ni el importe, ni las versiones.
  const ins = db.prepare(
    `INSERT OR IGNORE INTO paper_bets (
       placed_at, sport, match_key, event_id, label, selection, p_model, p_market, odds, stake, bankroll_at,
       league, market, commence_time, provider_event_id, provider_selection,
       model_probability_raw, model_probability_calibrated, market_probability_raw, market_probability_no_vig, edge,
       bookmaker, books, line, stake_pct_bankroll, kelly_raw, kelly_fraction_used,
       model_version, model_config_version, calibration_version, data_version, strategy_version, git_commit,
       prediction_timestamp, odds_timestamp, opening_odds, opening_observed_at, signal_odds, signal_observed_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?)`,
  );
  const ahora = AHORA();
  const banco = bancoActual();
  let abierto = expuesto();
  let colocadas = 0;
  const detalle: string[] = [];
  const rechazos: Record<string, number> = {};

  for (const c of candidatas) {
    const d = decideEvent(
      c.salidas.map((s) => ({ label: s.label, p: s.p, odds: s.odds })),
      { sport: c.sport, bankroll: banco, openExposure: abierto },
      DEFAULT_CONFIG,
    );
    // La señal se registra SIEMPRE, se apueste o no: el edge detectado se mide sobre todo
    // lo evaluado, no solo sobre lo que pasó los topes (ver paper/signals.ts).
    const elegida = d ? c.salidas.find((s) => s.label === d.label) : undefined;
    const senalDe = (decision: 'apostada' | 'rechazada', stake: number, betId: number | null) =>
      d && elegida
        ? recordSignal({
            sport: c.sport, league: c.league, eventId: c.event_id, providerEventId: providerId(c.event_id),
            selection: elegida.label, providerSelection: elegida.proveedor, pRaw: elegida.pRaw, pCal: elegida.p,
            pMarket: elegida.pMarket, odds: elegida.odds, edge: d.edge, kellyRaw: fullKelly(elegida.p, elegida.odds),
            decision, reason: decision === 'rechazada' ? d.blockedBy : null, stake, paperBetId: betId,
            versions: versionsFor(c.sport), predictionTimestamp: c.predictedAt, oddsTimestamp: c.oddsAt, commenceTime: c.commence,
          })
        : null;
    if (!d || d.stake <= 0) {
      const motivoRechazo = d?.blockedBy ?? 'ninguna salida con ventaja';
      rechazos[motivoRechazo] = (rechazos[motivoRechazo] ?? 0) + 1;
      detalle.push(`${c.label}: no se apuesta — ${motivoRechazo}`);
      senalDe('rechazada', 0, null);
      continue;
    }
    const e = elegida;
    if (!e) {
      // No puede pasar —la etiqueta sale de esta misma lista— pero si pasara, apostar
      // sin saber a qué se apostó sería peor que no apostar.
      detalle.push(`${c.label}: la política eligió «${d.label}», que no está en las salidas`);
      continue;
    }
    const stake = Math.round(d.stake * 100) / 100;
    const pid = providerId(c.event_id);
    // Apertura y señal salen de los SNAPSHOTS, que son el mercado tal como se vio. La de
    // la señal es el precio cuando el modelo registró su predicción, que puede ser horas
    // antes de este momento; la de la apuesta es `odds`, la de ahora.
    const apertura = openingLine(pid, 'h2h', e.proveedor);
    const senal = c.predictedAt ? marketAt(pid, 'h2h', e.proveedor, c.predictedAt) : null;
    const v = versionsFor(c.sport);
    const alta = ins.run(
      ahora, c.sport, c.match_key, c.event_id, c.label, e.label, e.p, e.pMarket, e.odds, stake, banco,
      c.league, 'h2h', c.commence, pid, e.proveedor,
      e.pRaw, e.p, 1 / e.odds, e.pMarket, d.edge,
      `consenso (mediana de ${c.books ?? '?'} casas)`, c.books, null, stake / banco, fullKelly(e.p, e.odds), DEFAULT_CONFIG.kellyFraction,
      v.model_version, v.model_config_version, v.calibration_version, v.data_version, v.strategy_version, v.git_commit,
      c.predictedAt, c.oddsAt, apertura?.consensus ?? null, apertura?.at ?? null, senal?.consensus ?? null, senal ? c.predictedAt : null,
    );
    senalDe('apostada', stake, Number(alta.changes) ? Number(alta.lastInsertRowid) : null);
    // La exposición se acumula DENTRO del bucle: sin esto, veinte candidatas se
    // dimensionarían todas como si fueran la primera y los topes no servirían.
    abierto += stake;
    colocadas++;
    detalle.push(`${c.label}: ${e.label} a ${e.odds.toFixed(2)} · ${stake.toFixed(2)} (${(d.edge * 100).toFixed(1)} pp de ventaja)`);
  }
  guardarPasada({ cuando: AHORA(), candidatas: candidatas.length, colocadas, rechazos });
  return {
    colocadas,
    motivo:
      colocadas === 0
        ? `se evaluaron ${candidatas.length} partido(s) con cuotas reales y ninguno pasó la ` +
          'política de riesgo. No es una avería: es el modelo decidiendo no apostar.'
        : null,
    detalle,
  };
}

// ---------------------------------------------------------------------------
// CERRAR: la cuota de cierre, de los snapshots
// ---------------------------------------------------------------------------
/**
 * Fija la cuota de cierre de las apuestas cuyo partido ya empezó.
 *
 * Sale de los snapshots —el último estado del mercado ANTES del inicio—, nunca de la fila
 * de próximos, y va a su propia columna: la cuota con la que se apostó no se toca. El CLV
 * es `cuota apostada / cuota de cierre − 1`: positivo = se consiguió mejor precio que el
 * del cierre, que es la señal de habilidad que no depende de si el partido salió bien.
 *
 * Una apuesta sin ninguna observación antes del inicio se queda sin cierre (NULL): mejor
 * sin dato que con un cierre inventado.
 */
export function captureClosing(now = new Date()): { fijados: number } {
  const db = getDb();
  const sinCierre = db
    .prepare(
      `SELECT id, provider_event_id, provider_selection, market, commence_time, odds FROM paper_bets
        WHERE closing_odds IS NULL AND provider_event_id IS NOT NULL AND commence_time IS NOT NULL AND commence_time <= ?`,
    )
    .all(now.toISOString()) as { id: number; provider_event_id: string; provider_selection: string; market: string; commence_time: string; odds: number }[];
  const upd = db.prepare('UPDATE paper_bets SET closing_odds = ?, closing_line = ?, closing_observed_at = ?, clv = ? WHERE id = ?');
  let fijados = 0;
  for (const a of sinCierre) {
    const cl = closingLine(a.provider_event_id, a.market ?? 'h2h', a.provider_selection, a.commence_time);
    if (!cl) continue;
    upd.run(cl.consensus, cl.line, cl.at, a.odds / cl.consensus - 1, a.id);
    fijados++;
  }
  return { fijados };
}

// ---------------------------------------------------------------------------
// LIQUIDAR
// ---------------------------------------------------------------------------
/** Días sin resultado tras el inicio a partir de los cuales una apuesta se da por cancelada. */
export const DIAS_CANCELACION = 14;

type Liquidacion = { status: 'won' | 'lost' | 'push' | 'void' | 'cancelled'; resultado: string };

/**
 * Liquida contra el resultado REAL, leyéndolo del log de predicciones (que ya sabe
 * emparejar un partido con su resultado). Cada apuesta se liquida UNA vez: los triggers
 * impiden volver a escribir el resultado.
 */
export function settle(now = new Date()): { liquidadas: number } {
  captureClosing(now);
  captureSignalClosing(now);
  const db = getDb();
  const pend = db.prepare("SELECT * FROM paper_bets WHERE status = 'pending' ORDER BY id").all() as unknown as ApuestaPapel[];
  if (pend.length === 0) return { liquidadas: 0 };

  const tenis = db.prepare(
    `SELECT l.winner_id, l.p1_id, p1.name AS p1, p2.name AS p2
       FROM prediction_log l
       LEFT JOIN players p1 ON p1.tour = l.tour AND p1.id = l.p1_id
       LEFT JOIN players p2 ON p2.tour = l.tour AND p2.id = l.p2_id
      WHERE l.match_key = ? AND l.resolved_at IS NOT NULL`,
  );
  const futbol = db.prepare(
    'SELECT home_name, away_name, home_goals AS pc, away_goals AS pf FROM fb_prediction_log WHERE match_key = ? AND resolved_at IS NOT NULL',
  );
  const dosSalidas = (log: string, clave: string, casa: string, fuera: string) =>
    db.prepare(`SELECT home_name, away_name, ${casa} AS pc, ${fuera} AS pf FROM ${log} WHERE ${clave} = ? AND ${casa} IS NOT NULL`);
  const bb = dosSalidas('bb_prediction_log', 'game_key', 'home_pts', 'away_pts');
  const bsb = dosSalidas('bsb_prediction_log', 'match_key', 'home_runs', 'away_runs');
  const nfl = dosSalidas('naf_prediction_log', 'match_key', 'home_points', 'away_points');
  const upd = db.prepare(
    'UPDATE paper_bets SET status = ?, settled_at = ?, profit = ?, event_result = ?, bankroll_after = ?, roi = ? WHERE id = ?',
  );

  const cuando = now.toISOString();
  let banco = bancoActual();
  let liquidadas = 0;
  for (const a of pend) {
    const l = liquidar(a, { tenis, futbol, bb, bsb, nfl });
    let final = l;
    if (!final) {
      // Sin resultado mucho después del inicio: el partido no se jugó (o la fuente no lo
      // tiene). Se cancela y se devuelve el importe, que es lo que haría una casa. Dejarla
      // pendiente para siempre inmovilizaría exposición que ya no está en riesgo.
      const inicio = (a as ApuestaPapel & { commence_time?: string | null }).commence_time;
      if (inicio && now.getTime() - Date.parse(inicio) > DIAS_CANCELACION * 86_400_000) {
        final = { status: 'cancelled', resultado: `sin resultado ${DIAS_CANCELACION} días después del inicio` };
      } else continue;
    }
    const profit =
      final.status === 'won' ? Math.round(a.stake * (a.odds - 1) * 100) / 100 : final.status === 'lost' ? -a.stake : 0;
    banco += profit;
    upd.run(final.status, cuando, profit, final.resultado, Math.round(banco * 100) / 100, profit / a.stake, a.id);
    liquidadas++;
  }
  return { liquidadas };
}

type Stmt = ReturnType<ReturnType<typeof getDb>['prepare']>;

/** El resultado de una apuesta, o null si su partido aún no tiene resultado. */
function liquidar(a: ApuestaPapel, q: { tenis: Stmt; futbol: Stmt; bb: Stmt; bsb: Stmt; nfl: Stmt }): Liquidacion | null {
  if (a.sport === 'tennis') {
    const r = q.tenis.get(a.match_key) as { winner_id: number; p1_id: number; p1: string; p2: string } | undefined;
    if (!r) return null;
    // El log guarda el id del ganador; la apuesta, el nombre. Se compara por nombre
    // porque es lo que se enseñó y lo que se puede auditar leyendo la fila.
    const ganador = r.winner_id === r.p1_id ? r.p1 : r.p2;
    return { status: ganador === a.selection ? 'won' : 'lost', resultado: `ganó ${ganador}` };
  }
  const st = a.sport === 'football' ? q.futbol : a.sport === 'basketball' ? q.bb : a.sport === 'baseball' ? q.bsb : a.sport === 'nfl' ? q.nfl : null;
  if (!st) return null;
  const r = st.get(a.match_key) as { home_name: string; away_name: string; pc: number; pf: number } | undefined;
  if (!r) return null;
  const marcador = `${r.home_name} ${r.pc}-${r.pf} ${r.away_name}`;
  if (r.pc === r.pf) {
    // Fútbol: el empate es un resultado más, no una anulación (regalarle al modelo el 25 %
    // de los partidos sin riesgo sería falsear el banco). NFL: el moneyline se devuelve
    // (push). Baloncesto y béisbol no admiten empate: es un dato corrupto y se anula.
    if (a.sport === 'football') return { status: a.selection === 'Empate' ? 'won' : 'lost', resultado: marcador };
    return { status: a.sport === 'nfl' ? 'push' : 'void', resultado: marcador };
  }
  const ganador = r.pc > r.pf ? r.home_name : r.away_name;
  return { status: ganador === a.selection ? 'won' : 'lost', resultado: marcador };
}
