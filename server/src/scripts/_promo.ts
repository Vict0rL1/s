// ¿Se puede predecir a un equipo recién ascendido con su Elo de Segunda?
//
// The question comes from a real card: Atlético Madrid vs Málaga, with no model and
// only the market's implied numbers, because Málaga has never appeared in the LaLiga
// table this archive covers — they play in Segunda. That is not an edge case, it is
// every promoted club, every August, in every league.
//
// The data exists upstream (openfootball ships es.2, de.2, it.2, fr.2), so the
// blocker is not the download. It is that an Elo built inside the second division is
// NOT ON THE SAME SCALE as one built inside the first: both are centred near 1500 by
// construction, because league play is zero-sum within a division and the two
// divisions never meet. Predicting across them naively would hand the reader a
// confident, wrong number — worse than the honest blank they get today.
//
// So: measure the gap. England is the only place this archive can measure it, because
// `epl` and `championship` are both present for seven seasons and clubs move between
// them every year. The estimator:
//
//   1. find every club PROMOTED into the Premier League (played the Championship in
//      season S, the Premier League in S+1),
//   2. take its Championship Elo as at the end of S,
//   3. score its actual Premier League matches in S+1 against the opponent's Premier
//      League Elo, and find the constant OFFSET that best explains those results.
//
// If that offset is stable across seasons, cross-division prediction is possible and
// the breakdown can be shown for every fixture. If it moves around, it cannot, and
// the app should keep saying so rather than inventing one.

import { getDb } from '../db.ts';
import { eloExpectation, HOME_ADVANTAGE } from '../football/model.ts';
import { loadMatches, replayMatches } from '../football/ratings.ts';

interface Snapshot {
  /** elo[teamId] at the end of the given season. */
  elo: Map<string, number>;
  matches: Map<string, number>;
}

/** Replay one league and keep each team's rating as at the end of every season. */
function ratingsBySeason(league: string): Map<number, Snapshot> {
  const out = new Map<number, Snapshot>();
  const live = new Map<string, { elo: number; n: number }>();
  let current: number | null = null;
  replayMatches(loadMatches(league as never, 0), {
    onMatch: ({ match, home, away }: any) => {
      const season = Number(match.season);
      if (current !== null && season !== current) {
        out.set(current, {
          elo: new Map([...live].map(([k, v]) => [k, v.elo])),
          matches: new Map([...live].map(([k, v]) => [k, v.n])),
        });
      }
      current = season;
      live.set(match.home_id, { elo: home.elo, n: home.matches });
      live.set(match.away_id, { elo: away.elo, n: away.matches });
    },
  } as any);
  if (current !== null) {
    out.set(current, {
      elo: new Map([...live].map(([k, v]) => [k, v.elo])),
      matches: new Map([...live].map(([k, v]) => [k, v.n])),
    });
  }
  return out;
}

const db = getDb();
/** first division → its second, by country. */
const PAIRS: [string, string, string][] = [
  ['Inglaterra', 'epl', 'championship'],
  ['España', 'laliga', 'laliga2'],
  ['Alemania', 'bundesliga', 'bundesliga2'],
  ['Italia', 'seriea', 'serieb'],
  ['Francia', 'ligue1', 'ligue2'],
];

function run(country: string, top: string, second: string): void {
const epl = ratingsBySeason(top);
const ch = ratingsBySeason(second);

/** Which clubs played each season, per league. */
function squads(league: string): Map<number, Set<string>> {
  const rows = db
    .prepare(
      `SELECT season, home_id AS a, away_id AS b FROM fb_matches WHERE league = ?`,
    )
    .all(league) as unknown as { season: number; a: string; b: string }[];
  const m = new Map<number, Set<string>>();
  for (const r of rows) {
    const s = m.get(r.season) ?? new Set<string>();
    s.add(r.a).add(r.b);
    m.set(r.season, s);
  }
  return m;
}
const eplSquads = squads(top);
const chSquads = squads(second);

interface Row {
  season: number;
  club: string;
  chElo: number;
  /** Actual EPL results that season. */
  played: { oppElo: number; home: boolean; result: 'W' | 'D' | 'L' }[];
}
const promoted: Row[] = [];
for (const season of [...eplSquads.keys()].sort()) {
  const prev = season - 1;
  const inEpl = eplSquads.get(season)!;
  const inChPrev = chSquads.get(prev);
  const chPrevElo = ch.get(prev)?.elo;
  const eplElo = epl.get(season)?.elo;
  if (!inChPrev || !chPrevElo || !eplElo) continue;
  for (const club of inEpl) {
    // Promoted = played the Championship last season and the Premier League now,
    // and was NOT in the Premier League last season.
    if (!inChPrev.has(club) || eplSquads.get(prev)?.has(club)) continue;
    const chElo = chPrevElo.get(club);
    if (chElo === undefined) continue;
    const games = db
      .prepare(
        `SELECT home_id, away_id, home_goals, away_goals FROM fb_matches
         WHERE league = ? AND season = ? AND (home_id = ? OR away_id = ?)`,
      )
      .all(top, season, club, club) as unknown as {
      home_id: string;
      away_id: string;
      home_goals: number;
      away_goals: number;
    }[];
    const played: Row['played'] = [];
    for (const g of games) {
      const isHome = g.home_id === club;
      const opp = isHome ? g.away_id : g.home_id;
      // The opponent's rating as at the END of that season is the best single
      // number available here; using it for every match of the season is a known
      // approximation and it is symmetric, so it does not bias the offset.
      const oppElo = eplElo.get(opp);
      if (oppElo === undefined) continue;
      const diff = g.home_goals - g.away_goals;
      const mine = isHome ? diff : -diff;
      played.push({ oppElo, home: isHome, result: mine > 0 ? 'W' : mine === 0 ? 'D' : 'L' });
    }
    if (played.length >= 20) promoted.push({ season, club, chElo, played });
  }
}
console.log(`\n=== ${country}: ${top} ← ${second}`);
console.log(`${promoted.length} equipos ascendidos con temporada completa arriba`);
if (promoted.length < 6) {
  console.log('  muestra insuficiente para medir un salto de división');
  return;
}

/** Log-likelihood of the observed results if the promoted club's Elo were chElo+off. */
function logLik(rows: Row[], offset: number): number {
  let ll = 0;
  for (const r of rows) {
    for (const p of r.played) {
      const mine = r.chElo + offset;
      // Two-way expectation with the draw folded in at half a win, which is what
      // eloExpectation scores against — the same convention the ratings are built on.
      const e = p.home
        ? eloExpectation(mine, p.oppElo, HOME_ADVANTAGE)
        : 1 - eloExpectation(p.oppElo, mine, HOME_ADVANTAGE);
      const s = p.result === 'W' ? 1 : p.result === 'D' ? 0.5 : 0;
      // Brier-style on the two-way score; a proper score for a {0, 0.5, 1} outcome.
      ll -= (e - s) ** 2;
    }
  }
  return ll / rows.reduce((a, r) => a + r.played.length, 0);
}

function bestOffset(rows: Row[]): number {
  let best = 0;
  let bestLL = -Infinity;
  for (let off = -400; off <= 200; off += 5) {
    const ll = logLik(rows, off);
    if (ll > bestLL) {
      bestLL = ll;
      best = off;
    }
  }
  return best;
}

console.log(`  offset global: ${bestOffset(promoted)} Elo  (negativo = la 2ª sobreestima)`);
const perSeason: number[] = [];
for (const season of [...new Set(promoted.map((r) => r.season))].sort()) {
  const rows = promoted.filter((r) => r.season === season);
  const n = rows.reduce((a, r) => a + r.played.length, 0);
  const off = bestOffset(rows);
  perSeason.push(off);
  void n;
}
const mean = perSeason.reduce((a, b) => a + b, 0) / perSeason.length;
const sd =
  perSeason.length > 1
    ? Math.sqrt(perSeason.reduce((a, b) => a + (b - mean) ** 2, 0) / (perSeason.length - 1))
    : NaN;
// The number that decides whether this is usable: how much does that spread move a
// published probability?
const slope = (Math.LN10 * 0.25) / 400;
console.log(
  `  por temporada: media ${mean.toFixed(0)} · desviación ${Number.isNaN(sd) ? '—' : sd.toFixed(0)} Elo` +
    (Number.isNaN(sd) ? '' : `  →  ±${(sd * slope * 100).toFixed(1)} pp de incertidumbre`),
);
console.log(`  temporadas: ${perSeason.map((o) => (o > 0 ? '+' : '') + o).join(', ')}`);
}

for (const [country, top, second] of PAIRS) run(country, top, second);
getDb();
