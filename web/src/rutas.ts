// Las rutas de la app (Fase 5.2): URLs reales que se pueden compartir. Una sola tabla para la
// navegación, los enlaces y el mapa pestaña ↔ ruta; los filtros van en la query y se
// restauran al abrir el enlace (ver lib/rutas.ts).

import type { SportId } from './lib/theme';

/** La ruta base de cada pestaña. */
export const RUTA_DE_PESTANA: Record<SportId, string> = {
  picks: '/destacados',
  football: '/futbol',
  basketball: '/baloncesto',
  baseball: '/beisbol',
  nfl: '/nfl',
  nhl: '/nhl',
  ufc: '/ufc',
  tennis: '/tenis',
  bets: '/apuestas',
  trust: '/confianza',
};

export const PESTANAS: SportId[] = ['picks', 'football', 'basketball', 'baseball', 'nfl', 'nhl', 'ufc', 'tennis', 'bets', 'trust'];
export const DEPORTES: SportId[] = ['football', 'basketball', 'baseball', 'nfl', 'nhl', 'ufc', 'tennis'];

/** La pestaña a la que pertenece una ruta, o null si es una página fuera de pestañas. */
export function pestanaDeRuta(pathname: string): SportId | null {
  const primera = '/' + (pathname.split('/')[1] ?? '');
  for (const [id, ruta] of Object.entries(RUTA_DE_PESTANA) as [SportId, string][]) if (ruta === primera) return id;
  // Las páginas de detalle cuelgan de su deporte en la navegación.
  const seg = pathname.split('/');
  if ((seg[1] === 'partido' || seg[1] === 'equipo' || seg[1] === 'liga') && seg[2]) {
    const s = seg[2] as SportId;
    return DEPORTES.includes(s) ? s : null;
  }
  if (seg[1] === 'jugador') return 'tennis';
  if (seg[1] === 'luchador') return 'ufc';
  return null;
}

export const rutaPartido = (sport: string, id: string) => `/partido/${sport}/${encodeURIComponent(id)}`;
export const rutaEquipo = (sport: string, league: string, id: string) => `/equipo/${sport}/${encodeURIComponent(league)}/${encodeURIComponent(id)}`;
export const rutaJugador = (tour: string, id: string | number) => `/jugador/${encodeURIComponent(tour)}/${id}`;
export const rutaLuchador = (id: string) => `/luchador/${encodeURIComponent(id)}`;
export const rutaLiga = (sport: string, league: string) => `/liga/${sport}/${encodeURIComponent(league)}`;
export const RUTA_AJUSTES = '/ajustes';
export const RUTA_DIAGNOSTICO = '/confianza/diagnostico';
export const RUTA_GLOSARIO = '/glosario';
export const RUTA_LABORATORIO = '/apuestas/laboratorio';
export const RUTA_LINEAS = '/apuestas/lineas';
export const RUTA_ARCHIVO = '/confianza/archivo';

const CLAVE_ULTIMA = 'predictor.sport';

/** La pestaña que estaba abierta la última vez (la raíz redirige ahí). */
export function ultimaPestana(): SportId {
  try {
    const v = localStorage.getItem(CLAVE_ULTIMA);
    if (v && PESTANAS.includes(v as SportId)) return v as SportId;
  } catch {
    // Navegación privada: la primera pestaña vale.
  }
  return 'picks';
}
export function recordarPestana(id: SportId): void {
  try {
    localStorage.setItem(CLAVE_ULTIMA, id);
  } catch {
    // No poder recordarlo no impide navegar.
  }
}
