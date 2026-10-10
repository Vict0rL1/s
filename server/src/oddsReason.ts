// Por qué un deporte está enseñando cuotas de demostración.
//
// ===========================================================================
// «QUÉ» NO ES «POR QUÉ», Y SOLO SE GUARDABA EL QUÉ
// ===========================================================================
// Cada deporte guarda `*_odds_source = 'fixture' | 'live'`, que dice QUE está en
// demostración. Las causas son cuatro, piden cosas distintas, y desde fuera se parecen
// todas:
//
//   sin_clave      falta ODDS_API_KEY. Se arregla poniéndola.
//   fuente_falla   la clave está, pero el proveedor no contestó: cuota agotada, clave
//                  inválida o sin internet. Volver a poner la clave no arregla nada.
//   sin_ligas      el proveedor SÍ contestó y ofreció competiciones, pero ninguna de las
//                  que este proyecto sabe traducir. Nada que arreglar en el .env: o no
//                  hay liga en juego, o la clave de deporte del proveedor cambió.
//   sin_eventos    reconocimos la liga y no había ni un partido con precio. Entre
//                  jornadas y entre torneos es lo normal.
//   presupuesto    NO SE LLEGÓ A PREGUNTAR. La app se frena sola para no quemar el plan
//                  del mes de golpe, y esta vez el freno saltó.
//
// `presupuesto` es la que faltaba, y su ausencia costó cara. El guardia de presupuesto
// devolvía «cero eventos», que es indistinguible de «pregunté y no había ninguno», así
// que la app decía «no hay partidos con precio, entre jornadas es normal, prueba en unos
// días» cuando lo que pasaba era que se había frenado ella sola. Eso manda a esperar a
// que se arregle algo que NO se arregla esperando: al día siguiente vuelve a frenarse.
// Un freno propio nunca puede presentarse como una condición del mundo exterior.
//
// `sin_ligas` es la que más falta hacía y la que era imposible de diagnosticar: la
// ingesta de fútbol hace `if (!league) continue;` sobre cada competición que el proveedor
// lista, así que si ninguna casa las ofrece bajo la clave que conocemos, las 140 filas
// caen a demostración sin una sola línea de log. Por eso esta causa guarda ADEMÁS las
// claves que el proveedor ofreció, que es el dato con el que se arregla.

import { setMeta, getMeta } from './db.ts';

export type OddsReason =
  | 'sin_clave'
  | 'fuente_falla'
  | 'sin_ligas'
  | 'sin_eventos'
  | 'presupuesto'
  | null;

/** Los prefijos de meta de cada deporte. El tenis no lleva, por ser el primero. */
export type SportPrefix = '' | 'fb_' | 'bb_' | 'bsb_' | 'naf_' | 'nhl_' | 'ufc_';

const KEY = (p: SportPrefix): string => `${p}odds_fallback_reason`;
const DETAIL = (p: SportPrefix): string => `${p}odds_fallback_detail`;

/**
 * Guarda la causa, o la borra cuando la fuente vuelve a funcionar.
 *
 * El borrado importa tanto como el guardado: un detalle de error que sobrevive a un
 * refresco correcto hace que la pantalla enseñe el mensaje de un fallo que ya no ocurre,
 * y eso manda a arreglar algo que ya está bien.
 */
export function recordOddsReason(
  prefix: SportPrefix,
  reason: OddsReason,
  detail = '',
): void {
  setMeta(KEY(prefix), reason ?? '');
  setMeta(DETAIL(prefix), reason ? detail.slice(0, 240) : '');
}

export function readOddsReason(prefix: SportPrefix): { reason: OddsReason; detail: string } {
  const r = (getMeta(KEY(prefix)) || null) as OddsReason;
  return { reason: r, detail: getMeta(DETAIL(prefix)) || '' };
}

/** En una línea, para el diagnóstico y para la pantalla. */
export const REASON_TEXT: Record<NonNullable<OddsReason>, string> = {
  sin_clave: 'no hay ODDS_API_KEY',
  fuente_falla: 'el proveedor no contestó (cuota agotada, clave inválida o sin red)',
  sin_ligas: 'el proveedor no ofrece ninguna de las ligas configuradas ahora mismo',
  sin_eventos: 'no hay ningún partido con precio publicado',
  presupuesto: 'la app se frenó sola para no gastar el plan del mes de golpe (no llegó a preguntar)',
};

// ---------------------------------------------------------------------------
// La evidencia por competición, y la causa que se deduce de ella
// ---------------------------------------------------------------------------
import type { KeyOutcome } from './oddsApi.ts';

const KEYS = (p: SportPrefix): string => `${p}odds_keys`;

/** Lo que contestó cada competición en la última descarga. Lo lee `npm run doctor`. */
export function recordKeyOutcomes(prefix: SportPrefix, outcomes: KeyOutcome[]): void {
  setMeta(KEYS(prefix), JSON.stringify(outcomes));
}

export function readKeyOutcomes(prefix: SportPrefix): KeyOutcome[] {
  try {
    const raw = getMeta(KEYS(prefix));
    return raw ? (JSON.parse(raw) as KeyOutcome[]) : [];
  } catch {
    return [];
  }
}

/**
 * La causa de que un deporte acabe sin cuotas reales, deducida de la evidencia.
 *
 * Una sola regla para los cinco deportes. Antes cada ingesta la decidía a su manera, y
 * el tenis, por ejemplo, llamaba `sin_ligas` a «todas las peticiones fallaron con 401».
 *
 *   hay partidos con precio                → null (no hace falta causa)
 *   no se preguntó a nada                  → sin_ligas (el llamante pone qué ofrecía el proveedor)
 *   todo lo preguntado se frenó            → presupuesto
 *   algo falló y nada salió bien           → fuente_falla, CON el error de cada clave
 *   algo salió bien pero sin precio        → sin_eventos, con cuántos eventos y casas trajo cada una
 */
export function decideReason(
  outcomes: KeyOutcome[],
  conPrecio: number,
): { reason: OddsReason; detail: string } {
  if (conPrecio > 0) return { reason: null, detail: '' };
  if (outcomes.length === 0) return { reason: 'sin_ligas', detail: '' };
  const ok = outcomes.filter((o) => o.ok);
  const frenadas = outcomes.filter((o) => o.kind === 'presupuesto');
  const fallos = outcomes.filter((o) => !o.ok && o.kind !== 'presupuesto');
  const lista = (os: KeyOutcome[]): string =>
    os
      .slice(0, 12)
      .map((o) =>
        o.ok
          ? `${o.key}=${o.eventos} eventos (${o.conPrecio} con precio, ${o.casas} casas)`
          : `${o.key}: ${o.message ?? o.kind}`,
      )
      .join(' · ') + (os.length > 12 ? ' …' : '');
  if (ok.length === 0 && fallos.length === 0) {
    return { reason: 'presupuesto', detail: frenadas[0]?.message ?? '' };
  }
  if (ok.length === 0) return { reason: 'fuente_falla', detail: lista(fallos) };
  return {
    reason: 'sin_eventos',
    detail: lista(ok) + (fallos.length ? ` · además fallaron: ${lista(fallos)}` : ''),
  };
}
