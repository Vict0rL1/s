// Errores de la interfaz que tienen arreglo conocido (D7 de la revisión del 8 de octubre).

/**
 * ¿Es el error de cargar un trozo diferido (una pantalla con `lazy`)? Pasa tras un despliegue:
 * la pestaña abierta pide `Ajustes-<hash viejo>.js`, que ya no existe. Cada navegador lo dice
 * a su manera.
 */
export function esErrorDeChunk(e: unknown): boolean {
  if (!e || typeof e !== 'object' || !('message' in e)) return false;
  const m = String((e as { message: unknown }).message);
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS|Failed to load module script/i.test(m);
}

/** La marca en sessionStorage: cuándo se recargó por un trozo que faltaba. */
export const MARCA_RECARGA = 'predictor.recargaPorChunk';
const VENTANA_MS = 60_000;

/** Recargar si no se ha hecho ya hace menos de un minuto (si no, sería un bucle). */
export function debeRecargar(marca: string | null, ahora: number = Date.now()): boolean {
  const t = Number(marca);
  return !marca || !Number.isFinite(t) || ahora - t > VENTANA_MS;
}
