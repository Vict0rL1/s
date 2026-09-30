// Upcoming matches offered to the bet form, across all five sports.
//
// WHY THIS EXISTS RATHER THAN A FREE-TEXT BOX. Typing "Seahawks vs Patriots" by
// hand works, but it throws away the two numbers that make this log worth more
// than a spreadsheet: the model's probability and the market's, at the moment the
// bet was placed. Without them the tracker can only tell you whether you won.
// With them it can eventually tell you whether AGREEING WITH THE MODEL helped —
// and that question cannot be answered retroactively, because by then the odds
// have moved and the forecast has been rebuilt.
//
// So the form offers a list, and picking from it captures both. A free-text bet is
// still allowed; it just cannot join that comparison, and the UI says so.
//
// One flat shape for five sports with very different cards. Only what a bet needs:
// who is playing, when, and each side's two probabilities.

import { listUpcoming as listTennis } from './repo.ts';
import { listUpcoming as listFootball } from './football/repo.ts';
import { listUpcoming as listBasketball } from './basketball/repo.ts';
import { listUpcoming as listBaseball } from './baseball/repo.ts';
import { listUpcoming as listNfl } from './nfl/repo.ts';
import { listLeagues as listNflLeagues } from './nfl/repo.ts';
import { getDb } from './db.ts';

export interface BetCandidateSide {
  label: string;
  /** The model's probability for this side, 0–1. Null with no model. */
  modelProb: number | null;
  /** The market's de-vigged probability for this side. Null with no odds. */
  marketProb: number | null;
  /** Decimal odds, so the form can pre-fill and the user only corrects. */
  odds: number | null;
}

export interface BetCandidate {
  sport: string;
  league: string | null;
  event: string;
  commenceTime: string;
  matchKey: string;
  sides: BetCandidateSide[];
}

/** Two-way de-vig. Returns nulls rather than guessing when a price is missing. */
function deVig(a: number | null, b: number | null): [number | null, number | null] {
  if (!a || !b || a <= 1 || b <= 1) return [null, null];
  const ra = 1 / a;
  const rb = 1 / b;
  return [ra / (ra + rb), rb / (ra + rb)];
}

/**
 * Everything worth betting on in the next few days.
 *
 * Deliberately does NOT build a prediction per match. A prediction replays
 * thousands of games and this list can hold a hundred matches, so calling the
 * model for each would make opening the form take seconds.
 *
 * Instead: market probabilities come straight off the stored odds, and the model's
 * come from the prediction the app ALREADY LOGGED when it showed the match — one
 * indexed read per sport. Where nothing was logged the column stays null, which is
 * honest; a slow form is not.
 */
/**
 * The model's home/first-player probability per upcoming fixture, by sport.
 *
 * Read from the prediction logs, which every tab writes to when it displays a
 * match. `upcoming_id` is the join: it is the id of the row in the sport's own
 * upcoming table, which is exactly what the candidate list is built from.
 */
function loggedModelProbs(): Map<string, number> {
  const db = getDb();
  const out = new Map<string, number>();
  const sources: [string, string, string][] = [
    ['tennis', 'prediction_log', 'prob1'],
    ['football', 'fb_prediction_log', 'prob_home'],
    ['basketball', 'bb_prediction_log', 'prob_home'],
    ['baseball', 'bsb_prediction_log', 'prob_home'],
    ['nfl', 'naf_prediction_log', 'prob_home'],
  ];
  for (const [sport, table, col] of sources) {
    try {
      const rows = db
        .prepare(`SELECT upcoming_id AS id, ${col} AS p FROM ${table} WHERE upcoming_id IS NOT NULL`)
        .all() as unknown as { id: string; p: number | null }[];
      for (const r of rows) {
        if (r.p != null) out.set(`${sport}|${r.id}`, r.p);
      }
    } catch {
      // A sport whose log table does not exist yet simply contributes nothing.
    }
  }
  return out;
}

export function listBetCandidates(limit = 120): BetCandidate[] {
  const out: BetCandidate[] = [];
  const logged = loggedModelProbs();
  /**
   * The model's probability for a side.
   *
   * The log stores ONE number — the home team's (or first player's) probability —
   * so the away side is its complement. That is exact for two-way markets and
   * wrong for football's three outcomes, which is why football passes null for the
   * draw and only uses this for home/away... and even then the complement would
   * absorb the draw. So football gets null throughout: a slightly-wrong number
   * that feeds an "did the model agree with me" report is worse than no number.
   */
  const modelProb = (matchKey: string, side: 'home' | 'away'): number | null => {
    const p = logged.get(matchKey);
    if (p == null) return null;
    return side === 'home' ? p : 1 - p;
  };

  // --- tennis
  for (const m of listTennis({})) {
    const [p1, p2] = deVig(m.p1_odds, m.p2_odds);
    out.push({
      sport: 'tennis',
      league: m.tour?.toUpperCase() ?? null,
      event: `${m.p1_name} vs ${m.p2_name}`,
      commenceTime: m.commence_time,
      matchKey: `tennis|${m.id}`,
      sides: [
        { label: m.p1_name, modelProb: modelProb(`tennis|${m.id}`, 'home'), marketProb: p1, odds: m.p1_odds },
        { label: m.p2_name, modelProb: modelProb(`tennis|${m.id}`, 'away'), marketProb: p2, odds: m.p2_odds },
      ],
    });
  }

  // --- football: three outcomes, so the draw is a side of its own.
  // modelProb stays null here on purpose: the log keeps only P(home), and its
  // complement is "draw or away", not "away". A number that is quietly wrong would
  // poison the agreement report, so football contributes no model column.
  for (const g of listFootball()) {
    const raw = [g.odds_home, g.odds_draw, g.odds_away];
    const inv: (number | null)[] = raw.map((o) => (o && o > 1 ? 1 / o : null));
    const sum: number = inv.reduce<number>((acc, x) => acc + (x ?? 0), 0);
    const prob = (i: number): number | null =>
      inv[i] != null && sum > 0 ? (inv[i] as number) / sum : null;
    out.push({
      sport: 'football',
      league: g.league,
      event: `${g.home_name} vs ${g.away_name}`,
      commenceTime: g.commence_time,
      matchKey: `football|${g.id}`,
      sides: [
        { label: g.home_name, modelProb: null, marketProb: prob(0), odds: g.odds_home },
        { label: 'Empate', modelProb: null, marketProb: prob(1), odds: g.odds_draw },
        { label: g.away_name, modelProb: null, marketProb: prob(2), odds: g.odds_away },
      ],
    });
  }

  // --- basketball and baseball: two-way
  for (const g of listBasketball()) {
    const [h, a] = deVig(g.home_odds, g.away_odds);
    out.push({
      sport: 'basketball',
      league: g.league,
      event: `${g.home_name} vs ${g.away_name}`,
      commenceTime: g.commence_time,
      matchKey: `basketball|${g.id}`,
      sides: [
        { label: g.home_name, modelProb: modelProb(`basketball|${g.id}`, 'home'), marketProb: h, odds: g.home_odds },
        { label: g.away_name, modelProb: modelProb(`basketball|${g.id}`, 'away'), marketProb: a, odds: g.away_odds },
      ],
    });
  }
  for (const g of listBaseball()) {
    const [h, a] = deVig(g.odds_home, g.odds_away);
    out.push({
      sport: 'baseball',
      league: g.league,
      event: `${g.home_name} vs ${g.away_name}`,
      commenceTime: g.commence_time,
      matchKey: `baseball|${g.id}`,
      sides: [
        { label: g.home_name, modelProb: modelProb(`baseball|${g.id}`, 'home'), marketProb: h, odds: g.odds_home },
        { label: g.away_name, modelProb: modelProb(`baseball|${g.id}`, 'away'), marketProb: a, odds: g.odds_away },
      ],
    });
  }

  // --- NFL: per configured league, since listUpcoming takes one
  for (const l of listNflLeagues()) {
    for (const g of listNfl(l.id, 40)) {
      const [h, a] = deVig(g.odds_home, g.odds_away);
      out.push({
        sport: 'nfl',
        league: l.id,
        event: `${g.home_name} vs ${g.away_name}`,
        commenceTime: g.commence_time,
        matchKey: `nfl|${g.id}`,
        sides: [
          { label: g.home_name, modelProb: modelProb(`nfl|${g.id}`, 'home'), marketProb: h, odds: g.odds_home },
          { label: g.away_name, modelProb: modelProb(`nfl|${g.id}`, 'away'), marketProb: a, odds: g.odds_away },
        ],
      });
    }
  }

  return out
    .filter((c) => c.commenceTime)
    .sort((x, y) => x.commenceTime.localeCompare(y.commenceTime))
    .slice(0, limit);
}
