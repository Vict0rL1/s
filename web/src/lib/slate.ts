// La tabla de PARTIDOS: una fila por partido, con o sin cuotas.
//
// ===========================================================================
// POR QUÉ NO BASTA CON `picks.ts`
// ===========================================================================
// `PicksPanel` es una tabla de MERCADOS ordenada por discrepancia con el precio, y por
// eso desaparece cuando no hay precio: `if (considered === 0) return null`. En la NFL
// eso pasa siempre que las casas no han publicado línea, porque la NFL es el único
// deporte que no se inventa cuotas. Resultado: la pestaña se quedaba sin ninguna vista
// de conjunto, y desde fuera parecía que faltaba algo.
//
// No es lo mismo «el modelo no discrepa del mercado» que «no hay partidos que enseñar».
// Lo primero es un hallazgo sobre los precios; lo segundo es una pantalla vacía. Esta
// tabla contesta a la pregunta de la que nadie debería quedarse sin respuesta —«¿qué se
// juega y qué dice el modelo?»— y esa pregunta no tiene nada que ver con las cuotas.
//
// Así que las columnas de mercado son OPCIONALES por diseño: cuando no hay precio, la
// fila sigue teniendo sentido y esas dos celdas dicen «—». Un guion es una respuesta
// honesta; una tabla que no aparece no lo es.

import { devig2, realMarket } from './picks';

export interface SlateRow {
  id: string;
  /** ISO de inicio. */
  when: string;
  /** El emparejamiento tal y como se lee: «Away @ Home», «A vs B». */
  match: string;
  /** El lado que el modelo ve favorito, y su probabilidad. */
  pick: string;
  pickProb: number;
  /**
   * La probabilidad del MISMO lado según el mercado, sin margen. Null = no hay precio,
   * o el que hay se lo ha inventado la app (ver `realMarket`), que para comparar es lo
   * mismo que no tener ninguno.
   */
  marketProb: number | null;
  /** La cuota decimal de ese lado, cuando existe de verdad. */
  odds: number | null;
  /** El empate, solo en fútbol: sin él la fila miente sobre lo que suman los dos lados. */
  drawProb?: number;
  league?: string;
}

/** El favorito entre dos lados, con su nombre y su probabilidad. */
function mejor(
  a: { name: string; p: number; mp: number | null; odds: number | null },
  b: { name: string; p: number; mp: number | null; odds: number | null },
): { pick: string; pickProb: number; marketProb: number | null; odds: number | null } {
  const g = a.p >= b.p ? a : b;
  return { pick: g.name, pickProb: g.p, marketProb: g.mp, odds: g.odds };
}

export function footballSlate(
  rows: {
    fixture: {
      id: string; commence_time: string; home_name: string; away_name: string;
      league?: string;
      odds_home: number | null; odds_draw: number | null; odds_away: number | null;
      source?: string;
    };
    prediction: { final: { home: number; draw: number; away: number } } | null;
  }[],
): SlateRow[] {
  const out: SlateRow[] = [];
  for (const r of rows) {
    if (!r.prediction) continue;
    const f = r.fixture;
    const m = r.prediction.final;
    // El fútbol tiene tres salidas, así que quitar el margen con `devig2` sería quitarlo
    // de dos de tres y repartir mal el resto. Se hace a mano sobre las tres.
    const has =
      realMarket(f.source) && f.odds_home != null && f.odds_draw != null && f.odds_away != null;
    let mh: number | null = null;
    let ma: number | null = null;
    if (has) {
      const raw = [1 / f.odds_home!, 1 / f.odds_draw!, 1 / f.odds_away!];
      const s = raw[0] + raw[1] + raw[2];
      mh = raw[0] / s;
      ma = raw[2] / s;
    }
    out.push({
      id: f.id,
      when: f.commence_time,
      match: `${f.home_name} vs ${f.away_name}`,
      league: f.league,
      drawProb: m.draw,
      ...mejor(
        { name: f.home_name, p: m.home, mp: mh, odds: has ? f.odds_home : null },
        { name: f.away_name, p: m.away, mp: ma, odds: has ? f.odds_away : null },
      ),
    });
  }
  return out;
}

export function tennisSlate(
  rows: {
    match: {
      id: string; commence_time: string; p1_name: string; p2_name: string;
      p1_odds: number | null; p2_odds: number | null; source?: string;
    };
    prediction: { model: { prob1: number; prob2: number } } | null;
  }[],
): SlateRow[] {
  const out: SlateRow[] = [];
  for (const r of rows) {
    if (!r.prediction) continue;
    const m = r.match;
    const has = realMarket(m.source) && m.p1_odds != null && m.p2_odds != null;
    const [q1, q2] = has ? devig2(m.p1_odds!, m.p2_odds!) : [null, null];
    out.push({
      id: m.id,
      when: m.commence_time,
      match: `${m.p1_name} vs ${m.p2_name}`,
      ...mejor(
        { name: m.p1_name, p: r.prediction.model.prob1, mp: q1, odds: has ? m.p1_odds : null },
        { name: m.p2_name, p: r.prediction.model.prob2, mp: q2, odds: has ? m.p2_odds : null },
      ),
    });
  }
  return out;
}

export function basketballSlate(
  rows: {
    game: {
      id: string; commence_time: string; home_name: string; away_name: string;
      home_odds: number | null; away_odds: number | null; source?: string;
    };
    prediction: { model: { probHome: number; probAway: number } } | null;
  }[],
): SlateRow[] {
  const out: SlateRow[] = [];
  for (const r of rows) {
    if (!r.prediction) continue;
    const g = r.game;
    const has = realMarket(g.source) && g.home_odds != null && g.away_odds != null;
    const [mh, ma] = has ? devig2(g.home_odds!, g.away_odds!) : [null, null];
    out.push({
      id: g.id,
      when: g.commence_time,
      match: `${g.home_name} vs ${g.away_name}`,
      ...mejor(
        { name: g.home_name, p: r.prediction.model.probHome, mp: mh, odds: has ? g.home_odds : null },
        { name: g.away_name, p: r.prediction.model.probAway, mp: ma, odds: has ? g.away_odds : null },
      ),
    });
  }
  return out;
}

export function baseballSlate(
  rows: {
    game: {
      id: string; commence_time: string; home_name: string; away_name: string;
      odds_home: number | null; odds_away: number | null; source?: string;
    };
    prediction: { model: { home: number; away: number } } | null;
  }[],
): SlateRow[] {
  const out: SlateRow[] = [];
  for (const r of rows) {
    if (!r.prediction) continue;
    const g = r.game;
    const has = realMarket(g.source) && g.odds_home != null && g.odds_away != null;
    const [mh, ma] = has ? devig2(g.odds_home!, g.odds_away!) : [null, null];
    out.push({
      id: g.id,
      when: g.commence_time,
      match: `${g.home_name} vs ${g.away_name}`,
      ...mejor(
        { name: g.home_name, p: r.prediction.model.home, mp: mh, odds: has ? g.odds_home : null },
        { name: g.away_name, p: r.prediction.model.away, mp: ma, odds: has ? g.odds_away : null },
      ),
    });
  }
  return out;
}

export function nflSlate(
  rows: {
    game: {
      id: string; commence_time: string; home_name: string; away_name: string;
      odds_home: number | null; odds_away: number | null; source?: string;
    };
    prediction: {
      final: { home: number; away: number };
      market?: { market: { home: number; away: number } | null } | null;
    } | null;
  }[],
): SlateRow[] {
  const out: SlateRow[] = [];
  for (const r of rows) {
    if (!r.prediction) continue;
    const g = r.game;
    const p = r.prediction;
    const has = realMarket(g.source) && g.odds_home != null && g.odds_away != null;
    // La NFL casi nunca trae moneyline, pero SÍ trae la línea de cierre con el
    // calendario, y de ahí sale una probabilidad de mercado perfectamente buena — en
    // este deporte, mejor que la del modelo. Tirarla y enseñar «—» sería esconder el
    // único número que ya se tiene.
    const spreadMkt = p.market?.market ?? null;
    const [mh, ma] = has
      ? devig2(g.odds_home!, g.odds_away!)
      : spreadMkt
        ? [spreadMkt.home, spreadMkt.away]
        : [null, null];
    out.push({
      id: g.id,
      when: g.commence_time,
      match: `${g.away_name} @ ${g.home_name}`,
      ...mejor(
        { name: g.home_name, p: p.final.home, mp: mh, odds: has ? g.odds_home : null },
        { name: g.away_name, p: p.final.away, mp: ma, odds: has ? g.odds_away : null },
      ),
    });
  }
  return out;
}
