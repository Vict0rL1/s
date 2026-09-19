// El enrutador con modelo de lenguaje: OPCIONAL, y con el contrato más estrecho posible.
//
// ===========================================================================
// QUÉ SE LE DEJA HACER, Y QUÉ NO
// ===========================================================================
// Lo único que hace el modelo es ELEGIR una de las seis herramientas y rellenar sus
// argumentos. Nada más. El texto de la respuesta lo sigue componiendo `tools.ts` a
// partir de SQLite, exactamente igual que sin modelo.
//
// La razón es la de siempre en este proyecto: el encargo era comprobar datos. Un modelo
// que redacta «Alcaraz tiene 2180 de Elo» produce una frase que suena idéntica esté bien
// o mal, y para saber cuál de las dos es hay que ir a mirarlo — que es el trabajo que se
// quería ahorrar. Eligiendo herramienta no puede equivocarse de esa forma: si elige mal,
// sale una respuesta a otra pregunta, y eso SE NOTA.
//
// ===========================================================================
// QUÉ APORTA, PARA QUE LA CLAVE SE PAGUE O NO CON CRITERIO
// ===========================================================================
// El enrutador de expresiones regulares acierta en las frases previstas y falla en las
// demás: faltas de ortografía, orden raro, preguntas indirectas. Un modelo aguanta eso.
// Lo que NO aporta es ni un dato nuevo ni una respuesta mejor a una pregunta que el
// enrutador ya entiende — con clave o sin ella, «top 10 ATP» da lo mismo.
//
// Por eso es opcional y por defecto está apagado: cuesta dinero por pregunta y la mayor
// parte del valor de esta pantalla no depende de él.
//
// ===========================================================================
// FALLA HACIA EL LADO SEGURO
// ===========================================================================
// Sin clave, con error de red, con una respuesta que no se entiende o con un nombre de
// herramienta que no está en la lista: se usa el enrutador determinista. Nunca se
// devuelve un error al usuario por un problema del modelo, porque la app funciona
// perfectamente sin él.

import { env } from '../config.ts';
import { enrutar, type Intencion } from './router.ts';

const API = 'https://api.anthropic.com/v1/messages';
/** Barato y rápido: esto es clasificación entre seis salidas, no redacción. */
const MODELO = 'claude-haiku-4-5-20251001';

/**
 * Las seis herramientas, descritas para el modelo.
 *
 * Es deliberadamente la MISMA lista que entiende `responder`. Si aquí apareciera una
 * séptima, el modelo podría elegirla y no habría nada que ejecutar.
 */
const HERRAMIENTAS = [
  {
    name: 'jugador',
    description: 'Ficha de un jugador: Elo general y por superficie, récord y ranking oficial.',
    input_schema: {
      type: 'object' as const,
      properties: { nombre: { type: 'string', description: 'Nombre o apellido del jugador' } },
      required: ['nombre'],
    },
  },
  {
    name: 'caraACara',
    description: 'Historial de enfrentamientos entre dos jugadores, partido a partido.',
    input_schema: {
      type: 'object' as const,
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'prediccion',
    description: 'Probabilidad que el modelo da a un partido entre dos jugadores.',
    input_schema: {
      type: 'object' as const,
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
        superficie: { type: 'string', description: 'tierra, hierba o dura. Por defecto dura.' },
      },
      required: ['a', 'b'],
    },
  },
  {
    name: 'clasificacion',
    description: 'Los N primeros del circuito por Elo.',
    input_schema: {
      type: 'object' as const,
      properties: {
        n: { type: 'integer', description: 'Cuántos, de 1 a 30' },
        tour: { type: 'string', description: 'atp o wta' },
      },
      required: [],
    },
  },
  {
    name: 'estadoDatos',
    description: 'Qué partidos hay guardados, cuáles tienen cuotas reales y por qué faltan.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'precision',
    description: 'Cifras medidas del backtest: acierto, Brier y log loss.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
] as const;

// El tipo sale de la lista, no se escribe a mano: así, añadir una herramienta aquí sin
// implementarla en `responder` es un error de compilación y no un fallo en caliente.
type NombreHerramienta = (typeof HERRAMIENTAS)[number]['name'];
const NOMBRES = new Set<string>(HERRAMIENTAS.map((h) => h.name));
const esNombre = (s: string): s is NombreHerramienta => NOMBRES.has(s);

const SISTEMA =
  'Eres el enrutador de una app de predicciones deportivas. Tu ÚNICA tarea es elegir ' +
  'qué herramienta responde a la pregunta y con qué argumentos. NUNCA escribas datos, ' +
  'cifras, nombres de jugadores que no aparezcan en la pregunta, ni respuestas: los ' +
  'datos los pone la aplicación. Si la pregunta no encaja en ninguna herramienta, no ' +
  'llames a ninguna.';

/**
 * Convierte lo que devolvió el modelo en una `Intencion`, o en null si no vale.
 *
 * Se valida el nombre contra la lista y cada argumento por tipo. No es desconfianza
 * decorativa: lo que llega es texto de un servicio externo, y de aquí sale directo a
 * elegir qué consulta se ejecuta.
 */
function aIntencion(bloques: unknown): Intencion | null {
  if (!Array.isArray(bloques)) return null;
  const uso = bloques.find(
    (b): b is { type: string; name: string; input: Record<string, unknown> } =>
      typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_use',
  );
  if (!uso || !esNombre(uso.name)) return null;
  const s = (k: string): string => {
    const v = uso.input?.[k];
    return typeof v === 'string' ? v.slice(0, 80) : '';
  };
  switch (uso.name) {
    case 'jugador':
      return s('nombre') ? { herramienta: 'jugador', argumentos: [s('nombre')] } : null;
    case 'caraACara':
      return s('a') && s('b') ? { herramienta: 'caraACara', argumentos: [s('a'), s('b')] } : null;
    case 'prediccion':
      return s('a') && s('b')
        ? { herramienta: 'prediccion', argumentos: [s('a'), s('b'), s('superficie')] }
        : null;
    case 'clasificacion': {
      const n = Number(uso.input?.n);
      const tour = s('tour') === 'wta' ? 'wta' : 'atp';
      return { herramienta: 'clasificacion', argumentos: [String(Number.isFinite(n) ? n : 10), tour] };
    }
    case 'estadoDatos':
      return { herramienta: 'estadoDatos', argumentos: [] };
    case 'precision':
      return { herramienta: 'precision', argumentos: [] };
    default:
      return null;
  }
}

export function hayModelo(): boolean {
  return !!env.anthropicApiKey;
}

/**
 * Elige herramienta con el modelo, y si algo falla, con el enrutador de siempre.
 *
 * Devuelve además CÓMO se decidió, porque la pantalla lo dice: saber si contestó el
 * modelo o las expresiones regulares cambia lo que se puede esperar de la siguiente
 * pregunta, y esconderlo sería vender el determinismo que no se está usando.
 */
export async function enrutarConModelo(
  pregunta: string,
): Promise<{ intencion: Intencion; via: 'modelo' | 'determinista'; nota?: string }> {
  if (!env.anthropicApiKey) return { intencion: enrutar(pregunta), via: 'determinista' };
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 256,
        system: SISTEMA,
        tools: HERRAMIENTAS,
        messages: [{ role: 'user', content: pregunta.slice(0, 300) }],
      }),
    });
    if (!res.ok) {
      return {
        intencion: enrutar(pregunta),
        via: 'determinista',
        nota: `el modelo respondió ${res.status}`,
      };
    }
    const j = (await res.json()) as { content?: unknown };
    const i = aIntencion(j.content);
    if (!i) {
      return {
        intencion: enrutar(pregunta),
        via: 'determinista',
        nota: 'el modelo no eligió ninguna herramienta válida',
      };
    }
    return { intencion: i, via: 'modelo' };
  } catch (e) {
    return {
      intencion: enrutar(pregunta),
      via: 'determinista',
      nota: `no pude hablar con el modelo: ${(e as Error).message.slice(0, 80)}`,
    };
  }
}

/** Exportado para poder probar la validación sin llamar a la API. */
export const _aIntencion = aIntencion;
