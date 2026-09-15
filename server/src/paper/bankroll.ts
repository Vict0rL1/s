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
import { decideStake, DEFAULT_CONFIG } from '../staking/policy.ts';

/** El banco inicial del experimento. Se guarda para que cambiarlo sea deliberado. */
export const BANCO_INICIAL = 1000;
const KEY_INICIO = 'paper:startedAt';

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
  apuestas: ApuestaPapel[];
  /** Por qué no hay apuestas, cuando no hay. */
  motivo: string | null;
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
    apuestas: todas.slice(0, 50),
    motivo,
  };
}

// ---------------------------------------------------------------------------
// APOSTAR
// ---------------------------------------------------------------------------
interface Candidato {
  sport: string;
  match_key: string;
  event_id: string;
  label: string;
  selection: string;
  pModel: number;
  pMarket: number;
  odds: number;
}

/**
 * Candidatas del tenis: del log de predicciones, unido a la fila de próximos.
 *
 * Del log porque ahí ya está escrita la probabilidad del modelo TAL COMO SE MOSTRÓ, con
 * su fecha; recalcularla aquí daría la de hoy, que para un partido de mañana es la
 * misma, pero para uno de la semana que viene no — y entonces la apuesta quedaría
 * registrada con una probabilidad que nunca se enseñó.
 */
function candidatasTenis(): Candidato[] {
  const rows = getDb()
    .prepare(
      `SELECT l.match_key, l.upcoming_id, l.p1_name, l.p2_name, l.prob1, l.market_prob1,
              u.p1_odds, u.p2_odds, u.source, u.commence_time
         FROM prediction_log l
         JOIN upcoming_matches u ON u.id = l.upcoming_id
        WHERE l.resolved_at IS NULL
          AND l.market_prob1 IS NOT NULL
          AND u.source <> 'fixture'
          AND u.p1_odds IS NOT NULL AND u.p2_odds IS NOT NULL
          AND u.commence_time > ?
          AND l.upcoming_id NOT IN (SELECT event_id FROM paper_bets)`,
    )
    .all(new Date().toISOString()) as unknown as {
    match_key: string;
    upcoming_id: string;
    p1_name: string;
    p2_name: string;
    prob1: number;
    market_prob1: number;
    p1_odds: number;
    p2_odds: number;
  }[];

  const out: Candidato[] = [];
  for (const r of rows) {
    // Se apuesta al lado donde el modelo ve MÁS ventaja, no al favorito. Son cosas
    // distintas: el favorito puede estar caro y el otro lado barato.
    const lados = [
      { nombre: r.p1_name, p: r.prob1, pm: r.market_prob1, odds: r.p1_odds },
      { nombre: r.p2_name, p: 1 - r.prob1, pm: 1 - r.market_prob1, odds: r.p2_odds },
    ];
    const mejor = lados.reduce((a, b) => (b.p - b.pm > a.p - a.pm ? b : a));
    out.push({
      // La clave del deporte tiene que ser LA MISMA que la de experiments/calibration.json,
      // porque `decideStake` la usa para buscar la calibración medida y falla cerrado si no
      // la encuentra. Con 'tenis' en castellano no la encontraba y se negaba a apostar
      // dando «calibración insuficiente» — un mensaje correcto para una causa falsa.
      sport: 'tennis',
      match_key: r.match_key,
      event_id: r.upcoming_id,
      label: `${r.p1_name} vs ${r.p2_name}`,
      selection: mejor.nombre,
      pModel: mejor.p,
      pMarket: mejor.pm,
      odds: mejor.odds,
    });
  }
  return out;
}

/** Candidatas de la NFL. Misma forma, otra tabla. */
function candidatasNfl(): Candidato[] {
  const rows = getDb()
    .prepare(
      `SELECT l.match_key, l.upcoming_id, l.home_name, l.away_name, l.prob_home, l.market_prob_home,
              u.odds_home, u.odds_away, u.source, u.commence_time
         FROM naf_prediction_log l
         JOIN naf_upcoming u ON u.id = l.upcoming_id
        WHERE l.home_points IS NULL
          AND l.market_prob_home IS NOT NULL
          AND u.source <> 'fixture'
          AND u.odds_home IS NOT NULL AND u.odds_away IS NOT NULL
          AND u.commence_time > ?
          AND l.upcoming_id NOT IN (SELECT event_id FROM paper_bets)`,
    )
    .all(new Date().toISOString()) as unknown as {
    match_key: string;
    upcoming_id: string;
    home_name: string;
    away_name: string;
    prob_home: number;
    market_prob_home: number;
    odds_home: number;
    odds_away: number;
  }[];

  return rows.map((r) => {
    const lados = [
      { nombre: r.home_name, p: r.prob_home, pm: r.market_prob_home, odds: r.odds_home },
      { nombre: r.away_name, p: 1 - r.prob_home, pm: 1 - r.market_prob_home, odds: r.odds_away },
    ];
    const mejor = lados.reduce((a, b) => (b.p - b.pm > a.p - a.pm ? b : a));
    return {
      sport: 'nfl',
      match_key: r.match_key,
      event_id: r.upcoming_id,
      label: `${r.away_name} @ ${r.home_name}`,
      selection: mejor.nombre,
      pModel: mejor.p,
      pMarket: mejor.pm,
      odds: mejor.odds,
    };
  });
}

export function place(): { colocadas: number; motivo: string | null; detalle: string[] } {
  const db = getDb();
  if (!getMeta(KEY_INICIO)) setMeta(KEY_INICIO, new Date().toISOString());

  let candidatas: Candidato[] = [];
  try {
    candidatas = [...candidatasTenis(), ...candidatasNfl()];
  } catch (e) {
    return { colocadas: 0, motivo: `no pude leer las candidatas: ${(e as Error).message}`, detalle: [] };
  }
  if (candidatas.length === 0) {
    return {
      colocadas: 0,
      // El motivo distingue las dos razones por las que puede no haber nada, que piden
      // cosas distintas: sin cuotas reales el experimento no puede empezar; con ellas y
      // sin ventaja, ha corrido y ha decidido no apostar, que es un resultado.
      motivo:
        'no hay ningún partido con CUOTAS REALES por delante. Con cuotas de demostración ' +
        'este banco no apuesta: el modelo encontraría valor en su propio precio y el ' +
        'resultado no diría nada.',
      detalle: [],
    };
  }

  // Ordenadas por ventaja: si los topes de exposición cortan, que corten las peores.
  candidatas.sort((a, b) => b.pModel - b.pMarket - (a.pModel - a.pMarket));

  const ins = db.prepare(
    `INSERT OR IGNORE INTO paper_bets
       (placed_at, sport, match_key, event_id, label, selection, p_model, p_market, odds, stake, bankroll_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const ahora = new Date().toISOString();
  const banco = bancoActual();
  let abierto = expuesto();
  let colocadas = 0;
  const detalle: string[] = [];

  for (const c of candidatas) {
    const d = decideStake(
      { sport: c.sport, p: c.pModel, odds: c.odds, bankroll: banco, openExposure: abierto },
      DEFAULT_CONFIG,
    );
    if (d.stake <= 0) {
      detalle.push(`${c.label}: no se apuesta — ${d.blockedBy ?? 'sin ventaja suficiente'}`);
      continue;
    }
    ins.run(
      ahora, c.sport, c.match_key, c.event_id, c.label, c.selection,
      c.pModel, c.pMarket, c.odds, Math.round(d.stake * 100) / 100, banco,
    );
    // La exposición se acumula DENTRO del bucle. Sin esto, veinte candidatas se
    // dimensionarían todas como si fueran la primera y los topes no servirían de nada.
    abierto += d.stake;
    colocadas++;
    detalle.push(
      `${c.label}: ${c.selection} a ${c.odds.toFixed(2)} · ${d.stake.toFixed(2)} ` +
        `(${(d.edge * 100).toFixed(1)} pp de ventaja)`,
    );
  }
  return { colocadas, motivo: colocadas === 0 ? 'ninguna candidata pasó la política de sizing' : null, detalle };
}

// ---------------------------------------------------------------------------
// LIQUIDAR
// ---------------------------------------------------------------------------
/**
 * Liquida contra el resultado REAL, leyéndolo del log de predicciones.
 *
 * El log ya tiene toda la maquinaria de emparejar un próximo partido con su resultado
 * —ventana de fechas incluida, ver trackRecord.ts— y reusarla evita tener dos ideas
 * distintas de cuándo un partido «ya se jugó».
 */
export function settle(): { liquidadas: number } {
  const db = getDb();
  const pend = db
    .prepare("SELECT * FROM paper_bets WHERE status = 'pending'")
    .all() as unknown as ApuestaPapel[];
  if (pend.length === 0) return { liquidadas: 0 };

  const tenis = db.prepare(
    `SELECT l.winner_id, p1.name AS p1, p2.name AS p2
       FROM prediction_log l
       LEFT JOIN players p1 ON p1.tour = l.tour AND p1.id = l.p1_id
       LEFT JOIN players p2 ON p2.tour = l.tour AND p2.id = l.p2_id
      WHERE l.match_key = ? AND l.resolved_at IS NOT NULL`,
  );
  const nfl = db.prepare(
    `SELECT home_name, away_name, home_points, away_points
       FROM naf_prediction_log WHERE match_key = ? AND home_points IS NOT NULL`,
  );
  const upd = db.prepare(
    'UPDATE paper_bets SET status = ?, settled_at = ?, profit = ? WHERE id = ?',
  );

  const ahora = new Date().toISOString();
  let liquidadas = 0;
  for (const a of pend) {
    let ganador: string | null = null;
    if (a.sport === 'tennis') {
      const r = tenis.get(a.match_key) as { winner_id: number; p1: string; p2: string } | undefined;
      if (!r) continue;
      // El log guarda el id del ganador; la apuesta guarda el nombre. Se compara por
      // nombre porque es lo que se enseñó y lo que se puede auditar leyendo la fila.
      const row = db
        .prepare('SELECT p1_id, p2_id FROM prediction_log WHERE match_key = ?')
        .get(a.match_key) as { p1_id: number; p2_id: number } | undefined;
      if (!row) continue;
      ganador = r.winner_id === row.p1_id ? r.p1 : r.p2;
    } else if (a.sport === 'nfl') {
      const r = nfl.get(a.match_key) as
        | { home_name: string; away_name: string; home_points: number; away_points: number }
        | undefined;
      if (!r) continue;
      if (r.home_points === r.away_points) {
        // Empate: en la NFL es raro y el moneyline se anula. Void, no perdida.
        upd.run('void', ahora, 0, a.id);
        liquidadas++;
        continue;
      }
      ganador = r.home_points > r.away_points ? r.home_name : r.away_name;
    }
    if (!ganador) continue;
    const acierto = ganador === a.selection;
    upd.run(
      acierto ? 'won' : 'lost',
      ahora,
      acierto ? Math.round(a.stake * (a.odds - 1) * 100) / 100 : -a.stake,
      a.id,
    );
    liquidadas++;
  }
  return { liquidadas };
}
