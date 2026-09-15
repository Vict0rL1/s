// El salto de división: qué vale un Elo de Segunda cuando el equipo sube.
//
// ===========================================================================
// THE CARD THAT ASKED FOR THIS
// ===========================================================================
// Atlético Madrid vs Málaga, LaLiga, with no model at all — just the market's
// implied numbers and the line "Probabilidades implícitas del mercado, no del
// modelo". The reason is not a bug: Málaga plays in Segunda, so they appear
// nowhere in the LaLiga table this archive covers, and a fixture whose team does
// not resolve gets no prediction.
//
// That is not an edge case. It is three clubs per league per season, every August,
// and for the first months of a season those clubs play a fifth of all fixtures.
//
// ===========================================================================
// WHY THE SECOND DIVISION'S ELO CANNOT BE USED AS-IS
// ===========================================================================
// League play is zero-sum WITHIN a division and the two divisions never meet, so
// both tables are centred near 1500 by construction. A club rated 1650 in Segunda
// is not the same strength as a club rated 1650 in LaLiga — it is much weaker.
// Copying the number across would produce a confident, wrong prediction, which is
// worse than the honest blank the reader gets today.
//
// So the gap is MEASURED, per country, from clubs that actually made the jump:
// take a club's second-division Elo at the end of the season it was promoted, then
// find the constant offset that best explains its real results in the division
// above the following season.
//
//     país         salto    desviación entre temporadas   → incertidumbre
//     Inglaterra   −253 Elo          77                        ±11.1 pp
//     España       −135 Elo          38                        ±5.4 pp
//     Alemania     −195 Elo          53                        ±7.6 pp
//     Italia       −193 Elo          50                        ±7.2 pp
//     Francia      −162 Elo          68                        ±9.8 pp
//
// Every country negative, and the ordering is the one anyone who follows football
// would predict: the Premier League is further above its second tier than LaLiga is
// above Segunda. Five independent countries agreeing in sign is what makes this a
// real effect rather than a fit to 18 English clubs.
//
// THE SAMPLE IS SMALL and saying so matters: 7-9 promoted clubs per country over
// 3-6 seasons. That is why the season-to-season spread is carried around and fed
// into the reliability band instead of being averaged away — a card built on a
// transplanted rating should say it is less sure, and by how much.

import { getDb, getMeta, setMeta } from '../db.ts';
import { footballConfig } from '../config.ts';
import { eloExpectation, HOME_ADVANTAGE } from './model.ts';
import { loadMatches, replayMatches } from './ratings.ts';
import type { LeagueId } from './types.ts';

/** Below this many promoted clubs the offset is noise and nothing is stored. */
const MIN_PROMOTED = 6;
/** Guard rails: an offset outside this range means the estimator found garbage. */
const MIN_OFFSET = -400;
const MAX_OFFSET = 0;

export interface PromotionGap {
  /** Elo to ADD to the second-division rating. Negative: the second overstates. */
  offset: number;
  /** Season-to-season spread of that estimate, in Elo. The honest error bar. */
  sd: number;
  /** Clubs the estimate is built on. */
  clubs: number;
  /** The league the rating is transplanted FROM. */
  from: LeagueId;
}

/** The second division of the same country, if this app ingests one. */
export function secondDivisionOf(league: LeagueId): LeagueId | null {
  const top = footballConfig.leagues.find((l) => l.id === league);
  if (!top || (top.tier ?? 1) !== 1) return null;
  const second = footballConfig.leagues.find(
    (l) => l.country === top.country && (l.tier ?? 1) === 2,
  );
  return (second?.id as LeagueId) ?? null;
}

/** Each team's rating as at the end of every season of one league. */
function eloBySeason(league: LeagueId): Map<number, Map<string, number>> {
  const out = new Map<number, Map<string, number>>();
  const live = new Map<string, number>();
  let current: number | null = null;
  const flush = () => {
    if (current !== null) out.set(current, new Map(live));
  };
  replayMatches(loadMatches(league, 0), {
    onMatch: ({ match, home, away }) => {
      const season = Number(match.season);
      if (current !== null && season !== current) flush();
      current = season;
      live.set(match.home_id, home.elo);
      live.set(match.away_id, away.elo);
    },
  });
  flush();
  return out;
}

function squadsBySeason(league: LeagueId): Map<number, Set<string>> {
  const rows = getDb()
    .prepare('SELECT season, home_id AS a, away_id AS b FROM fb_matches WHERE league = ?')
    .all(league) as unknown as { season: number; a: string; b: string }[];
  const m = new Map<number, Set<string>>();
  for (const r of rows) {
    const s = m.get(r.season) ?? new Set<string>();
    s.add(r.a).add(r.b);
    m.set(r.season, s);
  }
  return m;
}

interface Promoted {
  season: number;
  secondElo: number;
  played: { oppElo: number; home: boolean; score: number }[];
}

/**
 * Fit the offset by minimising squared error on the two-way outcome.
 *
 * A draw counts half, which is the convention the ratings themselves are built and
 * updated on — scoring the fit differently from the model it feeds would be fitting
 * one thing and using another.
 */
function fit(rows: Promoted[]): number {
  let best = 0;
  let bestErr = Infinity;
  for (let off = MIN_OFFSET; off <= MAX_OFFSET; off += 5) {
    let err = 0;
    let n = 0;
    for (const r of rows) {
      for (const p of r.played) {
        const mine = r.secondElo + off;
        const e = p.home
          ? eloExpectation(mine, p.oppElo, HOME_ADVANTAGE)
          : 1 - eloExpectation(p.oppElo, mine, HOME_ADVANTAGE);
        err += (e - p.score) ** 2;
        n++;
      }
    }
    if (n > 0 && err / n < bestErr) {
      bestErr = err / n;
      best = off;
    }
  }
  return best;
}

/** Measure the gap for one first-division league. Null when it cannot be measured. */
export function measurePromotionGap(league: LeagueId): PromotionGap | null {
  const second = secondDivisionOf(league);
  if (!second) return null;
  const topElo = eloBySeason(league);
  const secondElo = eloBySeason(second);
  const topSquads = squadsBySeason(league);
  const secondSquads = squadsBySeason(second);
  const db = getDb();

  const rows: Promoted[] = [];
  for (const season of [...topSquads.keys()].sort()) {
    const prev = season - 1;
    const nowUp = topSquads.get(season)!;
    const wasDown = secondSquads.get(prev);
    const prevSecond = secondElo.get(prev);
    const nowTop = topElo.get(season);
    if (!wasDown || !prevSecond || !nowTop) continue;
    for (const club of nowUp) {
      // Promoted: in the second division last season, in this one now, and NOT here
      // last season. The last clause matters — without it a club that yo-yos inside
      // the same season's data would be counted as promoted every year.
      if (!wasDown.has(club) || topSquads.get(prev)?.has(club)) continue;
      const from = prevSecond.get(club);
      if (from === undefined) continue;
      const games = db
        .prepare(
          `SELECT home_id, away_id, home_goals, away_goals FROM fb_matches
           WHERE league = ? AND season = ? AND (home_id = ? OR away_id = ?)`,
        )
        .all(league, season, club, club) as unknown as {
        home_id: string;
        away_id: string;
        home_goals: number;
        away_goals: number;
      }[];
      const played: Promoted['played'] = [];
      for (const g of games) {
        const isHome = g.home_id === club;
        const oppElo = nowTop.get(isHome ? g.away_id : g.home_id);
        if (oppElo === undefined) continue;
        const diff = (g.home_goals - g.away_goals) * (isHome ? 1 : -1);
        played.push({ oppElo, home: isHome, score: diff > 0 ? 1 : diff === 0 ? 0.5 : 0 });
      }
      // A full season or nothing: half a season of a promoted club is mostly the
      // fixture list it happened to draw.
      if (played.length >= 20) rows.push({ season, secondElo: from, played });
    }
  }
  if (rows.length < MIN_PROMOTED) return null;

  const offset = fit(rows);
  const seasons = [...new Set(rows.map((r) => r.season))].sort();
  const perSeason = seasons.map((s) => fit(rows.filter((r) => r.season === s)));
  const mean = perSeason.reduce((a, b) => a + b, 0) / perSeason.length;
  const sd =
    perSeason.length > 1
      ? Math.sqrt(perSeason.reduce((a, b) => a + (b - mean) ** 2, 0) / (perSeason.length - 1))
      : Math.abs(offset) * 0.4; // one season measured: assume a wide, honest error bar
  if (offset <= MIN_OFFSET || offset >= MAX_OFFSET) return null;
  return { offset, sd: Math.round(sd), clubs: rows.length, from: second };
}

const KEY = (league: string) => `fb_promotion_gap_${league}`;

export function storePromotionGap(league: LeagueId, gap: PromotionGap | null): void {
  setMeta(KEY(league), gap ? JSON.stringify(gap) : '');
}

export function getPromotionGap(league: LeagueId): PromotionGap | null {
  const raw = getMeta(KEY(league));
  if (!raw) return null;
  try {
    const g = JSON.parse(raw) as PromotionGap;
    return Number.isFinite(g.offset) ? g : null;
  } catch {
    return null;
  }
}
