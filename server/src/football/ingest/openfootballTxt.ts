// El formato Football.TXT de openfootball, que tiene temporadas que el mirror JSON no.
//
// ===========================================================================
// POR QUÉ HACE FALTA UN SEGUNDO FORMATO DE LA MISMA FUENTE
// ===========================================================================
// `openfootball/football.json` es un mirror generado de los repos de texto, y el
// mirror TIENE HUECOS. Medido contra la fuente, fichero a fichero:
//
//     es.2 (Segunda)   json: 2019-20, 2020-21,                     2024-25, 2025-26
//                       txt: 2019-20, 2020-21, 2021-22, 2022-23, 2023-24, 2024-25, 2025-26
//     it.2 (Serie B)   json: 2019-20, 2020-21,                     2024-25, 2025-26
//                       txt: las siete
//
// Tres temporadas por liga que existen, son públicas, y la app no estaba leyendo.
// No es un detalle de completitud: el salto de división —lo último que se añadió al
// modelo— se mide sobre clubes que ascienden, y para contar a un club ascendido hace
// falta la temporada S en Segunda Y la S+1 en Primera. Un hueco en Segunda no borra
// una temporada: borra el PAR, y con él los clubes que ascendieron ese año. El hueco
// 2021-24 costaba tres pares de cinco posibles en España e Italia.
//
// ===========================================================================
// EL FORMATO
// ===========================================================================
//     = Segunda División de España 2023/24
//
//     # Date       Fri Aug 11 2023 - Sun Jun 2 2024 (296d)
//     # Teams      22
//
//     ▪ Matchday 1
//     Fri Aug 11
//       21:00  Levante UD               0-0  SD Huesca
//     Sat Aug 12
//       19:00  CD Mirandés              1-1 (1-1)  Sporting Gijón
//              CD Leganés               1-2 (0-1)  CD Alavés
//
// La hora es opcional (se hereda la fecha, no la hora), el resultado al descanso va
// entre paréntesis, y la fecha NO LLEVA AÑO.
//
// ===========================================================================
// EL AÑO, QUE ES LA ÚNICA PARTE DIFÍCIL
// ===========================================================================
// "Sat Jan 14" en una temporada 2022-23 es 2023; "Sat Aug 13" es 2022. La regla
// obvia —julio-diciembre al año de inicio, enero-junio al de fin— funciona para el
// fútbol europeo y se rompe en cuanto una temporada no encaja en ese molde.
//
// Así que en vez de una regla sobre los meses se usa el ORDEN: el fichero está en
// orden cronológico, se empieza en el año que declara la cabecera, y cada vez que el
// mes RETROCEDE respecto al anterior se suma un año. Eso deduce el cambio de año de
// los datos en lugar de suponerlo, y la comprobación de que funciona no es teórica
// —ver más abajo—.
//
// ===========================================================================
// CÓMO SE VERIFICA
// ===========================================================================
// 2024-25 existe EN LOS DOS FORMATOS. Así que el parser no se juzga leyendo su
// salida: se parsea el .txt, se parsea el .json que ya usa la app, y se comparan
// partido a partido. Si el .txt no reproduce exactamente el .json —mismas fechas,
// mismos equipos, mismos goles, mismos descansos— el parser está mal. Ver
// `npm run verify:data`, sección «Football.TXT reproduce el JSON».

/** Un partido en la MISMA forma que da el JSON, para que el resto no note la diferencia. */
export interface TxtMatch {
  round?: string;
  date: string;
  time?: string;
  team1: string;
  team2: string;
  score: { ft: [number, number]; ht?: [number, number] };
}

const MONTHS: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

/**
 * Una línea de fecha: `Sat Aug 13`, `Sat Aug 13 2022`, `[Sat Aug 13]`, con o sin
 * sangría. La sangría cambia entre ficheros y no significa nada.
 */
const DATE_RE = /^\s*\[?\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Z][a-z]{2})\s+(\d{1,2})(?:\s+(\d{4}))?\s*\]?\s*$/;

// ===========================================================================
// DOS LAYOUTS, NO UNO
// ===========================================================================
// Esto no se dedujo leyendo el formato: se descubrió comparando contra el JSON, que
// es exactamente para lo que servía esa comparación. La primera versión del parser
// sacaba 1 partido de 390 y parecía que el fichero estaba vacío.
//
// Los ficheros antiguos ponen el marcador EN MEDIO:
//
//       20:45  Parma Calcio 1913        2-2 (2-2)  SSC Bari
//
// y los nuevos separan con `v` y lo ponen AL FINAL:
//
//     20:30  Brescia Calcio          v Palermo FC               1-0 (0-0)
//
// Cada fichero usa uno solo, pero el repo tiene de los dos —Serie B 2022-23 es del
// primero y 2024-25 del segundo—, así que hay que aceptar ambos. Se prueba primero
// el de `v` porque es el más específico: su separador no puede confundirse con nada.

/** Marcador al final, equipos separados por `v`. */
const MATCH_V_RE =
  /^\s*(?:(\d{1,2}:\d{2})\s+)?(\S.*?)\s{2,}v\.?\s+(\S.*?)\s{2,}(\d+)-(\d+)(?:\s*\((\d+)-(\d+)\))?\s*(?:\[[^\]]*\])?\s*$/;

/**
 * Marcador en medio.
 *
 * Los DOS ESPACIOS mínimos alrededor del marcador no son cosmética, son lo que hace
 * el patrón seguro: hay clubes con números en el nombre —"Parma Calcio 1913",
 * "Como 1907", "Bayer 04 Leverkusen"— y un `\d+-\d+` suelto podría engancharse
 * dentro del nombre. El fichero alinea el marcador en columnas, así que exigir la
 * separación es a la vez fiel al formato y suficiente para desambiguar.
 */
const MATCH_MID_RE =
  /^\s*(?:(\d{1,2}:\d{2})\s+)?(\S.*?)\s{2,}(\d+)-(\d+)(?:\s*\((\d+)-(\d+)\))?\s{2,}(\S.*?)\s*(?:\[[^\]]*\])?\s*$/;

// ===========================================================================
// EL AÑO: POR QUÉ NO SE CUENTA, SE DECIDE
// ===========================================================================
// La primera versión iba contando: empezar en el año de inicio y sumar uno cada vez
// que el mes retrocedía. Suena razonable y está mal, y la comparación contra el JSON
// dijo exactamente cuánto: 47 partidos de 390 con el año equivocado, todos al final
// de la temporada, todos +1.
//
// La causa es que el fichero NO está estrictamente ordenado. Un partido aplazado se
// escribe en la jornada a la que pertenece, con la fecha en que se acabó jugando, así
// que el mes retrocede sin que el año cambie — y a partir de ahí el contador arrastra
// el error hasta el final del fichero.
//
// La cabecera ya dice el rango entero:
//
//     # Date       Fri Aug 16 2024 - Sun Jun 1 2025 (289d)
//
// Con eso, el año de una fecha no hay que deducirlo del orden: solo hay dos años
// posibles, y se elige el que cae DENTRO del rango declarado. Eso es una decisión
// local, inmune al orden de las líneas, y que además se comprueba a sí misma.

interface Span {
  startMonth: number;
  startYear: number;
  endYear: number;
  /** Límites como YYYYMMDD para poder comparar como números. */
  from: number;
  to: number;
}

/** El rango de la temporada, de la cabecera. Null si el fichero no la trae. */
function headerSpan(text: string): Span | null {
  const m = text.match(
    /^#\s*Date\s+\w{3}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4})\s*[-–]\s*\w{3}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4})/m,
  );
  if (!m) return null;
  const sM = MONTHS[m[1]];
  const eM = MONTHS[m[4]];
  if (!sM || !eM) return null;
  const sY = Number(m[3]);
  const eY = Number(m[6]);
  return {
    startMonth: sM,
    startYear: sY,
    endYear: eY,
    from: sY * 10000 + sM * 100 + Number(m[2]),
    to: eY * 10000 + eM * 100 + Number(m[5]),
  };
}

/** El rango supuesto cuando no hay cabecera: la temporada europea de "2022-23". */
function spanFromLabel(label: string): Span {
  const sY = Number(label.slice(0, 4));
  const eY = /^\d{4}-\d{2}$/.test(label) ? sY + 1 : sY;
  return {
    // Julio: el corte convencional entre temporadas europeas.
    startMonth: 7,
    startYear: sY,
    endYear: eY,
    from: sY * 10000 + 701,
    to: eY * 10000 + 630,
  };
}

/**
 * El año de una fecha sin año, dado el rango de la temporada.
 *
 * Se prueban los dos años posibles y gana el que cae dentro del rango. Cuando
 * ninguno cae —una fecha fuera de lo que declara la cabecera, que existe: amistosos
 * de pretemporada colados, o una final movida a julio— se recurre a la regla del mes,
 * que es la convención de siempre y nunca está más de un año equivocada.
 */
function yearFor(month: number, day: number, s: Span): number {
  for (const y of [s.startYear, s.endYear]) {
    const stamp = y * 10000 + month * 100 + day;
    if (stamp >= s.from && stamp <= s.to) return y;
  }
  return month >= s.startMonth ? s.startYear : s.endYear;
}

/**
 * Parsear un fichero Football.TXT.
 *
 * Tolerante a propósito, igual que el parser del JSON: una línea que no encaja no es
 * un error, es una línea que no es un partido —títulos, comentarios, jornadas,
 * separadores— y hay muchas. Lo que NO se tolera es inventar: un partido sin
 * marcador (aplazado, o del calendario futuro) se salta en vez de guardarse 0-0, que
 * es lo peor que le puede pasar a un rating.
 */
export function parseFootballTxt(text: string, seasonLabel: string): TxtMatch[] {
  const span = headerSpan(text) ?? spanFromLabel(seasonLabel);
  const out: TxtMatch[] = [];
  let date: string | null = null;
  let round: string | undefined;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;

    if (line.startsWith('▪')) {
      round = line.slice(1).trim() || undefined;
      continue;
    }
    // `=` es el título y `#` son comentarios y cabeceras. Ninguno es un partido.
    if (line.startsWith('=') || line.startsWith('#')) continue;

    const d = line.match(DATE_RE);
    if (d) {
      const month = MONTHS[d[1]];
      if (!month) continue;
      const day = Number(d[2]);
      // Cuando el fichero escribe el año, manda el fichero.
      const year = d[3] ? Number(d[3]) : yearFor(month, day, span);
      date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      continue;
    }

    // Un `[postponed]` no trae marcador y no encaja en ninguno de los dos patrones,
    // así que se cae solo por aquí. Un `[awarded]` sí lo trae —el resultado por
    // resolución de mesa cuenta en la clasificación— y se guarda como cualquier otro.
    const v = line.match(MATCH_V_RE);
    const mid = v ? null : line.match(MATCH_MID_RE);
    // Sin fecha previa no hay partido que colocar en el tiempo: es una línea suelta
    // de una sección que no entendemos, y adivinar la fecha sería peor que saltarla.
    if (!date || (!v && !mid)) continue;
    const [time, team1, team2, hg, ag, hth, hta] = v
      ? [v[1], v[2], v[3], v[4], v[5], v[6], v[7]]
      : [mid![1], mid![2], mid![7], mid![3], mid![4], mid![5], mid![6]];
    const match: TxtMatch = {
      date,
      team1: team1.trim(),
      team2: team2.trim(),
      score: { ft: [Number(hg), Number(ag)] },
    };
    if (time) match.time = time;
    if (hth !== undefined && hta !== undefined) match.score.ht = [Number(hth), Number(hta)];
    if (round) match.round = round;
    out.push(match);
  }
  return out;
}

/** El fichero .txt de una liga dentro de su repo de país, en la forma del JSON. */
export function txtToJson(text: string, seasonLabel: string): string {
  return JSON.stringify({ name: seasonLabel, matches: parseFootballTxt(text, seasonLabel) });
}
