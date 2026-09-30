// Córners y tarjetas por equipo: el mismo esqueleto que los goles, otra distribución.
//
// ===========================================================================
// POR QUÉ NO SE REUTILIZA EL DIXON-COLES TAL CUAL
// ===========================================================================
// El esqueleto sí: media = nivel de la liga × lo que genera este equipo × lo que
// concede el rival × ventaja de campo. Eso vale para cualquier conteo.
//
// Lo que NO se reutiliza es la familia. Los goles de un equipo están casi en Poisson
// (var/media 0,95) y los córners y las tarjetas se esperan SOBREdispersos, por un motivo
// que no existe en los goles: hay un factor común a todo el partido que ninguno de los
// dos equipos controla. El árbitro. Hay quien saca seis tarjetas y quien saca una, y eso
// mueve las dos cuentas del partido a la vez.
//
// Así que la familia no se elige aquí: se mide. `fitCounts` contrasta la dispersión y
// devuelve Poisson o binomial negativa según lo que salga, y el modelo guarda cuál fue y
// con qué z — para que la decisión se pueda discutir en vez de tener que creerla.
//
// ===========================================================================
// Y POR QUÉ NO HAY DATOS AQUÍ
// ===========================================================================
// Los córners y las tarjetas por partido los publica football-data.co.uk (columnas
// HC/AC/HY/AY/HR/AR) y la ingesta las lee desde ahora. Pero ese sitio no es alcanzable
// desde el entorno donde se desarrolló esto, y las dos fuentes que SÍ lo son
// —openfootball y footballcsv— traen únicamente marcadores. Comprobado: el CSV de
// footballcsv tiene exactamente cinco columnas, `Round,Date,Team 1,FT,Team 2`.
//
// De modo que este modelo se queda APAGADO mientras las columnas estén vacías, y lo dice
// en vez de rellenar el hueco con una media de liga inventada. En una máquina que
// alcance football-data.co.uk, `npm run update-data:fb` las llena y el modelo se
// enciende solo — no hay nada más que hacer.

import { getDb, getMeta, setMeta } from '../db.ts';
import { fitCounts, countPmf, withMean, type CountModel } from '../markets/counts.ts';

export type CountMarket = 'corners' | 'cards';

/** Lo que hace falta saber de una liga para cotizar sus córners o sus tarjetas. */
export interface TeamCountModel {
  market: CountMarket;
  /** Cuenta media por equipo y partido, ya separada por localía. */
  baseHome: number;
  baseAway: number;
  /** Multiplicador de lo que GENERA cada equipo, respecto a la media de la liga. */
  generated: Record<string, number>;
  /** Multiplicador de lo que CONCEDE cada equipo. */
  conceded: Record<string, number>;
  /** La familia elegida y su dispersión medida. */
  distribution: CountModel;
  matches: number;
}

/**
 * Cuántos partidos de prior pesa el multiplicador de un equipo.
 *
 * Mismo principio que los priors del Dixon-Coles y que las tasas de los jugadores: un
 * equipo con cuatro partidos y muchos córners no es el que más córners genera de la
 * liga, es un equipo del que no se sabe nada. Con 20 partidos de prior, hacen falta unas
 * 20 jornadas para que su propio ritmo pese la mitad.
 */
const PRIOR_MATCHES = 20;

const KEY = (league: string, market: CountMarket): string => `fb_counts_${market}_${league}`;

interface Row {
  home_id: string;
  away_id: string;
  h: number;
  a: number;
}

function readRows(league: string, market: CountMarket, maxSeason: number): Row[] {
  const cols =
    market === 'corners'
      ? ['home_corners', 'away_corners']
      : ['home_yellows', 'away_yellows'];
  return getDb()
    .prepare(
      `SELECT home_id, away_id, ${cols[0]} h, ${cols[1]} a
       FROM fb_matches
       WHERE league = ? AND season < ? AND ${cols[0]} IS NOT NULL AND ${cols[1]} IS NOT NULL`,
    )
    .all(league, maxSeason) as unknown as Row[];
}

/**
 * Ajustar el modelo de una liga. `null` si no hay datos, que es el caso normal aquí.
 *
 * Los multiplicadores salen de un par de pasadas alternas: con las medias de la liga
 * fijas se estima lo que genera y concede cada equipo, y con eso se recalculan. Dos
 * pasadas bastan — no es un ajuste conjunto como el Dixon-Coles porque estos conteos son
 * mucho más ruidosos y un optimizador completo aquí ajustaría ruido con más decimales.
 */
export function fitTeamCounts(
  league: string,
  market: CountMarket,
  maxSeason = 9999,
): TeamCountModel | null {
  const rows = readRows(league, market, maxSeason);
  if (rows.length < 200) return null;

  const baseHome = rows.reduce((s, r) => s + r.h, 0) / rows.length;
  const baseAway = rows.reduce((s, r) => s + r.a, 0) / rows.length;
  if (!(baseHome > 0) || !(baseAway > 0)) return null;

  const generated: Record<string, number> = {};
  const conceded: Record<string, number> = {};
  const teams = new Set<string>();
  for (const r of rows) {
    teams.add(r.home_id);
    teams.add(r.away_id);
  }
  for (const t of teams) {
    generated[t] = 1;
    conceded[t] = 1;
  }

  for (let pass = 0; pass < 2; pass++) {
    const gen = new Map<string, { got: number; exp: number }>();
    const con = new Map<string, { got: number; exp: number }>();
    const bump = (m: Map<string, { got: number; exp: number }>, k: string, got: number, exp: number) => {
      const e = m.get(k) ?? { got: 0, exp: 0 };
      e.got += got;
      e.exp += exp;
      m.set(k, e);
    };
    for (const r of rows) {
      bump(gen, r.home_id, r.h, baseHome * conceded[r.away_id]);
      bump(gen, r.away_id, r.a, baseAway * conceded[r.home_id]);
      bump(con, r.away_id, r.h, baseHome * generated[r.home_id]);
      bump(con, r.home_id, r.a, baseAway * generated[r.away_id]);
    }
    // Encogimiento hacia 1: (observado + prior) / (esperado + prior), con el prior en
    // las mismas unidades que lo esperado. Con pocos partidos el cociente tiende a 1,
    // que es «como la media de la liga» — la única afirmación defendible sin datos.
    for (const t of teams) {
      const g = gen.get(t);
      const c = con.get(t);
      const priorG = PRIOR_MATCHES * ((baseHome + baseAway) / 2);
      if (g) generated[t] = (g.got + priorG) / (g.exp + priorG);
      if (c) conceded[t] = (c.got + priorG) / (c.exp + priorG);
    }
  }

  // La familia se decide sobre los RESIDUOS estandarizados, no sobre la muestra cruda:
  // la muestra cruda mezcla la heterogeneidad entre partidos con la dispersión dentro de
  // cada uno, y es esa mezcla la que hace parecer sobredisperso algo que no lo está.
  // Escalando cada cuenta a una media común queda solo lo segundo.
  const scaled: number[] = [];
  for (const r of rows) {
    const eh = baseHome * generated[r.home_id] * conceded[r.away_id];
    const ea = baseAway * generated[r.away_id] * conceded[r.home_id];
    // Se reescala al nivel medio de la liga para que la dispersión sea comparable.
    scaled.push((r.h * baseHome) / Math.max(0.1, eh), (r.a * baseAway) / Math.max(0.1, ea));
  }
  const distribution = fitCounts(scaled.map((x) => Math.round(x)));
  if (!distribution) return null;

  return { market, baseHome, baseAway, generated, conceded, distribution, matches: rows.length };
}

export function storeTeamCounts(league: string, market: CountMarket, m: TeamCountModel | null): void {
  setMeta(KEY(league, market), m ? JSON.stringify(m) : '');
}

const cache = new Map<string, { raw: string; model: TeamCountModel }>();

export function getTeamCounts(league: string, market: CountMarket): TeamCountModel | null {
  const raw = getMeta(KEY(league, market));
  if (!raw) return null;
  const k = KEY(league, market);
  const hit = cache.get(k);
  if (hit && hit.raw === raw) return hit.model;
  try {
    const model = JSON.parse(raw) as TeamCountModel;
    cache.set(k, { raw, model });
    return model;
  } catch {
    return null;
  }
}

export function clearTeamCountsCache(): void {
  cache.clear();
}

export interface CountForecast {
  market: CountMarket;
  /** Cuenta esperada de cada equipo y del total. */
  home: number;
  away: number;
  total: number;
  /** P(total > línea) para las líneas que de verdad se cotizan. */
  lines: { line: number; over: number }[];
  /** La familia usada, para poder decirlo en la tarjeta. */
  distribution: 'poisson' | 'negbin';
  /** var/media medida en la liga. 1 = Poisson exacta. */
  dispersion: number;
}

/** Las líneas habituales de cada mercado. Fuera de estas nadie cotiza. */
const LINES: Record<CountMarket, number[]> = {
  corners: [7.5, 8.5, 9.5, 10.5, 11.5, 12.5],
  cards: [1.5, 2.5, 3.5, 4.5, 5.5],
};

export function forecastCounts(
  model: TeamCountModel,
  homeId: string,
  awayId: string,
): CountForecast | null {
  const g = model.generated[homeId];
  const c = model.conceded[awayId];
  const g2 = model.generated[awayId];
  const c2 = model.conceded[homeId];
  if (g == null || c == null || g2 == null || c2 == null) return null;

  const home = model.baseHome * g * c;
  const away = model.baseAway * g2 * c2;
  // El TOTAL se modela directamente con su propia media, no como la suma de dos
  // distribuciones independientes: el factor común del partido —el árbitro en las
  // tarjetas, el estilo en los córners— correlaciona las dos cuentas, y sumarlas como
  // independientes subestimaría la cola justo donde viven las líneas altas.
  const pmf = countPmf(withMean(model.distribution, home + away), 40);
  return {
    market: model.market,
    home,
    away,
    total: home + away,
    lines: LINES[model.market].map((line) => ({
      line,
      over: pmf.slice(Math.ceil(line)).reduce((a, b) => a + b, 0),
    })),
    distribution: model.distribution.kind,
    dispersion: model.distribution.dispersion,
  };
}
