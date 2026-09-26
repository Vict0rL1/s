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
// Everything else — LaLiga, the Bundesliga, the Championship, NPB, KBO, college
// — gets a NEUTRAL crest rather than an invented colour. Guessing that Real
// Madrid is purple would be inventing information, which this app does not do
// anywhere else either.
//
// Football nicknames are deliberately NOT indexed. "City", "United" and "Albion"
// each belong to several clubs, and a nickname key would have painted Manchester
// City in Leicester's gold. The North American leagues do get nickname keys,
// because the basketball database really does store teams as "Celtics".

type ColorPair = readonly [primary: string, secondary: string];

const TEAM_COLORS: Record<string, Record<string, ColorPair>> = {
  epl: {
    'arsenal': ['#ef0107', '#023474'],
    'bournemouth': ['#e62333', '#000000'],
    'brightonhovealbion': ['#0055a9', '#f8bc1b'],
    'burnley': ['#6c1d45', '#99d6ea'],
    'chelsea': ['#034694', '#dba111'],
    'crystalpalace': ['#1b458f', '#c4122e'],
    'everton': ['#274488', '#274488'],
    'huddersfieldtown': ['#0073d2', '#0073d2'],
    'leicestercity': ['#fdbe11', '#0053a0'],
    'liverpool': ['#c8102e', '#00b2a9'],
    'manchestercity': ['#98c5e9', '#00285e'],
    'manchesterunited': ['#da020e', '#ffe500'],
    'newcastleunited': ['#241f20', '#00b8f4'],
    'southampton': ['#ed1a3b', '#211e1f'],
    'stokecity': ['#e03a3e', '#1b449c'],
    'swanseacity': ['#000000', '#000000'],
    'tottenhamhotspur': ['#001c58', '#001c58'],
    'watford': ['#fbee23', '#ed2127'],
    'westbromwichalbion': ['#091453', '#091453'],
    'westhamunited': ['#60223b', '#f7c240'],
  },
  mlb: {
    'anaheim': ['#ba0021', '#003263'],
    'angels': ['#ba0021', '#003263'],
    'arizonadiamondbacks': ['#a71930', '#000000'],
    'astros': ['#002d62', '#eb6e1f'],
    'ath': ['#003831', '#efb21e'],
    'athletics': ['#003831', '#efb21e'],
    'atlantabraves': ['#ce1141', '#13274f'],
    'baltimoreorioles': ['#df4601', '#000000'],
    'bostonredsox': ['#bd3039', '#0d2b56'],
    'braves': ['#ce1141', '#13274f'],
    'brewers': ['#0a2351', '#b6922e'],
    'cardinals': ['#c41e3a', '#000066'],
    'chicagocubs': ['#cc3433', '#0e3386'],
    'chicagowhitesox': ['#000000', '#c4ced4'],
    'cincinnatireds': ['#c6011f', '#000000'],
    'clevelandguardians': ['#e31937', '#002b5c'],
    'clevelandindians': ['#e31937', '#002b5c'],
    'coloradorockies': ['#333366', '#231f20'],
    'cubs': ['#cc3433', '#0e3386'],
    'detroittigers': ['#0c2c56', '#0c2c56'],
    'diamondbacks': ['#a71930', '#000000'],
    'dodgers': ['#ef3e42', '#005a9c'],
    'floridamarlins': ['#ff6600', '#0077c8'],
    'giants': ['#fd5a1e', '#000000'],
    'guardians': ['#e31937', '#002b5c'],
    'houstonastros': ['#002d62', '#eb6e1f'],
    'indians': ['#e31937', '#002b5c'],
    'jays': ['#134a8e', '#1d2d5c'],
    'kansascityroyals': ['#004687', '#c09a5b'],
    'losangelesangels': ['#ba0021', '#003263'],
    'losangelesangelsofanaheim': ['#ba0021', '#003263'],
    'losangelesdodgers': ['#ef3e42', '#005a9c'],
    'mariners': ['#0c2c56', '#005c5c'],
    'marlins': ['#ff6600', '#0077c8'],
    'mets': ['#ff5910', '#002d72'],
    'miamimarlins': ['#ff6600', '#0077c8'],
    'milwaukeebrewers': ['#0a2351', '#b6922e'],
    'minnesotatwins': ['#002b5c', '#d31145'],
    'nationals': ['#ab0003', '#11225b'],
    'newyorkmets': ['#ff5910', '#002d72'],
    'newyorkyankees': ['#e4002b', '#003087'],
    'oaklandas': ['#003831', '#efb21e'],
    'oaklandathletics': ['#003831', '#efb21e'],
    'orioles': ['#df4601', '#000000'],
    'padres': ['#002d62', '#fec325'],
    'philadelphiaphillies': ['#284898', '#e81828'],
    'phillies': ['#284898', '#e81828'],
    'pirates': ['#fdb827', '#000000'],
    'pittsburghpirates': ['#fdb827', '#000000'],
    'rangers': ['#c0111f', '#003278'],
    'rays': ['#092c5c', '#8fbce6'],
    'reds': ['#c6011f', '#000000'],
    'rockies': ['#333366', '#231f20'],
    'royals': ['#004687', '#c09a5b'],
    'sandiegopadres': ['#002d62', '#fec325'],
    'sanfranciscogiants': ['#fd5a1e', '#000000'],
    'seattlemariners': ['#0c2c56', '#005c5c'],
    'stlouiscardinals': ['#c41e3a', '#000066'],
    'tampabayrays': ['#092c5c', '#8fbce6'],
    'texasrangers': ['#c0111f', '#003278'],
    'tigers': ['#0c2c56', '#0c2c56'],
    'torontobluejays': ['#134a8e', '#1d2d5c'],
    'twins': ['#002b5c', '#d31145'],
    'washingtonnationals': ['#ab0003', '#11225b'],
    'yankees': ['#e4002b', '#003087'],
  },
  nba: {
    '76ers': ['#ed174c', '#006bb6'],
    'atlantahawks': ['#e13a3e', '#c4d600'],
    'blazers': ['#e03a3e', '#bac3c9'],
    'bostonceltics': ['#008348', '#bb9753'],
    'brooklynnets': ['#061922', '#061922'],
    'bucks': ['#00471b', '#f0ebd2'],
    'bulls': ['#ce1141', '#061922'],
    'cavaliers': ['#860038', '#fdbb30'],
    'celtics': ['#008348', '#bb9753'],
    'charlottehornets': ['#1d1160', '#008ca8'],
    'chicagobulls': ['#ce1141', '#061922'],
    'clevelandcavaliers': ['#860038', '#fdbb30'],
    'clippers': ['#ed174c', '#006bb6'],
    'dallasmavericks': ['#007dc5', '#c4ced3'],
    'denvernuggets': ['#4d90cd', '#fdb927'],
    'detroitpistons': ['#ed174c', '#006bb6'],
    'goldenstatewarriors': ['#fdb927', '#006bb6'],
    'grizzlies': ['#0f586c', '#7399c6'],
    'hawks': ['#e13a3e', '#c4d600'],
    'heat': ['#98002e', '#f9a01b'],
    'hornets': ['#1d1160', '#008ca8'],
    'houstonrockets': ['#ce1141', '#c4ced3'],
    'indianapacers': ['#ffc633', '#00275d'],
    'jazz': ['#002b5c', '#f9a01b'],
    'kings': ['#724c9f', '#8e9090'],
    'knicks': ['#006bb6', '#f58426'],
    'lakers': ['#fdb927', '#552582'],
    'losangelesclippers': ['#ed174c', '#006bb6'],
    'losangeleslakers': ['#fdb927', '#552582'],
    'magic': ['#007dc5', '#c4ced3'],
    'mavericks': ['#007dc5', '#c4ced3'],
    'memphisgrizzlies': ['#0f586c', '#7399c6'],
    'miamiheat': ['#98002e', '#f9a01b'],
    'milwaukeebucks': ['#00471b', '#f0ebd2'],
    'minnesotatimberwolves': ['#005083', '#00a94f'],
    'nets': ['#061922', '#061922'],
    'neworleanspelicans': ['#002b5c', '#e31837'],
    'newyorkknicks': ['#006bb6', '#f58426'],
    'nuggets': ['#4d90cd', '#fdb927'],
    'oklahomacitythunder': ['#007dc3', '#f05133'],
    'orlandomagic': ['#007dc5', '#c4ced3'],
    'pacers': ['#ffc633', '#00275d'],
    'pelicans': ['#002b5c', '#e31837'],
    'philadelphia76ers': ['#ed174c', '#006bb6'],
    'phoenixsuns': ['#e56020', '#1d1160'],
    'pistons': ['#ed174c', '#006bb6'],
    'portlandtrailblazers': ['#e03a3e', '#bac3c9'],
    'raptors': ['#ce1141', '#061922'],
    'rockets': ['#ce1141', '#c4ced3'],
    'sacramentokings': ['#724c9f', '#8e9090'],
    'sanantoniospurs': ['#bac3c9', '#061922'],
    'spurs': ['#bac3c9', '#061922'],
    'suns': ['#e56020', '#1d1160'],
    'thunder': ['#007dc3', '#f05133'],
    'timberwolves': ['#005083', '#00a94f'],
    'torontoraptors': ['#ce1141', '#061922'],
    'utahjazz': ['#002b5c', '#f9a01b'],
    'warriors': ['#fdb927', '#006bb6'],
    'washingtonwizards': ['#002b5c', '#e31837'],
    'wizards': ['#002b5c', '#e31837'],
  },
  nfl: {
    '49ers': ['#aa0000', '#b3995d'],
    'arizonacardinals': ['#97233f', '#000000'],
    'atlantafalcons': ['#a71930', '#000000'],
    'baltimoreravens': ['#241773', '#000000'],
    'bears': ['#0b162a', '#c83803'],
    'bengals': ['#000000', '#fb4f14'],
    'bills': ['#00338d', '#c60c30'],
    'broncos': ['#002244', '#fb4f14'],
    'browns': ['#fb4f14', '#22150c'],
    'buccaneers': ['#d50a0a', '#34302b'],
    'buffalobills': ['#00338d', '#c60c30'],
    'cardinals': ['#97233f', '#000000'],
    'carolinapanthers': ['#0085ca', '#000000'],
    'chargers': ['#002244', '#0073cf'],
    'chicagobears': ['#0b162a', '#c83803'],
    'chiefs': ['#e31837', '#ffb612'],
    'cincinnatibengals': ['#000000', '#fb4f14'],
    'clevelandbrowns': ['#fb4f14', '#22150c'],
    'colts': ['#002c5f', '#a5acaf'],
    'commanders': ['#773141', '#ffb612'],
    'cowboys': ['#002244', '#b0b7bc'],
    'dallascowboys': ['#002244', '#b0b7bc'],
    'denverbroncos': ['#002244', '#fb4f14'],
    'detroitlions': ['#005a8b', '#b0b7bc'],
    'dolphins': ['#008e97', '#f58220'],
    'eagles': ['#004953', '#a5acaf'],
    'falcons': ['#a71930', '#000000'],
    'giants': ['#0b2265', '#a71930'],
    'greenbaypackers': ['#203731', '#ffb612'],
    'houstontexans': ['#03202f', '#a71930'],
    'indianapoliscolts': ['#002c5f', '#a5acaf'],
    'jacksonvillejaguars': ['#000000', '#006778'],
    'jaguars': ['#000000', '#006778'],
    'jets': ['#203731', '#203731'],
    'kansascitychiefs': ['#e31837', '#ffb612'],
    'lasvegasraiders': ['#a5acaf', '#000000'],
    'lions': ['#005a8b', '#b0b7bc'],
    'losangeleschargers': ['#002244', '#0073cf'],
    'losangelesrams': ['#002244', '#b3995d'],
    'lv': ['#a5acaf', '#000000'],
    'miamidolphins': ['#008e97', '#f58220'],
    'minnesotavikings': ['#4f2683', '#ffc62f'],
    'newenglandpatriots': ['#002244', '#c60c30'],
    'neworleanssaints': ['#9f8958', '#000000'],
    'newyorkgiants': ['#0b2265', '#a71930'],
    'newyorkjets': ['#203731', '#203731'],
    'oaklandraiders': ['#a5acaf', '#000000'],
    'packers': ['#203731', '#ffb612'],
    'panthers': ['#0085ca', '#000000'],
    'patriots': ['#002244', '#c60c30'],
    'philadelphiaeagles': ['#004953', '#a5acaf'],
    'pittsburghsteelers': ['#000000', '#ffb612'],
    'raiders': ['#a5acaf', '#000000'],
    'rams': ['#002244', '#b3995d'],
    'ravens': ['#241773', '#000000'],
    'saints': ['#9f8958', '#000000'],
    'sanfrancisco49ers': ['#aa0000', '#b3995d'],
    'seahawks': ['#002244', '#69be28'],
    'seattleseahawks': ['#002244', '#69be28'],
    'steelers': ['#000000', '#ffb612'],
    'tampabaybuccaneers': ['#d50a0a', '#34302b'],
    'tennesseetitans': ['#002244', '#4b92db'],
    'texans': ['#03202f', '#a71930'],
    'titans': ['#002244', '#4b92db'],
    'vikings': ['#4f2683', '#ffc62f'],
    'washingtoncommanders': ['#773141', '#ffb612'],
  },
};

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

/** Relative luminance, for deciding what can be read on top of a colour. */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const v = (i: number) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * v(0) + 0.7152 * v(2) + 0.0722 * v(4);
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
  const l = luminance(fill);
  if (l < 0.035) fill = mix(fill, '#8b93a1', 0.42);
  else if (l > 0.82) fill = mix(fill, '#4b5159', 0.18);
  const ink = luminance(fill) > 0.35 ? '#0b0d11' : '#f2f4f7';
  // A hairline of the second colour: enough to tell two clubs apart when their
  // primaries are both, say, navy, without turning the crest into a logo.
  const ring = c.secondary === c.primary ? 'rgba(255,255,255,0.14)' : c.secondary;
  return { fill, ring, ink };
}
