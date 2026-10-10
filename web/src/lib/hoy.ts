// El panel de arriba («Qué se juega hoy» / «Cómo le fue al modelo»): lo que decide su estado
// inicial, aparte y sin React para poder probarlo.

/** El servidor manda el nombre del deporte en español; la pestaña, su id. */
export const NOMBRE_DE_ID: Record<string, string> = { football: 'Fútbol', basketball: 'Baloncesto', baseball: 'Béisbol', nfl: 'NFL', nhl: 'NHL', ufc: 'UFC', tennis: 'Tenis' };
export const ID_DE_NOMBRE: Record<string, string> = Object.fromEntries(Object.entries(NOMBRE_DE_ID).map(([id, nombre]) => [nombre, id]));

/**
 * ¿Abierto? La preferencia guardada manda ('1' / '0'). Sin ella, «hoy» nace abierto (es lo que
 * se viene a mirar) y los resultados plegados: una tabla de la semana entera encima de cada
 * pestaña empujaba la página hacia abajo para algo que se consulta de vez en cuando.
 */
export function panelAbierto(guardado: string | null, activa: 'hoy' | 'resultados'): boolean {
  if (guardado === '1') return true;
  if (guardado === '0') return false;
  return activa === 'hoy';
}

/** El filtro de deporte con el que nacen los resultados: el de la pestaña, si es de un deporte. */
export function deporteInicial(pestana: string | null): string | null {
  return pestana ? (NOMBRE_DE_ID[pestana] ?? null) : null;
}
