// Props de jugador: minutos esperados × tasa por minuto, con la incertidumbre de los
// minutos dentro y no al lado.
//
// ===========================================================================
// POR QUÉ NO SE PUEDE MULTIPLICAR Y YA
// ===========================================================================
// «Marca 0,45 goles por 90 minutos y se esperan 70 minutos, o sea 0,35 goles» da la
// media correcta y la probabilidad EQUIVOCADA. Los 70 minutos no son 70: son 90 si
// juega de titular y aguanta, 60 si le cambian, 20 si entra desde el banquillo y 0 si no
// juega. La media de esas cuatro cosas es 70 y ninguna de ellas es 70.
//
// Y la pregunta del mercado no es la media, es P(marca al menos uno). Con la media
// aplastada a un número, P(marca) = 1 − e^(−0,35) = 29,5 % para todo el mundo con la
// misma media. Con la distribución de minutos dentro:
//
//     P(marca) = Σ_m  P(minutos = m) · [1 − e^(−tasa·m)]
//
// que para un suplente con una probabilidad alta de no jugar da bastante menos, porque
// la masa en m = 0 aporta exactamente cero. Es una mezcla, no un producto.
//
// ===========================================================================
// LA TASA: DE DÓNDE SALE CUANDO NO HAY DATOS
// ===========================================================================
// En la jornada 1 un jugador lleva 90 minutos y 0 goles. Su tasa observada es 0, y
// publicar un 0 % de que marque sería absurdo. En la jornada 3 alguien lleva 2 goles en
// 180 minutos: su tasa observada es 1 gol por 90, o sea el mejor delantero de la
// historia.
//
// Se resuelve igual que en el resto del proyecto: encogimiento jerárquico. La tasa de un
// jugador es la media entre lo suyo y lo de su posición, pesada por cuántos minutos
// lleva. Con 90 minutos es casi toda la posición; con 2.000, casi toda suya.
//
//     tasa = (goles + κ · tasa_posición · 90) / (minutos + κ · 90)
//
// κ es «cuántos partidos completos de prior». No está puesto a ojo: sale de igualar el
// encogimiento a la varianza entre jugadores de la misma posición (ver PRIOR_MATCHES).

import type { FbPlayerRow } from './players.ts';

/**
 * Cuántos partidos de 90 minutos pesa el prior de la posición.
 *
 * Un delantero medio marca ~0,35 por 90. La desviación entre delanteros reales ronda
 * 0,20. Con κ partidos de prior, la varianza del estimador encogido iguala a la del
 * reparto entre jugadores cuando κ ≈ media/varianza² en unidades de 90 minutos, que para
 * estos números cae entre 8 y 12 partidos. Se toma 10.
 *
 * La consecuencia práctica es la que importa: hasta ~10 partidos jugados, lo que manda
 * es la posición; a partir de ahí, el jugador.
 */
export const PRIOR_MATCHES = 10;

export interface PositionPrior {
  goals: number;
  assists: number;
  cards: number;
}

/**
 * Tasas por 90 minutos de un jugador medio de cada posición: el RESPALDO.
 *
 * Se usan cuando la temporada lleva tan pocos minutos que medirlas sería medir ruido.
 * Son del orden de las que publica cualquier resumen de temporada de una liga grande, y
 * se declaran como lo que son —valores de referencia, no una medición de este
 * proyecto—. En cuanto hay minutos suficientes, `measurePositionPriors` las sustituye.
 */
export const POSITION_PRIORS: Record<string, PositionPrior> = {
  GK: { goals: 0.002, assists: 0.01, cards: 0.06 },
  DEF: { goals: 0.05, assists: 0.05, cards: 0.19 },
  MID: { goals: 0.12, assists: 0.12, cards: 0.17 },
  FWD: { goals: 0.32, assists: 0.14, cards: 0.13 },
};

/**
 * Minutos por posición que hacen falta para creerse una tasa medida.
 *
 * Para estimar una tasa de 0,3 por 90 con un error del 10 % hacen falta del orden de
 * cien sucesos, o sea unos 300 partidos completos: 27.000 minutos. Se toma 25.000.
 *
 * Que el umbral exista importa más de lo que parece. La instantánea con la que se
 * desarrolló esto es de la PRIMERA JORNADA: 1.887 minutos de delanteros en total, con
 * los que sale que un delantero da más asistencias (0,286 por 90) que goles (0,239) —
 * que no es un hallazgo sobre el fútbol, es una ronda de partidos. Sin el umbral, esa
 * cifra habría entrado en el modelo como si fuera un dato.
 */
export const MIN_MINUTES_FOR_PRIOR = 25000;

/**
 * Medir los priors sobre la plantilla real, cuando hay minutos para ello.
 *
 * Devuelve, por posición, la tasa medida o la de respaldo, y `measured` diciendo cuál
 * es cada una — porque «no hay datos suficientes» es información que la tarjeta debe
 * poder enseñar, no un detalle interno.
 */
export function measurePositionPriors(
  players: { position: string; minutes: number; goals: number; assists: number; yellow_cards?: number }[],
): Record<string, PositionPrior & { measured: boolean; minutes: number }> {
  const agg = new Map<string, { min: number; g: number; a: number; y: number }>();
  for (const p of players) {
    const e = agg.get(p.position) ?? { min: 0, g: 0, a: 0, y: 0 };
    e.min += p.minutes ?? 0;
    e.g += p.goals ?? 0;
    e.a += p.assists ?? 0;
    e.y += p.yellow_cards ?? 0;
    agg.set(p.position, e);
  }
  const out: Record<string, PositionPrior & { measured: boolean; minutes: number }> = {};
  for (const pos of Object.keys(POSITION_PRIORS)) {
    const e = agg.get(pos);
    const minutes = e?.min ?? 0;
    if (!e || minutes < MIN_MINUTES_FOR_PRIOR) {
      out[pos] = { ...POSITION_PRIORS[pos], measured: false, minutes };
      continue;
    }
    const per90 = (x: number) => (x / (minutes / 90));
    out[pos] = {
      goals: per90(e.g),
      assists: per90(e.a),
      cards: per90(e.y),
      measured: true,
      minutes,
    };
  }
  return out;
}

/**
 * La distribución de minutos de un jugador, como una lista de (minutos, probabilidad).
 *
 * Discreta y corta a propósito: los minutos de un futbolista no son continuos en la
 * práctica, son «los 90», «le cambian», «entra un rato» y «no juega». Cuatro escenarios
 * describen el reparto mejor que una normal truncada, y se pueden explicar en la
 * tarjeta, que es la mitad del valor.
 */
export interface MinutesDistribution {
  points: { minutes: number; probability: number }[];
  expected: number;
  /** P(no juega ni un minuto). El número que más mueve una prop y el que nadie enseña. */
  pDidNotPlay: number;
}

/**
 * Partidos de prior sobre la TITULARIDAD.
 *
 * Es el mismo problema que las tasas, y en la instantánea con la que se desarrolló esto
 * se veía a la primera: en la jornada 1 todo el que jugó tiene `starts` = 1 sobre 1
 * partido, o sea una titularidad del 100 %, y las props salían con 79,9 minutos
 * esperados y un 0 % de no jugar PARA TODA LA PLANTILLA — el suplente con la misma
 * seguridad que el capitán. No era un fallo del código: era una división por un partido.
 *
 * Con 5 partidos de prior, un jugador con una titularidad de 1 sobre 1 sale en 0,53 —
 * «probablemente juega, pero no se sabe» — y hace falta media temporada para que su
 * propio registro mande. El prior es 11/plantilla: la probabilidad de que un miembro
 * cualquiera de la plantilla salga de inicio.
 */
export const STARTER_PRIOR_MATCHES = 5;

export function shrunkStarterShare(
  starts: number,
  teamMatches: number,
  squadSize: number,
): number {
  const prior = squadSize > 0 ? Math.min(1, 11 / squadSize) : 0.44;
  const k = STARTER_PRIOR_MATCHES;
  return (starts + k * prior) / (Math.max(1, teamMatches) + k);
}

/**
 * @param starterShare  proporción de partidos del equipo en los que fue titular
 * @param available     0..1, de `chance_next` o del estado de la ficha
 */
export function minutesDistribution(
  starterShare: number,
  available: number,
): MinutesDistribution {
  const s = Math.max(0, Math.min(1, starterShare));
  const a = Math.max(0, Math.min(1, available));

  // Titular: casi siempre acaba, a veces le cambian sobre el 70, alguna vez pronto.
  // Suplente: casi siempre entra poco, y muchas veces no entra.
  const points = [
    { minutes: 90, probability: a * s * 0.62 },
    { minutes: 70, probability: a * s * 0.28 },
    { minutes: 45, probability: a * s * 0.1 },
    { minutes: 25, probability: a * (1 - s) * 0.34 },
    { minutes: 10, probability: a * (1 - s) * 0.28 },
    { minutes: 0, probability: a * (1 - s) * 0.38 + (1 - a) },
  ];
  const expected = points.reduce((t, p) => t + p.minutes * p.probability, 0);
  const pDidNotPlay = points.filter((p) => p.minutes === 0).reduce((t, p) => t + p.probability, 0);
  return { points, expected, pDidNotPlay };
}

/** Tasa por minuto, encogida hacia la posición. */
export function shrunkRate(
  events: number,
  minutes: number,
  priorPer90: number,
  priorMatches = PRIOR_MATCHES,
): number {
  const priorMinutes = priorMatches * 90;
  return (events + (priorPer90 / 90) * priorMinutes) / (minutes + priorMinutes);
}

export interface PropDistribution {
  /** P(0), P(1), P(2)… del suceso para este jugador en este partido. */
  pmf: number[];
  /** P(al menos uno). El mercado que de verdad se cotiza. */
  atLeastOne: number;
  /** P(dos o más). */
  atLeastTwo: number;
  expected: number;
}

/**
 * La mezcla: para cada escenario de minutos, una Poisson con la media de ESE escenario.
 *
 * Poisson y no otra cosa porque a nivel de un jugador los sucesos son raros e
 * independientes dentro del partido; lo que rompe la Poisson en los totales de equipo es
 * el acoplamiento entre los dos equipos, que aquí no existe. La sobredispersión que se
 * ve entre jugadores la mete la MEZCLA sobre minutos, que es de donde de verdad viene.
 */
export function propDistribution(
  ratePerMinute: number,
  minutes: MinutesDistribution,
  maxCount = 4,
): PropDistribution {
  const pmf = new Array<number>(maxCount + 1).fill(0);
  for (const point of minutes.points) {
    if (point.probability <= 0) continue;
    const lambda = ratePerMinute * point.minutes;
    let p = Math.exp(-lambda);
    for (let k = 0; k <= maxCount; k++) {
      pmf[k] += point.probability * p;
      p = (p * lambda) / (k + 1);
    }
  }
  // La cola por encima de maxCount es minúscula pero existe; se deja fuera de la pmf y
  // se refleja en que la pmf no suma 1, en vez de repartirla y falsear P(0). Por eso
  // «al menos uno» se calcula como 1 − P(0) y no sumando la pmf: P(0) es exacta.
  const atLeastOne = 1 - pmf[0];
  const atLeastTwo = Math.max(0, 1 - pmf[0] - pmf[1]);
  return {
    pmf,
    atLeastOne,
    atLeastTwo,
    expected: ratePerMinute * minutes.expected,
  };
}

export interface PlayerProp {
  playerId: string;
  name: string;
  position: string;
  teamId: string;
  minutes: MinutesDistribution;
  /** Minutos jugados en la temporada, para que se vea cuánto respalda a la tasa. */
  minutesPlayed: number;
  /** Cuánto pesa el prior de la posición, de 0 a 1. 1 = todo prior. */
  priorWeight: number;
  /**
   * Titularidad estimada, ya encogida. Va en la respuesta porque es lo que explica los
   * minutos esperados, y sin ella un 53 % de titularidad parece un dato sobre el
   * jugador cuando puede ser «la temporada acaba de empezar».
   */
  starterShare: number;
  /** Partidos del equipo sobre los que se estimó. Pocos = la titularidad no está fijada. */
  teamMatches: number;
  goals: PropDistribution;
  assists: PropDistribution;
  cards: PropDistribution;
  /** Marca o asiste: el mercado más cotizado de los tres. */
  goalOrAssist: number;
}

/** Disponibilidad de 0 a 1, leída del estado de la ficha del jugador. */
export function availabilityOf(p: { status: string; chanceNext: number | null }): number {
  if (p.chanceNext != null) return Math.max(0, Math.min(1, p.chanceNext / 100));
  // 'a' disponible · 'd' en duda · 'i' lesionado · 's' sancionado · 'u' no disponible
  return p.status === 'a' ? 1 : p.status === 'd' ? 0.5 : 0;
}

export function buildPlayerProp(
  player: FbPlayerRow & { yellow_cards?: number },
  teamMatches: number,
  priors = POSITION_PRIORS,
  squadSize = 25,
): PlayerProp {
  const prior = priors[player.position] ?? priors.MID;
  const minutesPlayed = player.minutes ?? 0;
  const starterShare = shrunkStarterShare(player.starts ?? 0, teamMatches, squadSize);
  const available = availabilityOf({
    status: player.status ?? 'a',
    chanceNext: player.chance_next ?? null,
  });
  const minutes = minutesDistribution(starterShare, available);

  const goals = shrunkRate(player.goals ?? 0, minutesPlayed, prior.goals);
  const assists = shrunkRate(player.assists ?? 0, minutesPlayed, prior.assists);
  const cards = shrunkRate(player.yellow_cards ?? 0, minutesPlayed, prior.cards);

  const gd = propDistribution(goals, minutes);
  const ad = propDistribution(assists, minutes);
  const cd = propDistribution(cards, minutes, 2);

  return {
    playerId: player.id,
    name: player.name,
    position: player.position,
    teamId: player.team_id,
    minutes,
    minutesPlayed,
    priorWeight: (PRIOR_MATCHES * 90) / (minutesPlayed + PRIOR_MATCHES * 90),
    starterShare,
    teamMatches,
    goals: gd,
    assists: ad,
    cards: cd,
    // Goles y asistencias del mismo jugador en el mismo partido son casi excluyentes
    // (no te asistes a ti mismo) pero no independientes: los dos suben con los minutos.
    // Se combinan sobre la MISMA mezcla de minutos, que es lo que los correlaciona.
    goalOrAssist: combinedAtLeastOne(goals, assists, minutes),
  };
}

/** P(al menos un gol O al menos una asistencia), integrando sobre los mismos minutos. */
function combinedAtLeastOne(
  rateA: number,
  rateB: number,
  minutes: MinutesDistribution,
): number {
  let p = 0;
  for (const point of minutes.points) {
    if (point.probability <= 0) continue;
    const none = Math.exp(-(rateA + rateB) * point.minutes);
    p += point.probability * (1 - none);
  }
  return p;
}
