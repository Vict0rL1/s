// Números en pantalla, con Intl y en el idioma activo (D5 de la revisión del 8 de octubre).
//
// Antes cada componente hacía `(p * 100).toFixed(1) + '%'`: punto decimal en español, el «%»
// pegado (o separado por un espacio normal que se parte de línea), y el banco de papel con un
// «$» que nadie eligió. Aquí vive una sola forma de escribirlos. El idioma lo fija el proveedor
// de i18n al pintar (`fijarIdiomaFormato`), así que los ~180 sitios que llaman a `pct` no
// necesitan recibirlo.
//
// Sin React a propósito: los tests de la web cargan este módulo tal cual.

export type IdiomaFormato = 'es' | 'en';

let activo: IdiomaFormato = 'es';

/** El idioma con el que formatean `pct`, `num` y `pp`. Lo llama el proveedor de i18n. */
export function fijarIdiomaFormato(i: IdiomaFormato): void {
  activo = i;
}

export const localeFormato = (i: IdiomaFormato = activo) => (i === 'en' ? 'en-GB' : 'es-ES');

const cache = new Map<string, Intl.NumberFormat>();
function nf(i: IdiomaFormato, estilo: 'percent' | 'decimal', d: number): Intl.NumberFormat {
  const k = `${i}|${estilo}|${d}`;
  let f = cache.get(k);
  if (!f) {
    f = new Intl.NumberFormat(localeFormato(i), { style: estilo, minimumFractionDigits: d, maximumFractionDigits: d });
    cache.set(k, f);
  }
  return f;
}

/** Una probabilidad (0–1) como porcentaje: «52,3 %» (espacio duro) en español, «52.3%» en inglés. */
export function pct(p: number, d = 1, i: IdiomaFormato = activo): string {
  return nf(i, 'percent', d).format(p).replace('-', '−');
}

/** Un número con `d` decimales y la coma o el punto del idioma. */
export function num(x: number, d = 2, i: IdiomaFormato = activo): string {
  return nf(i, 'decimal', d).format(x).replace('-', '−');
}

/** Puntos porcentuales con signo: «+2,4 pp». */
export function pp(x: number, d = 1, i: IdiomaFormato = activo): string {
  return `${x > 0 ? '+' : x < 0 ? '−' : ''}${num(Math.abs(x), d, i)} pp`;
}

/**
 * Dinero del banco de papel o del registro: con Intl y SIN símbolo. El proyecto no inventa
 * moneda (ver lib/bets.ts: los mismos números valen para euros, pesos o unidades).
 */
export function dinero(n: number, i: IdiomaFormato = activo): string {
  return num(n, 2, i);
}
