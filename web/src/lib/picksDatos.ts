// Tablas de «Lo que el modelo destacaría» (lib/picks.ts): avisos por deporte y tasas base del
// mercado con las que se ordena. Partido de picks.ts en la Fase 7 (ningún fichero de lib/ por encima de ~400 líneas).

import type { Clave } from '../i18n';

/**
 * What the reader has to know before acting on any of this, per sport.
 *
 * Written from the backtests in this repo, not from optimism. The NFL line is the
 * uncomfortable one and it is the most important one on the page.
 *
 * Son claves del catálogo (seguimiento i18n): el texto, en es.ts y en.ts.
 */
export const CAVEATS: Record<string, Clave> = {
  football: 'aviso.football',
  baseball: 'aviso.baseball',
  basketball: 'aviso.basketball',
  nfl: 'aviso.nfl',
  nhl: 'aviso.nhl',
  ufc: 'aviso.ufc',
  tennis: 'aviso.tennis',
};

/** Las de segunda división. Los mercados que no dependen del escalón no están. */
export const BASE_RATE_TIER2: Record<string, number> = {
  '1X2': 0.427,
  'Doble oportunidad': 0.712,
  'Ambos marcan': 0.511,
  'Total de goles': 0.463,
};

export const BASE_RATE: Record<string, number> = {
  // Football, primera división
  '1X2': 0.435,               // el local gana
  'Doble oportunidad': 0.685, // 1X; X2 es 0.565, se usa la más común
  'Ambos marcan': 0.538,
  'Total de goles': 0.530,    // +2.5
  // Basketball / baseball / NFL winner markets, home side
  Ganador: 0.55,
  Hándicap: 0.5,              // una línea justa es 50/50 por construcción
  'Línea de carreras': 0.5,
  'Total de puntos': 0.5,
  'Total de carreras': 0.5,
};

/**
 * Las segundas divisiones que la app ingiere.
 *
 * Una lista explícita y no una heurística sobre el nombre: "Championship" no lleva
 * ningún "2" y "LaLiga Hypermotion" tampoco, así que cualquier regla por el texto
 * fallaría justo en las dos ligas con más partidos de este grupo.
 */
export const TIER2 = new Set(['championship', 'laliga2', 'bundesliga2', 'serieb', 'ligue2']);
