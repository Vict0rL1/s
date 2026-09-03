// Matching a feed's spelling of a club to the team already in the database.
//
// Every football feed writes clubs differently — "Manchester United FC" in
// footballcsv, "Man United" at football-data.co.uk, "Man Utd" in the FPL data,
// "Manchester United" from the bookmakers. Shared here so all of them agree, and
// so that fixing one feed's spelling fixes it everywhere.

import { getDb } from '../../db.ts';
import type { LeagueId } from '../types.ts';

/** Strip accents, punctuation and the club suffixes feeds disagree about. */
export function normalizeTeamName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(fc|cf|afc|sc|ac|ss|as|cd|ud|rcd|club|de|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function buildTeamIndex(league: LeagueId): Map<string, string> {
  const rows = getDb()
    .prepare('SELECT id, name FROM fb_teams WHERE league = ?')
    .all(league) as unknown as { id: string; name: string }[];
  const idx = new Map<string, string>();
  for (const r of rows) {
    const k = normalizeTeamName(r.name);
    if (k && !idx.has(k)) idx.set(k, r.id);
    // The id is itself a slug of some source's spelling, so index it too.
    const s = normalizeTeamName(r.id.replace(/-/g, ' '));
    if (s && !idx.has(s)) idx.set(s, r.id);
  }
  return idx;
}

/**
 * Resolve a feed's club name to a team id, or null.
 *
 * Prefix matching is allowed because a feed's shorter name is usually a prefix of
 * ours ("Man City" / "Manchester City FC") — but ONLY when it leaves exactly one
 * candidate. Anything looser cheerfully merges the two Manchester clubs, and a
 * silently wrong team is far worse than an unmatched one.
 */
export function resolveTeam(idx: Map<string, string>, name: string): string | null {
  const n = normalizeTeamName(name);
  if (!n) return null;
  if (idx.has(n)) return idx.get(n)!;
  const hits = [...idx.entries()].filter(([k]) => k.startsWith(n) || n.startsWith(k));
  const ids = new Set(hits.map(([, id]) => id));
  return ids.size === 1 ? [...ids][0] : null;
}
