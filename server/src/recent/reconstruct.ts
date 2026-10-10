// Las predicciones RECONSTRUIDAS de los partidos recientes: qué habría dicho el modelo de
// cada partido jugado, con solo lo que se sabía antes de que empezara.
//
// ===========================================================================
// POR QUÉ HACE FALTA
// ===========================================================================
// «¿Acertó?» salía solo del registro en vivo: los partidos que la app llegó a enseñar
// antes de jugarse. Con el servidor apagado unos días, o en una liga que nadie abrió,
// el registro tiene huecos, y una semana con 19 partidos no dice nada del modelo. El
// archivo de resultados, en cambio, tiene TODOS los partidos jugados.
//
// ===========================================================================
// SIN MIRAR AL FUTURO, Y CON EL MODELO DE VERDAD
// ===========================================================================
// No se reimplementa ningún modelo. Cada deporte usa la misma reproducción cronológica
// que su backtest (`replayGames` / `replayMatches` / `runBacktest`), que entrega a cada
// partido el estado de los ratings ANTES de jugarlo y se actualiza después. El
// Dixon-Coles del fútbol se ajusta solo con partidos de fechas anteriores
// (DcWalkForward). Es decir: la cifra es la del backtest, partido a partido.
//
// Dentro de un mismo día, como en los backtests y en los replays: los partidos se
// procesan en orden y uno ya jugado cuenta como pasado para el siguiente (con el Elo o
// con la ventaja de campo que el baloncesto aprende en línea). Ni el resultado del propio
// partido ni nada de días posteriores mueve su predicción; lo fija recent/recent.test.ts.
//
// Lo que NO es: la probabilidad que se enseñó. No lleva la mezcla con el mercado ni el
// post-proceso del vivo, ni alineaciones o lesiones del día. Por eso va etiquetada aparte
// («reconstruida») y su acierto se cuenta por separado del registro en vivo, que sigue
// siendo la prueba de verdad.
//
// Y no se usa para ajustar nada: no escribe en el registro de experimentos ni en las
// métricas de backtest. Es para mirar, no para elegir — el holdout sigue cerrado.
//
// Tenis: no se reconstruye. Su archivo (Sackmann) solo trae la fecha de INICIO del
// torneo, no la del partido, y llega con semanas de retraso.

import { getDb } from '../db.ts';
import { loadGames as cargarBaloncesto, replayGames as replayBaloncesto } from '../basketball/ratings.ts';
import { runBacktest as backtestBeisbol } from '../baseball/backtest.ts';
import type { Juego } from '../evaluation/walkforward.ts';
import { listGamesWithMarket } from '../nfl/repo.ts';
import { replayGames as replayNfl, type ReplayGame as JuegoNfl } from '../nfl/ratings.ts';
import { loadMatches, replayMatches, DC_HYPER } from '../football/ratings.ts';
import type { DcMatch } from '../football/bayes/dixonColes.ts';
import { DcWalkForward } from '../football/bayes/walkforward.ts';
import { prediccionFutbolEnReplay, prediccionNflEnReplay } from '../evaluation/replay.ts';
import type { LeagueId as LigaBaloncesto } from '../basketball/types.ts';
import type { LeagueId as LigaFutbol } from '../football/types.ts';
import type { LeagueId as LigaNfl } from '../nfl/types.ts';
import type { LeagueId as LigaBeisbol } from '../baseball/types.ts';
import { recorrer as recorrerNhl } from '../nhl/ajuste.ts';
import { leerPartidos as partidosNhl } from '../nhl/evaluacion.ts';
import { leerFichas as fichasUfc, leerPeleas as peleasUfc, recorrer as recorrerUfc } from '../ufc/evaluacion.ts';
import { pesosVigentes as pesosUfc, predecirConPesos as predecirUfc } from '../ufc/combinado.ts';
import { UFC } from '../ufc/model.ts';

export type DeporteReconstruible = 'Fútbol' | 'Baloncesto' | 'Béisbol' | 'NFL' | 'NHL' | 'UFC';

export interface PrediccionReconstruida {
  deporte: DeporteReconstruible;
  liga: string;
  /** YYYYMMDD, tal como lo guarda el archivo (fecha local del partido). */
  fecha: string;
  casaId: string;
  fueraId: string;
  /** [local, visitante] o, en fútbol, [local, empate, visitante]. */
  probs: number[];
  /** Índice en `probs` de lo que pasó. */
  y: number;
}

/**
 * Partidos previos que necesita cada lado para reconstruir su predicción: los mismos
 * calentamientos que el backtest de cada deporte. Por debajo, el rating aún no dice
 * nada y la cifra no describiría al modelo sino a su valor inicial.
 */
export const CALENTAMIENTO: Record<DeporteReconstruible, number> = { 'Fútbol': 20, 'Baloncesto': 20, 'Béisbol': 60, NFL: 0, NHL: 20, UFC: 0 };

export interface Reconstruccion {
  partidos: PrediccionReconstruida[];
  /** Jugados en la ventana pero sin reconstruir (algún lado sin historia suficiente). */
  sinHistoria: Record<DeporteReconstruible, number>;
}

const ligasDe = (tabla: string): string[] => {
  try {
    return (getDb().prepare(`SELECT DISTINCT league AS l FROM ${tabla}`).all() as { l: string }[]).map((r) => r.l);
  } catch {
    return [];
  }
};

function baloncesto(desde: string, out: Reconstruccion): void {
  for (const liga of ligasDe('bb_games')) {
    replayBaloncesto(cargarBaloncesto(liga as LigaBaloncesto), {
      onGame: ({ game, home, away, probHome }) => {
        if (game.game_date < desde || game.home_pts === game.away_pts) return;
        if (home.games < CALENTAMIENTO.Baloncesto || away.games < CALENTAMIENTO.Baloncesto) {
          out.sinHistoria.Baloncesto++;
          return;
        }
        out.partidos.push({
          deporte: 'Baloncesto', liga, fecha: game.game_date, casaId: game.home_id, fueraId: game.away_id,
          probs: [probHome, 1 - probHome], y: game.home_pts > game.away_pts ? 0 : 1,
        });
      },
    });
  }
}

function beisbol(desde: string, out: Reconstruccion): void {
  for (const liga of ligasDe('bsb_games')) {
    // El backtest tal cual, con el factor de estadio de ventana expansiva que usa su CLI
    // por defecto: cada partido con un factor calculado solo con partidos anteriores.
    const flujo: Juego[] = [];
    backtestBeisbol({ league: liga as LigaBeisbol, park: true, flujo });
    for (const j of flujo) {
      if (j.fecha < desde) continue;
      if (!j.modelo) {
        out.sinHistoria['Béisbol']++;
        continue;
      }
      out.partidos.push({ deporte: 'Béisbol', liga, fecha: j.fecha, casaId: j.a, fueraId: j.b, probs: j.modelo, y: j.y });
    }
  }
}

function nfl(desde: string, out: Reconstruccion): void {
  for (const liga of ligasDe('naf_games')) {
    const filas = listGamesWithMarket(liga as LigaNfl).filter((r) => r.home_points != null && r.away_points != null);
    const juegos: JuegoNfl[] = filas.map((r) => ({
      season: r.season, week: r.week, game_date: r.game_date, home_id: r.home_id, away_id: r.away_id,
      home_points: r.home_points, away_points: r.away_points, neutral: r.neutral, playoff: r.playoff,
      home_rest: r.home_rest, away_rest: r.away_rest, home_qb_id: r.home_qb_id, away_qb_id: r.away_qb_id,
      home_qb_name: r.home_qb_name, away_qb_name: r.away_qb_name, roof: r.roof, wind: r.wind,
    }));
    replayNfl(juegos, {
      onGame: ({ game, expectedMargin, expectedTotal }) => {
        if (game.game_date < desde || game.home_points === game.away_points) return;
        // El mismo camino que el backtest (evaluation/replay.ts).
        out.partidos.push({
          deporte: 'NFL', liga, fecha: game.game_date, casaId: game.home_id, fueraId: game.away_id,
          probs: prediccionNflEnReplay(expectedMargin, expectedTotal), y: game.home_points > game.away_points ? 0 : 1,
        });
      },
    });
  }
}

function nhl(desde: string, out: Reconstruccion): void {
  // El mismo recorrido que el backtest y la predicción publicada (nhl/ajuste.ts): el moneyline es el
  // Elo antes del partido. Las fechas de la NHL van con guiones; aquí se pasan a YYYYMMDD.
  const partidos = partidosNhl();
  const pasos = recorrerNhl(partidos);
  const jugados = new Map<string, number>();
  partidos.forEach((g, i) => {
    const fecha = g.game_date.replace(/-/g, '');
    const pocos = (jugados.get(g.home_id) ?? 0) < CALENTAMIENTO.NHL || (jugados.get(g.away_id) ?? 0) < CALENTAMIENTO.NHL;
    jugados.set(g.home_id, (jugados.get(g.home_id) ?? 0) + 1);
    jugados.set(g.away_id, (jugados.get(g.away_id) ?? 0) + 1);
    if (fecha < desde) return;
    if (pocos) {
      out.sinHistoria.NHL++;
      return;
    }
    const p = pasos[i].pLocal;
    out.partidos.push({ deporte: 'NHL', liga: 'nhl', fecha, casaId: g.home_id, fueraId: g.away_id, probs: [p, 1 - p], y: g.home_goals > g.away_goals ? 0 : 1 });
  });
}

function ufc(desde: string, out: Reconstruccion): void {
  // El mismo recorrido que el backtest y la predicción publicada (ufc/evaluacion.ts): los rasgos de
  // antes de la pelea y los pesos de la logística publicada, ajustados SOLO con lo anterior al
  // holdout (las peleas recientes son holdout: se miran, no ajustan nada). Sin calentamiento por
  // luchador: el backtest también puntúa los debuts. A y B son los dos en orden de id.
  const { pasos } = recorrerUfc(peleasUfc(), UFC, fichasUfc());
  const { pesos } = pesosUfc(pasos);
  const desdeGuion = `${desde.slice(0, 4)}-${desde.slice(4, 6)}-${desde.slice(6, 8)}`;
  for (const x of pasos) {
    if (x.fecha < desdeGuion) continue;
    const p = predecirUfc(x.rasgos, pesos).p;
    out.partidos.push({ deporte: 'UFC', liga: 'ufc', fecha: x.fecha.replace(/-/g, ''), casaId: x.ids[0], fueraId: x.ids[1], probs: [p, 1 - p], y: x.y === 1 ? 0 : 1 });
  }
}

function futbol(desde: string, out: Reconstruccion): void {
  for (const liga of ligasDe('fb_matches')) {
    const partidos = loadMatches(liga as LigaFutbol);
    if (partidos.length === 0 || partidos[partidos.length - 1].match_date < desde) continue;
    const filasDc: DcMatch[] = partidos.map((m) => ({ date: m.match_date, homeId: m.home_id, awayId: m.away_id, homeGoals: m.home_goals, awayGoals: m.away_goals }));
    // Ajuste perezoso: solo se pide para fechas de la ventana, y cada ajuste usa
    // únicamente partidos de fechas ANTERIORES (`h.date < date` en DcWalkForward).
    const dc = new DcWalkForward(filasDc, DC_HYPER);
    replayMatches(partidos, {
      onMatch: ({ match, home, away, lambda }) => {
        if (match.match_date < desde) return;
        if (home.matches < CALENTAMIENTO['Fútbol'] || away.matches < CALENTAMIENTO['Fútbol']) {
          out.sinHistoria['Fútbol']++;
          return;
        }
        // El mismo camino que el backtest (evaluation/replay.ts): Dixon-Coles si conoce a
        // los dos; si no, el Elo.
        out.partidos.push({
          deporte: 'Fútbol', liga, fecha: match.match_date, casaId: match.home_id, fueraId: match.away_id,
          probs: prediccionFutbolEnReplay(dc, match, lambda).probs, y: match.result === 'H' ? 0 : match.result === 'D' ? 1 : 2,
        });
      },
    });
  }
}

const TABLAS: Record<DeporteReconstruible, { tabla: string; marcador: [string, string]; fecha: string }> = {
  'Fútbol': { tabla: 'fb_matches', marcador: ['home_goals', 'away_goals'], fecha: 'match_date' },
  'Baloncesto': { tabla: 'bb_games', marcador: ['home_pts', 'away_pts'], fecha: 'game_date' },
  'Béisbol': { tabla: 'bsb_games', marcador: ['home_runs', 'away_runs'], fecha: 'game_date' },
  NFL: { tabla: 'naf_games', marcador: ['home_points', 'away_points'], fecha: 'game_date' },
  NHL: { tabla: 'nhl_games', marcador: ['home_goals', 'away_goals'], fecha: 'game_date' },
  // Sin marcador: el asalto y el orden en la cartelera hacen de huella (la ingesta reescribe el archivo entero).
  UFC: { tabla: 'ufc_fights', marcador: ['asalto', 'orden'], fecha: 'fecha' },
};
const CALCULO: Record<DeporteReconstruible, (desde: string, out: Reconstruccion) => void> = {
  'Fútbol': futbol, 'Baloncesto': baloncesto, 'Béisbol': beisbol, NFL: nfl, NHL: nhl, UFC: ufc,
};

/**
 * Huella del archivo: si no cambia, la reconstrucción tampoco. Filas e id máximo no
 * bastan: un marcador corregido en su sitio no cambia ninguno de los dos, y la pantalla
 * seguiría puntuando el resultado viejo. La suma de los marcadores sí lo ve.
 */
function huella(t: (typeof TABLAS)[DeporteReconstruible]): string {
  try {
    const r = getDb()
      .prepare(`SELECT COUNT(*) AS n, MAX(id) AS m, MAX(${t.fecha}) AS f, TOTAL(${t.marcador[0]}) AS a, TOTAL(${t.marcador[1]}) AS b FROM ${t.tabla}`)
      .get() as Record<string, unknown>;
    return [r.n, r.m, r.f, r.a, r.b].join('|');
  } catch {
    return 'sin tabla';
  }
}

// Reproducir el archivo entero cuesta ~1 s por deporte; se hace una vez por cambio de
// datos (un `update-data`) y por ventana, no en cada petición.
const cache = new Map<string, { huella: string; r: Reconstruccion }>();

/** Todos los partidos jugados desde `desde` (YYYYMMDD) con su predicción reconstruida. */
export function reconstruirDesde(desde: string): Reconstruccion {
  const total: Reconstruccion = { partidos: [], sinHistoria: { 'Fútbol': 0, 'Baloncesto': 0, 'Béisbol': 0, NFL: 0, NHL: 0, UFC: 0 } };
  for (const deporte of Object.keys(TABLAS) as DeporteReconstruible[]) {
    const clave = `${deporte}|${desde}`;
    const h = huella(TABLAS[deporte]);
    let e = cache.get(clave);
    if (!e || e.huella !== h) {
      const r: Reconstruccion = { partidos: [], sinHistoria: { 'Fútbol': 0, 'Baloncesto': 0, 'Béisbol': 0, NFL: 0, NHL: 0, UFC: 0 } };
      try {
        CALCULO[deporte](desde, r);
      } catch {
        // Un deporte sin archivo (o con un archivo a medio cargar) no deja sin
        // reconstrucción a los otros tres.
      }
      e = { huella: h, r };
      cache.set(clave, e);
    }
    total.partidos.push(...e.r.partidos);
    total.sinHistoria[deporte] += e.r.sinHistoria[deporte];
  }
  return total;
}

/** Para los tests: olvidar lo calculado. */
export function olvidarReconstrucciones(): void {
  cache.clear();
}
