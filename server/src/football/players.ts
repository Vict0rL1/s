// ===========================================================================
// THE SQUAD — who is actually playing
// ===========================================================================
// docs/FOOTBALL.md has always opened its limitations with the same sentence:
// "it does not know the lineups. That is the biggest one of all." Three separate
// team-level signals were built and measured to try to get at it from the outside
// — a learned attack/defence profile, recent form, fixture congestion — and all
// three came back empty, because none of them can see the one fact that matters.
// This module is the fact itself.
//
// WHAT WAS MEASURED
//
// Three Premier League seasons of teamsheets (5.300 team-matches, of which 1.663
// survive the controls), everything leave-one-gameweek-out so no player's rating
// contains the match it is used to predict, and every comparison adjusted for the
// opponent and the venue — without that adjustment "full-strength XI" quietly
// means "the fixtures a manager thought were worth a full-strength XI".
//
//   Missing share of the regular XI's       goals scored vs expected
//   attacking output
//     0–5%    (n=113)                          +24.9%
//     5–15%   (n=260)                           +1.1%
//     15–25%  (n=413)                           +2.1%
//     25–40%  (n=513)                           −4.4%
//     >40%    (n=364)                           −5.6%
//
//   Missing share of the regular XI's        goals conceded vs expected
//   minutes
//     0–5%    (n= 28)                          −31.9%
//     5–15%   (n=355)                           −4.5%
//     15–25%  (n=531)                           −2.4%
//     25–40%  (n=548)                           +5.8%
//     >40%    (n=201)                           +0.4%
//
// Monotonic in both directions, and significant in both: a likelihood-ratio test
// against "the lineup tells you nothing" gives χ² = 6.1 for goals scored and
// χ² = 6.2 for goals conceded (3.84 is p<0.05). That is the first signal in this
// whole football model that beat the Elo rather than being absorbed by it.
//
// HOW IT IS USED — and the one thing to be careful about
//
// The default is NEUTRAL. Marking nobody out changes nothing.
//
// That is not laziness, it is the only correct reading. A team's rating is built
// from matches it played with its usual amount of rotation — 28% of the regular
// XI's attacking output missing, on average, across those three seasons. So the
// baseline already assumes a somewhat rotated side. Handing out a bonus whenever
// the user has not marked anyone would be treating "I don't know the lineup" as
// "everyone is fit", which is exactly backwards: not knowing is the normal state,
// and the model is already calibrated for it.
//
// Marking someone out, on the other hand, IS new information, and it moves the
// number. Which makes this the one part of the app where the user knows more than
// the model — lineups are published an hour before kickoff — and can say so.
// ===========================================================================

import { getDb } from '../db.ts';
import type { LeagueId } from './types.ts';

export type Position = 'GK' | 'DEF' | 'MID' | 'FWD';

export interface FbPlayerRow {
  id: string;
  league: LeagueId;
  team_id: string;
  name: string;
  position: Position;
  minutes: number;
  starts: number;
  xgi90: number | null;
  goals: number;
  assists: number;
  status: string | null;
  chance_next: number | null;
  news: string | null;
  season: string | null;
}

/**
 * Fitted on goals SCORED against the share of the regular XI's attacking output
 * that is missing. See the table above.
 */
export const PLAYER_ATTACK_WEIGHT = 0.31;

/**
 * Fitted on goals CONCEDED against the share of the regular XI's minutes that is
 * missing. Larger than the attacking weight, and it uses minutes rather than
 * attacking output for a reason: a centre-back's contribution does not show up in
 * goals and assists, so weighting the defensive side by xGI would score a back
 * four at roughly zero and conclude that losing all of them is free.
 */
export const PLAYER_DEFENCE_WEIGHT = 0.38;

/**
 * How much of the regular XI is typically absent anyway, in the three seasons the
 * weights were fitted on: 28.0% of its attacking output and 24.8% of its minutes.
 *
 * THIS IS WHAT KEEPS THE ADJUSTMENT FROM DOUBLE-COUNTING, and it is easy to miss.
 *
 * The weights above were fitted against the total share missing on the day, and a
 * team's rating was built from matches carrying that same routine rotation. So
 * the baseline forecast already assumes a somewhat rotated side. Learning that
 * one specific player worth 25% of the attack is injured does NOT mean 25% is
 * missing instead of the usual 28% — it means that 25% is missing AND the rest of
 * the squad goes on rotating as it always does:
 *
 *   expected total = s + typical·(1 − s)
 *   excess over the baseline = s·(1 − typical)
 *
 * Applying the raw weight to `s` instead of to `s·(1 − typical)` overstates every
 * absence by about a third. Which is exactly the direction a model like this
 * flatters itself in: dramatic reactions to news look insightful.
 */
export const TYPICAL_MISSING_ATTACK = 0.28;
export const TYPICAL_MISSING_MINUTES = 0.248;

/** Minutes below which a player is squad filler rather than a regular. */
export const REGULAR_MINUTES = 450;

/** The shape of the notional regular XI, used to keep it a plausible team. */
const FORMATION: Record<Position, number> = { GK: 1, DEF: 4, MID: 4, FWD: 2 };

export interface SquadPlayer extends FbPlayerRow {
  /** In the notional regular XI. */
  regular: boolean;
  /** Share of the XI's attacking output this player represents (0 outside it). */
  attackShare: number;
  /** Share of the XI's minutes this player represents (0 outside it). */
  minutesShare: number;
  /** Flagged unavailable by the source itself (injury, suspension). */
  flaggedOut: boolean;
  /** Why the source flagged them, when it says. */
  flagReason: string | null;
}

export interface SquadAvailability {
  /** Multiplier on goals scored. <1 = scores less. */
  attack: number;
  /** Multiplier on goals conceded. >1 = concedes more. */
  defence: number;
  /** Share of the regular XI's attacking output that is out. */
  missingAttack: number;
  /** Share of the regular XI's minutes that is out. */
  missingMinutes: number;
  /** The players treated as unavailable, most important first. */
  out: { id: string; name: string; position: Position; attackShare: number; reason: string | null }[];
}

export const NEUTRAL_AVAILABILITY: SquadAvailability = {
  attack: 1,
  defence: 1,
  missingAttack: 0,
  missingMinutes: 0,
  out: [],
};

export function hasSquadData(league: LeagueId, teamId?: string): boolean {
  const db = getDb();
  const row = teamId
    ? db.prepare('SELECT COUNT(*) AS n FROM fb_players WHERE league = ? AND team_id = ?').get(league, teamId)
    : db.prepare('SELECT COUNT(*) AS n FROM fb_players WHERE league = ?').get(league);
  return ((row as unknown as { n: number }).n ?? 0) > 0;
}

function loadSquad(league: LeagueId, teamId: string): FbPlayerRow[] {
  return getDb()
    .prepare(
      `SELECT id, league, team_id, name, position, minutes, starts, xgi90, goals, assists,
              status, chance_next, news, season
       FROM fb_players WHERE league = ? AND team_id = ? ORDER BY minutes DESC`,
    )
    .all(league, teamId) as unknown as FbPlayerRow[];
}

/**
 * A team's squad, with the notional regular XI marked and each player's share of
 * it worked out.
 *
 * The XI is "most minutes, in a 4-4-2 skeleton" rather than simply "top 11 by
 * minutes". Sorting on minutes alone happily produces an XI with three
 * goalkeepers and no striker for a club that changed keeper mid-season, and then
 * the attacking shares below describe a team that never took the field.
 */
export function getSquad(league: LeagueId, teamId: string): SquadPlayer[] {
  const rows = loadSquad(league, teamId);
  const chosen = new Set<string>();
  for (const [pos, count] of Object.entries(FORMATION) as [Position, number][]) {
    rows
      .filter((r) => r.position === pos)
      .slice(0, count)
      .forEach((r) => chosen.add(r.id));
  }
  // Backfill to eleven. A squad can be short in one line — a club registering a
  // single recognised striker, say — and the shares below are shares of the XI,
  // so a ten-man XI would inflate everyone else's importance by a tenth.
  for (const r of rows) {
    if (chosen.size >= 11) break;
    chosen.add(r.id);
  }

  const xi = rows.filter((r) => chosen.has(r.id));
  const totalAttack = xi.reduce((a, r) => a + Math.max(0, r.xgi90 ?? 0), 0);
  const totalMinutes = xi.reduce((a, r) => a + r.minutes, 0);

  return rows.map((r) => {
    const regular = chosen.has(r.id);
    const flag = availabilityFlag(r);
    return {
      ...r,
      regular,
      attackShare: regular && totalAttack > 0 ? Math.max(0, r.xgi90 ?? 0) / totalAttack : 0,
      minutesShare: regular && totalMinutes > 0 ? r.minutes / totalMinutes : 0,
      flaggedOut: flag.out,
      flagReason: flag.reason,
    };
  });
}

/**
 * Read the source's own availability flags.
 *
 * `status` is a one-letter code — a(vailable), d(oubtful), i(njured),
 * s(uspended), u(navailable). Only `i`, `s` and `u` are treated as out; a doubt
 * is not an absence, and pretending otherwise would move numbers on rumour.
 */
function availabilityFlag(r: FbPlayerRow): { out: boolean; reason: string | null } {
  const s = (r.status ?? 'a').toLowerCase();
  const known: Record<string, string> = { i: 'lesionado', s: 'sancionado', u: 'no disponible' };
  if (known[s]) return { out: true, reason: r.news?.trim() || known[s] };
  // Some feeds leave `status` alone and only drop the chance of playing.
  if (r.chance_next != null && r.chance_next === 0) {
    return { out: true, reason: r.news?.trim() || 'sin opciones de jugar' };
  }
  return { out: false, reason: null };
}

/**
 * Turn a set of absences into multipliers on expected goals.
 *
 * `outIds` are the players the caller says are out. `useFlags` additionally
 * treats anyone the source itself has marked injured or suspended as out, which
 * is what makes this useful without the user having to know anything.
 */
export function squadAvailability(
  league: LeagueId,
  teamId: string,
  outIds: string[] = [],
  opts: { useFlags?: boolean; attackWeight?: number; defenceWeight?: number } = {},
): SquadAvailability {
  const squad = getSquad(league, teamId);
  if (squad.length === 0) return NEUTRAL_AVAILABILITY;

  const useFlags = opts.useFlags !== false;
  const explicit = new Set(outIds);
  const out = squad.filter((p) => explicit.has(p.id) || (useFlags && p.flaggedOut));

  // Only absences from the regular XI move the number. A fourth-choice full-back
  // being injured is true and irrelevant, and counting it would let a long
  // injury list on the fringe of a squad swamp a genuine one.
  const missingAttack = out.reduce((a, p) => a + p.attackShare, 0);
  const missingMinutes = out.reduce((a, p) => a + p.minutesShare, 0);
  const aw = opts.attackWeight ?? PLAYER_ATTACK_WEIGHT;
  const dw = opts.defenceWeight ?? PLAYER_DEFENCE_WEIGHT;

  // See TYPICAL_MISSING_*: only the part of an absence that exceeds the rotation
  // already priced into the rating is new information.
  const excessAttack = missingAttack * (1 - TYPICAL_MISSING_ATTACK);
  const excessMinutes = missingMinutes * (1 - TYPICAL_MISSING_MINUTES);

  return {
    attack: Math.exp(-aw * excessAttack),
    defence: Math.exp(dw * excessMinutes),
    missingAttack,
    missingMinutes,
    out: out
      .filter((p) => p.regular)
      .sort((a, b) => b.attackShare - a.attackShare)
      .map((p) => ({
        id: p.id,
        name: p.name,
        position: p.position,
        attackShare: Math.round(p.attackShare * 1000) / 1000,
        reason: explicit.has(p.id) && !p.flaggedOut ? 'marcado como baja' : p.flagReason,
      })),
    // Absences outside the XI are deliberately dropped from `out` above: the
    // panel should show what changed the forecast, not everything that is true.
  };
}

/** One-line summary of what the absences did, for the reasoning panel. */
export function describeAvailability(a: SquadAvailability, teamName: string): string | null {
  if (a.out.length === 0) return null;
  const names = a.out.slice(0, 3).map((p) => p.name).join(', ');
  const more = a.out.length > 3 ? ` y ${a.out.length - 3} más` : '';
  const attackPct = Math.round((1 - a.attack) * 100);
  const defencePct = Math.round((a.defence - 1) * 100);
  const effect =
    attackPct <= 0 && defencePct <= 0
      ? 'sin efecto apreciable en el pronóstico'
      : `marca ~${attackPct}% menos y encaja ~${defencePct}% más`;
  return `${teamName} sin ${names}${more}: ${effect}.`;
}
