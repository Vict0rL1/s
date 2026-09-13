// Sondeo adaptativo: el mismo presupuesto, repartido donde importa.
//
// ===========================================================================
// EL ERROR QUE HAY QUE NO COMETER
// ===========================================================================
// «Sondeo adaptativo» suena a «sondear más a menudo». Con The Odds API eso es
// imposible y decirlo importa: el plan gratuito son 500 peticiones AL MES, y sondear un
// solo deporte cada minuto serían 43.200. No hay ajuste fino que arregle un factor de
// ochenta y seis.
//
// Lo que sí se puede hacer —y es donde está toda la mejora real— es gastar el MISMO
// presupuesto de forma desigual. Hoy esta app refresca todo cada N minutos: el partido
// que empieza en veinte minutos y la línea que lleva tres días quieta reciben
// exactamente la misma atención. Repartiendo por urgencia, el partido inminente se mira
// diez veces más y el de la semana que viene diez veces menos, sin gastar un crédito
// más.
//
// ===========================================================================
// QUÉ HACE URGENTE A UN PARTIDO
// ===========================================================================
// Dos cosas, y las dos se pueden medir sin pedirle nada al proveedor:
//
//   PROXIMIDAD. Las líneas se mueven mucho más en la última hora que tres días antes —
//   entran las alineaciones, el dinero tardío y la información de última hora. Un
//   precio de un partido que empieza en 30 minutos se queda obsoleto antes.
//
//   MOVIMIENTO RECIENTE. Un mercado que se ha movido dos veces hoy probablemente se
//   mueva otra vez; uno que lleva tres días clavado probablemente siga clavado. Esto
//   sale gratis del historial de precios que ya se guarda (`fb_odds_history`).
//
// Las dos son heurísticas declaradas, no efectos medidos, y se dicen así. Lo que SÍ es
// aritmética es la consecuencia: repartir un presupuesto fijo proporcionalmente a un
// peso baja la latencia media ponderada por ese peso. Que el peso sea el correcto es la
// parte que habría que medir con datos que esta app todavía no tiene.

import { getDb } from '../db.ts';

export interface FixtureUrgency {
  fixtureId: string;
  sport: string;
  commenceTime: string;
  minutesToStart: number;
  /** Cambios de precio observados en las últimas 24 h. */
  recentMoves: number;
  /** 0..1. Cuánta parte del presupuesto merece, antes de normalizar. */
  weight: number;
  reason: string;
}

/**
 * Peso por proximidad al inicio.
 *
 * Decae como una exponencial con semivida de 6 horas, acotado. Los números concretos
 * son una elección declarada; lo que no es arbitrario es la FORMA: tiene que ser
 * monótona y suave, porque un escalón («a partir de 60 minutos, ×10») produce un salto
 * de gasto en un instante y deja el minuto 61 tan desatendido como el día anterior.
 */
export function proximityWeight(minutesToStart: number): number {
  if (minutesToStart < 0) return 0; // ya empezó: el mercado pre-partido se cerró
  const halfLifeMin = 360;
  return Math.pow(2, -minutesToStart / halfLifeMin);
}

/**
 * Peso por movimiento reciente.
 *
 * Un mercado quieto vale 1; cada movimiento observado en 24 h lo multiplica, con techo.
 * El techo existe para que un partido con una línea histérica no se lleve el
 * presupuesto entero y deje a los demás sin refrescar en toda la tarde.
 */
export function movementWeight(recentMoves: number): number {
  return Math.min(4, 1 + recentMoves * 0.75);
}

/** Los partidos próximos con su urgencia, más urgente primero. */
export function rankFixtures(now = new Date()): FixtureUrgency[] {
  const db = getDb();
  const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const rows = db
    .prepare(
      `SELECT u.id, u.commence_time AS commenceTime,
              (SELECT COUNT(*) FROM fb_odds_history h
                WHERE h.fixture_id = u.id AND h.observed_at >= ?) AS moves
       FROM fb_upcoming u
       WHERE u.commence_time > ?
       ORDER BY u.commence_time`,
    )
    .all(since, now.toISOString()) as unknown as {
    id: string;
    commenceTime: string;
    moves: number;
  }[];

  return rows
    .map((r) => {
      const minutesToStart = (Date.parse(r.commenceTime) - now.getTime()) / 60_000;
      const p = proximityWeight(minutesToStart);
      const m = movementWeight(r.moves);
      return {
        fixtureId: r.id,
        sport: 'football',
        commenceTime: r.commenceTime,
        minutesToStart,
        recentMoves: r.moves,
        weight: p * m,
        reason:
          minutesToStart < 120
            ? `empieza en ${minutesToStart.toFixed(0)} min`
            : r.moves > 0
              ? `${r.moves} movimiento(s) en 24 h`
              : 'ni inminente ni en movimiento',
      };
    })
    .sort((a, b) => b.weight - a.weight);
}

export interface Allocation {
  /** Minutos hasta el próximo sondeo de todo el lote. */
  cycleMinutes: number;
  /** Los partidos que entran en el próximo ciclo, por orden de urgencia. */
  fixtures: FixtureUrgency[];
  /** Cuántos quedan fuera de este ciclo por presupuesto. */
  deferred: number;
  explanation: string;
}

/**
 * Repartir un presupuesto de peticiones entre los partidos, por urgencia.
 *
 * ===========================================================================
 * POR QUÉ NO SE PUEDE PEDIR UN PARTIDO SUELTO (Y QUÉ SE HACE EN VEZ DE ESO)
 * ===========================================================================
 * The Odds API cobra por petición y devuelve TODOS los eventos del deporte en cada
 * una, así que no existe «refrescar solo este partido»: pedir el Arsenal-City trae la
 * Premier entera y cuesta lo mismo. Eso limita lo fino que puede ser el reparto — la
 * unidad es el DEPORTE, no el partido.
 *
 * Lo que sí se puede hacer, y es lo que hace esto: decidir CADA CUÁNTO se pide cada
 * deporte, según lo urgente que sea el partido más urgente que tenga. Una liga con un
 * partido dentro de media hora se pide a menudo; una que no juega hasta el sábado se
 * pide una vez al día. El reparto es por deporte y la urgencia se hereda del partido
 * que más la tenga, que es lo correcto: si hay UNO inminente, el sondeo tiene que ir
 * rápido aunque los otros diecinueve no lo necesiten.
 */
export function allocate(
  budgetRequestsPerDay: number,
  costPerCycle: number,
  now = new Date(),
): Allocation {
  return allocateFrom(rankFixtures(now), budgetRequestsPerDay, costPerCycle);
}

/**
 * La regla de gasto, separada de la consulta que la alimenta.
 *
 * Está partida en dos a propósito. Mezclado con `rankFixtures`, lo único comprobable
 * era «lo que salga con los partidos que hoy haya en la base» — y como los partidos
 * próximos caducan solos, la comprobación del techo de aceleración pasaba a ser
 * vacía en cuanto la base envejecía un par de días, sin que nada avisara. Aquí la
 * aritmética se puede examinar con una lista escrita a mano.
 */
export function allocateFrom(
  fixtures: FixtureUrgency[],
  budgetRequestsPerDay: number,
  costPerCycle: number,
): Allocation {
  if (fixtures.length === 0 || costPerCycle <= 0) {
    return {
      cycleMinutes: 720,
      fixtures: [],
      deferred: 0,
      explanation: 'Sin partidos próximos: cadencia mínima.',
    };
  }
  const cyclesPerDay = Math.max(1, budgetRequestsPerDay / costPerCycle);
  const baseMinutes = 1440 / cyclesPerDay;

  // La urgencia del lote es la del partido MÁS urgente. Si hay uno a media hora, el
  // ciclo entero va rápido: el coste es por deporte, no por partido, así que apurar
  // por el más urgente no cuesta nada extra.
  const top = fixtures[0].weight;
  // El factor va de 1 (nada urgente) a 8 (inminente y moviéndose). Acotado por arriba
  // porque el presupuesto es real: gastar hoy ocho veces más es no tener nada mañana.
  const speedUp = Math.min(8, Math.max(1, top * 8));
  const cycleMinutes = Math.max(1, Math.round(baseMinutes / speedUp));

  return {
    cycleMinutes,
    fixtures: fixtures.slice(0, 20),
    deferred: Math.max(0, fixtures.length - 20),
    explanation:
      `El presupuesto da ${cyclesPerDay.toFixed(1)} ciclos al día (${baseMinutes.toFixed(0)} min ` +
      `de media). El partido más urgente —${fixtures[0].reason}— acelera ×${speedUp.toFixed(1)}, ` +
      `así que el próximo sondeo va en ${cycleMinutes} min. Cuando no haya nada inminente, ` +
      'el ciclo se relaja solo y devuelve el crédito.',
  };
}
