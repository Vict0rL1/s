// Las franquicias de la NHL: la abreviatura de los datos (sportsdataverse, la API de la NHL) y el
// nombre con el que la nombran las casas de apuestas.
//
// Hace falta una tabla porque el calendario solo trae la CIUDAD («New York», que son dos equipos) y
// las casas traen el nombre completo («New York Rangers»). Las tres antiguas (ATL, PHX, ARI) están
// para poder nombrar los partidos del archivo; no juegan, así que nunca resuelven un nombre de una
// casa. Los Elo NO se pliegan entre franquicias que se mudaron (ATL→WPG, ARI→UTA): así se midió el
// modelo, y se publica lo que se midió.

export interface Franquicia {
  id: string;
  nombre: string;
  ciudad: string;
  activa: boolean;
}

const F = (id: string, nombre: string, ciudad: string, activa = true): Franquicia => ({ id, nombre, ciudad, activa });

export const FRANQUICIAS: readonly Franquicia[] = [
  F('ANA', 'Anaheim Ducks', 'Anaheim'),
  F('BOS', 'Boston Bruins', 'Boston'),
  F('BUF', 'Buffalo Sabres', 'Buffalo'),
  F('CGY', 'Calgary Flames', 'Calgary'),
  F('CAR', 'Carolina Hurricanes', 'Carolina'),
  F('CHI', 'Chicago Blackhawks', 'Chicago'),
  F('COL', 'Colorado Avalanche', 'Colorado'),
  F('CBJ', 'Columbus Blue Jackets', 'Columbus'),
  F('DAL', 'Dallas Stars', 'Dallas'),
  F('DET', 'Detroit Red Wings', 'Detroit'),
  F('EDM', 'Edmonton Oilers', 'Edmonton'),
  F('FLA', 'Florida Panthers', 'Florida'),
  F('LAK', 'Los Angeles Kings', 'Los Angeles'),
  F('MIN', 'Minnesota Wild', 'Minnesota'),
  F('MTL', 'Montréal Canadiens', 'Montréal'),
  F('NSH', 'Nashville Predators', 'Nashville'),
  F('NJD', 'New Jersey Devils', 'New Jersey'),
  F('NYI', 'New York Islanders', 'New York'),
  F('NYR', 'New York Rangers', 'New York'),
  F('OTT', 'Ottawa Senators', 'Ottawa'),
  F('PHI', 'Philadelphia Flyers', 'Philadelphia'),
  F('PIT', 'Pittsburgh Penguins', 'Pittsburgh'),
  F('SJS', 'San Jose Sharks', 'San Jose'),
  F('SEA', 'Seattle Kraken', 'Seattle'),
  F('STL', 'St. Louis Blues', 'St. Louis'),
  F('TBL', 'Tampa Bay Lightning', 'Tampa Bay'),
  F('TOR', 'Toronto Maple Leafs', 'Toronto'),
  F('UTA', 'Utah Mammoth', 'Utah'),
  F('VAN', 'Vancouver Canucks', 'Vancouver'),
  F('VGK', 'Vegas Golden Knights', 'Vegas'),
  F('WSH', 'Washington Capitals', 'Washington'),
  F('WPG', 'Winnipeg Jets', 'Winnipeg'),
  F('ATL', 'Atlanta Thrashers', 'Atlanta', false),
  F('PHX', 'Phoenix Coyotes', 'Phoenix', false),
  F('ARI', 'Arizona Coyotes', 'Arizona', false),
];

const POR_ID = new Map(FRANQUICIAS.map((f) => [f.id, f]));

/** El nombre completo de una abreviatura, o la abreviatura si no se conoce (no se inventa uno). */
export const nombreDe = (id: string): string => POR_ID.get(id)?.nombre ?? id;
export const franquicia = (id: string): Franquicia | null => POR_ID.get(id) ?? null;

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Nombres que alguna casa usa y no salen de la tabla («Utah Hockey Club» fue el de 2024-25). */
const ALIAS: Record<string, string> = {
  'utah hockey club': 'UTA',
  'utah hc': 'UTA',
};

/**
 * El equipo ACTIVO al que se refiere un nombre de una casa, o null.
 *
 * Por orden: el nombre completo, un alias conocido, el apodo («Rangers»), y la ciudad SOLO si es de un
 * único equipo (con «New York» no se adivina).
 */
export function resolverEquipo(nombre: string): Franquicia | null {
  const n = norm(nombre);
  if (!n) return null;
  const activas = FRANQUICIAS.filter((f) => f.activa);
  const exacta = activas.find((f) => norm(f.nombre) === n);
  if (exacta) return exacta;
  if (ALIAS[n]) return POR_ID.get(ALIAS[n]) ?? null;
  const porApodo = activas.filter((f) => norm(f.nombre).endsWith(` ${n}`) || n.endsWith(norm(f.nombre).slice(norm(f.ciudad).length).trim()));
  if (porApodo.length === 1) return porApodo[0];
  const porCiudad = activas.filter((f) => norm(f.ciudad) === n || n.startsWith(`${norm(f.ciudad)} `));
  return porCiudad.length === 1 ? porCiudad[0] : null;
}
