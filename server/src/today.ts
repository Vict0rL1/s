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

export interface PartidoDeHoy {
  deporte: 'Fútbol' | 'Baloncesto' | 'Béisbol' | 'NFL' | 'Tenis';
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

interface Fuente {
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
function probSql(f: Fuente, alias = ''): string {
  return f.mostrado ? `COALESCE(${alias}${f.mostrado}, ${alias}${f.prob})` : `${alias}${f.prob}`;
}
function empateSql(f: Fuente, alias = ''): string {
  return f.mostradoEmpate
    ? `COALESCE(${alias}${f.mostradoEmpate}, ${alias}${f.empate})`
    : `${alias}${f.empate}`;
}

const FUENTES: Fuente[] = [
  { deporte: 'Fútbol', log: 'fb_prediction_log', up: 'fb_upcoming', clave: 'match_key', casa: 'home_name', fuera: 'away_name', prob: 'prob_home', precio: 'odds_home', resuelto: 'resolved_at', empate: 'prob_draw', mostrado: 'shown_home', mostradoEmpate: 'shown_draw' },
  { deporte: 'Baloncesto', log: 'bb_prediction_log', up: 'bb_upcoming', clave: 'game_key', casa: 'home_name', fuera: 'away_name', prob: 'prob_home', precio: 'home_odds', resuelto: 'home_pts' },
  { deporte: 'Béisbol', log: 'bsb_prediction_log', up: 'bsb_upcoming', clave: 'match_key', casa: 'home_name', fuera: 'away_name', prob: 'prob_home', precio: 'odds_home', resuelto: 'resolved_at' },
  { deporte: 'NFL', log: 'naf_prediction_log', up: 'naf_upcoming', clave: 'match_key', casa: 'home_name', fuera: 'away_name', prob: 'prob_home', precio: 'odds_home', resuelto: 'home_points', mostrado: 'shown_home' },
  { deporte: 'Tenis', log: 'prediction_log', up: 'upcoming_matches', clave: 'match_key', casa: 'p1_name', fuera: 'p2_name', prob: 'prob1', precio: 'p1_odds', resuelto: 'resolved_at' },
];

// ===========================================================================
// Y EL CIERRE DEL CÍRCULO: ¿ACERTÓ?
// ===========================================================================
// «Hoy» dice lo que el modelo cree. Sin la otra mitad —qué pasó— eso es una promesa sin
// cumplir, y una app de predicciones que solo enseña predicciones es indistinguible de
// una que las inventa.
//
// El panel de historial ya daba el AGREGADO (acierta el 65 %), que es el número honesto
// y el que hay que mirar para juzgar. Pero partido a partido es lo que se puede
// comprobar: quien recuerda el partido de ayer puede verificar esta fila con su propia
// memoria, y eso es lo que convierte un porcentaje en algo en lo que fiarse.
//
// Funciona sin cuotas, que es lo que lo hace útil incluso con el proveedor caído: para
// saber si el modelo acertó no hace falta ningún precio, solo el resultado.
export interface ResultadoReciente {
  deporte: PartidoDeHoy['deporte'];
  cuando: string;
  partido: string;
  favorito: string;
  probabilidad: number;
  ganador: string;
  acerto: boolean;
}

interface FuenteResuelta extends Fuente {
  /** Columnas del marcador final, o null en el tenis, que guarda el id del ganador. */
  marcador: [string, string] | null;
}

/** Cuántos días atrás se mira. Una semana: más y la lista deja de leerse de un vistazo. */
const DIAS_ATRAS = 7;

/** Las filas registradas antes de `shown_*`, rellenadas. Vacío en cuanto se ha hecho. */
function rellenarMostrado(): void {
  try {
    backfillShownFootball();
    backfillShownNfl();
  } catch {
    // Sin tablas todavía: nada que rellenar.
  }
}

export function resultadosRecientes(now = new Date()): ResultadoReciente[] {
  rellenarMostrado();
  const db = getDb();
  const desde = new Date(now.getTime() - DIAS_ATRAS * 86_400_000).toISOString();
  const out: ResultadoReciente[] = [];

  const resueltas: FuenteResuelta[] = [
    { ...FUENTES[0], marcador: ['home_goals', 'away_goals'] },
    { ...FUENTES[1], marcador: ['home_pts', 'away_pts'] },
    { ...FUENTES[2], marcador: ['home_runs', 'away_runs'] },
    { ...FUENTES[3], marcador: ['home_points', 'away_points'] },
    { ...FUENTES[4], marcador: null },
  ];

  for (const f of resueltas) {
    try {
      const rows = f.marcador
        ? (db
            .prepare(
              `SELECT commence_time AS cuando, ${f.casa} AS casa, ${f.fuera} AS fuera,
                      ${probSql(f)} AS p ${f.empate ? `, ${empateSql(f)} AS pEmpate` : ''},
                      ${f.marcador[0]} AS gc, ${f.marcador[1]} AS gf
                 FROM ${f.log}
                WHERE ${f.marcador[0]} IS NOT NULL AND commence_time >= ?
                ORDER BY commence_time DESC LIMIT 40`,
            )
            .all(desde) as unknown as {
            cuando: string; casa: string; fuera: string; p: number;
            pEmpate?: number; gc: number; gf: number;
          }[])
        : (db
            .prepare(
              `SELECT l.commence_time AS cuando, l.p1_name AS casa, l.p2_name AS fuera,
                      l.prob1 AS p, l.winner_id, l.p1_id
                 FROM prediction_log l
                WHERE l.winner_id IS NOT NULL AND l.commence_time >= ?
                ORDER BY l.commence_time DESC LIMIT 40`,
            )
            .all(desde) as unknown as {
            cuando: string; casa: string; fuera: string; p: number;
            winner_id: number; p1_id: number;
          }[]);

      for (const r of rows as (typeof rows)[number][]) {
        if (!r.casa || !r.fuera || typeof r.p !== 'number') continue;
        const pEmpate = typeof (r as { pEmpate?: number }).pEmpate === 'number' ? (r as { pEmpate: number }).pEmpate : 0;
        const lados: [string, number][] = [
          [r.casa, r.p],
          [r.fuera, 1 - r.p - pEmpate],
        ];
        if (f.empate) lados.push(['Empate', pEmpate]);
        const [favorito, probabilidad] = lados.reduce((a, b) => (b[1] > a[1] ? b : a));

        let ganador: string;
        if (f.marcador) {
          const g = r as { gc: number; gf: number };
          // El empate solo existe donde el modelo lo predice. En baloncesto o béisbol un
          // marcador igualado sería dato corrupto, y llamarlo «Empate» inventaría un
          // resultado que ese deporte no tiene.
          ganador = g.gc > g.gf ? r.casa : g.gf > g.gc ? r.fuera : f.empate ? 'Empate' : '';
        } else {
          const w = r as { winner_id: number; p1_id: number };
          ganador = w.winner_id === w.p1_id ? r.casa : r.fuera;
        }
        if (!ganador) continue;
        out.push({
          deporte: f.deporte,
          cuando: r.cuando,
          partido: f.deporte === 'NFL' ? `${r.fuera} @ ${r.casa}` : `${r.casa} vs ${r.fuera}`,
          favorito,
          probabilidad,
          ganador,
          acerto: ganador === favorito,
        });
      }
    } catch {
      // Un deporte sin tabla todavía no puede aportar resultados, y no es motivo para
      // dejar sin vista a los otros cuatro.
    }
  }

  out.sort((a, b) => b.cuando.localeCompare(a.cuando));
  return out.slice(0, 40);
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
          partido: f.deporte === 'NFL' ? `${r.fuera} @ ${r.casa}` : `${r.casa} vs ${r.fuera}`,
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
