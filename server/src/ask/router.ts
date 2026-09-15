// De la pregunta a la consulta. Nunca de la pregunta a la respuesta.
//
// ===========================================================================
// POR QUÉ ESTO FUNCIONA SIN NINGUNA IA
// ===========================================================================
// La tentación es mandar la pregunta a un modelo y enseñar lo que conteste. Eso da un
// asistente que habla muy bien y que, cuando se equivoca, se equivoca exactamente igual
// de bien — y aquí el encargo era COMPROBAR datos, o sea, lo contrario.
//
// El reparto correcto es más aburrido y mucho más útil: entender la pregunta es una
// tarea de clasificación con seis salidas, y para seis salidas unas expresiones
// regulares bastan. El resultado no depende de ninguna clave, no cuesta dinero, no
// tarda, funciona sin internet y —lo que importa— es DETERMINISTA: la misma pregunta da
// siempre la misma consulta, y la consulta da siempre el número que hay en la base.
//
// ===========================================================================
// DÓNDE ENCAJARÍA UN MODELO, SI SE QUISIERA
// ===========================================================================
// En este fichero y solo aquí: sustituyendo `enrutar` por una llamada con herramientas,
// donde el modelo elige `herramienta` y `argumentos` y NADA más. El contrato de salida
// —`Intencion`— es el mismo, así que `tools.ts` no se entera y las respuestas siguen
// saliendo de SQLite. Lo que un modelo aportaría es tolerancia a preguntas raras; lo
// que NO debe aportar nunca es el contenido de la respuesta.

import * as T from './tools.ts';
import type { Respuesta } from './tools.ts';

export interface Intencion {
  herramienta: 'jugador' | 'caraACara' | 'prediccion' | 'clasificacion' | 'estadoDatos' | 'precision' | 'ninguna';
  argumentos: string[];
}

/** Quita acentos y signos para que «cómo» y «como» sean la misma palabra. */
const limpia = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[¿?¡!.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Corta «X contra Y» en sus dos lados.
 *
 * Los separadores van del más largo al más corto a propósito: con «vs» antes que «v»,
 * «Alcaraz v Sinner» se parte bien, y al revés «vs» dejaría una «s» pegada al segundo
 * nombre. Cosas así son la mitad de los fallos de un enrutador por texto.
 */
function dosLados(q: string): [string, string] | null {
  for (const sep of [' contra ', ' frente a ', ' vs ', ' vs. ', ' v ', ' - ', ' x ']) {
    const i = q.indexOf(sep);
    if (i > 0) {
      const a = q.slice(0, i).trim();
      const b = q.slice(i + sep.length).trim();
      if (a && b) return [a, b];
    }
  }
  return null;
}

/** Quita el arranque de la pregunta para quedarse con los nombres. */
function sinPreambulo(q: string): string {
  return q
    .replace(/^(quien|quién) (gana|ganaria|ganaría|ganara|va a ganar)( entre)?\s*/i, '')
    .replace(/^(que|qué) (dice el modelo|probabilidad|posibilidades)( de| sobre| para)?\s*/i, '')
    .replace(/^(cara a cara|h2h|historial|enfrentamientos?)( de| entre)?\s*/i, '')
    .replace(/^(prediccion|predicción|pronostico|pronóstico)( de| para| sobre)?\s*/i, '')
    .replace(/^(como|cómo) (va|esta|está|quedaria|quedaría)\s*/i, '')
    .replace(/^(dame|dime|muestrame|muéstrame|ensename|enséñame)( el| la| los| las)?\s*/i, '')
    .replace(/\s+(en|sobre) (tierra|arcilla|hierba|cesped|césped|pista dura|dura|hard|clay|grass)\s*$/i, '')
    .trim();
}

export function enrutar(pregunta: string): Intencion {
  const q = limpia(pregunta);
  if (!q) return { herramienta: 'ninguna', argumentos: [] };

  // El orden importa: lo más específico primero. «cara a cara de A contra B» contiene
  // «contra», así que si la predicción fuera antes se lo quedaría ella.
  if (/\b(cara a cara|h2h|enfrentamientos?|historial|se han enfrentado)\b/.test(q)) {
    const l = dosLados(sinPreambulo(q));
    if (l) return { herramienta: 'caraACara', argumentos: l };
  }

  if (/\b(estado|datos|guardado|cuantos partidos hay|que hay|actualizad|al dia|al día|cuotas)\b/.test(q)) {
    return { herramienta: 'estadoDatos', argumentos: [] };
  }

  if (/\b(precision|precisión|acierta|acierto|fiable|backtest|log loss|brier|que tal predice)\b/.test(q)) {
    return { herramienta: 'precision', argumentos: [] };
  }

  if (/\b(clasificacion|clasificación|ranking|mejores|top|los primeros)\b/.test(q)) {
    const n = Number(q.match(/\b(\d{1,2})\b/)?.[1] ?? 10);
    const tour = /\bwta\b|femenin/.test(q) ? 'wta' : 'atp';
    return { herramienta: 'clasificacion', argumentos: [String(n), tour] };
  }

  // Predicción: dos nombres separados por algo. Va después de las anteriores porque un
  // «contra» suelto es la señal más débil de todas.
  const lados = dosLados(sinPreambulo(q));
  if (lados) {
    const sup = q.match(/\b(tierra|arcilla|clay|hierba|cesped|césped|grass|pista dura|dura|hard)\b/)?.[1] ?? '';
    return { herramienta: 'prediccion', argumentos: [...lados, sup] };
  }

  // Un solo nombre: la ficha del jugador. Es la última porque cualquier texto que no se
  // haya reconocido antes acaba aquí, y preguntar por un jugador que no existe tiene
  // una respuesta clara («no lo encuentro») en vez de un «no te he entendido».
  const nombre = sinPreambulo(q).replace(/^(de|del|sobre|el|la)\s+/, '').trim();
  if (nombre.length >= 3 && /^[a-z0-9 '.-]+$/.test(nombre)) {
    return { herramienta: 'jugador', argumentos: [nombre] };
  }

  return { herramienta: 'ninguna', argumentos: [] };
}

export function responder(pregunta: string): Respuesta & { intencion: Intencion } {
  const intencion = enrutar(pregunta);
  const [a, b, c] = intencion.argumentos;
  let r: Respuesta;
  switch (intencion.herramienta) {
    case 'jugador':
      r = T.jugador(a);
      break;
    case 'caraACara':
      r = T.caraACara(a, b);
      break;
    case 'prediccion':
      r = T.prediccion(a, b, c);
      break;
    case 'clasificacion':
      r = T.clasificacion(Number(a) || 10, b === 'wta' ? 'wta' : 'atp');
      break;
    case 'estadoDatos':
      r = T.estadoDatos();
      break;
    case 'precision':
      r = T.precision();
      break;
    default:
      // «No te he entendido» con ejemplos concretos, no un encogimiento de hombros. Un
      // asistente que no sabe qué puede hacer es un asistente que no se usa dos veces.
      r = {
        texto:
          'No he entendido la pregunta. Sé contestar a estas cosas, y solo a estas — ' +
          'con datos de la base, nunca de memoria:',
        filas: [
          { etiqueta: 'Un jugador', valor: 'Alcaraz' },
          { etiqueta: 'Cara a cara', valor: 'cara a cara Alcaraz contra Sinner' },
          { etiqueta: 'Una predicción', valor: 'quién gana Alcaraz contra Sinner en tierra' },
          { etiqueta: 'La clasificación', valor: 'top 10 ATP por Elo' },
          { etiqueta: 'Qué hay guardado', valor: 'estado de los datos' },
          { etiqueta: 'Si acierta', valor: 'qué precisión tiene el modelo' },
        ],
        fuente: 'ninguna: no he llegado a consultar nada',
      };
  }
  return { ...r, intencion };
}
