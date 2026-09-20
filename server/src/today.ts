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
}

const FUENTES: Fuente[] = [
  { deporte: 'Fútbol', log: 'fb_prediction_log', up: 'fb_upcoming', clave: 'match_key', casa: 'home_name', fuera: 'away_name', prob: 'prob_home', precio: 'odds_home', resuelto: 'resolved_at', empate: 'prob_draw' },
  { deporte: 'Baloncesto', log: 'bb_prediction_log', up: 'bb_upcoming', clave: 'game_key', casa: 'home_name', fuera: 'away_name', prob: 'prob_home', precio: 'home_odds', resuelto: 'home_pts' },
  { deporte: 'Béisbol', log: 'bsb_prediction_log', up: 'bsb_upcoming', clave: 'match_key', casa: 'home_name', fuera: 'away_name', prob: 'prob_home', precio: 'odds_home', resuelto: 'resolved_at' },
  { deporte: 'NFL', log: 'naf_prediction_log', up: 'naf_upcoming', clave: 'match_key', casa: 'home_name', fuera: 'away_name', prob: 'prob_home', precio: 'odds_home', resuelto: 'home_points' },
  { deporte: 'Tenis', log: 'prediction_log', up: 'upcoming_matches', clave: 'match_key', casa: 'p1_name', fuera: 'p2_name', prob: 'prob1', precio: 'p1_odds', resuelto: 'resolved_at' },
];

/** Medianoche de MAÑANA en local, que es donde acaba «hoy». */
function finDeHoy(now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0).toISOString();
}

export function partidosDeHoy(now = new Date()): { partidos: PartidoDeHoy[]; nota: string | null } {
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
                  l.${f.casa} AS casa, l.${f.fuera} AS fuera, l.${f.prob} AS p
                  ${f.empate ? `, l.${f.empate} AS pEmpate` : ''}
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
