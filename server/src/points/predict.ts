// La predicción completa desde el modelo de puntos, y las reglas de cada torneo.
//
// ===========================================================================
// UN SOLO SITIO DONDE SE DECIDE LA REGLA DEL SET DECISIVO
// ===========================================================================
// El set final no se juega igual en todas partes, y la diferencia no es cosmética: cambia
// el total de juegos esperado y, con dos sacadores parejos, también quién gana.
//
// La historia reciente, que es justo el rango de datos de esta app:
//   · hasta 2018  Wimbledon, Roland Garros y el Abierto de Australia: set largo
//   · 2019-2021   cada Grand Slam con su propia regla (Wimbledon TB a 7 en 12-12,
//                 Australia TB a 10, US Open TB a 7, Roland Garros set largo)
//   · desde 2022  los cuatro con tiebreak a 10 en el set decisivo
//
// Guardarlo en un solo sitio con la fecha es lo que permite puntuar el pasado con las
// reglas que de verdad regían entonces, en vez de con las de hoy.

import { matchDistribution, STANDARD_SET, type MatchRules, type SetRules } from './markets.ts';
import { pointProbs, type PointsModel, type Surface } from './fit.ts';

const TB10: SetRules = { tiebreak: true, tiebreakTo: 10 };
const LONG: SetRules = { tiebreak: false, tiebreakTo: 7 };

/**
 * La regla del set decisivo de un torneo en una fecha.
 *
 * El nombre del torneo llega como texto libre del archivo de Sackmann, así que se
 * reconoce por subcadena. Lo que NO se hace es adivinar: cualquier torneo que no sea uno
 * de los cuatro grandes usa la regla estándar, que es la correcta para el circuito.
 */
export function decidingSetRules(tourneyName: string | null | undefined, date: string): SetRules {
  const name = (tourneyName ?? '').toLowerCase();
  const year = Number(date.slice(0, 4)) || 0;
  const isSlam =
    name.includes('wimbledon') ||
    name.includes('roland') ||
    name.includes('french open') ||
    name.includes('us open') ||
    name.includes('australian open');
  if (!isSlam) return STANDARD_SET;

  if (year >= 2022) return TB10;
  if (year >= 2019) {
    if (name.includes('australian')) return TB10;
    if (name.includes('us open')) return STANDARD_SET;
    // Wimbledon jugaba tiebreak a 7 pero solo al llegar a 12-12, así que hasta ahí es un
    // set largo. Modelarlo como set largo se acerca mucho más que como tiebreak a 6-6.
    if (name.includes('wimbledon')) return LONG;
    return LONG; // Roland Garros
  }
  // Antes de 2019, solo el US Open tenía tiebreak en el quinto.
  return name.includes('us open') ? STANDARD_SET : LONG;
}

export function matchRulesFor(
  bestOf: number,
  tourneyName?: string | null,
  date = '20260101',
): MatchRules {
  return {
    bestOf: bestOf === 5 ? 5 : 3,
    set: STANDARD_SET,
    decidingSet: bestOf === 5 ? decidingSetRules(tourneyName, date) : STANDARD_SET,
  };
}

export interface PointsPrediction {
  /** Las dos probabilidades de punto, que es TODO lo que entra en lo demás. */
  points: { p1: number; p2: number };
  /** P(gana el jugador 1). */
  matchProb: number;
  /** P(el jugador 1 gana un set cualquiera). */
  setProb: number;
  setScores: { label: string; side: 1 | 2; probability: number }[];
  /** Total de juegos: línea, probabilidad de over, y la esperanza. */
  totals: { line: number; over: number; under: number }[];
  expectedGames: number;
  /** Hándicaps de juegos habituales. */
  handicaps: { handicap: number; cover: number }[];
  /** De quién no se sabe nada. Con esto puesto, el resto no habla de este partido. */
  unknown: { p1: boolean; p2: boolean };
  detail: ReturnType<typeof pointProbs>['detail'];
}

/** Líneas que se publican. Media unidad siempre: en tenis no hay empate posible. */
const TOTAL_LINES_OFFSETS = [-4, -2, 0, 2, 4];
const HANDICAPS = [-6.5, -4.5, -3.5, -2.5, -1.5, 1.5, 2.5, 3.5, 4.5, 6.5];

/**
 * Todos los mercados de un partido, del mismo modelo de puntos.
 *
 * Las líneas de totales se centran en la ESPERANZA del propio modelo en vez de ser una
 * lista fija: publicar «más de 20.5» para un partido de 45 juegos esperados es publicar
 * un 99 % que no informa de nada. Se centran donde la distribución tiene masa.
 */
export function predictFromPoints(
  model: PointsModel,
  id1: number,
  id2: number,
  surface: Surface,
  bestOf: number,
  tourneyName?: string | null,
  date?: string,
): PointsPrediction {
  const pp = pointProbs(model, id1, id2, surface);
  const rules = matchRulesFor(bestOf, tourneyName, date);
  // Quién saca primero no se sabe antes del partido (lo decide un sorteo), así que se
  // promedia sobre las dos posibilidades. Fijar uno sesgaría los hándicaps de juegos.
  const a = matchDistribution(pp.p1, pp.p2, 1, rules);
  const b = matchDistribution(pp.p1, pp.p2, 2, rules);

  const blend = <T extends Record<string, number>>(xs: T[], ys: T[], key: keyof T, value: keyof T): T[] => {
    const m = new Map<number, number>();
    for (const x of xs) m.set(x[key] as number, ((m.get(x[key] as number) ?? 0) + (x[value] as number) / 2));
    for (const y of ys) m.set(y[key] as number, ((m.get(y[key] as number) ?? 0) + (y[value] as number) / 2));
    return [...m.entries()]
      .map(([k, v]) => ({ [key]: k, [value]: v }) as unknown as T)
      .sort((p, q) => (p[key] as number) - (q[key] as number));
  };

  const totalGames = blend(a.totalGames, b.totalGames, 'games' as never, 'probability' as never) as {
    games: number;
    probability: number;
  }[];
  const gameMargin = blend(a.gameMargin, b.gameMargin, 'margin' as never, 'probability' as never) as {
    margin: number;
    probability: number;
  }[];

  const expectedGames = totalGames.reduce((acc, x) => acc + x.games * x.probability, 0);
  const centre = Math.round(expectedGames);

  const overAt = (line: number): number =>
    totalGames.reduce((acc, x) => acc + (x.games > line ? x.probability : 0), 0);
  const coverAt = (h: number): number =>
    gameMargin.reduce((acc, x) => acc + (x.margin + h > 0 ? x.probability : 0), 0);

  const setScoreMap = new Map<string, number>();
  for (const src of [a.setScores, b.setScores]) {
    for (const s of src) {
      const k = `${s.side}|${s.label}`;
      setScoreMap.set(k, (setScoreMap.get(k) ?? 0) + s.probability / 2);
    }
  }

  return {
    points: { p1: pp.p1, p2: pp.p2 },
    matchProb: (a.matchProb + b.matchProb) / 2,
    setProb: (a.setProb + b.setProb) / 2,
    setScores: [...setScoreMap.entries()]
      .map(([k, probability]) => {
        const [side, label] = k.split('|');
        return { label, side: Number(side) as 1 | 2, probability };
      })
      .sort((x, y) => y.probability - x.probability),
    totals: TOTAL_LINES_OFFSETS.map((o) => {
      const line = centre + o + 0.5;
      const over = overAt(line);
      return { line, over, under: 1 - over };
    }),
    expectedGames,
    handicaps: HANDICAPS.map((handicap) => ({ handicap, cover: coverAt(handicap) })),
    unknown: { p1: pp.unknown1, p2: pp.unknown2 },
    detail: pp.detail,
  };
}
