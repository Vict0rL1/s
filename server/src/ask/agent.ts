// El agente: varios pasos, y ni uno solo redactando números.
//
// ===========================================================================
// QUÉ HACE «AGENTE» AQUÍ, Y QUÉ NO
// ===========================================================================
// Un agente, en el sentido útil, es algo que DECIDE UNA SECUENCIA: mira la pregunta,
// elige una consulta, lee lo que sale, y con eso decide si hace falta otra. Eso es lo
// que hay aquí.
//
// Lo que NO hace, y es lo que separa esto de un chatbot: no escribe ni un dato. Los
// textos los componen las herramientas a partir de SQLite, igual que antes. El agente
// solo elige el ORDEN y el QUÉ. La diferencia importa porque el encargo original era
// comprobar datos, y un párrafo bien escrito con un número inventado es peor que no
// tener nada — suena igual esté bien o mal.
//
// ===========================================================================
// POR QUÉ ENCADENAR APORTA ALGO DE VERDAD
// ===========================================================================
// «¿Quién es mejor, Alcaraz o Sinner?» no tiene UNA respuesta en la base: tiene cuatro
// —el Elo de cada uno, su historial y lo que el modelo dice de un partido entre ellos— y
// cada una contesta a una parte. El enrutador de un solo paso tenía que elegir una y
// tirar las otras tres, y elegía la predicción, que es la que menos contexto da.
//
// Encadenar también deja ver el desacuerdo: el Elo puede favorecer a uno y el cara a
// cara al otro. Un asistente que enseña las dos cosas es más útil que uno que promedia
// en silencio y da un número.

import * as T from './tools.ts';
import type { Respuesta } from './tools.ts';
import { enrutar, responder } from './router.ts';

export interface Paso {
  herramienta: string;
  argumentos: string[];
  respuesta: Respuesta;
}

export interface RespuestaAgente {
  /** Una frase que resume, compuesta a partir de los pasos. Nunca inventa cifras. */
  texto: string;
  pasos: Paso[];
  /** Cómo se decidió el plan: útil para saber qué se puede esperar. */
  plan: string;
}

const limpia = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[¿?¡!.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Los dos nombres de una comparación, si la pregunta es una comparación. */
function dosNombres(q: string): [string, string] | null {
  const limpio = q
    .replace(/^(quien|quién) es (mejor|peor)( entre)?\s*/i, '')
    .replace(/^(compara|comparame|comparar|comparación|comparacion)( a| entre)?\s*/i, '')
    .replace(/^(analiza|analizame|dime todo( sobre)?|todo sobre)\s*/i, '')
    .trim();
  for (const sep of [' contra ', ' frente a ', ' vs ', ' y ', ' o ', ' - ']) {
    const i = limpio.indexOf(sep);
    if (i > 0) {
      const a = limpio.slice(0, i).trim();
      const b = limpio.slice(i + sep.length).trim();
      if (a.length >= 3 && b.length >= 3) return [a, b];
    }
  }
  return null;
}

/**
 * ¿Es esto una comparación, o una pregunta de un solo paso?
 *
 * El listón es alto a propósito: hace falta una palabra que pida comparar Y dos nombres.
 * Con solo los dos nombres, «Alcaraz contra Sinner» es una petición de predicción y
 * convertirla en cuatro consultas sería contestar algo que nadie preguntó.
 */
function esComparacion(q: string): boolean {
  return /\b(compara|comparar|comparacion|quien es mejor|quién es mejor|analiza|dime todo|todo sobre)\b/.test(q);
}

export function responderAgente(pregunta: string): RespuestaAgente {
  const q = limpia(pregunta);
  const par = esComparacion(q) ? dosNombres(q) : null;

  if (par) {
    const [a, b] = par;
    const pasos: Paso[] = [];
    const empuja = (herramienta: string, argumentos: string[], respuesta: Respuesta) =>
      pasos.push({ herramienta, argumentos, respuesta });

    // Paso 1 y 2: quiénes son. Si el primero no existe, no se hacen los otros tres:
    // encadenar sobre un jugador que no está en la base produce tres «no lo encuentro»
    // seguidos, que es ruido con aspecto de trabajo.
    const fa = T.jugador(a);
    empuja('jugador', [a], fa);
    if (!fa.filas) {
      return { texto: fa.texto, pasos, plan: 'comparación abortada: el primer jugador no está en la base' };
    }
    const fb = T.jugador(b);
    empuja('jugador', [b], fb);
    if (!fb.filas) {
      return { texto: fb.texto, pasos, plan: 'comparación abortada: el segundo jugador no está en la base' };
    }

    // Paso 3: el historial entre ellos.
    const h2h = T.caraACara(a, b);
    empuja('caraACara', [a, b], h2h);

    // Paso 4: y qué dice el modelo de un partido hoy.
    const pred = T.prediccion(a, b);
    empuja('prediccion', [a, b], pred);

    // El resumen se COMPONE de los textos que ya devolvieron las herramientas. No se
    // redacta nada nuevo con cifras: si aquí se escribiera «X está claramente por
    // delante», esa frase sería una opinión sin medir colada entre datos medidos.
    return {
      texto: `${h2h.texto} ${pred.texto}`,
      pasos,
      plan: 'comparación: ficha de cada uno, cara a cara y predicción — cuatro consultas',
    };
  }

  // Un solo paso: el enrutador de siempre. Se reutiliza en vez de duplicar sus reglas.
  // Import estático y no `require`: este proyecto es ESM, y un `require` aquí compila
  // pero revienta al ejecutarse. No hay ciclo — `router.ts` no importa a este fichero.
  const r = responder(pregunta);
  return {
    texto: r.texto,
    pasos: [{ herramienta: r.intencion.herramienta, argumentos: r.intencion.argumentos, respuesta: r }],
    plan: 'una sola consulta',
  };
}

/** Para que `enrutar` siga exportándose desde aquí a quien lo importe. */
export { enrutar };
