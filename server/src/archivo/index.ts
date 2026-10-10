// El archivo de predicciones (Fase 6.6): todo lo que el modelo dijo antes de cada partido, de los
// cinco registros, con lo que pasó.
//
// Por cada predicción: la probabilidad TAL COMO SE MOSTRÓ (la enseñada donde existe), el
// resultado, la confianza de la última evaluación anterior al inicio, el CLV de la apuesta de papel
// o, si no la hubo, de la señal registrada, y la versión de la política con la que se evaluó. Lee
// los registros inmutables; no escribe nada.
//
// Los filtros de texto, deporte, liga y fechas van en SQL; la confianza, la banda y el resultado
// salen de cruzar tablas y se filtran después, antes de paginar. Con los volúmenes de hoy (miles de
// filas) es inmediato; si crece mucho, la Fase 7 puede precalcularlo.

import { getDb } from '../db.ts';
import { normalizar } from '../buscar/index.ts';
import { avisoMuestra, type AvisoMuestra } from '../evaluation/sample.ts';

/** «nulo»: empate en la NFL, el moneyline se devuelve; ni acierto ni fallo. */
export type Resultado = 'acierto' | 'fallo' | 'nulo' | 'pendiente';
export type Banda = '50–60 %' | '60–75 %' | '≥ 75 %';

export interface FilaArchivo {
  sport: string;
  matchKey: string;
  eventoId: string | null;
  liga: string | null;
  cuando: string | null;
  registrada: string;
  partido: string;
  casa: string;
  fuera: string;
  probabilidades: number[];
  /** Nombres de las salidas, en el orden de `probabilidades`. */
  salidas: string[];
  favorito: string;
  probabilidad: number;
  /** La del mercado para el favorito, sin margen, cuando se registró. */
  mercado: number | null;
  banda: Banda;
  resultado: Resultado;
  marcador: string | null;
  confianza: 'ALTA' | 'MEDIA' | 'BAJA' | null;
  decision: string | null;
  clv: number | null;
  /** De dónde sale el CLV: la apuesta de papel o la señal registrada. */
  clvDe: 'papel' | 'señal' | null;
  politica: number | null;
  version: string | null;
  url: string;
}

export interface FiltroArchivo {
  q?: string;
  sport?: string;
  liga?: string;
  confianza?: 'ALTA' | 'MEDIA' | 'BAJA' | 'ninguna';
  banda?: Banda;
  resultado?: Resultado;
  desde?: string;
  hasta?: string;
  pagina?: number;
  porPagina?: number;
}

export interface Archivo {
  filas: FilaArchivo[];
  total: number;
  pagina: number;
  porPagina: number;
  /** Resueltas = aciertos + fallos (los nulos no cuentan). */
  resumen: { resueltas: number; aciertos: number; pendientes: number; aviso: AvisoMuestra };
  ligas: { sport: string; liga: string }[];
}

/** Una consulta por registro con las mismas columnas: la unión sale de aquí. */
const CONSULTAS: Record<string, string> = {
  tennis: `SELECT 'tennis' AS sport, match_key AS mk, upcoming_id AS ev, COALESCE(tournament_name, tour) AS liga, commence_time AS cuando, predicted_at AS reg,
                  p1_name AS casa, p2_name AS fuera, prob1 AS p0, NULL AS p1, 1 - prob1 AS p2, market_prob1 AS m0, NULL AS m1, 1 - market_prob1 AS m2,
                  CASE WHEN resolved_at IS NULL OR winner_id IS NULL THEN NULL WHEN winner_id = p1_id THEN 0 ELSE 2 END AS y, NULL AS marcador, model_version AS v
             FROM prediction_log`,
  football: `SELECT 'football', match_key, upcoming_id, league, commence_time, predicted_at, home_name, away_name,
                    COALESCE(shown_home, prob_home), COALESCE(shown_draw, prob_draw), COALESCE(shown_away, prob_away), market_prob_home, market_prob_draw, market_prob_away,
                    CASE WHEN resolved_at IS NULL OR home_goals IS NULL THEN NULL WHEN home_goals > away_goals THEN 0 WHEN home_goals = away_goals THEN 1 ELSE 2 END,
                    CASE WHEN home_goals IS NULL THEN NULL ELSE home_goals || '-' || away_goals END, model_version
               FROM fb_prediction_log`,
  basketball: `SELECT 'basketball', game_key, upcoming_id, league, commence_time, predicted_at, home_name, away_name, prob_home, NULL, 1 - prob_home, market_prob_home, NULL, 1 - market_prob_home,
                      CASE WHEN home_pts IS NULL THEN NULL WHEN home_pts > away_pts THEN 0 ELSE 2 END, CASE WHEN home_pts IS NULL THEN NULL ELSE home_pts || '-' || away_pts END, model_version
                 FROM bb_prediction_log`,
  baseball: `SELECT 'baseball', match_key, upcoming_id, league, commence_time, predicted_at, home_name, away_name, prob_home, NULL, 1 - prob_home, market_prob_home, NULL, 1 - market_prob_home,
                    CASE WHEN home_runs IS NULL THEN NULL WHEN home_runs > away_runs THEN 0 ELSE 2 END, CASE WHEN home_runs IS NULL THEN NULL ELSE home_runs || '-' || away_runs END, model_version
               FROM bsb_prediction_log`,
  // NFL: un empate devuelve el moneyline; se cuenta como resuelto sin acierto ni fallo (y = −1).
  nfl: `SELECT 'nfl', match_key, upcoming_id, league, commence_time, predicted_at, home_name, away_name, COALESCE(shown_home, prob_home), NULL, 1 - COALESCE(shown_home, prob_home),
               market_prob_home, NULL, 1 - market_prob_home,
               CASE WHEN home_points IS NULL THEN NULL WHEN home_points > away_points THEN 0 WHEN home_points = away_points THEN -1 ELSE 2 END,
               CASE WHEN home_points IS NULL THEN NULL ELSE home_points || '-' || away_points END, model_version
          FROM naf_prediction_log`,
  // NHL: el moneyline incluye prórroga y tanda, no hay empate.
  nhl: `SELECT 'nhl', match_key, upcoming_id, league, commence_time, predicted_at, home_name, away_name, COALESCE(shown_home, prob_home), NULL, 1 - COALESCE(shown_home, prob_home),
               market_prob_home, NULL, 1 - market_prob_home,
               CASE WHEN home_goals IS NULL THEN NULL WHEN home_goals > away_goals THEN 0 ELSE 2 END,
               CASE WHEN home_goals IS NULL THEN NULL ELSE home_goals || '-' || away_goals END, model_version
          FROM nhl_prediction_log`,
  // UFC: A y B (sin local); el empate y el «sin resultado» devuelven la apuesta (y = −1). El «marcador» es el método.
  ufc: `SELECT 'ufc', match_key, upcoming_id, league, commence_time, predicted_at, home_name, away_name, COALESCE(shown_home, prob_home), NULL, 1 - COALESCE(shown_home, prob_home),
               market_prob_home, NULL, 1 - market_prob_home,
               CASE WHEN outcome IS NULL THEN NULL WHEN outcome = 'A' THEN 0 WHEN outcome = 'B' THEN 2 ELSE -1 END,
               CASE WHEN outcome IS NULL THEN NULL WHEN outcome = 'EMPATE' THEN 'empate' WHEN outcome = 'NC' THEN 'sin resultado' ELSE COALESCE(metodo, 'decidida') END, model_version
          FROM ufc_prediction_log`,
};

const CABECERA =
  'SELECT NULL AS sport, NULL AS mk, NULL AS ev, NULL AS liga, NULL AS cuando, NULL AS reg, NULL AS casa, NULL AS fuera, NULL AS p0, NULL AS p1, NULL AS p2, ' +
  'NULL AS m0, NULL AS m1, NULL AS m2, NULL AS y, NULL AS marcador, NULL AS v WHERE 0';

interface Cruda {
  sport: string; mk: string; ev: string | null; liga: string | null; cuando: string | null; reg: string; casa: string; fuera: string;
  p0: number; p1: number | null; p2: number; m0: number | null; m1: number | null; m2: number | null; y: number | null; marcador: string | null; v: string | null;
}

export function bandaDe(p: number): Banda {
  return p < 0.6 ? '50–60 %' : p < 0.75 ? '60–75 %' : '≥ 75 %';
}

/** La fila normalizada: favorito, banda y resultado. */
export function normalizarFila(r: Cruda): Omit<FilaArchivo, 'confianza' | 'decision' | 'clv' | 'clvDe' | 'politica'> {
  const tres = r.p1 != null;
  const probabilidades = tres ? [r.p0, r.p1 as number, r.p2] : [r.p0, r.p2];
  const salidas = tres ? [r.casa, 'Empate', r.fuera] : [r.casa, r.fuera];
  const mercado = tres ? [r.m0, r.m1, r.m2] : [r.m0, r.m2];
  let i = 0;
  for (let k = 1; k < probabilidades.length; k++) if (probabilidades[k] > probabilidades[i]) i = k;
  // y: 0 local/primero, 1 empate, 2 visitante/segundo; −1 empate devuelto (NFL).
  const yIdx = r.y == null || r.y < 0 ? null : tres ? r.y : r.y === 0 ? 0 : 1;
  const resultado: Resultado = r.y == null ? 'pendiente' : r.y < 0 ? 'nulo' : yIdx === i ? 'acierto' : 'fallo';
  const arroba = r.sport === 'nfl' || r.sport === 'nhl';
  const sep = arroba ? ' @ ' : ' vs ';
  const partido = arroba ? `${r.fuera}${sep}${r.casa}` : `${r.casa}${sep}${r.fuera}`;
  return {
    sport: r.sport,
    matchKey: r.mk,
    eventoId: r.ev,
    liga: r.liga,
    cuando: r.cuando,
    registrada: r.reg,
    partido,
    casa: r.casa,
    fuera: r.fuera,
    probabilidades,
    salidas,
    favorito: salidas[i],
    probabilidad: probabilidades[i],
    mercado: mercado[i] ?? null,
    banda: bandaDe(probabilidades[i]),
    resultado,
    marcador: r.marcador,
    version: r.v,
    url: `/partido/${r.sport}/${encodeURIComponent(r.ev ?? r.mk)}?clave=${encodeURIComponent(r.mk)}`,
  };
}

export function buscarEnArchivo(f: FiltroArchivo = {}): Archivo {
  const db = getDb();
  const deportes = f.sport && CONSULTAS[f.sport] ? [f.sport] : Object.keys(CONSULTAS);
  const where: string[] = [];
  const args: string[] = [];
  if (f.liga) {
    where.push('liga = ?');
    args.push(f.liga);
  }
  if (f.desde) {
    where.push('COALESCE(cuando, reg) >= ?');
    args.push(f.desde);
  }
  if (f.hasta) {
    where.push('COALESCE(cuando, reg) < ?');
    args.push(`${f.hasta}T99`);
  }
  // La cabecera sin filas pone los nombres de columna, consulte uno o los cinco registros.
  const union = [CABECERA, ...deportes.map((d) => CONSULTAS[d])].join(' UNION ALL ');
  // Sin try: una consulta rota tiene que fallar a la vista, no devolver un archivo vacío.
  const crudas = db
    .prepare(`SELECT * FROM (${union}) ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY COALESCE(cuando, reg) DESC LIMIT 20000`)
    .all(...args) as unknown as Cruda[];
  const ligas = [...new Map(crudas.filter((c) => c.liga).map((c) => [`${c.sport}|${c.liga}`, { sport: c.sport, liga: c.liga as string }])).values()].sort((a, b) => a.sport.localeCompare(b.sport) || a.liga.localeCompare(b.liga));

  let filas = crudas.map(normalizarFila);
  if (f.q?.trim()) {
    const n = normalizar(f.q);
    filas = filas.filter((x) => normalizar(`${x.partido} ${x.liga ?? ''} ${x.matchKey}`).includes(n));
  }
  if (f.banda) filas = filas.filter((x) => x.banda === f.banda);
  if (f.resultado) filas = filas.filter((x) => x.resultado === f.resultado);

  // La confianza de la última evaluación ANTES del inicio, y el CLV con su política.
  const evaluacion = db.prepare(
    "SELECT confidence, decision FROM prediction_assessments WHERE sport = ? AND match_key = ? AND (? IS NULL OR assessed_at <= ?) ORDER BY assessed_at DESC, id DESC LIMIT 1",
  );
  const papel = db.prepare('SELECT clv, policy_version_id AS pv FROM paper_bets WHERE event_id = ? ORDER BY id DESC LIMIT 1');
  const senal = db.prepare('SELECT clv, policy_version_id AS pv FROM edge_signals WHERE event_id = ? ORDER BY id DESC LIMIT 1');
  const cruzar = (x: (typeof filas)[number]): FilaArchivo => {
    const a = evaluacion.get(x.sport, x.matchKey, x.cuando, x.cuando) as { confidence: string; decision: string } | undefined;
    const p = x.eventoId ? (papel.get(x.eventoId) as { clv: number | null; pv: number | null } | undefined) : undefined;
    const s = !p && x.eventoId ? (senal.get(x.eventoId) as { clv: number | null; pv: number | null } | undefined) : undefined;
    const fuente = p ?? s;
    return {
      ...x,
      confianza: (a?.confidence as FilaArchivo['confianza']) ?? null,
      decision: a?.decision ?? null,
      clv: fuente?.clv ?? null,
      clvDe: p ? 'papel' : s ? 'señal' : null,
      politica: fuente?.pv ?? null,
    };
  };
  let completas: FilaArchivo[];
  if (f.confianza) {
    completas = filas.map(cruzar).filter((x) => (f.confianza === 'ninguna' ? x.confianza == null : x.confianza === f.confianza));
  } else completas = [];

  const total = f.confianza ? completas.length : filas.length;
  const porPagina = Math.max(1, Math.min(200, f.porPagina ?? 50));
  const pagina = Math.max(1, f.pagina ?? 1);
  const desde = (pagina - 1) * porPagina;
  const pag = f.confianza ? completas.slice(desde, desde + porPagina) : filas.slice(desde, desde + porPagina).map(cruzar);

  const base = f.confianza ? completas : filas;
  const resueltas = base.filter((x) => x.resultado === 'acierto' || x.resultado === 'fallo');
  return {
    filas: pag,
    total,
    pagina,
    porPagina,
    resumen: {
      resueltas: resueltas.length,
      aciertos: resueltas.filter((x) => x.resultado === 'acierto').length,
      pendientes: base.filter((x) => x.resultado === 'pendiente').length,
      aviso: avisoMuestra(resueltas.length, 'predicciones'),
    },
    ligas,
  };
}
