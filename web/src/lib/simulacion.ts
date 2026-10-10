// Qué deportes tienen simulación de temporada (G9, lote G). La misma lista que el servidor
// (server/src/simulation/season.ts → DEPORTES_SIMULABLES; un test del servidor las ata): pedirla
// para la NHL o la UFC daba un 404 en la consola de cada ficha de equipo y de liga.
export const SIMULABLES = ['football', 'basketball', 'baseball', 'nfl'] as const;

export const tieneSimulacion = (sport: string): boolean => (SIMULABLES as readonly string[]).includes(sport);
