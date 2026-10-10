// En qué dirección escuchan los servidores de desarrollo (Vite, y la sonda de puertos de dev.mjs).
//
// La misma regla que `hostDeEscucha` en server/src/auth/mode.ts (la imagen de producción no lleva
// scripts/, así que el servidor tiene su copia; un test comprueba que dicen lo mismo):
//
//   · HOST, si se fija a mano.
//   · 0.0.0.0 (toda la red local) en producción, con APP_AUTH=on (hay contraseña) o con
//     DEV_LAN=on (abrirla sin contraseña, a sabiendas: para probar en el móvil).
//   · 127.0.0.1 en lo demás. Antes era siempre 0.0.0.0, y con la puerta apagada —lo normal en
//     el portátil— cualquiera en la misma wifi abría la app y el registro de apuestas (D15 de la
//     revisión del 8 de octubre de 2026).

const si = (v) => ['on', '1', 'true', 'si', 'sí'].includes(String(v ?? '').trim().toLowerCase());

/** @param {Record<string, string | undefined>} entorno */
export function hostDeEscucha(entorno = process.env) {
  const fijo = entorno.HOST?.trim();
  if (fijo) return fijo;
  if (entorno.NODE_ENV === 'production' || entorno.APP_AUTH?.trim().toLowerCase() === 'on' || si(entorno.DEV_LAN)) return '0.0.0.0';
  return '127.0.0.1';
}

/** ¿Se ve desde la red local? (para decir o no la dirección del móvil). */
export const abiertaALaRed = (entorno = process.env) => hostDeEscucha(entorno) !== '127.0.0.1';
