// Official team colours, for the identity crest on a card.
//
// ===========================================================================
// THE RULE: a team colour is IDENTITY. It is never a data mark.
// ===========================================================================
// The bars, the grid cells and the margin bands keep the shared, validated
// palette — blue is the home side in all five sports, whatever colours the two
// clubs happen to wear. A team colour appears in exactly one place: the small
// round crest next to the name, which answers "which club is this" and nothing
// else. That is the same split the rest of the design system already uses, one
// level up: colour marks WHO, ink states WHAT.
//
// Without that rule, a Seahawks-vs-Chiefs card would have navy, action green,
// red and gold competing with the two hues that actually carry the forecast,
// and the palette work would be undone in one afternoon.
//
// SOURCE: jimniels/teamcolors, the open dataset of official league colours.
// Only the leagues whose values were checked are here:
//
//   NFL   32/32 teams      MLB   32/32      NBA   28/45 (the 17 missing are
//   Premier League 20/20                    franchises that folded in the 1940s
//                                           and never appear in a card)
//
// Two Premier League clubs are corrected: the source lists EPL colours in an
// inconsistent order and put a secondary first, which made Liverpool teal and
// Burnley pale blue. Both are set from the club crest instead.
//
// Since Phase 5.23 LaLiga, Serie A, the Bundesliga and Ligue 1 are in too (see their block),
// and the NBA covers all 30 current franchises. Everything else — the Championship, NPB,
// KBO, college — gets a NEUTRAL crest rather than an invented colour. Guessing that Real
// Madrid is purple would be inventing information, which this app does not do
// anywhere else either.
//
// Football nicknames are deliberately NOT indexed. "City", "United" and "Albion"
// each belong to several clubs, and a nickname key would have painted Manchester
// City in Leicester's gold. The North American leagues do get nickname keys,
// because the basketball database really does store teams as "Celtics".

import { contraste, luminancia } from './contraste';
import { TEAM_COLORS } from './teamColorsDatos';

/** Strip accents, punctuation and the club-type words that vary by source. */
function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(fc|afc|cf|sc|ac|club|the)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

export interface Crest {
  primary: string;
  secondary: string;
  /** False when we do not know this team's colours and are showing a neutral. */
  known: boolean;
}

const NEUTRAL: Crest = { primary: '#2a2f38', secondary: '#3b424e', known: false };

/**
 * The crest colours for a team.
 *
 * Tries the league's own table first, then the other North American tables —
 * because the same franchise can appear under two league ids (an NBA team in a
 * WNBA-shaped config, an MLB team reached through a different league row), and
 * a crest that works on one screen and not the next looks like a bug.
 */
export function crestColors(league: string, name: string, code?: string | null): Crest {
  const keys = [normalizeName(name)];
  if (code) keys.push(normalizeName(code));
  const tables = [TEAM_COLORS[league], ...Object.values(TEAM_COLORS)];
  for (const table of tables) {
    if (!table) continue;
    for (const k of keys) {
      const hit = table[k];
      if (hit) return { primary: hit[0], secondary: hit[1], known: true };
    }
  }
  return NEUTRAL;
}

/**
 * The two or three letters on the crest.
 *
 * A real abbreviation when the database has one (NFL writes SEA, Retrosheet
 * NYA); otherwise the initials of the significant words, so "Real Sociedad"
 * reads RS and "Borussia Monchengladbach" BM.
 */
export function monogram(name: string, code?: string | null): string {
  if (code && /^[A-Za-z]{2,3}$/.test(code)) return code.toUpperCase();
  const words = name
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(/\s+/)
    // "United" and "City" are NOT filtered, even though they are noise in a
    // name: Manchester United and Manchester City both came out "MAN" without
    // them, which is worse than noise — it is the same crest for two clubs that
    // play each other. With them, MU and MC.
    .filter((w) => w.length > 1 && !/^(fc|afc|cf|sc|ac|de|el|la|los|las|the|club)$/i.test(w));
  const use = words.length > 0 ? words : name.split(/\s+/).filter(Boolean);
  if (use.length === 1) return use[0].slice(0, 3).toUpperCase();
  return use
    .slice(0, 3)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}


function mix(hex: string, toward: string, amount: number): string {
  const a = hex.replace('#', '');
  const b = toward.replace('#', '');
  const ch = (i: number) => {
    const x = parseInt(a.slice(i, i + 2), 16);
    const y = parseInt(b.slice(i, i + 2), 16);
    return Math.round(x + (y - x) * amount)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${ch(0)}${ch(2)}${ch(4)}`;
}

/**
 * The crest as it should actually be painted.
 *
 * Several teams' official primary is pure black — the Raiders, the Falcons,
 * Newcastle — and a black disc on a #14161b card is an invisible hole. Anything
 * below the floor is lifted toward the card surface's opposite until it reads as
 * a deliberate mark, and the ink on top follows the result rather than the
 * original. Very light crests (the Padres' sand, Wimbledon white) get the
 * reverse treatment.
 */
export function crestPaint(c: Crest): { fill: string; ring: string; ink: string } {
  let fill = c.primary;
  const l = luminancia(fill);
  if (l < 0.035) fill = mix(fill, '#8b93a1', 0.42);
  else if (l > 0.82) fill = mix(fill, '#4b5159', 0.18);
  // The ink is whichever of the two reads better, and if neither reaches 4.5:1 (a mid-tone red
  // or orange sits right between them) the fill is shaded just enough, away from the ink (G6:
  // the old luminance threshold put white on the Giants' orange at 2.86:1).
  const ink = contraste('#0b0d11', fill) >= contraste('#f2f4f7', fill) ? '#0b0d11' : '#f2f4f7';
  const away = ink === '#f2f4f7' ? '#000000' : '#ffffff';
  for (let step = 1; contraste(ink, fill) < 4.5 && step <= 20; step++) fill = mix(fill, away, 0.04);
  // A hairline of the second colour: enough to tell two clubs apart when their
  // primaries are both, say, navy, without turning the crest into a logo.
  const ring = c.secondary === c.primary ? 'rgba(255,255,255,0.14)' : c.secondary;
  return { fill, ring, ink };
}
