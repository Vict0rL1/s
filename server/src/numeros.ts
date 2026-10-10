// Números en el texto que escribe el servidor (G5 de la prueba en el navegador, 9 de octubre).
//
// El servidor escribe en español el titular, la «Lectura completa» y los avisos de fiabilidad, y
// la web los pinta tal cual. Antes cada deporte hacía `(p * 100).toFixed(1)` y pegaba el «%»:
// «41.6%» al lado del «41,6 %» de la web (web/src/lib/formato.ts). Aquí, la misma forma que allí:
// coma decimal, «−» para los negativos y el «%» separado por un espacio duro.

export const DURO = ' ';

/** Un número con `d` decimales: «2,29», «−3,6». Sin `d`, los decimales que traiga. */
export function num(x: number, d?: number): string {
  const s = d == null ? String(Math.abs(x)) : Math.abs(x).toFixed(d);
  return `${x < 0 && Number(s) !== 0 ? '−' : ''}${s.replace('.', ',')}`;
}

/** Una probabilidad (0–1) como porcentaje: «41,6 %». */
export const pct = (p: number, d = 1): string => `${num(p * 100, d)}${DURO}%`;

/** Un número con signo: «+2,8», «−3,6», «0,0». */
export const conSigno = (x: number, d = 1): string => `${x > 0 && Number(x.toFixed(d)) !== 0 ? '+' : ''}${num(x, d)}`;
