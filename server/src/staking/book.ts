// La cartera entera de una vez: n candidatas dentro, n decisiones fuera.
//
// ===========================================================================
// POR QUÉ HACE FALTA UNA FUNCIÓN NUEVA Y NO BASTA CON LLAMAR N VECES A LA VIEJA
// ===========================================================================
// `decideStake` responde «¿cuánto pongo en ESTA?». Es la pregunta correcta cuando hay
// una, y la equivocada cuando hay ocho, porque tres de las cosas que deciden el tamaño
// solo se pueden saber mirándolas todas juntas:
//
//   · el factor de cartera, que depende de con quién más se comparte el riesgo
//   · el tope por día y por liga, que son sumas sobre subconjuntos
//   · la exposición agregada, que no es la suma de las exposiciones
//
// Llamar n veces a la función de una deja las tres sin gobierno, y el fallo no se ve:
// cada apuesta sale con su tamaño «prudente» y la cartera entera no lo es.
//
// ===========================================================================
// EL ORDEN, Y POR QUÉ ESE
// ===========================================================================
//   1. Cada candidata pasa por las puertas de siempre (ventaja, calibración, Kelly,
//      tope por evento, límites de pérdida). Lo que muere aquí no llega a la cartera.
//   2. Kelly de CARTERA sobre las supervivientes → un factor ≤ 1 por posición.
//   3. Los topes de exposición —total, por día, por liga— se aplican al final y en
//      orden de más restrictivo primero.
//
// El paso 3 va al final porque es un reparto: hay que saber cuánto pide cada una antes
// de decidir cuánto cabe. Y cuando no cabe todo, se recorta PROPORCIONALMENTE en vez de
// servir por orden de llegada: servir por orden dejaría la última a cero por el azar
// del orden de la lista, y ese azar no es un criterio de riesgo.

import {
  decideStake,
  lossState,
  exposureBreakdown,
  DEFAULT_CONFIG,
  type StakeDecision,
  type StakingConfig,
} from './policy.ts';
import { readCalibration, type CalibrationFile } from './calibration.ts';
import { portfolioFactors, type Candidate } from './portfolio.ts';
import { aggregateExposure, links, type Position } from './correlation.ts';

export interface BookCandidate {
  key: string;
  label: string;
  sport: string;
  league: string;
  /** El día por el que cuenta, YYYY-MM-DD. */
  day: string;
  /** Qué partido. Dos candidatas con el mismo valor comparten encuentro. */
  matchKey: string;
  market: Position['market'];
  side: Position['side'];
  p: number;
  odds: number;
}

export interface BookEntry {
  key: string;
  label: string;
  league: string;
  day: string;
  /** Lo que habría puesto el sizing por apuesta aislada. */
  soloStake: number;
  /** Lo que se pone de verdad. */
  stake: number;
  fraction: number;
  edge: number;
  /** Factor de Kelly de cartera, ≤ 1. */
  portfolioFactor: number;
  /** Recorte adicional por los topes de exposición. */
  exposureFactor: number;
  steps: StakeDecision['steps'];
  blockedBy: string | null;
}

export interface BookResult {
  entries: BookEntry[];
  /** La suma ingenua de lo que pediría cada apuesta por su cuenta. */
  naiveStake: number;
  /** Lo que de verdad se pone. */
  totalStake: number;
  /** Exposición agregada teniendo en cuenta la correlación. */
  aggregate: ReturnType<typeof aggregateExposure>;
  /** Los vínculos que movieron algo, el más fuerte primero. */
  links: ReturnType<typeof links>;
  /** Qué tope recortó y cuánto. */
  caps: { scope: string; limit: number; used: number; factor: number }[];
  notes: string[];
}

/**
 * Dimensionar una cartera.
 *
 * `openExposure` de cada llamada a `decideStake` se deja en 0 a propósito: el tope
 * total se aplica UNA vez al final, sobre la cartera completa. Pasarlo por candidata
 * volvería a hacer lo que esta función existe para evitar —que la primera de la lista
 * se lleve el margen y la última se quede sin— y encima lo aplicaría dos veces.
 */
export function decideBook(
  cands: BookCandidate[],
  bankroll: number,
  cfg: StakingConfig = DEFAULT_CONFIG,
  cal: CalibrationFile = readCalibration(),
  now = new Date(),
): BookResult {
  const notes: string[] = [];

  // --- 1. Las puertas de siempre, una a una ---
  const solo = cands.map((c) => ({
    c,
    d: decideStake(
      { sport: c.sport, p: c.p, odds: c.odds, bankroll, openExposure: 0 },
      cfg,
      cal,
      now,
    ),
  }));

  const alive = solo.filter((s) => s.d.stake > 0);
  const naiveStake = alive.reduce((a, s) => a + s.d.stake, 0);

  // --- 2. Kelly de cartera sobre las que siguen vivas ---
  const positions: Candidate[] = alive.map((s) => ({
    key: s.c.key,
    matchKey: s.c.matchKey,
    league: s.c.league,
    day: s.c.day,
    market: s.c.market,
    side: s.c.side,
    fraction: s.d.stake / bankroll,
    p: s.c.p,
    odds: s.c.odds,
  }));
  const pf = portfolioFactors(positions);
  if (positions.length > 1) notes.push(`Kelly de cartera: ${pf.explanation}`);

  const afterPortfolio = alive.map((s, i) => ({
    ...s,
    factor: pf.factors[i] ?? 1,
    want: s.d.stake * (pf.factors[i] ?? 1),
  }));

  // --- 3. Los topes de exposición ---
  const open = exposureBreakdown();
  const caps: BookResult['caps'] = [];

  /**
   * El factor de recorte de un cubo: cuánto cabe frente a cuánto se pide.
   *
   * Se cuenta lo YA pendiente dentro del mismo cubo, porque un tope diario que ignora
   * las apuestas que ya hay abiertas para hoy no es un tope diario.
   */
  const capFactor = (scope: string, limitFrac: number, used: number, wanted: number): number => {
    const limit = limitFrac * bankroll;
    const room = Math.max(0, limit - used);
    const factor = wanted > 0 ? Math.min(1, room / wanted) : 1;
    if (factor < 1) caps.push({ scope, limit, used, factor });
    return factor;
  };

  const wantedTotal = afterPortfolio.reduce((a, s) => a + s.want, 0);
  const totalFactor = capFactor('total', cfg.maxTotalExposure, open.total, wantedTotal);

  const dayFactor = new Map<string, number>();
  for (const day of new Set(afterPortfolio.map((s) => s.c.day))) {
    const wanted = afterPortfolio.filter((s) => s.c.day === day).reduce((a, s) => a + s.want, 0);
    dayFactor.set(
      day,
      capFactor(`día ${day}`, cfg.maxExposurePerDay, open.byDay.get(day) ?? 0, wanted),
    );
  }

  const leagueFactor = new Map<string, number>();
  for (const lg of new Set(afterPortfolio.map((s) => s.c.league))) {
    const wanted = afterPortfolio.filter((s) => s.c.league === lg).reduce((a, s) => a + s.want, 0);
    leagueFactor.set(
      lg,
      capFactor(`liga ${lg}`, cfg.maxExposurePerLeague, open.byLeague.get(lg) ?? 0, wanted),
    );
  }

  const byKey = new Map(afterPortfolio.map((s) => [s.c.key, s]));
  const entries: BookEntry[] = solo.map(({ c, d }) => {
    const a = byKey.get(c.key);
    if (!a) {
      return {
        key: c.key,
        label: c.label,
        league: c.league,
        day: c.day,
        soloStake: d.stake,
        stake: 0,
        fraction: 0,
        edge: d.edge,
        portfolioFactor: 0,
        exposureFactor: 0,
        steps: d.steps,
        blockedBy: d.blockedBy,
      };
    }
    // El más restrictivo de los tres manda. Multiplicarlos recortaría tres veces por
    // lo mismo: los topes son condiciones que hay que cumplir a la vez, no descuentos
    // que se acumulan.
    const expFactor = Math.min(totalFactor, dayFactor.get(c.day) ?? 1, leagueFactor.get(c.league) ?? 1);
    // Hacia abajo a céntimos, como en la puerta 6: redondear al más cercano puede subir
    // por encima del tope que se acaba de aplicar.
    const stake = Math.floor(a.want * expFactor * 100) / 100;
    return {
      key: c.key,
      label: c.label,
      league: c.league,
      day: c.day,
      soloStake: d.stake,
      stake,
      fraction: stake / bankroll,
      edge: d.edge,
      portfolioFactor: a.factor,
      exposureFactor: expFactor,
      steps: [
        ...d.steps,
        {
          gate: '7 · Kelly de cartera',
          result:
            a.factor >= 0.999
              ? 'sin recorte: no comparte riesgo con las demás'
              : `×${a.factor.toFixed(2)} por correlación con el resto de la cartera`,
        },
        {
          gate: '8 · topes de exposición',
          result:
            expFactor >= 0.999
              ? 'cabe entera en el total, el día y la liga'
              : `×${expFactor.toFixed(2)} — recortado por el tope más ajustado de los tres`,
        },
      ],
      blockedBy: stake <= 0 ? (d.blockedBy ?? 'sin margen de exposición') : null,
    };
  });

  const placed = entries.filter((e) => e.stake > 0);
  const aggregate = aggregateExposure(
    placed.map((e) => {
      const c = cands.find((x) => x.key === e.key)!;
      return {
        key: e.key,
        matchKey: c.matchKey,
        league: c.league,
        day: c.day,
        market: c.market,
        side: c.side,
        fraction: e.fraction,
      };
    }),
  );

  const loss = lossState(bankroll, cfg, now);
  if (loss.dayBreached || loss.weekBreached) {
    notes.push('Operativa cortada por límite de pérdida: ninguna apuesta se dimensiona.');
  }

  return {
    entries,
    naiveStake,
    totalStake: placed.reduce((a, e) => a + e.stake, 0),
    aggregate,
    links: links(
      placed.map((e) => {
        const c = cands.find((x) => x.key === e.key)!;
        return {
          key: e.key,
          matchKey: c.matchKey,
          league: c.league,
          day: c.day,
          market: c.market,
          side: c.side,
          fraction: e.fraction,
        };
      }),
    ),
    caps,
    notes,
  };
}
