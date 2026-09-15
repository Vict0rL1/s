// ¿WebSocket o sondeo? Se comprueba, no se supone.
//
// ===========================================================================
// POR QUÉ ESTO ES UNA SONDA Y NO UN CLIENTE DE WEBSOCKET
// ===========================================================================
// El encargo dice «WebSockets donde la API los ofrezca». La parte importante de esa
// frase es «donde los ofrezca», y averiguarlo es trabajo, no una suposición.
//
// Escribir un cliente de WebSocket contra un endpoint que no existe es peor que no
// escribirlo: parece que la funcionalidad está, falla en tiempo de ejecución en casa de
// otro, y el fallo se confunde con un problema de red. Así que aquí hay una SONDA que
// intenta el apretón de manos de verdad y guarda lo que contestó el servidor, con
// fecha. Si algún día ese endpoint existe, la sonda lo detecta y este fichero es donde
// se enchufa el cliente.
//
// ===========================================================================
// LO QUE SE SABE HOY
// ===========================================================================
// The Odds API v4 es REST: se piden eventos por HTTP y cada respuesta trae
// `x-requests-remaining`. No publica un endpoint de WebSocket ni de streaming en su
// guía. El entorno donde se desarrolló esto no alcanza ni su API ni su documentación,
// así que ESA afirmación no está verificada aquí — está verificada por la sonda, en la
// máquina de quien la corra, y el resultado se guarda con su fecha.
//
// `npm run latency -- --probe` la ejecuta. Mientras no se haya corrido, el estado es
// «sin comprobar», que NO es lo mismo que «no hay».

import { getMeta, setMeta } from '../db.ts';

export type TransportKind = 'websocket' | 'sondeo';

export interface ProbeResult {
  /** Qué transporte se va a usar. Sin respuesta concluyente, 'sondeo' (el seguro). */
  transport: TransportKind;
  /**
   * Si la comprobación llegó a alguna conclusión.
   *
   * ===========================================================================
   * «NO PUDE COMPROBARLO» NO ES «NO HAY»
   * ===========================================================================
   * La primera versión de esta sonda devolvía «no hay WebSocket» cuando los tres
   * intentos fallaban por error de conexión — que es exactamente lo que pasa en una
   * red que no alcanza el host. Eso es un veredicto sobre la RED disfrazado de
   * veredicto sobre la API, y es justo el tipo de confusión que este módulo existe
   * para no cometer: un 404 dice que ahí no hay nada, y un «fetch failed» no dice
   * absolutamente nada sobre lo que hay al otro lado.
   */
  conclusive: boolean;
  /** Lo que contestó el servidor al intentar el apretón de manos. */
  detail: string;
  /** Cuándo se comprobó. Sin fecha, un «no hay» de hace un año no vale nada. */
  checkedAt: string;
  /** Los endpoints que se intentaron, para poder repetir la prueba a mano. */
  tried: { url: string; result: string; answered?: boolean }[];
}

const KEY = 'latency:transport_probe';

export function lastProbe(): ProbeResult | null {
  const raw = getMeta(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ProbeResult;
  } catch {
    return null;
  }
}

/**
 * Intentar el apretón de manos de WebSocket contra los sitios donde estaría, si
 * estuviera.
 *
 * No usa una librería de WebSocket a propósito: lo único que hace falta saber es si el
 * servidor responde `101 Switching Protocols`, y eso se ve en una petición HTTP normal
 * con las cabeceras de upgrade. Sin dependencia nueva y sin ambigüedad — un 404 o un
 * 400 son respuestas claras.
 */
export async function probeWebSocket(apiKey: string | undefined): Promise<ProbeResult> {
  const candidates = [
    'https://api.the-odds-api.com/v4/stream',
    'https://api.the-odds-api.com/v4/ws',
    'https://stream.the-odds-api.com/v4',
  ];
  const tried: { url: string; result: string; answered: boolean }[] = [];

  for (const base of candidates) {
    const url = apiKey ? `${base}?apiKey=${encodeURIComponent(apiKey)}` : base;
    try {
      const res = await fetch(url, {
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          // Cualquier valor de 16 bytes en base64 sirve para el apretón de manos.
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        },
      });
      if (res.status === 101) {
        return {
          transport: 'websocket',
          conclusive: true,
          detail: `${base} respondió 101 Switching Protocols: hay WebSocket.`,
          checkedAt: new Date().toISOString(),
          tried: [...tried, { url: base, result: '101 Switching Protocols' }],
        };
      }
      tried.push({ url: base, result: `HTTP ${res.status}`, answered: true });
    } catch (e) {
      tried.push({
        url: base,
        result: `no se pudo conectar: ${(e as Error).message}`,
        answered: false,
      });
    }
  }

  // ¿Contestó ALGUNO? Un solo código HTTP basta para saber que el host está vivo y que
  // lo que no está es el endpoint. Si no contestó ninguno, lo único demostrado es que
  // no hay ruta hasta allí.
  const anyAnswered = tried.some((t) => t.answered);
  return {
    transport: 'sondeo',
    conclusive: anyAnswered,
    detail: anyAnswered
      ? 'El host responde y ninguno de los endpoints candidatos hizo el upgrade a ' +
        'WebSocket. El proveedor es REST y hay que sondear: la latencia de origen la ' +
        'fija la cadencia, no la red.'
      : 'Ningún intento llegó a contestar, así que esto mide la red de ' +
        'esta máquina y no lo que ofrece la API. Se sondea (que funciona siempre) y ' +
        'conviene repetir la sonda desde una red que alcance api.the-odds-api.com.',
    checkedAt: new Date().toISOString(),
    tried,
  };
}

export function storeProbe(p: ProbeResult): void {
  setMeta(KEY, JSON.stringify(p));
}

/**
 * Qué transporte usar ahora mismo.
 *
 * Sin sonda previa devuelve 'sondeo' — que es lo correcto por seguridad: sondear
 * funciona siempre, y suponer un WebSocket que no existe deja la app sin datos.
 */
export function currentTransport(): { kind: TransportKind; note: string } {
  const p = lastProbe();
  if (!p) {
    return {
      kind: 'sondeo',
      note: 'Sin comprobar. `npm run latency -- --probe` lo verifica; hasta entonces se sondea.',
    };
  }
  const days = (Date.now() - Date.parse(p.checkedAt)) / 86400_000;
  return {
    kind: p.transport,
    note:
      p.detail +
      (!p.conclusive
        ? ` (intentado hace ${days.toFixed(0)} días, sin conclusión)`
        : days > 90
          ? ` (comprobado hace ${days.toFixed(0)} días: convendría repetirlo)`
          : ` (comprobado hace ${days.toFixed(0)} días)`),
  };
}
