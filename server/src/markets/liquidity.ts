// Cuántas casas cotizan cada mercado — y por qué eso cambia cómo hay que leerlo.
//
// ===========================================================================
// LO QUE UN MERCADO FINO TE HACE
// ===========================================================================
// Toda la app está construida sobre una idea: la diferencia entre el modelo y el precio
// es interesante. En el 1X2 de la Premier eso es defendible — hay decenas de casas, el
// margen es del 4 % y el precio incorpora cosas que el modelo no ve.
//
// En «córners del Betis por encima de 5,5» no hay nada de eso. Puede haber dos casas
// cotizándolo, con un margen del 15 % y un límite de veinte euros. Y ahí las dos mitades
// de la comparación se rompen a la vez:
//
//   · EL PRECIO INFORMA MENOS. Una línea que nadie ha empujado no incorpora dinero
//     informado, porque no ha pasado dinero informado por ella. Discrepar de ella dice
//     mucho menos que discrepar de una línea líquida.
//
//   · Y EL MARGEN SE COME LA VENTAJA. Con un 15 % de margen hace falta una ventaja de
//     verdad enorme para que quede algo, y el mismo cálculo que en el 1X2 da «hay valor»
//     cuando lo que hay es un precio malo.
//
// Las dos cosas apuntan igual: en un mercado fino hay que exigir MÁS, no menos. La
// tentación es la contraria —«aquí las casas se equivocan más»— y a veces es verdad,
// pero no se puede saber sin haberlo medido, y esta app no lo ha medido.
//
// ===========================================================================
// DE DÓNDE SALE EL NÚMERO, Y DÓNDE NO SALE
// ===========================================================================
// El feed de cuotas que usa la app pide UN mercado: `h2h`. Con eso llega, por partido,
// cuántas casas lo cotizan — y ese número es real y está guardado (`fb_upcoming.books`).
//
// Para los mercados de este módulo —córners, tarjetas, mitades, props— el mismo
// proveedor los sirve por un endpoint POR EVENTO que se cobra aparte. Pedirlo para
// sesenta partidos gastaría la cuota de quien use la app sin habérselo preguntado, así
// que NO se pide. La consecuencia se dice tal cual: de esos mercados la app no sabe
// cuántas casas los cotizan, y `books: null` significa «no consultado», que no es lo
// mismo que «ninguna».
//
// Lo que sí se puede afirmar sin pedir nada es la ESTRUCTURA del mercado: que el 1X2 de
// una primera división europea lo cotizan todas las casas y las tarjetas de un jugador
// concreto no las cotiza casi ninguna es un hecho del sector, no una estimación de este
// proyecto. Eso es lo que codifica `MARKET_DEPTH`, y está separado del conteo real para
// que nadie confunda un hecho estructural con una medición.

/** Cuánta profundidad tiene un tipo de mercado, estructuralmente. */
export type Depth = 'profundo' | 'medio' | 'fino' | 'muy-fino';

export interface MarketLiquidity {
  /** Clave estable del mercado. */
  key: string;
  /** Cómo llamarlo en pantalla. */
  label: string;
  depth: Depth;
  /**
   * Casas que lo cotizan según el feed. `null` = no consultado (ver la cabecera).
   * No confundir con 0, que sería «consultado y no lo cotiza nadie».
   */
  books: number | null;
  /**
   * Cuánta ventaja hay que exigirle para que merezca la pena, en puntos de
   * probabilidad. Es el umbral del 1X2 escalado por la profundidad.
   */
  minEdge: number;
  /** Una línea para la tarjeta. */
  note: string;
}

/**
 * El umbral de ventaja del mercado principal, que es el que la app ya usaba.
 *
 * Los demás se escalan desde aquí en vez de tener cada uno su número: así hay UNA
 * decisión que discutir, y la relación entre mercados queda explícita.
 */
export const BASE_MIN_EDGE = 0.04;

/**
 * Multiplicador del umbral por profundidad.
 *
 * No son medidas: son la traducción directa del margen típico de cada tipo de mercado.
 * Un 1X2 europeo lleva un 4-5 % de margen y un mercado de nicho un 12-18 %; exigir el
 * triple de ventaja en el segundo es, aproximadamente, exigir la misma ventaja NETA. Se
 * dice que son estructurales y no medidos, y el porqué está en la cabecera.
 */
const EDGE_MULTIPLIER: Record<Depth, number> = {
  profundo: 1,
  medio: 1.5,
  fino: 2.5,
  'muy-fino': 3.5,
};

const NOTES: Record<Depth, string> = {
  profundo: 'Mercado principal: muchas casas, margen bajo. Discrepar aquí significa algo.',
  medio: 'Lo cotizan bastantes casas, con más margen que el 1X2. Exige algo más de ventaja.',
  fino:
    'Mercado con pocas casas y margen alto. La línea incorpora menos información, ' +
    'y el margen se come antes la ventaja: hace falta el doble y medio para que quede algo.',
  'muy-fino':
    'Muy pocas casas, margen muy alto y límites bajos. Trátalo como una opinión del ' +
    'modelo, no como una oportunidad: aquí es donde una ventaja aparente sale más veces ' +
    'del precio malo que del acierto.',
};

/**
 * La profundidad de cada mercado que publica la app.
 *
 * Los goles y el 1X2 los cotiza todo el mundo. Los córners y las tarjetas de equipo, un
 * puñado de casas. Las props de un jugador concreto y el descanso/final exacto, dos o
 * tres y con límites pequeños.
 */
export const MARKET_DEPTH: Record<string, { label: string; depth: Depth }> = {
  '1x2': { label: '1X2', depth: 'profundo' },
  'doble-oportunidad': { label: 'Doble oportunidad', depth: 'profundo' },
  'total-goles': { label: 'Total de goles', depth: 'profundo' },
  'ambos-marcan': { label: 'Ambos marcan', depth: 'profundo' },
  handicap: { label: 'Hándicap', depth: 'medio' },
  'marcador-exacto': { label: 'Marcador exacto', depth: 'medio' },
  'descanso-1x2': { label: '1X2 al descanso', depth: 'medio' },
  'descanso-total': { label: 'Goles al descanso', depth: 'medio' },
  'gana-una-mitad': { label: 'Gana alguna mitad', depth: 'fino' },
  'descanso-final': { label: 'Descanso/Final', depth: 'fino' },
  corners: { label: 'Córners', depth: 'fino' },
  tarjetas: { label: 'Tarjetas', depth: 'fino' },
  'prop-goleador': { label: 'Marca un gol', depth: 'medio' },
  'prop-asistencia': { label: 'Da una asistencia', depth: 'fino' },
  'prop-gol-o-asistencia': { label: 'Marca o asiste', depth: 'fino' },
  'prop-tarjeta': { label: 'Ve tarjeta', depth: 'muy-fino' },
  'prop-2-goles': { label: 'Marca 2 o más', depth: 'muy-fino' },
};

export function liquidityOf(key: string, books: number | null = null): MarketLiquidity {
  const meta = MARKET_DEPTH[key] ?? { label: key, depth: 'fino' as Depth };
  return {
    key,
    label: meta.label,
    depth: meta.depth,
    books,
    minEdge: BASE_MIN_EDGE * EDGE_MULTIPLIER[meta.depth],
    note: NOTES[meta.depth],
  };
}

/** ¿Hay que avisar de que este mercado es fino? */
export function isThin(depth: Depth): boolean {
  return depth === 'fino' || depth === 'muy-fino';
}

/** Todos los mercados, ordenados de más profundo a más fino. Para la pantalla. */
export function allMarkets(): MarketLiquidity[] {
  const order: Depth[] = ['profundo', 'medio', 'fino', 'muy-fino'];
  return Object.keys(MARKET_DEPTH)
    .map((k) => liquidityOf(k))
    .sort((a, b) => order.indexOf(a.depth) - order.indexOf(b.depth));
}
