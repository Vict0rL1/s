// De la predicción de cada deporte a una instantánea: qué probabilidades se enseñan y qué
// entradas del modelo se guardan para poder decir después QUÉ cambió.
//
// Solo entradas que el modelo usa de verdad. Lo que la app no sabe (el tiempo en la NFL,
// las alineaciones de la NBA, el bullpen) no aparece aquí con un valor inventado: no
// aparece, y la calidad de datos (trust/dataQuality.ts) lo marca como desconocido.

import type { Prediction } from '../model/predict.ts';
import type { UpcomingRow } from '../types.ts';
import type { FbPrediction } from '../football/predict.ts';
import type { FbUpcomingRow } from '../football/types.ts';
import type { GamePrediction } from '../basketball/predict.ts';
import type { UpcomingGameRow } from '../basketball/types.ts';
import type { BsbPrediction } from '../baseball/predict.ts';
import type { BsbUpcomingRow } from '../baseball/types.ts';
import type { NafPrediction } from '../nfl/predict.ts';
import type { NafUpcomingRow } from '../nfl/types.ts';
import type { NhlPrediction } from '../nhl/predict.ts';
import type { NhlUpcomingRow } from '../nhl/repo.ts';
import type { UfcPrediction } from '../ufc/predict.ts';
import type { UfcUpcomingRow } from '../ufc/repo.ts';
import { matchKey as tennisKey } from '../trackRecord.ts';
import { footballMatchKey } from '../football/trackRecord.ts';
import { gameKey } from '../basketball/trackRecord.ts';
import { matchKey as baseballKey } from '../baseball/trackRecord.ts';
import { matchKey as nflKey } from '../nfl/trackRecord.ts';
import { matchKey as nhlKey } from '../nhl/trackRecord.ts';
import { matchKey as ufcKey } from '../ufc/trackRecord.ts';
import type { Instantanea } from './snapshots.ts';

const r1 = (x: number) => Math.round(x * 10) / 10;
const cuotas = (...xs: (number | null)[]) => (xs.every((x) => x != null && x > 1) ? (xs as number[]) : null);

export function deTenis(row: UpcomingRow, p: Prediction): Instantanea | null {
  if (row.p1_id == null || row.p2_id == null) return null;
  return {
    sport: 'tennis',
    matchKey: tennisKey(row.tour, row.p1_id, row.p2_id, row.commence_time),
    eventId: row.id,
    commence: row.commence_time,
    outcomes: [row.p1_name, row.p2_name],
    probs: [p.model.prob1, p.model.prob2],
    probsRaw: null,
    odds: cuotas(row.p1_odds, row.p2_odds),
    oddsAt: row.updated_at ?? null,
    usaMercado: false,
    entradas: {
      superficie: { etiqueta: 'superficie', valor: p.surface },
      eloP1: { etiqueta: `Elo efectivo de ${row.p1_name}`, valor: r1(p.ratings.p1.effective) },
      eloP2: { etiqueta: `Elo efectivo de ${row.p2_name}`, valor: r1(p.ratings.p2.effective) },
      formaP1: { etiqueta: `forma de ${row.p1_name} (Elo)`, valor: r1(p.form.p1.delta) },
      formaP2: { etiqueta: `forma de ${row.p2_name} (Elo)`, valor: r1(p.form.p2.delta) },
      h2h: { etiqueta: 'cara a cara (Elo a favor de p1)', valor: r1(p.h2h.delta) },
      inactP1: { etiqueta: `inactividad de ${row.p1_name} (Elo)`, valor: r1(p.layoff.p1) },
      inactP2: { etiqueta: `inactividad de ${row.p2_name} (Elo)`, valor: r1(p.layoff.p2) },
    },
  };
}

export function deFutbol(row: FbUpcomingRow, p: FbPrediction): Instantanea | null {
  if (!row.home_id || !row.away_id) return null;
  const bajas = (xs: { playerName: string }[]) => (xs.length ? xs.map((x) => x.playerName).sort().join(', ') : 'ninguna');
  return {
    sport: 'football',
    matchKey: footballMatchKey(row),
    eventId: row.id,
    commence: row.commence_time,
    outcomes: [row.home_name, 'Empate', row.away_name],
    probs: [p.final.home, p.final.draw, p.final.away],
    probsRaw: [p.model.home, p.model.draw, p.model.away],
    odds: cuotas(row.odds_home, row.odds_draw, row.odds_away),
    oddsAt: row.updated_at ?? null,
    // `weight` es el peso del MODELO tras mezclar con el mercado; null = no se mezcló.
    usaMercado: p.postprocess.weight != null && p.postprocess.weight < 1,
    entradas: {
      eloLocal: { etiqueta: `Elo de ${row.home_name}`, valor: r1(p.teams.home.elo) },
      eloVisit: { etiqueta: `Elo de ${row.away_name}`, valor: r1(p.teams.away.elo) },
      bajasLocal: { etiqueta: `bajas aplicadas de ${row.home_name}`, valor: bajas(p.news.applied.home) },
      bajasVisit: { etiqueta: `bajas aplicadas de ${row.away_name}`, valor: bajas(p.news.applied.away) },
      onceLocal: { etiqueta: `alineación de ${row.home_name} publicada`, valor: p.news.lineup.home != null },
      onceVisit: { etiqueta: `alineación de ${row.away_name} publicada`, valor: p.news.lineup.away != null },
    },
  };
}

export function deBaloncesto(row: UpcomingGameRow, p: GamePrediction): Instantanea | null {
  if (!row.home_id || !row.away_id) return null;
  return {
    sport: 'basketball',
    matchKey: gameKey(row.league, row.home_id, row.away_id, row.commence_time),
    eventId: row.id,
    commence: row.commence_time,
    outcomes: [row.home_name, row.away_name],
    probs: [p.model.probHome, p.model.probAway],
    probsRaw: null,
    odds: cuotas(row.home_odds, row.away_odds),
    oddsAt: row.updated_at ?? null,
    usaMercado: false,
    entradas: {
      eloLocal: { etiqueta: `Elo de ${row.home_name}`, valor: r1(p.teams.home.elo) },
      eloVisit: { etiqueta: `Elo de ${row.away_name}`, valor: r1(p.teams.away.elo) },
      descansoLocal: { etiqueta: `días de descanso de ${row.home_name}`, valor: p.teams.home.daysRest },
      descansoVisit: { etiqueta: `días de descanso de ${row.away_name}`, valor: p.teams.away.daysRest },
    },
  };
}

export function deBeisbol(row: BsbUpcomingRow, p: BsbPrediction): Instantanea | null {
  if (!row.home_id || !row.away_id) return null;
  return {
    sport: 'baseball',
    matchKey: baseballKey(row),
    eventId: row.id,
    commence: row.commence_time,
    outcomes: [row.home_name, row.away_name],
    probs: [p.model.home, p.model.away],
    probsRaw: null,
    odds: cuotas(row.odds_home, row.odds_away),
    oddsAt: row.updated_at ?? null,
    usaMercado: false,
    entradas: {
      eloLocal: { etiqueta: `Elo de ${row.home_name}`, valor: r1(p.teams.home.elo) },
      eloVisit: { etiqueta: `Elo de ${row.away_name}`, valor: r1(p.teams.away.elo) },
      abridorLocal: { etiqueta: `abridor de ${row.home_name}`, valor: p.teams.home.starter.name },
      abridorVisit: { etiqueta: `abridor de ${row.away_name}`, valor: p.teams.away.starter.name },
    },
  };
}

export function deNfl(row: NafUpcomingRow, p: NafPrediction): Instantanea | null {
  if (!row.home_id || !row.away_id) return null;
  return {
    sport: 'nfl',
    matchKey: nflKey(row),
    eventId: row.id,
    commence: row.commence_time,
    outcomes: [row.home_name, row.away_name],
    probs: [p.final.home, p.final.away],
    probsRaw: [p.model.home, p.model.away],
    odds: cuotas(row.odds_home, row.odds_away),
    oddsAt: row.updated_at ?? null,
    // La final de la NFL se mezcla con el mercado (ver postprocess/blend.ts).
    usaMercado: p.postprocess.weight != null && p.postprocess.weight < 1,
    entradas: {
      eloLocal: { etiqueta: `rating de ${row.home_name}`, valor: r1(p.teams.home.elo) },
      eloVisit: { etiqueta: `rating de ${row.away_name}`, valor: r1(p.teams.away.elo) },
      qbLocal: { etiqueta: `QB de ${row.home_name}`, valor: p.quarterbacks.home?.name ?? null },
      qbVisit: { etiqueta: `QB de ${row.away_name}`, valor: p.quarterbacks.away?.name ?? null },
      techo: { etiqueta: 'techo del estadio', valor: p.conditions?.roof ?? null },
    },
  };
}

export function deNhl(row: NhlUpcomingRow, p: NhlPrediction): Instantanea | null {
  if (!row.home_id || !row.away_id) return null;
  return {
    sport: 'nhl',
    matchKey: nhlKey(row),
    eventId: row.id,
    commence: row.commence_time,
    outcomes: [row.home_name, row.away_name],
    probs: [p.final.home, p.final.away],
    probsRaw: [p.model.home, p.model.away],
    odds: cuotas(row.odds_home, row.odds_away),
    oddsAt: row.updated_at ?? null,
    // Sin mezcla con el mercado: no hay cuotas históricas de la NHL para ajustarla.
    usaMercado: false,
    entradas: {
      eloLocal: { etiqueta: `Elo de ${row.home_name}`, valor: r1(p.teams.home.elo) },
      eloVisit: { etiqueta: `Elo de ${row.away_name}`, valor: r1(p.teams.away.elo) },
      lineaTotal: { etiqueta: 'línea de total de goles', valor: p.total.line },
    },
  };
}

/** La UFC: A y B (home_* y away_*, sin local), la logística publicada, sin mezcla con el mercado. */
export function deUfc(row: UfcUpcomingRow, p: UfcPrediction): Instantanea | null {
  if (!row.home_id || !row.away_id) return null;
  return {
    sport: 'ufc',
    matchKey: ufcKey(row),
    eventId: row.id,
    commence: row.commence_time,
    outcomes: [row.home_name, row.away_name],
    probs: [p.final.home, p.final.away],
    probsRaw: [p.model.home, p.model.away],
    odds: cuotas(row.odds_home, row.odds_away),
    oddsAt: row.updated_at ?? null,
    // Sin mezcla con el mercado: no hay cuotas históricas de la UFC para ajustarla.
    usaMercado: false,
    entradas: {
      eloA: { etiqueta: `Elo de ${row.home_name}`, valor: r1(p.fighters.home.elo) },
      eloB: { etiqueta: `Elo de ${row.away_name}`, valor: r1(p.fighters.away.elo) },
      edad: { etiqueta: 'diferencia de edad (décadas, A − B)', valor: Math.round(p.rasgos.edad * 1000) / 1000 },
      alcance: { etiqueta: 'diferencia de alcance (×10 cm, A − B)', valor: Math.round(p.rasgos.alcance * 1000) / 1000 },
    },
  };
}
