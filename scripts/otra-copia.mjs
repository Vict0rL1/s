// ¿El puerto ocupado es OTRA COPIA DE ESTA APP?
//
// ===========================================================================
// POR QUÉ IMPORTA
// ===========================================================================
// `npm run dev` busca otro puerto cuando el suyo está ocupado (ver dev.mjs). Con un
// programa cualquiera en el 7373 eso es lo correcto. Con otra copia de ESTA app —la de
// otra carpeta, o una que se quedó abierta en otra terminal— es una trampa: la nueva
// arranca en el 7376, la persona abre http://localhost:7373 como siempre y ve LA OTRA.
// Otra versión, otra base, quizá sin su clave de cuotas. Pasó de verdad: «sigue sin
// haber cuotas» con la clave bien puesta, porque la página abierta era la copia vieja.
//
// Así que antes de moverse se pregunta al puerto quién es, y si es esta app, se para y
// se dice cómo cerrarla.
//
// ===========================================================================
// CÓMO SE RECONOCE
// ===========================================================================
// Dos firmas, cualquiera vale, las dos sin contraseña y presentes desde hace muchas
// versiones (también en la copia vieja que uno tenga por ahí):
//   · la página: el `<title>` de web/index.html empieza por «Sports Predictor» (lo sirve
//     Vite en el puerto web y el propio servidor cuando hay web/dist);
//   · la API: GET /ready devuelve JSON con `migraciones` y `trabajos` (200 o 503).
//
// ===========================================================================
// EL COMANDO PARA CERRARLA
// ===========================================================================
// `lsof -ti :7373` a secas lista TAMBIÉN a los clientes conectados a ese puerto —el
// navegador que tiene la app abierta— y `| xargs kill` los mataría con ella. Con
// `-sTCP:LISTEN` solo sale el proceso que ESCUCHA. Comprobado: sin el filtro salen el
// servidor y el cliente; con él, solo el servidor.

const FIRMA_TITULO = '<title>Sports Predictor';

/**
 * ¿Responde en `port` esta app? Nunca lanza: sin respuesta, o con otra cosa, es «no».
 * @param {number} port
 * @param {{ fetch?: typeof fetch, timeoutMs?: number, host?: string }} [opts]
 * @returns {Promise<boolean>}
 */
export async function pareceEstaApp(port, opts = {}) {
  const f = opts.fetch ?? globalThis.fetch;
  const host = opts.host ?? '127.0.0.1';
  const pedir = async (ruta) => {
    try {
      const r = await f(`http://${host}:${port}${ruta}`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 800) });
      return { status: r.status, cuerpo: await r.text() };
    } catch {
      return null;
    }
  };
  const pagina = await pedir('/');
  if (pagina && pagina.cuerpo.includes(FIRMA_TITULO)) return true;
  const listo = await pedir('/ready');
  if (!listo) return false;
  try {
    const j = JSON.parse(listo.cuerpo);
    return !!j && typeof j === 'object' && typeof j.migraciones === 'string' && typeof j.trabajos === 'string';
  } catch {
    return false;
  }
}

/**
 * El comando que cierra SOLO lo que escucha en esos puertos.
 * @param {number[]} puertos
 * @param {string} [plataforma]
 * @returns {string[]}
 */
export function comandoCerrar(puertos, plataforma = process.platform) {
  const ps = [...new Set(puertos)].sort((a, b) => a - b);
  if (plataforma === 'win32') {
    return [
      ...ps.map((p) => `netstat -ano | findstr LISTENING | findstr :${p}`),
      'taskkill /PID <el número del final de esa línea> /F',
    ];
  }
  const rango = ps.length === 1 ? String(ps[0]) : ps.at(-1) - ps[0] === ps.length - 1 ? `${ps[0]}-${ps.at(-1)}` : ps.join(',');
  return [`lsof -ti tcp:${rango} -sTCP:LISTEN | xargs kill`];
}

/**
 * El aviso, entero.
 * @param {{ web: number | null, api: number | null, plataforma?: string }} o
 * @returns {string}
 */
export function mensajeOtraCopia({ web, api, plataforma = process.platform }) {
  const puertos = [web, api].filter((p) => p != null);
  const donde = web != null ? `http://localhost:${web}` : `el puerto ${api}`;
  return [
    '',
    `❌ Ya hay otra copia de esta app abierta en ${donde}.`,
    '   Si arrancara, esta iría a otro puerto y en esa dirección seguirías viendo LA OTRA',
    '   (quizá de otra carpeta: otra versión, otra base, a lo mejor sin tu clave de cuotas).',
    '',
    '   Ciérrala con Ctrl+C en su terminal, o desde aquí:',
    ...comandoCerrar(puertos, plataforma).map((c) => `     ${c}`),
    '   y vuelve a ejecutar  npm run dev',
    '',
    '   ¿Las dos a la vez, a propósito?  npm run dev -- --junto',
    '',
  ].join('\n');
}
