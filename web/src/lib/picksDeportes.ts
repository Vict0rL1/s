// Los picks de cada deporte (lib/picks.ts). Partido de picks.ts en la Fase 7.
import { type Pick, realMarket, devig2, devig3, type Candidate, toPicks } from './picksNucleo';

/** Football: 1X2, double chance, over/under 2.5, both teams to score. */
export function footballPicks(
  rows: {
    fixture: {
      id: string; commence_time: string; home_name: string; away_name: string;
      /** Elige la tabla de referencia del escalón. Ver BASE_RATE_TIER2. */
      league?: string;
      odds_home: number | null; odds_draw: number | null; odds_away: number | null;
      /** 'fixture' = this app invented the price from the model. See realMarket(). */
      source?: string;
    };
    prediction: {
      model: { home: number; draw: number; away: number };
      final: { home: number; draw: number; away: number };
      goals: { over25: number; under25: number; bothScore: number };
    } | null;
  }[],
): Pick[] {
  const out: Pick[] = [];
  for (const r of rows) {
    if (!r.prediction) continue;
    const f = r.fixture;
    // El 1X2 usa la probabilidad PUBLICADA (calibrada, y mezclada con el mercado donde
    // hay peso ajustado): es la creencia de la app y es contra la que hay que medir una
    // cuota. Los mercados de goles siguen saliendo de la rejilla cruda, porque el
    // calibrador se ajustó sobre el 1X2 y solo sabe corregir el 1X2 — aplicarlo a la
    // rejilla sería usarlo fuera de donde se midió.
    const m = r.prediction.final;
    const g = r.prediction.goals;
    const match = `${f.home_name} vs ${f.away_name}`;
    const has =
      realMarket(f.source) && f.odds_home != null && f.odds_draw != null && f.odds_away != null;
    const [mh, mx, ma] = has ? devig3(f.odds_home!, f.odds_draw!, f.odds_away!) : [null, null, null];

    const c: Candidate[] = [
      { market: '1X2', selection: f.home_name, modelProb: m.home, marketProb: mh, odds: f.odds_home },
      { market: '1X2', selection: 'Empate', modelProb: m.draw, marketProb: mx, odds: f.odds_draw },
      { market: '1X2', selection: f.away_name, modelProb: m.away, marketProb: ma, odds: f.odds_away },
      // Double chance. Not a separate model output — it is the complement of the
      // third outcome, which is why it can be offered honestly: P(1 o X) = 1 − P(2).
      // The odds are not published for it here, so it carries the de-vigged
      // probability and no price, and the panel shows the fair odds instead.
      {
        market: 'Doble oportunidad',
        selection: `${f.home_name} o empate`,
        modelProb: m.home + m.draw,
        marketProb: mh == null || mx == null ? null : mh + mx,
        odds: null,
      },
      {
        market: 'Doble oportunidad',
        selection: `${f.away_name} o empate`,
        modelProb: m.away + m.draw,
        marketProb: ma == null || mx == null ? null : ma + mx,
        odds: null,
      },
      // Goals. The feed this app uses only prices 1X2, so there is no market
      // probability to compare against — stated as such rather than faked.
      { market: 'Total de goles', selection: 'Over 2.5', modelProb: g.over25, marketProb: null, odds: null },
      { market: 'Total de goles', selection: 'Under 2.5', modelProb: g.under25, marketProb: null, odds: null },
      { market: 'Ambos marcan', selection: 'Sí', modelProb: g.bothScore, marketProb: null, odds: null },
      { market: 'Ambos marcan', selection: 'No', modelProb: 1 - g.bothScore, marketProb: null, odds: null },
    ];
    out.push(...toPicks(f.id, f.commence_time, match, c, f.league));
  }
  return out;
}

/** Baseball: winner, the total on its own line, and the ±1.5 run line. */
export function baseballPicks(
  rows: {
    game: {
      id: string; commence_time: string; home_name: string; away_name: string;
      odds_home: number | null; odds_away: number | null;
      source?: string;
    };
    prediction: {
      model: { home: number; away: number };
      runs: {
        totalLine: number; over: number; under: number;
        runLine: { homeCovers: number; awayCovers: number };
      };
    } | null;
  }[],
): Pick[] {
  const out: Pick[] = [];
  for (const r of rows) {
    if (!r.prediction) continue;
    const g = r.game;
    const p = r.prediction;
    const match = `${g.away_name} @ ${g.home_name}`;
    const has = realMarket(g.source) && g.odds_home != null && g.odds_away != null;
    const [mh, ma] = has ? devig2(g.odds_home!, g.odds_away!) : [null, null];
    const c: Candidate[] = [
      { market: 'Ganador', selection: g.home_name, modelProb: p.model.home, marketProb: mh, odds: g.odds_home },
      { market: 'Ganador', selection: g.away_name, modelProb: p.model.away, marketProb: ma, odds: g.odds_away },
      { market: 'Total de carreras', selection: `Over ${p.runs.totalLine}`, modelProb: p.runs.over, marketProb: null, odds: null },
      { market: 'Total de carreras', selection: `Under ${p.runs.totalLine}`, modelProb: p.runs.under, marketProb: null, odds: null },
      { market: 'Línea de carreras', selection: `${g.home_name} −1.5`, modelProb: p.runs.runLine.homeCovers, marketProb: null, odds: null },
      { market: 'Línea de carreras', selection: `${g.away_name} +1.5`, modelProb: p.runs.runLine.awayCovers, marketProb: null, odds: null },
    ];
    out.push(...toPicks(g.id, g.commence_time, match, c));
  }
  return out;
}

/**
 * Basketball: winner, the model's own handicap, and the total.
 *
 * A separate adapter from the NFL's rather than a shared "points sport" one,
 * because the two predictions genuinely differ in shape — basketball keeps its
 * spread and total inside `projection.distribution`, the NFL has them at the top
 * level with a push probability. Forcing one signature would mean a wrapper per
 * sport anyway, plus a lie about how alike they are.
 */
export function basketballPicks(
  rows: {
    game: {
      id: string; commence_time: string; home_name: string; away_name: string;
      home_odds: number | null; away_odds: number | null;
      source?: string;
    };
    prediction: {
      model: { probHome: number; probAway: number };
      projection: {
        distribution: {
          spreadLine: number; homeCovers: number;
          totalLine: number | null; over: number | null; under: number | null;
        };
      };
    } | null;
  }[],
): Pick[] {
  const out: Pick[] = [];
  for (const r of rows) {
    if (!r.prediction) continue;
    const g = r.game;
    const p = r.prediction;
    const d = p.projection.distribution;
    const match = `${g.away_name} @ ${g.home_name}`;
    const has = realMarket(g.source) && g.home_odds != null && g.away_odds != null;
    const [mh, ma] = has ? devig2(g.home_odds!, g.away_odds!) : [null, null];
    const c: Candidate[] = [
      { market: 'Ganador', selection: g.home_name, modelProb: p.model.probHome, marketProb: mh, odds: g.home_odds },
      { market: 'Ganador', selection: g.away_name, modelProb: p.model.probAway, marketProb: ma, odds: g.away_odds },
      {
        market: 'Hándicap',
        selection: `${g.home_name} ${d.spreadLine > 0 ? '+' : ''}${d.spreadLine}`,
        modelProb: d.homeCovers,
        marketProb: null,
        odds: null,
      },
      {
        market: 'Hándicap',
        selection: `${g.away_name} ${-d.spreadLine > 0 ? '+' : ''}${-d.spreadLine}`,
        modelProb: 1 - d.homeCovers,
        marketProb: null,
        odds: null,
      },
    ];
    if (d.totalLine != null && d.over != null && d.under != null) {
      c.push(
        { market: 'Total de puntos', selection: `Over ${d.totalLine}`, modelProb: d.over, marketProb: null, odds: null },
        { market: 'Total de puntos', selection: `Under ${d.totalLine}`, modelProb: d.under, marketProb: null, odds: null },
      );
    }
    out.push(...toPicks(g.id, g.commence_time, match, c));
  }
  return out;
}

/**
 * The NFL: winner, handicap, total.
 *
 * The one sport whose handicap probabilities carry a PUSH — the margin landing
 * exactly on the line, which in this sport is common enough to matter (3 and 7 are
 * where margins pile up). `cover` here excludes the push, so it is already the
 * probability of the bet winning rather than not losing.
 */
export function nflPicks(
  rows: {
    game: {
      id: string; commence_time: string; home_name: string; away_name: string;
      odds_home: number | null; odds_away: number | null;
      source?: string;
    };
    prediction: {
      model: { home: number; away: number; tie: number };
      final: { home: number; away: number };
      spread: { line: number; home: { cover: number }; away: { cover: number } };
      total: { line: number; over: number; under: number };
      // Derived from the closing handicap when there is no moneyline, which is the
      // normal case here — nflverse ships the line with the schedule.
      market?: { market: { home: number; away: number } | null } | null;
    } | null;
  }[],
): Pick[] {
  const out: Pick[] = [];
  for (const r of rows) {
    if (!r.prediction) continue;
    const g = r.game;
    const p = r.prediction;
    const match = `${g.away_name} @ ${g.home_name}`;
    const has = realMarket(g.source) && g.odds_home != null && g.odds_away != null;
    // Moneyline first when it exists; otherwise the probability read off the closing
    // line, which is the better forecast of the two on this sport and was being
    // thrown away — the column showed "—" on every row while the card had the number.
    const spreadMkt = p.market?.market ?? null;
    const [mh, ma] = has
      ? devig2(g.odds_home!, g.odds_away!)
      : spreadMkt
        ? [spreadMkt.home, spreadMkt.away]
        : [null, null];
    const c: Candidate[] = [
      // El ganador usa la probabilidad PUBLICADA, que en este deporte es la que más
      // cambia: el peso ajustado del modelo es 0,10 y el encogimiento se lleva incluso
      // eso cuando discrepa mucho del precio. Es justamente lo que hay que hacer con un
      // modelo que, medido, no le gana a la línea de cierre.
      { market: 'Ganador', selection: g.home_name, modelProb: p.final.home, marketProb: mh, odds: g.odds_home },
      { market: 'Ganador', selection: g.away_name, modelProb: p.final.away, marketProb: ma, odds: g.odds_away },
      {
        market: 'Hándicap',
        selection: `${g.home_name} ${p.spread.line > 0 ? '+' : ''}${p.spread.line}`,
        modelProb: p.spread.home.cover,
        marketProb: null,
        odds: null,
      },
      {
        market: 'Hándicap',
        selection: `${g.away_name} ${-p.spread.line > 0 ? '+' : ''}${-p.spread.line}`,
        modelProb: p.spread.away.cover,
        marketProb: null,
        odds: null,
      },
      { market: 'Total de puntos', selection: `Over ${p.total.line}`, modelProb: p.total.over, marketProb: null, odds: null },
      { market: 'Total de puntos', selection: `Under ${p.total.line}`, modelProb: p.total.under, marketProb: null, odds: null },
    ];
    out.push(...toPicks(g.id, g.commence_time, match, c));
  }
  return out;
}

/** Tennis: the winner. There is no second market the model produces. */
export function tennisPicks(
  rows: {
    match: {
      id: string; commence_time: string; p1_name: string; p2_name: string;
      p1_odds: number | null; p2_odds: number | null;
      source?: string;
    };
    prediction: { model: { prob1: number; prob2: number } } | null;
  }[],
): Pick[] {
  const out: Pick[] = [];
  for (const r of rows) {
    if (!r.prediction) continue;
    const m = r.match;
    const has = realMarket(m.source) && m.p1_odds != null && m.p2_odds != null;
    const [q1, q2] = has ? devig2(m.p1_odds!, m.p2_odds!) : [null, null];
    out.push(
      ...toPicks(m.id, m.commence_time, `${m.p1_name} vs ${m.p2_name}`, [
        { market: 'Ganador', selection: m.p1_name, modelProb: r.prediction.model.prob1, marketProb: q1, odds: m.p1_odds },
        { market: 'Ganador', selection: m.p2_name, modelProb: r.prediction.model.prob2, marketProb: q2, odds: m.p2_odds },
      ]),
    );
  }
  return out;
}

/**
 * NHL: el ganador (prórroga y tanda incluidas, el moneyline de la NHL). Sin post-proceso: lo publicado
 * es el modelo. El total de goles NO entra: sale de una media de goles de la liga fija repartida por el
 * Elo, así que dice casi lo mismo en todos los partidos («menos de 6,5» a un 55 % en cada uno) y no
 * se ha medido que gane a esa media. Está en la tarjeta; aquí sería ruido con apariencia de selección.
 */
export function nhlPicks(
  rows: {
    game: {
      id: string; commence_time: string; home_name: string; away_name: string;
      odds_home: number | null; odds_away: number | null;
      source?: string;
    };
    prediction: { final: { home: number; away: number } } | null;
  }[],
): Pick[] {
  const out: Pick[] = [];
  for (const r of rows) {
    if (!r.prediction) continue;
    const g = r.game;
    const p = r.prediction;
    const has = realMarket(g.source) && g.odds_home != null && g.odds_away != null;
    const [mh, ma] = has ? devig2(g.odds_home!, g.odds_away!) : [null, null];
    const c: Candidate[] = [
      { market: 'Ganador', selection: g.home_name, modelProb: p.final.home, marketProb: mh, odds: g.odds_home },
      { market: 'Ganador', selection: g.away_name, modelProb: p.final.away, marketProb: ma, odds: g.odds_away },
    ];
    out.push(...toPicks(g.id, g.commence_time, `${g.away_name} @ ${g.home_name}`, c));
  }
  return out;
}

/**
 * UFC: el ganador a dos vías (el empate y el «sin resultado» devuelven la apuesta). Sin post-proceso:
 * lo publicado es el modelo. Las peleas sin predicción (debuts, nombres compartidos) no entran.
 */
export function ufcPicks(
  rows: {
    fight: {
      id: string; commence_time: string; home_name: string; away_name: string;
      odds_home: number | null; odds_away: number | null;
      source?: string;
    };
    prediction: { final: { home: number; away: number } } | null;
  }[],
): Pick[] {
  const out: Pick[] = [];
  for (const r of rows) {
    if (!r.prediction) continue;
    const g = r.fight;
    const p = r.prediction;
    const has = realMarket(g.source) && g.odds_home != null && g.odds_away != null;
    const [ma, mb] = has ? devig2(g.odds_home!, g.odds_away!) : [null, null];
    const c: Candidate[] = [
      { market: 'Ganador', selection: g.home_name, modelProb: p.final.home, marketProb: ma, odds: g.odds_home },
      { market: 'Ganador', selection: g.away_name, modelProb: p.final.away, marketProb: mb, odds: g.odds_away },
    ];
    out.push(...toPicks(g.id, g.commence_time, `${g.home_name} vs ${g.away_name}`, c));
  }
  return out;
}
