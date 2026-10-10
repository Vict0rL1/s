// Cargas de las pestañas de deporte y enlaces profundos (D8 de la revisión del 8 de octubre).

/**
 * El `?dia=` con el que seguir. Mientras carga (o antes de la primera carga) no hay días que
 * mirar, y los que hay pueden ser de la liga anterior: el día se conserva. Solo cuando la carga
 * terminó y ese día no existe se quita (un día vacío parecería «no hay partidos»).
 */
export function conservarDia(dia: string | null, dias: string[], cargando: boolean): string | null {
  if (!dia) return null;
  if (cargando || dias.length === 0) return dia;
  return dias.includes(dia) ? dia : null;
}

/** Numera las peticiones: solo la última puede escribir su respuesta. */
export function contadorDePeticiones(): { nueva: () => number; esUltima: (n: number) => boolean } {
  let ultima = 0;
  return {
    nueva: () => ++ultima,
    esUltima: (n) => n === ultima,
  };
}

/**
 * El torneo con el que seguir (G2, lote G). Mientras la lista de torneos no ha llegado, el del
 * enlace se conserva: antes se veía la lista vacía, se ponía `null` y luego el primero, y
 * `/tenis?torneo=wimbledon` acababa en el Open de Australia.
 */
export function torneoValido(actual: string | null, lista: { id: string }[], cargada: boolean): string | null {
  if (!cargada) return actual;
  if (lista.length === 0) return null;
  return actual && lista.some((t) => t.id === actual) ? actual : lista[0].id;
}

/**
 * Las filas que se pintan: solo las de la liga elegida (G3, lote G). Al cambiar de liga, las de
 * la anterior siguen en el estado hasta que llega la respuesta, y se veían bajo la nueva.
 */
export function filasDeLaLiga<T>(filas: T[], ligaDe: (f: T) => string | null | undefined, liga: string | null): T[] {
  if (!liga) return [];
  return filas.filter((f) => ligaDe(f) === liga);
}
