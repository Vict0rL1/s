// Qué se le saca a un texto de noticia, y por qué justo eso.
//
// ===========================================================================
// EL CRITERIO PARA QUE UN CAMPO EXISTA
// ===========================================================================
// Cada campo de este esquema tiene que CAMBIAR una predicción. No está para que la
// tarjeta se vea completa: si un dato no entra en ningún cálculo, extraerlo cuesta
// tokens, invita a enseñarlo, y enseñar un dato que no se usa hace creer que el modelo
// lo tiene en cuenta.
//
// Por eso no hay «titular», ni «fuente», ni «resumen». Sí hay `kind`, porque una
// sanción y una lesión de rodilla se comportan distinto; sí hay `returnDate`, porque
// decide si la ausencia afecta a ESTE partido o al de dentro de un mes; y sí hay
// `confidence`, porque «no se descarta que llegue» y «causará baja» no son lo mismo y
// el sizing tiene que poder distinguirlos.
//
// ===========================================================================
// POR QUÉ UN MODELO Y NO UNA EXPRESIÓN REGULAR
// ===========================================================================
// La fuente estructurada que ya usa la app (FPL) da `status` y `chance_next`, y para lo
// que da, basta. Un modelo de lenguaje aquí solo se gana el sitio con lo que aquella NO
// distingue:
//
//   «Has joined Rangers on loan for the rest of the season»  → status 'u'
//   «Knee injury - Unknown return date»                       → status 'i'
//
// Las dos son «no disponible» para el feed y son cosas MUY distintas para el modelo: la
// primera es permanente y no vuelve, la segunda puede resolverse el jueves. Y ninguna
// expresión regular sobrevive a una rueda de prensa —«no forzaremos con Pedri, aunque
// entrenó ayer»— que es exactamente el texto que un usuario querría pegar.
//
// La regla es la de siempre en este proyecto: lo que se puede leer con una regla, se lee
// con una regla; el modelo se reserva para el texto libre de verdad.

/** Qué le pasa al jugador. Cada tipo se comporta distinto y por eso se distinguen. */
export type AbsenceKind =
  /** Lesión: incierta, puede resolverse antes del partido. */
  | 'lesion'
  /** Sanción: CIERTA. No hay duda de disponibilidad, solo de cuántos partidos. */
  | 'sancion'
  /** Enfermedad: como la lesión pero típicamente más corta. */
  | 'enfermedad'
  /** Descanso o rotación: decisión del entrenador, la más incierta de todas. */
  | 'rotacion'
  /** Se ha ido del club. Permanente, y no debería seguir contando en la plantilla. */
  | 'salida'
  /** Vuelve de una ausencia: la noticia SUMA disponibilidad en vez de restarla. */
  | 'regreso'
  /** Convocado por su selección. */
  | 'internacional'
  /** El texto habla del jugador pero no dice nada sobre si juega. */
  | 'sin-impacto';

export interface NewsItem {
  /** Nombre del jugador tal y como aparece en el texto, sin normalizar. */
  playerName: string;
  /** Equipo, si el texto lo dice. Ayuda a desambiguar nombres repetidos. */
  teamName: string | null;
  kind: AbsenceKind;
  /**
   * Probabilidad de que juegue, de 0 a 1.
   *
   * Es el campo que de verdad mueve el modelo, y por eso se pide explícito en vez de
   * derivarlo del tipo: «duda hasta última hora» y «descartado» son las dos una lesión.
   * Una sanción es 0 y no admite matices; una rotación rara vez baja de 0,3.
   */
  playProbability: number;
  /** Parte del cuerpo, cuando es una lesión. Null si no aplica o no se dice. */
  bodyPart: string | null;
  /** Fecha estimada de regreso en YYYY-MM-DD, si el texto la da. */
  returnDate: string | null;
  /**
   * Cuánto se fía el extractor de haber entendido bien el texto, de 0 a 1.
   *
   * Distinto de `playProbability`: aquí un 0,4 significa «el texto es ambiguo y esto es
   * lo que me parece», no «hay un 40 % de que juegue». Se separan porque un texto claro
   * sobre una duda («50 % de posibilidades, decide el míster») debe salir con confianza
   * ALTA y probabilidad de jugar MEDIA, y mezclarlos perdería justo esa distinción.
   */
  confidence: number;
  /** El trozo de texto del que sale. Para poder comprobarlo sin volver a llamar. */
  quote: string;
}

export interface NewsExtraction {
  items: NewsItem[];
}

/**
 * El esquema JSON que se le pasa a la API.
 *
 * `additionalProperties: false` y todos los campos en `required` no son decoración: son
 * lo que permite `strict`, y con strict la respuesta valida por construcción en vez de
 * «casi siempre». Los campos que pueden faltar se declaran anulables (`['string',
 * 'null']`) en vez de opcionales — así el modelo tiene que decidir explícitamente «no lo
 * dice» en lugar de poder olvidarse del campo, que son dos cosas distintas.
 */
export const NEWS_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      description:
        'Un elemento por jugador mencionado cuyo estado de disponibilidad cambie. Si el ' +
        'texto no habla de la disponibilidad de nadie, devuelve una lista vacía.',
      items: {
        type: 'object',
        properties: {
          playerName: {
            type: 'string',
            description: 'Nombre del jugador tal y como aparece en el texto.',
          },
          teamName: {
            type: ['string', 'null'],
            description: 'Equipo del jugador si el texto lo menciona; null si no.',
          },
          kind: {
            type: 'string',
            enum: [
              'lesion',
              'sancion',
              'enfermedad',
              'rotacion',
              'salida',
              'regreso',
              'internacional',
              'sin-impacto',
            ],
            description:
              'Tipo de novedad. "sancion" solo si es una suspensión disciplinaria. ' +
              '"salida" si ha dejado el club (traspaso o cesión). "regreso" si vuelve de ' +
              'una ausencia. "sin-impacto" si se le menciona pero no se dice nada sobre ' +
              'su disponibilidad.',
          },
          playProbability: {
            type: 'number',
            description:
              'Probabilidad de 0 a 1 de que juegue el próximo partido. Una sanción o una ' +
              'salida del club son 0. "Duda" suele estar entre 0,4 y 0,6. Si el texto da ' +
              'un porcentaje, úsalo.',
          },
          bodyPart: {
            type: ['string', 'null'],
            description: 'Parte del cuerpo lesionada, en español y en minúsculas. Null si no aplica.',
          },
          returnDate: {
            type: ['string', 'null'],
            description:
              'Fecha estimada de regreso en formato YYYY-MM-DD. Null si el texto no la da ' +
              'o dice que se desconoce. No la inventes a partir de "unas semanas".',
          },
          confidence: {
            type: 'number',
            description:
              'De 0 a 1: cuánto te fías de haber entendido el texto. Un texto claro sobre ' +
              'una situación incierta lleva confianza ALTA. Baja solo si el texto es ' +
              'ambiguo, contradictorio o no estás seguro de a qué jugador se refiere.',
          },
          quote: {
            type: 'string',
            description: 'El fragmento literal del texto del que sale esta conclusión.',
          },
        },
        required: [
          'playerName',
          'teamName',
          'kind',
          'playProbability',
          'bodyPart',
          'returnDate',
          'confidence',
          'quote',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const;

/**
 * Cuánta disponibilidad implica cada tipo cuando el texto NO da una probabilidad usable.
 *
 * Es el respaldo, no lo principal: si el extractor devuelve una `playProbability` que
 * viene del texto, manda esa. Esto solo actúa cuando la confianza es baja, y entonces se
 * prefiere el valor típico del tipo antes que un número que el modelo se ha inventado.
 */
export const KIND_DEFAULT_PLAY: Record<AbsenceKind, number> = {
  lesion: 0.15,
  sancion: 0,
  enfermedad: 0.4,
  rotacion: 0.5,
  salida: 0,
  regreso: 0.7,
  internacional: 0.5,
  'sin-impacto': 1,
};
