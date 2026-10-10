// El modelo de la NHL en sombra (Fase 8.1): Elo con margen de goles y goles por Poisson.
//
// ===========================================================================
// LO QUE ES Y LO QUE TODAVÍA NO
// ===========================================================================
// Un Elo de equipo (K, ventaja de campo y multiplicador por diferencia de goles, como el del resto de
// deportes de equipo de la app) y, encima, una Poisson por equipo cuyo reparto de goles se ajusta para
// que la probabilidad de ganar —prórroga y tanda incluidas— sea EXACTAMENTE la del Elo. De ahí salen
// el ganador (moneyline), el empate a 60 minutos y el total de goles.
//
// Los parámetros de abajo son los de partida. Con la historia ya bajada (21.960 partidos, 2009-10 en
// adelante) se probó a ajustarlos por el registro de experimentos (`nhl/ajuste.ts`): ninguna
// alternativa mejoró de forma demostrable en la validación 2024-25, así que se quedan.

export type ParamsNhl = { inicial: number; k: number; campo: number; golesLiga: number; fuerzaProrroga: number; maxGoles: number; regresion: number };

export const NHL: ParamsNhl = {
  /** Elo inicial de un equipo nuevo. */
  inicial: 1500,
  /** Paso de actualización. */
  k: 6,
  /** Ventaja de jugar en casa, en puntos de Elo. */
  campo: 35,
  /** Goles esperados a 60 minutos entre los dos, sin prórroga. */
  golesLiga: 6.0,
  /** La prórroga y la tanda, a la mitad de fuerza del Elo: son más azar que el partido. */
  fuerzaProrroga: 0.5,
  /** Hasta cuántos goles por equipo se suma la Poisson. */
  maxGoles: 15,
  /** Al empezar cada temporada, cuánto vuelve cada Elo hacia la media (0 = nada). */
  regresion: 0,
};

export const esperado = (dr: number) => 1 / (1 + 10 ** (-dr / 400));

function poisson(l: number, max: number): number[] {
  const p = [Math.exp(-l)];
  for (let k = 1; k <= max; k++) p.push((p[k - 1] * l) / k);
  return p;
}

/** Ganar en los 60 minutos, empatar y perder, con dos medias de goles. */
export function resultado60(lh: number, la: number, max = NHL.maxGoles): { gana: number; empata: number; pierde: number; grid: number[][] } {
  const ph = poisson(lh, max);
  const pa = poisson(la, max);
  let gana = 0;
  let empata = 0;
  let pierde = 0;
  const grid = ph.map((x) => pa.map((y) => x * y));
  for (let i = 0; i <= max; i++)
    for (let j = 0; j <= max; j++) {
      if (i > j) gana += grid[i][j];
      else if (i === j) empata += grid[i][j];
      else pierde += grid[i][j];
    }
  const s = gana + empata + pierde;
  return { gana: gana / s, empata: empata / s, pierde: pierde / s, grid };
}

export interface PrediccionNhl {
  /** Gana el local, prórroga y tanda incluidas (el moneyline de la NHL). */
  local: number;
  visitante: number;
  /** Empate a los 60 minutos (va a la prórroga). */
  empate60: number;
  golesLocal: number;
  golesVisitante: number;
  /** P(total de goles > línea), con el gol de la prórroga o la tanda contado como uno. */
  overTotal: (linea: number) => number;
}

/**
 * La predicción de un partido a partir de los dos Elo.
 *
 * Se busca el reparto de goles (bisección sobre su logaritmo) para que P(gana el local en 60) +
 * P(empate) · P(gana la prórroga) sea la probabilidad del Elo. Así el moneyline y el total salen del
 * mismo modelo y no se contradicen.
 */
export function predecir(eloLocal: number, eloVisitante: number, neutral = false, p: ParamsNhl = NHL, golesLiga = p.golesLiga): PrediccionNhl {
  const dr = eloLocal + (neutral ? 0 : p.campo) - eloVisitante;
  const objetivo = esperado(dr);
  const pOt = esperado(dr * p.fuerzaProrroga);
  const total = golesLiga;
  const con = (c: number) => {
    const lh = (total / 2) * Math.exp(c);
    const la = (total / 2) * Math.exp(-c);
    const r = resultado60(lh, la, p.maxGoles);
    return { lh, la, r, p: r.gana + r.empata * pOt };
  };
  let lo = -3;
  let hi = 3;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (con(mid).p < objetivo) lo = mid;
    else hi = mid;
  }
  const { lh, la, r } = con((lo + hi) / 2);
  const local = r.gana + r.empata * pOt;
  return {
    local,
    visitante: 1 - local,
    empate60: r.empata,
    golesLocal: lh,
    golesVisitante: la,
    overTotal: (linea: number) => {
      let p = 0;
      for (let i = 0; i < r.grid.length; i++)
        for (let j = 0; j < r.grid[i].length; j++) {
          const final = i + j + (i === j ? 1 : 0);
          if (final > linea) p += r.grid[i][j];
        }
      return Math.min(1, p / r.grid.flat().reduce((a, b) => a + b, 0));
    },
  };
}

/** El Elo después de un partido. Lo que gana uno lo pierde el otro; la prórroga cuenta como victoria. */
export function actualizar(eloLocal: number, eloVisitante: number, golesLocal: number, golesVisitante: number, neutral = false, p: ParamsNhl = NHL): [number, number] {
  const dr = eloLocal + (neutral ? 0 : p.campo) - eloVisitante;
  const e = esperado(dr);
  const s = golesLocal > golesVisitante ? 1 : 0;
  const dif = Math.abs(golesLocal - golesVisitante);
  // Multiplicador por margen, con la corrección de autocorrelación habitual (el favorito gana por más).
  const drGanador = s === 1 ? dr : -dr;
  const mov = Math.log(Math.max(1, dif) + 1) * (2.2 / (drGanador * 0.001 + 2.2));
  const delta = p.k * mov * (s - e);
  return [eloLocal + delta, eloVisitante - delta];
}
