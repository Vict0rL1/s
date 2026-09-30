// Resolve a feed's team name to our own slug.
//
// Three sources spell the same franchise three ways: FiveThirtyEight writes the
// bare nickname ("Lakers"), hoopR/ESPN the full name ("Los Angeles Lakers"), and a
// bookmaker feed sometimes "LA Lakers". Left unresolved that is not a cosmetic
// problem — it splits one franchise into three ids, each with a third of the
// history and its own wrong Elo, and it stores the same game more than once.
//
// It happened: adding hoopR alongside FiveThirtyEight took the NBA from 45 teams to
// 98, with the Lakers holding 6,023 games as `lakers` (1948-2015) and another 2,134
// as `los-angeles-lakers` (2002-2026). `npm run verify:data` now has a check for
// exactly that shape.
//
// Lifted out of odds.ts, which had it privately, once a second caller needed it.
// Football keeps its equivalent in the same place under the same name.

import { getDb } from '../../db.ts';
import type { LeagueId } from '../types.ts';

export function normalize(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Index of a league's teams by several spellings, because feeds disagree:
 * "Los Angeles Lakers", "LA Lakers" and "Lakers" all mean one team. Matching on
 * the full name plus the last word (the nickname) covers the realistic cases
 * without fuzzy matching, which would happily confuse the two Los Angeles teams.
 */
export function buildNameIndex(league: LeagueId): Map<string, string> {
  const rows = getDb()
    .prepare('SELECT id, name, abbreviation, location FROM bb_teams WHERE league = ?')
    .all(league) as unknown as {
    id: string;
    name: string;
    abbreviation: string | null;
    location: string | null;
  }[];
  const idx = new Map<string, string>();
  const add = (key: string, id: string) => {
    const k = normalize(key);
    if (!k) return;
    // First writer wins: never let a nickname collision silently overwrite a
    // full-name match.
    if (!idx.has(k)) idx.set(k, id);
  };
  for (const r of rows) add(r.name, r.id);
  for (const r of rows) {
    if (r.abbreviation) add(r.abbreviation, r.id);
    // Nickname = the name minus its location prefix.
    if (r.location && r.name.startsWith(r.location)) {
      add(r.name.slice(r.location.length).trim(), r.id);
    } else {
      const words = r.name.split(/\s+/);
      if (words.length > 1) add(words[words.length - 1], r.id);
    }
  }
  return idx;
}

export function resolve(idx: Map<string, string>, name: string): string | null {
  const n = normalize(name);
  if (idx.has(n)) return idx.get(n)!;
  // "LA Clippers" vs "Los Angeles Clippers": try the trailing nickname.
  const words = n.split(' ');
  for (let take = 1; take <= Math.min(2, words.length - 1); take++) {
    const tail = words.slice(words.length - take).join(' ');
    if (idx.has(tail)) return idx.get(tail)!;
  }
  return null;
}

