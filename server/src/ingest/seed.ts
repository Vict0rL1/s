// ===========================================================================
// SEED DATASET  (synthetic sample data for an offline, end-to-end demo)
// ===========================================================================
// This generates a small, SELF-CONSISTENT dataset so the whole app works
// without internet access (real ingestion — `npm run update-data` — needs to
// reach GitHub + The Odds API).
//
// Player NAMES are real, but every match here is SIMULATED from latent
// per-surface skill using the same Elo win-probability formula the model uses.
// That makes ratings, form and head-to-head look realistic and internally
// consistent — but it is NOT real historical data. `update-data` replaces it.
// The app tags this via meta.data_source = "seed".
// ===========================================================================

import { getDb, resetData, setMeta } from '../db.ts';
import { recomputeRatings } from './ratings.ts';
import { expectedScore } from '../model/elo.ts';
import { tournamentsConfig } from '../config.ts';
import type { Surface, TourId } from '../types.ts';

// --- Deterministic RNG (mulberry32) so seeding is reproducible -------------
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SeedPlayer {
  id: number;
  name: string;
  ioc: string;
  hand: 'R' | 'L';
  base: number;
  d: { Hard: number; Clay: number; Grass: number }; // per-surface skill offset
}

const ATP: SeedPlayer[] = [
  { id: 1001, name: 'Novak Djokovic', ioc: 'SRB', hand: 'R', base: 2150, d: { Hard: 30, Clay: 0, Grass: 20 } },
  { id: 1002, name: 'Carlos Alcaraz', ioc: 'ESP', hand: 'R', base: 2120, d: { Hard: 10, Clay: 40, Grass: 30 } },
  { id: 1003, name: 'Jannik Sinner', ioc: 'ITA', hand: 'R', base: 2110, d: { Hard: 40, Clay: 0, Grass: 10 } },
  { id: 1004, name: 'Rafael Nadal', ioc: 'ESP', hand: 'L', base: 2080, d: { Hard: 0, Clay: 120, Grass: -10 } },
  { id: 1005, name: 'Daniil Medvedev', ioc: 'RUS', hand: 'R', base: 2060, d: { Hard: 50, Clay: -60, Grass: 0 } },
  { id: 1006, name: 'Alexander Zverev', ioc: 'GER', hand: 'R', base: 2030, d: { Hard: 20, Clay: 20, Grass: -10 } },
  { id: 1007, name: 'Stefanos Tsitsipas', ioc: 'GRE', hand: 'R', base: 2010, d: { Hard: 0, Clay: 40, Grass: -20 } },
  { id: 1008, name: 'Andrey Rublev', ioc: 'RUS', hand: 'R', base: 1990, d: { Hard: 20, Clay: 10, Grass: -10 } },
  { id: 1009, name: 'Casper Ruud', ioc: 'NOR', hand: 'R', base: 1970, d: { Hard: -10, Clay: 50, Grass: -30 } },
  { id: 1010, name: 'Taylor Fritz', ioc: 'USA', hand: 'R', base: 1960, d: { Hard: 30, Clay: -20, Grass: 20 } },
  { id: 1011, name: 'Grigor Dimitrov', ioc: 'BUL', hand: 'R', base: 1940, d: { Hard: 10, Clay: -10, Grass: 20 } },
  { id: 1012, name: 'Hubert Hurkacz', ioc: 'POL', hand: 'R', base: 1930, d: { Hard: 20, Clay: -30, Grass: 30 } },
];

const WTA: SeedPlayer[] = [
  { id: 2001, name: 'Iga Swiatek', ioc: 'POL', hand: 'R', base: 2130, d: { Hard: 10, Clay: 80, Grass: -20 } },
  { id: 2002, name: 'Aryna Sabalenka', ioc: 'BLR', hand: 'R', base: 2100, d: { Hard: 40, Clay: 0, Grass: 10 } },
  { id: 2003, name: 'Elena Rybakina', ioc: 'KAZ', hand: 'R', base: 2060, d: { Hard: 30, Clay: -10, Grass: 40 } },
  { id: 2004, name: 'Coco Gauff', ioc: 'USA', hand: 'R', base: 2050, d: { Hard: 30, Clay: 10, Grass: 0 } },
  { id: 2005, name: 'Jessica Pegula', ioc: 'USA', hand: 'R', base: 2000, d: { Hard: 20, Clay: -10, Grass: 0 } },
  { id: 2006, name: 'Ons Jabeur', ioc: 'TUN', hand: 'R', base: 1990, d: { Hard: -10, Clay: 10, Grass: 40 } },
  { id: 2007, name: 'Marketa Vondrousova', ioc: 'CZE', hand: 'L', base: 1970, d: { Hard: 0, Clay: 10, Grass: 30 } },
  { id: 2008, name: 'Maria Sakkari', ioc: 'GRE', hand: 'R', base: 1960, d: { Hard: 20, Clay: 10, Grass: -20 } },
  { id: 2009, name: 'Barbora Krejcikova', ioc: 'CZE', hand: 'R', base: 1955, d: { Hard: 0, Clay: 30, Grass: 20 } },
  { id: 2010, name: 'Qinwen Zheng', ioc: 'CHN', hand: 'R', base: 1945, d: { Hard: 30, Clay: 0, Grass: -10 } },
  { id: 2011, name: 'Petra Kvitova', ioc: 'CZE', hand: 'L', base: 1950, d: { Hard: 10, Clay: -20, Grass: 40 } },
  { id: 2012, name: 'Jelena Ostapenko', ioc: 'LAT', hand: 'R', base: 1940, d: { Hard: 10, Clay: 20, Grass: 10 } },
];

// Events simulated each season (name, surface, month). Names align with the
// config so results attribute to the right tournament where relevant.
const SEASON_EVENTS: { name: string; surface: Surface; month: number; bestOf: number }[] = [
  { name: 'Australian Open', surface: 'Hard', month: 1, bestOf: 5 },
  { name: 'Indian Wells Masters', surface: 'Hard', month: 3, bestOf: 3 },
  { name: 'Madrid Open', surface: 'Clay', month: 5, bestOf: 3 },
  { name: 'Roland Garros', surface: 'Clay', month: 6, bestOf: 5 },
  { name: 'Wimbledon', surface: 'Grass', month: 7, bestOf: 5 },
  { name: 'US Open', surface: 'Hard', month: 9, bestOf: 5 },
];

const START_YEAR = 2013;
const END_YEAR = 2025;

function skillOn(p: SeedPlayer, surface: Surface): number {
  return p.base + p.d[surface];
}

/**
 * Generate a plausible score string that is ALWAYS consistent with the winner:
 * the winner takes exactly `setsToWin` sets (including the decisive last one),
 * the loser takes 0..setsToWin-1 sets (more when the match was close).
 */
function makeScore(rng: () => number, bestOf: number, winnerProb: number): string {
  const setsToWin = bestOf === 5 ? 3 : 2;
  const maxLoserSets = setsToWin - 1;

  let loserSets = 0;
  for (let i = 0; i < maxLoserSets; i++) {
    if (rng() < (1 - winnerProb) * 0.9) loserSets++;
  }

  // Non-decisive sets, shuffled, then the winner clinches the final set.
  const pattern: ('W' | 'L')[] = [];
  for (let i = 0; i < setsToWin - 1; i++) pattern.push('W');
  for (let i = 0; i < loserSets; i++) pattern.push('L');
  for (let i = pattern.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pattern[i], pattern[j]] = [pattern[j], pattern[i]];
  }
  pattern.push('W');

  return pattern
    .map((s) =>
      s === 'W' ? `6-${Math.floor(rng() * 5)}` : `${Math.floor(rng() * 5)}-6`,
    )
    .join(' ');
}

interface StatLine {
  ace: number;
  df: number;
  svpt: number;
  in1: number;
  won1: number;
  won2: number;
  bpSaved: number;
  bpFaced: number;
}

function makeStats(rng: () => number, skill: number, won: boolean): StatLine {
  const serveQuality = (skill - 1900) / 250; // ~0..1
  const svpt = 60 + Math.floor(rng() * 40);
  const ace = Math.max(0, Math.round((3 + serveQuality * 8) * (won ? 1.1 : 0.9) + rng() * 3));
  const df = Math.max(0, Math.round((3 - serveQuality * 1.5) + rng() * 2));
  const in1 = Math.round(svpt * (0.58 + serveQuality * 0.08));
  const won1 = Math.round(in1 * (0.68 + serveQuality * 0.1));
  const won2 = Math.round((svpt - in1) * (0.5 + serveQuality * 0.05));
  const bpFaced = Math.floor(rng() * 8);
  const bpSaved = Math.floor(rng() * (bpFaced + 1) * (won ? 0.7 : 0.4));
  return { ace, df, svpt, in1, won1, won2, bpSaved, bpFaced };
}

function simulateTour(tour: TourId, players: SeedPlayer[], rng: () => number): number {
  const db = getDb();
  const playerInsert = db.prepare(
    'INSERT INTO players (id, tour, name, hand, country, birthdate) VALUES (?, ?, ?, ?, ?, ?)',
  );
  db.exec('BEGIN');
  for (const p of players) {
    playerInsert.run(p.id, tour, p.name, p.hand, p.ioc, null);
  }
  db.exec('COMMIT');

  const matchInsert = db.prepare(
    `INSERT INTO matches (
       tour, tourney_id, tourney_name, tourney_date, surface, level, round, best_of,
       winner_id, loser_id, score,
       w_ace, w_df, w_svpt, w_1stIn, w_1stWon, w_2ndWon, w_bpSaved, w_bpFaced,
       l_ace, l_df, l_svpt, l_1stIn, l_1stWon, l_2ndWon, l_bpSaved, l_bpFaced
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?)`,
  );

  let count = 0;

  const playMatch = (
    a: SeedPlayer,
    b: SeedPlayer,
    ev: (typeof SEASON_EVENTS)[number],
    date: string,
    round: string,
  ): SeedPlayer => {
    const pa = expectedScore(skillOn(a, ev.surface), skillOn(b, ev.surface));
    const aWins = rng() < pa;
    const winner = aWins ? a : b;
    const loser = aWins ? b : a;
    const winnerProb = aWins ? pa : 1 - pa;
    const ws = makeStats(rng, skillOn(winner, ev.surface), true);
    const ls = makeStats(rng, skillOn(loser, ev.surface), false);
    matchInsert.run(
      tour,
      `${date.slice(0, 4)}-${ev.name.replace(/\s+/g, '')}`,
      ev.name,
      date,
      ev.surface,
      ev.bestOf === 5 ? 'G' : 'M',
      round,
      ev.bestOf,
      winner.id,
      loser.id,
      makeScore(rng, ev.bestOf, winnerProb),
      ws.ace, ws.df, ws.svpt, ws.in1, ws.won1, ws.won2, ws.bpSaved, ws.bpFaced,
      ls.ace, ls.df, ls.svpt, ls.in1, ls.won1, ls.won2, ls.bpSaved, ls.bpFaced,
    );
    count++;
    return winner;
  };

  db.exec('BEGIN');
  for (let year = START_YEAR; year <= END_YEAR; year++) {
    for (const ev of SEASON_EVENTS) {
      // 12-player bracket with byes for the top 4 seeds, so EVERY player plays
      // each event → the ratings converge to real skill (no lucky outliers).
      // Small selection noise keeps draws from being identical year to year.
      const seeded = [...players]
        .map((p) => ({ p, seed: skillOn(p, ev.surface) + (rng() - 0.5) * 60 }))
        .sort((a, b) => b.seed - a.seed)
        .map((x) => x.p);

      const date = `${year}${String(ev.month).padStart(2, '0')}01`;
      const byes = seeded.slice(0, 4); // seeds 1–4
      const prelim = seeded.slice(4); // seeds 5–12 (8 players)

      // First round (R16): 5v12, 6v11, 7v10, 8v9.
      const r16Winners: SeedPlayer[] = [];
      for (let i = 0; i < prelim.length / 2; i++) {
        const a = prelim[i];
        const b = prelim[prelim.length - 1 - i];
        r16Winners.push(playMatch(a, b, ev, date, 'R16'));
      }

      // Quarterfinals: 4 byes + 4 R16 winners.
      let alive = [...byes, ...r16Winners];
      for (const round of ['QF', 'SF', 'F']) {
        const next: SeedPlayer[] = [];
        for (let i = 0; i < alive.length; i += 2) {
          next.push(playMatch(alive[i], alive[i + 1], ev, date, round));
        }
        alive = next;
      }
    }
  }
  db.exec('COMMIT');
  return count;
}

// Upcoming fixtures: near-future matchups with market odds. Odds are derived
// from latent skill but nudged/noised so the market sometimes disagrees with the
// model → the "value" flag has something to show.
function seedUpcoming(tour: TourId, players: SeedPlayer[], rng: () => number): number {
  const db = getDb();
  const byName = new Map(players.map((p) => [p.name, p]));

  // Two tournaments per tour so the tournament selector is meaningful. `month`
  // and `round` make the fixtures look calendar-coherent (a Roland Garros match
  // is dated in June, Wimbledon in July, US Open in September).
  type Block = {
    tournamentId: string;
    surface: Surface;
    month: number;
    round: string;
    pairs: [string, string][];
  };
  const plan: Block[] =
    tour === 'atp'
      ? [
          {
            tournamentId: 'wimbledon',
            surface: 'Grass',
            month: 7,
            round: 'QF',
            pairs: [
              ['Carlos Alcaraz', 'Taylor Fritz'],
              ['Novak Djokovic', 'Hubert Hurkacz'],
              ['Jannik Sinner', 'Grigor Dimitrov'],
              ['Daniil Medvedev', 'Alexander Zverev'],
            ],
          },
          {
            tournamentId: 'us_open',
            surface: 'Hard',
            month: 9,
            round: 'SF',
            pairs: [
              ['Jannik Sinner', 'Daniil Medvedev'],
              ['Carlos Alcaraz', 'Andrey Rublev'],
              ['Novak Djokovic', 'Stefanos Tsitsipas'],
            ],
          },
        ]
      : [
          {
            tournamentId: 'wimbledon',
            surface: 'Grass',
            month: 7,
            round: 'QF',
            pairs: [
              ['Elena Rybakina', 'Iga Swiatek'],
              ['Aryna Sabalenka', 'Marketa Vondrousova'],
              ['Ons Jabeur', 'Coco Gauff'],
              ['Petra Kvitova', 'Jessica Pegula'],
            ],
          },
          {
            tournamentId: 'roland_garros',
            surface: 'Clay',
            month: 6,
            round: 'SF',
            pairs: [
              ['Iga Swiatek', 'Aryna Sabalenka'],
              ['Coco Gauff', 'Jelena Ostapenko'],
              ['Barbora Krejcikova', 'Maria Sakkari'],
            ],
          },
        ];

  const insert = db.prepare(
    `INSERT INTO upcoming_matches (
       id, tour, tournament_id, tournament_name, surface, commence_time,
       p1_name, p2_name, p1_id, p2_id, p1_odds, p2_odds, books, source, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );

  const tconf = (id: string) => tournamentsConfig.tournaments.find((t) => t.id === id);
  let count = 0;
  let slot = 0; // spreads demo fixtures across the next few days, starting today
  db.exec('BEGIN');
  plan.forEach((block) => {
    const conf = tconf(block.tournamentId);
    block.pairs.forEach((pair, pi) => {
      const a = byName.get(pair[0])!;
      const b = byName.get(pair[1])!;
      const pa = expectedScore(skillOn(a, block.surface), skillOn(b, block.surface));
      // Market ≈ true prob + bias/noise, then add ~5% bookmaker margin.
      const bias = (rng() - 0.5) * 0.12;
      const mp = Math.min(0.9, Math.max(0.1, pa + bias));
      const margin = 1.05; // bookmaker overround (~5%): implied probs sum to >1
      const odds1 = round2(1 / (mp * margin));
      const odds2 = round2(1 / ((1 - mp) * margin));
      insert.run(
        `seed-${tour}-${block.tournamentId}-${pi}`,
        tour,
        block.tournamentId,
        conf?.name ?? block.tournamentId,
        block.surface,
        nearTermISO(slot++),
        a.name,
        b.name,
        a.id,
        b.id,
        odds1,
        odds2,
        6,
        'fixture',
        new Date().toISOString(),
      );
      count++;
    });
  });
  db.exec('COMMIT');
  return count;
}

/**
 * Spread demo fixtures across the next few days starting a couple of hours from
 * now, so there is always something "today/soon" to show (real upcoming matches
 * come from The Odds API via `npm run update-data`).
 */
function nearTermISO(slot: number): string {
  const hoursFromNow = 3 + slot * 7; // first ~3h out, then ~every 7h → ~4 days
  return new Date(Date.now() + hoursFromNow * 3600 * 1000).toISOString();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function seedDatabase(): {
  players: number;
  matches: number;
  upcoming: number;
  ratings: Record<string, number>;
} {
  getDb();
  resetData();

  const rng = makeRng(20260721); // fixed seed → reproducible dataset
  const atpMatches = simulateTour('atp', ATP, rng);
  const wtaMatches = simulateTour('wta', WTA, rng);
  const atpUp = seedUpcoming('atp', ATP, rng);
  const wtaUp = seedUpcoming('wta', WTA, rng);

  const ratings = recomputeRatings();

  setMeta('data_source', 'seed');
  setMeta('seeded_at', new Date().toISOString());

  return {
    players: ATP.length + WTA.length,
    matches: atpMatches + wtaMatches,
    upcoming: atpUp + wtaUp,
    ratings,
  };
}
