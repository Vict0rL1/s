// Qué se juega HOY, en los cinco deportes a la vez.
//
// ===========================================================================
// EL HUECO QUE LLENA
// ===========================================================================
// La app está organizada por deporte, que es lo correcto: los modelos son distintos, los
// mercados son distintos y mezclarlos en una lista haría imposible leer ninguno. Pero
// hay una pregunta que NO respeta esa división y es la primera que se hace cualquiera al
// abrirla: «¿qué hay hoy?».
//
// Contestarla obligaba a pinchar las cinco pestañas y acordarse de lo que decía cada
// una. Cinco clics para una pregunta de un vistazo.
//
// ===========================================================================
// DE DÓNDE SALEN LAS PROBABILIDADES, Y POR QUÉ DE AHÍ
// ===========================================================================
// Del log de predicciones, no recalculándolas. Dos motivos:
//
//   1. Recalcular cinco modelos para treinta partidos dentro de una petición web es
//      caro, y esta vista se pide al abrir la app.
//   2. El log guarda la probabilidad TAL COMO SE MOSTRÓ, con su fecha. Si se
//      recalculara aquí, esta pantalla podría decir un número y la pestaña del deporte
//      otro para el mismo partido — y no habría forma de saber cuál de los dos es el
//      que se usó para nada.
//
// Consecuencia honesta: un partido que todavía no ha pasado por el log sale sin
// probabilidad, y se dice, en vez de inventarle una.

import { backfillShownFootball } from './football/trackRecord.ts';
import { backfillShownNfl } from './nfl/trackRecord.ts';
import { getDb } from './db.ts';
import { freshSince } from './freshness.ts';
import { reconstruirDesde } from './recent/reconstruct.ts';

export interface PartidoDeHoy {
  deporte: 'Fútbol' | 'Baloncesto' | 'Béisbol' | 'NFL' | 'NHL' | 'UFC' | 'Tenis';
  /** ISO de inicio. */
  cuando: string;
  partido: string;
  /** El lado que el modelo ve favorito, o null si el partido aún no se ha predicho. */
  favorito: string | null;
  probabilidad: number | null;
  /**
   * ¿Este partido trae un precio de una casa de verdad?
   *
   * Hacen falta las DOS cosas: que la fila no venga del generador de demostración Y que
   * haya un precio. La primera versión solo miraba la fuente, y contaba como «con cuotas
   * reales» los trece partidos de la NFL — que vienen del calendario de nflverse, son
   * perfectamente reales, y no llevan ni una cuota. Decir «13 con cuotas reales» con cero
   * precios en pantalla es la clase de resumen que hace desconfiar de todo lo demás.
   */
  precioReal: boolean;
  /** Ya ha empezado, según el reloj. */
  empezado: boolean;
}

export interface Fuente {
  deporte: PartidoDeHoy['deporte'];
  log: string;
  up: string;
  clave: string;
  casa: string;
  fuera: string;
  prob: string;
  /** Cómo se llama en el log la columna que marca «ya resuelto». */
  resuelto: string;
  /** La columna del precio del local, para saber si hay precio de verdad. */
  precio: string;
  /** El fútbol tiene empate y hay que mirarlo para elegir favorito. */
  empate?: string;
  /**
   * Columnas con la probabilidad que SE ENSEÑÓ, donde difiere de la cruda (NFL y
   * fútbol tienen post-proceso). Se leen con COALESCE: una fila sin rellenar cae a la
   * cruda en vez de desaparecer.
   */
  mostrado?: string;
  mostradoEmpate?: string;
}

/** La probabilidad a puntuar: la enseñada si existe, la cruda si no. */
export function probSql(f: Fuente, alias = ''): string {
  return f.mostrado ? `COALESCE(${alias}${f.mostrado}, ${alias}${f.prob})` : `${alias}${f.prob}`;
}
export function empateSql(f: Fuente, alias = ''): string {
  return f.mostradoEmpate
    ? `COALESCE(${alias}${f.mostradoEmpate}, ${alias}${f.empate})`
    : `${alias}${f.empate}`;
}

export const FUENTES: Fuente[] = [
  { deporte: 'Fútbol', log: 'fb_prediction_log', up: 'fb_upcoming', clave: 'match_key', casa: 'home_name', fuera: 'away_name', prob: 'prob_home', precio: 'odds_home', resuelto: 'resolved_at', empate: 'prob_draw', mostrado: 'shown_home', mostradoEmpate: 'shown_draw' },
  { deporte: 'Baloncesto', log: 'bb_prediction_log', up: 'bb_upcoming', clave: 'game_key', casa: 'home_name', fuera: 'away_name', prob: 'prob_home', precio: 'home_odds', resuelto: 'home_pts' },
  { deporte: 'Béisbol', log: 'bsb_prediction_log', up: 'bsb_upcoming', clave: 'match_key', casa: 'home_name', fuera: 'away_name', prob: 'prob_home', precio: 'odds_home', resuelto: 'resolved_at' },
  { deporte: 'NFL', log: 'naf_prediction_log', up: 'naf_upcoming', clave: 'match_key', casa: 'home_name', fuera: 'away_name', prob: 'prob_home', precio: 'odds_home', resuelto: 'home_points', mostrado: 'shown_home' },
  { deporte: 'Tenis', log: 'prediction_log', up: 'upcoming_matches', clave: 'match_key', casa: 'p1_name', fuera: 'p2_name', prob: 'prob1', precio: 'p1_odds', resuelto: 'resolved_at' },
  // Al final y no en su sitio alfabético: hay código que lee FUENTES por posición.
  { deporte: 'NHL', log: 'nhl_prediction_log', up: 'nhl_upcoming', clave: 'match_key', casa: 'home_name', fuera: 'away_name', prob: 'prob_home', precio: 'odds_home', resuelto: 'home_goals', mostrado: 'shown_home' },
  // La UFC: home_* es el luchador A y away_* el B (sin local). Empate y «sin resultado» quedan 0-0 y no se puntúan.
  { deporte: 'UFC', log: 'ufc_prediction_log', up: 'ufc_upcoming', clave: 'match_key', casa: 'home_name', fuera: 'away_name', prob: 'prob_home', precio: 'odds_home', resuelto: 'resolved_at', mostrado: 'shown_home' },
];

/** Deportes que nombran el partido a la norteamericana: «visitante @ local». */
export const CON_ARROBA = new Set<PartidoDeHoy['deporte']>(['NFL', 'NHL']);

// ===========================================================================
// Y EL CIERRE DEL CÍRCULO: ¿ACERTÓ?
// ===========================================================================
// «Hoy» dice lo que el modelo cree. Sin la otra mitad —qué pasó— eso es una promesa sin
// cumplir, y una app de predicciones que solo enseña predicciones es indistinguible de
// una que las inventa.
//
// DOS ORÍGENES, CONTADOS POR SEPARADO
//   · «en vivo»: la predicción que la app registró ANTES del partido (los logs de cada
//     deporte). Es la prueba de verdad, pero solo cubre lo que la app llegó a enseñar.
//   · «reconstruida»: la del backtest para TODOS los partidos jugados del archivo,
//     con solo los datos anteriores a cada uno (recent/reconstruct.ts). Cubre los huecos
//     del registro —servidor apagado, ligas que nadie abrió— y con eso deja de ser una
//     muestra de 19 partidos.
// Un partido con predicción en vivo NO se cuenta otra vez como reconstruido.
//
// Y LO QUE FALTA SE DICE
// Los resultados llegan con `update-data`. Un día vacío casi nunca es «no hubo
// partidos»: es un archivo sin actualizar, y la respuesta lleva, por deporte, hasta
// cuándo llega el archivo, cuántos partidos ya jugados esperan resultado y qué comando
// lo arregla.
//
// Funciona sin cuotas: para saber si el modelo acertó solo hace falta el resultado.

export type Origen = 'en vivo' | 'reconstruida';

export interface ResultadoReciente {
  deporte: PartidoDeHoy['deporte'];
  liga: string | null;
  /** Día local, YYYY-MM-DD. */
  dia: string;
  /** ISO de inicio; las reconstruidas solo saben el día (el archivo no guarda la hora). */
  cuando: string | null;
  partido: string;
  /** Los dos lados por separado, para los escudos de la pantalla. */
  casa: string;
  fuera: string;
  casaId: string | null;
  fueraId: string | null;
  favorito: string;
  probabilidad: number;
  ganador: string;
  acerto: boolean;
  origen: Origen;
}

export interface ResumenAciertos {
  total: number;
  aciertos: number;
  /** null sin partidos: «0 %» se leería como «no acierta ninguno». */
  tasa: number | null;
  /** Aciertos que el propio modelo esperaba: la suma de sus probabilidades. */
  esperado: number | null;
  tasaEsperada: number | null;
  /** El rango normal por puro azar (95 %), en aciertos enteros. */
  rangoNormal: [number, number] | null;
}

export interface ArchivoDeporte {
  deporte: PartidoDeHoy['deporte'];
  /** Último resultado guardado (YYYY-MM-DD), o null si el archivo está vacío. */
  hasta: string | null;
  /** Partidos de la ventana que la app vio empezar y siguen sin resultado. */
  sinResultado: number;
  comando: string;
  /** Si el deporte se reconstruye (el tenis no: ver recent/reconstruct.ts). */
  reconstruye: boolean;
}

export interface HistorialReciente {
  dias: number;
  desde: string;
  hasta: string;
  resultados: ResultadoReciente[];
  resumen: ResumenAciertos;
  porOrigen: Record<Origen, ResumenAciertos>;
  porDeporte: Partial<Record<PartidoDeHoy['deporte'], ResumenAciertos>>;
  /** TODOS los días de la ventana, también los vacíos: un día que falta no se ve. */
  porDia: (ResumenAciertos & { dia: string })[];
  archivo: ArchivoDeporte[];
  /** Jugados en la ventana sin reconstruir porque algún lado tenía poca historia. */
  sinHistoria: number;
}

interface FuenteResuelta extends Fuente {
  /** Columnas del marcador final, o null en el tenis, que guarda el id del ganador. */
  marcador: [string, string] | null;
  /**
   * El partido del archivo al que se resolvió: para no contarlo dos veces. `casa`/`fuera` dicen de
   * dónde salen los dos lados de la clave (por defecto, `g.home_id`/`g.away_id` del archivo; la UFC
   * los toma del registro, que los guarda en el mismo orden que la reconstrucción).
   */
  enlace: { col: string; tabla: string; fecha: string; casa?: string; fuera?: string } | null;
  archivo: { tabla: string; fecha: string };
  comando: string;
}

/** Ventanas que se ofrecen. Una semana por defecto; hasta un mes para tener muestra. */
export const VENTANAS = [7, 14, 30] as const;

/** Las filas registradas antes de `shown_*`, rellenadas. Vacío en cuanto se ha hecho. */
function rellenarMostrado(): void {
  try {
    backfillShownFootball();
    backfillShownNfl();
  } catch {
    // Sin tablas todavía: nada que rellenar.
  }
}

const p2 = (n: number) => String(n).padStart(2, '0');
/** Día LOCAL de un instante, YYYY-MM-DD: como se agrupa en pantalla. */
export function diaLocal(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
/** YYYYMMDD (o YYYY-MM-DD, el de la NHL) del archivo → YYYY-MM-DD. */
const diaDeArchivo = (ymd: string) => {
  const d = ymd.replace(/-/g, '');
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
};

export function resumir(xs: { probabilidad: number; acerto: boolean }[]): ResumenAciertos {
  const n = xs.length;
  if (n === 0) return { total: 0, aciertos: 0, tasa: null, esperado: null, tasaEsperada: null, rangoNormal: null };
  const aciertos = xs.filter((x) => x.acerto).length;
  // «8 de 15, 53 %» no dice si eso es bueno o malo. Lo dice compararlo con lo que el
  // propio modelo prometió: si daba a cada favorito su probabilidad, los aciertos
  // esperados son la SUMA de esas probabilidades y su dispersión la suma de p·(1−p).
  const esperado = xs.reduce((a, x) => a + x.probabilidad, 0);
  const sd = Math.sqrt(xs.reduce((a, x) => a + x.probabilidad * (1 - x.probabilidad), 0));
  return {
    total: n,
    aciertos,
    tasa: aciertos / n,
    esperado,
    tasaEsperada: esperado / n,
    rangoNormal: [Math.max(0, Math.ceil(esperado - 1.96 * sd)), Math.min(n, Math.floor(esperado + 1.96 * sd))],
  };
}

/** El favorito de unas probabilidades [local, (empate,) visitante]. */
function favoritoDe(casa: string, fuera: string, probs: number[]): { favorito: string; probabilidad: number; indice: number } {
  const nombres = probs.length === 3 ? [casa, 'Empate', fuera] : [casa, fuera];
  let i = 0;
  for (let k = 1; k < probs.length; k++) if (probs[k] > probs[i]) i = k;
  return { favorito: nombres[i], probabilidad: probs[i], indice: i };
}

const RESUELTAS = (): FuenteResuelta[] => [
  { ...FUENTES[0], marcador: ['home_goals', 'away_goals'], enlace: { col: 'match_id', tabla: 'fb_matches', fecha: 'match_date' }, archivo: { tabla: 'fb_matches', fecha: 'match_date' }, comando: 'npm run update-data:fb' },
  { ...FUENTES[1], marcador: ['home_pts', 'away_pts'], enlace: { col: 'game_id', tabla: 'bb_games', fecha: 'game_date' }, archivo: { tabla: 'bb_games', fecha: 'game_date' }, comando: 'npm run update-data:bb' },
  { ...FUENTES[2], marcador: ['home_runs', 'away_runs'], enlace: { col: 'game_id', tabla: 'bsb_games', fecha: 'game_date' }, archivo: { tabla: 'bsb_games', fecha: 'game_date' }, comando: 'npm run update-data:bsb' },
  { ...FUENTES[3], marcador: ['home_points', 'away_points'], enlace: { col: 'game_id', tabla: 'naf_games', fecha: 'game_date' }, archivo: { tabla: 'naf_games', fecha: 'game_date' }, comando: 'npm run update-data:naf' },
  { ...FUENTES[5], marcador: ['home_goals', 'away_goals'], enlace: { col: 'game_id', tabla: 'nhl_games', fecha: 'game_date' }, archivo: { tabla: 'nhl_games', fecha: 'game_date' }, comando: 'npm run update-data:nhl' },
  { ...FUENTES[6], marcador: ['home_score', 'away_score'], enlace: { col: 'fight_id', tabla: 'ufc_fights', fecha: 'fecha', casa: 'l.home_id', fuera: 'l.away_id' }, archivo: { tabla: 'ufc_fights', fecha: 'fecha' }, comando: 'npm run update-data:ufc' },
  { ...FUENTES[4], marcador: null, enlace: null, archivo: { tabla: 'matches', fecha: 'tourney_date' }, comando: 'npm run update-data' },
];

const RECONSTRUYE = new Set<PartidoDeHoy['deporte']>(['Fútbol', 'Baloncesto', 'Béisbol', 'NFL', 'NHL', 'UFC']);

export function historialReciente(now = new Date(), dias: number = VENTANAS[0]): HistorialReciente {
  rellenarMostrado();
  const db = getDb();
  // «Los últimos 7 días» son SIETE DÍAS NATURALES: hoy y los seis anteriores, desde la
  // medianoche local. Con «ahora − 7×24 h» la lista arrastraba la tarde del octavo día,
  // que luego no salía en ninguna barra por día.
  const desdeD = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (dias - 1));
  const desde = desdeD.toISOString();
  const desdeYmd = diaLocal(desdeD).replaceAll('-', '');
  const out: ResultadoReciente[] = [];
  /** Partidos del archivo ya contados en vivo: deporte|YYYYMMDD|local|visitante. */
  const vistos = new Set<string>();
  const archivo: ArchivoDeporte[] = [];

  for (const f of RESUELTAS()) {
    let hasta: string | null = null;
    let sinResultado = 0;
    try {
      const m = (db.prepare(`SELECT MAX(${f.archivo.fecha}) AS d FROM ${f.archivo.tabla}`).get() as { d: string | null }).d;
      hasta = m ? diaDeArchivo(String(m)) : null;
      // Lo que la app vio empezar (con tres horas de margen para que acabe) y aún no
      // tiene resultado: el motivo más común de un día vacío.
      sinResultado = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM ${f.log} WHERE ${f.marcador ? f.resuelto : 'winner_id'} IS NULL AND commence_time >= ? AND commence_time < ?`)
          .get(desde, new Date(now.getTime() - 3 * 3_600_000).toISOString()) as { n: number }
      ).n;
    } catch {
      // Sin tabla: archivo vacío.
    }
    archivo.push({ deporte: f.deporte, hasta, sinResultado, comando: f.comando, reconstruye: RECONSTRUYE.has(f.deporte) });

    try {
      const rows = f.marcador
        ? (db
            .prepare(
              `SELECT l.commence_time AS cuando, l.league AS liga, l.${f.casa} AS casa, l.${f.fuera} AS fuera,
                      l.home_id AS casaId, l.away_id AS fueraId,
                      ${probSql(f, 'l.')} AS p ${f.empate ? `, ${empateSql(f, 'l.')} AS pEmpate` : ''},
                      l.${f.marcador[0]} AS gc, l.${f.marcador[1]} AS gf,
                      g.${f.enlace!.fecha} AS gFecha, ${f.enlace!.casa ?? 'g.home_id'} AS gCasa, ${f.enlace!.fuera ?? 'g.away_id'} AS gFuera
                 FROM ${f.log} l
                 LEFT JOIN ${f.enlace!.tabla} g ON g.id = l.${f.enlace!.col}
                WHERE l.${f.marcador[0]} IS NOT NULL AND l.commence_time >= ?
                ORDER BY l.commence_time DESC`,
            )
            .all(desde) as unknown as {
            cuando: string; liga: string | null; casa: string; fuera: string; casaId: string | null; fueraId: string | null; p: number; pEmpate?: number;
            gc: number; gf: number; gFecha: string | null; gCasa: string | null; gFuera: string | null;
          }[])
        : (db
            .prepare(
              `SELECT l.commence_time AS cuando, l.tour AS liga, l.p1_name AS casa, l.p2_name AS fuera,
                      CAST(l.p1_id AS TEXT) AS casaId, CAST(l.p2_id AS TEXT) AS fueraId,
                      l.prob1 AS p, l.winner_id, l.p1_id
                 FROM prediction_log l
                WHERE l.winner_id IS NOT NULL AND l.commence_time >= ?
                ORDER BY l.commence_time DESC`,
            )
            .all(desde) as unknown as {
            cuando: string; liga: string | null; casa: string; fuera: string; casaId: string | null; fueraId: string | null; p: number; winner_id: number; p1_id: number;
          }[]);

      for (const r of rows as (typeof rows)[number][]) {
        if (!r.casa || !r.fuera || typeof r.p !== 'number') continue;
        const pEmpate = typeof (r as { pEmpate?: number }).pEmpate === 'number' ? (r as { pEmpate: number }).pEmpate : 0;
        const probs = f.empate ? [r.p, pEmpate, 1 - r.p - pEmpate] : [r.p, 1 - r.p];
        const fav = favoritoDe(r.casa, r.fuera, probs);
        let ganador: string;
        if (f.marcador) {
          const g = r as { gc: number; gf: number; gFecha: string | null; gCasa: string | null; gFuera: string | null };
          // El empate solo existe donde el modelo lo predice. En baloncesto o béisbol un
          // marcador igualado sería dato corrupto, y llamarlo «Empate» inventaría un
          // resultado que ese deporte no tiene.
          ganador = g.gc > g.gf ? r.casa : g.gf > g.gc ? r.fuera : f.empate ? 'Empate' : '';
          if (g.gFecha && g.gCasa && g.gFuera) vistos.add(`${f.deporte}|${String(g.gFecha).replace(/-/g, '')}|${g.gCasa}|${g.gFuera}`);
        } else {
          const w = r as { winner_id: number; p1_id: number };
          ganador = w.winner_id === w.p1_id ? r.casa : r.fuera;
        }
        if (!ganador) continue;
        out.push({
          deporte: f.deporte,
          liga: r.liga,
          dia: diaLocal(new Date(r.cuando)),
          cuando: r.cuando,
          partido: CON_ARROBA.has(f.deporte) ? `${r.fuera} @ ${r.casa}` : `${r.casa} vs ${r.fuera}`,
          casa: r.casa,
          fuera: r.fuera,
          casaId: r.casaId,
          fueraId: r.fueraId,
          favorito: fav.favorito,
          probabilidad: fav.probabilidad,
          ganador,
          acerto: ganador === fav.favorito,
          origen: 'en vivo',
        });
      }
    } catch {
      // Un deporte sin tabla todavía no puede aportar resultados, y no es motivo para
      // dejar sin vista a los otros cuatro.
    }
  }

  // Lo reconstruido: todo lo jugado del archivo que el registro en vivo no tiene.
  const rec = reconstruirDesde(desdeYmd);
  const nombres = nombresDeEquipos();
  for (const p of rec.partidos) {
    if (vistos.has(`${p.deporte}|${p.fecha}|${p.casaId}|${p.fueraId}`)) continue;
    const casa = nombres.get(`${p.deporte}|${p.liga}|${p.casaId}`) ?? p.casaId;
    const fuera = nombres.get(`${p.deporte}|${p.liga}|${p.fueraId}`) ?? p.fueraId;
    const fav = favoritoDe(casa, fuera, p.probs);
    const ganador = p.probs.length === 3 ? [casa, 'Empate', fuera][p.y] : [casa, fuera][p.y];
    out.push({
      deporte: p.deporte,
      liga: p.liga,
      dia: diaDeArchivo(p.fecha),
      cuando: null,
      partido: CON_ARROBA.has(p.deporte) ? `${fuera} @ ${casa}` : `${casa} vs ${fuera}`,
      casa,
      fuera,
      casaId: p.casaId,
      fueraId: p.fueraId,
      favorito: fav.favorito,
      probabilidad: fav.probabilidad,
      ganador,
      acerto: fav.indice === p.y,
      origen: 'reconstruida',
    });
  }

  // Más reciente primero; dentro del día, lo registrado en vivo delante.
  out.sort((a, b) => b.dia.localeCompare(a.dia) || (a.origen === b.origen ? (b.cuando ?? '').localeCompare(a.cuando ?? '') : a.origen === 'en vivo' ? -1 : 1));

  const porDeporte: HistorialReciente['porDeporte'] = {};
  for (const d of new Set(out.map((x) => x.deporte))) porDeporte[d] = resumir(out.filter((x) => x.deporte === d));
  const porDia: HistorialReciente['porDia'] = [];
  for (let i = 0; i < dias; i++) {
    const dia = diaLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
    porDia.push({ dia, ...resumir(out.filter((x) => x.dia === dia)) });
  }
  return {
    dias,
    desde,
    hasta: now.toISOString(),
    resultados: out,
    resumen: resumir(out),
    porOrigen: { 'en vivo': resumir(out.filter((x) => x.origen === 'en vivo')), reconstruida: resumir(out.filter((x) => x.origen === 'reconstruida')) },
    porDeporte,
    porDia,
    archivo,
    sinHistoria: Object.values(rec.sinHistoria).reduce((a, b) => a + b, 0),
  };
}

/** deporte|liga|id → nombre, de las tablas de equipos de los cuatro deportes. */
function nombresDeEquipos(): Map<string, string> {
  const m = new Map<string, string>();
  for (const [deporte, tabla] of [['Fútbol', 'fb_teams'], ['Baloncesto', 'bb_teams'], ['Béisbol', 'bsb_teams'], ['NFL', 'naf_teams'], ['NHL', 'nhl_teams']] as const) {
    try {
      for (const r of getDb().prepare(`SELECT id, league, name FROM ${tabla}`).all() as { id: string; league: string; name: string }[]) {
        m.set(`${deporte}|${r.league}|${r.id}`, r.name);
      }
    } catch {
      // Sin tabla: se enseña el id, que es mejor que esconder el partido.
    }
  }
  try {
    for (const r of getDb().prepare('SELECT id, nombre FROM ufc_fighters').all() as { id: string; nombre: string }[]) m.set(`UFC|ufc|${r.id}`, r.nombre);
  } catch {
    // Sin archivo de la UFC: lo mismo.
  }
  return m;
}

/** Medianoche de MAÑANA en local, que es donde acaba «hoy». */
function finDeHoy(now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0).toISOString();
}

export function partidosDeHoy(now = new Date()): { partidos: PartidoDeHoy[]; nota: string | null } {
  rellenarMostrado();
  const db = getDb();
  // La misma ventana que usa cada pestaña: desde la medianoche local hasta la de
  // mañana. Reusar `freshSince` y no inventar un corte propio evita que esta vista
  // enseñe un partido que la pestaña del deporte ya ha escondido, o al revés.
  const desde = freshSince(now);
  const hasta = finDeHoy(now);
  const ahora = now.toISOString();
  const out: PartidoDeHoy[] = [];

  for (const f of FUENTES) {
    try {
      const rows = db
        .prepare(
          `SELECT u.commence_time AS cuando, u.source AS fuente, u.${f.precio} AS precio,
                  l.${f.casa} AS casa, l.${f.fuera} AS fuera, ${probSql(f, 'l.')} AS p
                  ${f.empate ? `, ${empateSql(f, 'l.')} AS pEmpate` : ''}
             FROM ${f.up} u
             LEFT JOIN ${f.log} l ON l.upcoming_id = u.id
            WHERE u.commence_time >= ? AND u.commence_time < ?
            ORDER BY u.commence_time ASC`,
        )
        .all(desde, hasta) as unknown as {
        cuando: string;
        fuente: string | null;
        precio: number | null;
        casa: string | null;
        fuera: string | null;
        p: number | null;
        pEmpate?: number | null;
      }[];

      for (const r of rows) {
        if (!r.casa || !r.fuera) continue;
        let favorito: string | null = null;
        let probabilidad: number | null = null;
        if (typeof r.p === 'number') {
          const pFuera = 1 - r.p - (typeof r.pEmpate === 'number' ? r.pEmpate : 0);
          const lados: [string, number][] = [
            [r.casa, r.p],
            [r.fuera, pFuera],
          ];
          if (typeof r.pEmpate === 'number') lados.push(['Empate', r.pEmpate]);
          const mejor = lados.reduce((a, b) => (b[1] > a[1] ? b : a));
          favorito = mejor[0];
          probabilidad = mejor[1];
        }
        out.push({
          deporte: f.deporte,
          cuando: r.cuando,
          partido: CON_ARROBA.has(f.deporte) ? `${r.fuera} @ ${r.casa}` : `${r.casa} vs ${r.fuera}`,
          favorito,
          probabilidad,
          precioReal: r.fuente != null && r.fuente !== 'fixture' && r.precio != null,
          empezado: r.cuando <= ahora,
        });
      }
    } catch {
      // Una tabla que todavía no existe no puede aportar partidos, y no es motivo para
      // dejar sin vista a los otros cuatro deportes.
    }
  }

  out.sort((a, b) => a.cuando.localeCompare(b.cuando));
  const sinPredecir = out.filter((p) => p.probabilidad == null).length;
  return {
    partidos: out,
    // Se dice cuántos van sin número y por qué, en vez de que parezcan un fallo de
    // carga. Un hueco explicado es un dato; uno sin explicar es una duda.
    nota:
      sinPredecir > 0
        ? `${sinPredecir} de ${out.length} todavía sin predicción guardada: aparecerá en cuanto la pestaña de su deporte los calcule.`
        : null,
  };
}
