// Los cinco deportes, UNA vez. Antes la lista vivía copiada en la evaluación, la
// validación, el versionado y la ficha de backtests; añadir un deporte obligaba a
// encontrar todas las copias, y la que se olvidara lo dejaba fuera sin avisar.

export const SPORT_IDS = ['tennis', 'football', 'basketball', 'baseball', 'nfl'] as const;

export type SportId = (typeof SPORT_IDS)[number];

/** Resultados posibles del mercado principal (h2h). Solo el fútbol tiene empate que se apuesta. */
export const OUTCOMES: Record<SportId, number> = { tennis: 2, football: 3, basketball: 2, baseball: 2, nfl: 2 };

export function isSportId(s: string): s is SportId {
  return (SPORT_IDS as readonly string[]).includes(s);
}
