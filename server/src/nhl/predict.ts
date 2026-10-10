// La predicción completa de un partido de la NHL, explicable.
//
// Todo sale de UNA distribución: el Elo da la probabilidad de ganar (prórroga y tanda incluidas, que
// es como se paga el moneyline en la NHL) y una Poisson por equipo, ajustada para reproducirla, da el
// resultado a 60 minutos, el total de goles y los marcadores probables. Así la tarjeta no puede decir
// un 60 % en el ganador y otra cosa en el total.
//
// ===========================================================================
// LO QUE NO HACE, Y LA TARJETA LO DICE
// ===========================================================================
//   · No conoce porteros ni bajas: el calendario no los trae, y el portero titular es el dato que más
//     mueve un partido de hockey.
//   · No se mezcla con el mercado. En los otros deportes el peso de la mezcla se ajustó con cuotas
//     históricas; de la NHL no hay ninguna alcanzable, así que no hay peso medido y la probabilidad
//     publicada es la del modelo. La diferencia con la casa se enseña como DESACUERDO, no como valor:
//     nadie ha medido todavía si ese desacuerdo se puede aprovechar.

import { VALUE_THRESHOLD } from '../model/market.ts';
import { NHL, predecir, resultado60 } from './model.ts';
import { estadoElo, getHeadToHead, getTeamInfo, type NhlTeamInfo } from './repo.ts';
import { nombreDe } from './equipos.ts';

export const DISCLAIMER =
  'Estimación estadística basada en un Elo por equipo con la diferencia de goles y una Poisson por equipo ' +
  'ajustada a ese Elo (prórroga y tanda a la mitad de fuerza). NO conoce al portero titular, las bajas ni el ' +
  'cansancio de los partidos seguidos, y no se mezcla con el mercado (no hay cuotas históricas de la NHL con ' +
  'las que medir esa mezcla). No es una certeza ni una recomendación para apostar.';

export type ReliabilityLevel = 'high' | 'medium' | 'low';

/**
 * La banda de incertidumbre. A JUICIO, no medida: en la NFL esta constante se ajustó contra el precio
 * de cierre, y aquí no hay precios históricos. Con un Elo de una temporada completa detrás de cada
 * equipo (82 partidos) da ±4,7 pp; con menos partidos, más.
 */
const ELO_SIGMA_C = 74;
const PARTIDOS_EFECTIVOS = 82;
const MIN_PARTIDOS = 40;
/** Días sin jugar a partir de los que el Elo es «de la temporada pasada» (el verano dura ~4 meses). */
const DIAS_PARADO = 100;

export interface NhlSide extends NhlTeamInfo {
  last5: ('W' | 'L')[];
  /** Goles esperados a 60 minutos en este partido. */
  expectedGoals: number;
}

export interface NhlReliability {
  level: ReliabilityLevel;
  label: string;
  marginPp: number;
  reasons: string[];
  gamesBehind: { home: number; away: number };
}

export interface NhlMarket {
  odds: { home: number; away: number };
  home: number;
  away: number;
  overround: number;
}

export interface NhlPrediction {
  league: 'nhl';
  teams: { home: NhlSide; away: NhlSide };
  /** Lo que dice el modelo: gana cada uno, prórroga y tanda incluidas. */
  model: { home: number; away: number };
  /** Lo que se publica. Igual que `model`: no hay post-proceso medido para la NHL. */
  final: { home: number; away: number };
  postprocess: { calibrator: 'ninguno'; weight: null; disagreement: null; note: string };
  /** El partido a 60 minutos: gana el local, empate (va a la prórroga) o gana el visitante. */
  regulation: { home: number; draw: number; away: number };
  goals: { home: number; away: number; /** Total esperado en el acta: la prórroga o la tanda suman uno. */ total: number };
  total: { line: number; over: number; under: number; push: number; fromMarket: boolean; odds: { over: number; under: number } | null };
  scorelines: { home: number; away: number; label: string; probability: number }[];
  h2h: ReturnType<typeof getHeadToHead>;
  market: {
    market: NhlMarket | null;
    edge: { home: number; away: number } | null;
    /** Desacuerdo, no valor: ver la cabecera del fichero. */
    verdict: 'differs_home' | 'differs_away' | 'agree' | 'no_market';
  };
  /** Los factores, en puntos de Elo a favor del local: su suma es el argumento de la logística. */
  reasoning: { factors: { key: string; label: string; pointsForHome: number }[] };
  reliability: NhlReliability;
  verdict: { label: string; close: boolean; marginPp: number };
  summary: { headline: string; bullets: string[] };
  context: { homeAdvantageElo: number; k: number; leagueGoals: number };
  disclaimer: string;
}

const pct = (p: number) => `${(p * 100).toFixed(1).replace('.', ',')} %`;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

function deVig(oddsHome: number | null | undefined, oddsAway: number | null | undefined): NhlMarket | null {
  if (!oddsHome || !oddsAway || oddsHome <= 1 || oddsAway <= 1) return null;
  const h = 1 / oddsHome;
  const a = 1 / oddsAway;
  return { odds: { home: oddsHome, away: oddsAway }, home: h / (h + a), away: a / (h + a), overround: h + a };
}

function fiabilidad(home: NhlTeamInfo, away: NhlTeamInfo, ahora: Date, probMargen: number): NhlReliability {
  const ef = (g: number) => Math.max(1, Math.min(g, PARTIDOS_EFECTIVOS));
  const sigma = ELO_SIGMA_C / Math.sqrt(ef(home.gamesInDb)) + ELO_SIGMA_C / Math.sqrt(ef(away.gamesInDb));
  const p = (dr: number) => 1 / (1 + 10 ** (-dr / 400));
  const marginPp = Math.round((p(sigma) - p(-sigma)) * 1000) / 10;
  const reasons: string[] = [];
  const pocos = Math.min(home.gamesInDb, away.gamesInDb);
  const parado = [home, away].filter((t) => t.lastDate && (ahora.getTime() - Date.parse(t.lastDate)) / 86_400_000 > DIAS_PARADO);
  let level: ReliabilityLevel = 'medium';
  if (pocos < MIN_PARTIDOS) {
    level = 'low';
    reasons.push(`Solo ${pocos} partidos detrás del Elo más flojo de los dos.`);
  }
  if (parado.length) reasons.push(`${parado.map((t) => t.name).join(' y ')} no juega${parado.length > 1 ? 'n' : ''} desde hace más de ${DIAS_PARADO} días: su Elo es el de la temporada pasada.`);
  if (probMargen < 0.06) reasons.push('Partido muy igualado: el favorito lo es por poco.');
  reasons.push('No conoce al portero titular, que es lo que más mueve un partido de hockey.');
  const label = level === 'low' ? 'fiabilidad baja' : 'fiabilidad media';
  return { level, label, marginPp, reasons, gamesBehind: { home: home.gamesInDb, away: away.gamesInDb } };
}

export interface PredictInput {
  homeId: string;
  awayId: string;
  oddsHome?: number | null;
  oddsAway?: number | null;
  totalLine?: number | null;
  oddsOver?: number | null;
  oddsUnder?: number | null;
  ahora?: Date;
}

export function buildPrediction(input: PredictInput): NhlPrediction | null {
  const { homeId, awayId } = input;
  const home = getTeamInfo(homeId);
  const away = getTeamInfo(awayId);
  if (!home || !away) return null;
  const e = estadoElo();
  const pr = predecir(e.elo.get(homeId)!, e.elo.get(awayId)!);
  const r60 = resultado60(pr.golesLocal, pr.golesVisitante);
  const totalEsperado = pr.golesLocal + pr.golesVisitante + r60.empata;

  // El total: la línea de la casa si la hay; si no, la media línea más cercana a lo esperado.
  const fromMarket = input.totalLine != null && Number.isFinite(input.totalLine);
  const linea = fromMarket ? input.totalLine! : Math.round(totalEsperado - 0.5) + 0.5;
  const over = pr.overTotal(linea);
  // Con línea entera el total exacto devuelve la apuesta («push»): P(total = L) = P(> L−1) − P(> L).
  const push = Number.isInteger(linea) ? Math.max(0, pr.overTotal(linea - 1) - over) : 0;
  const under = Math.max(0, 1 - over - push);

  const scorelines: NhlPrediction['scorelines'] = [];
  r60.grid.forEach((fila, i) => fila.forEach((pij, j) => scorelines.push({ home: i, away: j, label: `${i}-${j}`, probability: pij })));
  const suma = scorelines.reduce((a, s) => a + s.probability, 0);
  const top = scorelines
    .map((s) => ({ ...s, probability: r4(s.probability / suma) }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 6);

  const market = deVig(input.oddsHome, input.oddsAway);
  const edge = market ? { home: r4(pr.local - market.home), away: r4(pr.visitante - market.away) } : null;
  const verdictMercado: NhlPrediction['market']['verdict'] = !edge ? 'no_market' : edge.home >= VALUE_THRESHOLD ? 'differs_home' : edge.away >= VALUE_THRESHOLD ? 'differs_away' : 'agree';

  const ahora = input.ahora ?? new Date();
  const fav = pr.local >= 0.5 ? home : away;
  const pFav = Math.max(pr.local, pr.visitante);
  const reliability = fiabilidad(home, away, ahora, Math.abs(pr.local - 0.5));
  const close = Math.abs(pr.local - 0.5) * 100 < reliability.marginPp;
  const side = (t: NhlTeamInfo, g: number): NhlSide => ({ ...t, last5: t.form.slice(0, 5).map((f) => f.result), expectedGoals: Math.round(g * 100) / 100 });

  const bullets = [
    `Elo ${Math.round(home.elo)} contra ${Math.round(away.elo)}, más ${NHL.campo} puntos de jugar en casa.`,
    `Goles esperados a 60 minutos: ${pr.golesLocal.toFixed(2).replace('.', ',')} – ${pr.golesVisitante.toFixed(2).replace('.', ',')}; ${pct(r60.empata)} de llegar empatados a la prórroga.`,
    `Total esperado en el acta ${totalEsperado.toFixed(2).replace('.', ',')}: más de ${String(linea).replace('.', ',')}, ${pct(over)}.`,
  ];
  if (market) bullets.push(`La casa da ${pct(market.home)} al local sin margen; el modelo, ${pct(pr.local)}.`);

  return {
    league: 'nhl',
    teams: { home: side(home, pr.golesLocal), away: side(away, pr.golesVisitante) },
    model: { home: r4(pr.local), away: r4(pr.visitante) },
    final: { home: r4(pr.local), away: r4(pr.visitante) },
    postprocess: { calibrator: 'ninguno', weight: null, disagreement: null, note: 'sin post-proceso: no hay cuotas históricas de la NHL para ajustar la calibración ni la mezcla' },
    regulation: { home: r4(r60.gana), draw: r4(r60.empata), away: r4(r60.pierde) },
    goals: { home: Math.round(pr.golesLocal * 100) / 100, away: Math.round(pr.golesVisitante * 100) / 100, total: Math.round(totalEsperado * 100) / 100 },
    total: {
      line: linea,
      over: r4(over),
      under: r4(under),
      push: r4(push),
      fromMarket,
      odds: input.oddsOver && input.oddsUnder ? { over: input.oddsOver, under: input.oddsUnder } : null,
    },
    scorelines: top,
    h2h: getHeadToHead(homeId, awayId),
    market: { market, edge, verdict: verdictMercado },
    reasoning: {
      factors: [
        { key: 'elo', label: 'Diferencia de Elo', pointsForHome: Math.round((home.elo - away.elo) * 10) / 10 },
        { key: 'home', label: 'Ventaja de jugar en casa', pointsForHome: NHL.campo },
      ],
    },
    reliability,
    // El nombre del favorito; `close` dice si lo es solo por poco (dentro de la banda).
    verdict: { label: fav.name, close, marginPp: reliability.marginPp },
    summary: { headline: `${nombreDe(fav.id)} gana con un ${pct(pFav)} (prórroga y tanda incluidas)`, bullets },
    context: { homeAdvantageElo: NHL.campo, k: NHL.k, leagueGoals: NHL.golesLiga },
    disclaimer: DISCLAIMER,
  };
}
