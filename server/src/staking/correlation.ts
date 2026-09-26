// Cuánto se parecen dos posiciones abiertas. Medido, no supuesto.
//
// ===========================================================================
// LO QUE SE FUE A BUSCAR Y LO QUE SE ENCONTRÓ
// ===========================================================================
// La hipótesis de partida era la intuitiva: las apuestas de una misma liga y una misma
// jornada fallan juntas, porque comparten árbitros, clima, calendario y el mismo sesgo
// del modelo. Se midió sobre 65.505 predicciones fuera de muestra del Dixon-Coles
// (`npm run study:correlation`) y la respuesta fue que NO:
//
//   misma liga · misma jornada · mismo mercado     ρ = 0.0013  [−0.0020, 0.0047]
//     … restringido al mismo lado (mismo sesgo)    ρ = 0.0007  [−0.0038, 0.0053]
//   control: ligas y días distintos                ρ = −0.0002
//
// El control es lo que convierte ese cero en un resultado en vez de en una excusa: el
// estimador detecta correlación cuando la hay —abajo se ve— así que el cero de arriba
// es una medición, no falta de potencia.
//
// ===========================================================================
// LA CORRELACIÓN QUE SÍ EXISTE, Y ES CIEN VECES MAYOR
// ===========================================================================
// Entre MERCADOS DEL MISMO PARTIDO. Es obvia una vez vista —el 1X2 y el over miran el
// mismo marcador— y es justo la que el sizing por apuesta aislada no veía: `decideEvent`
// elige una sola selección del 1X2, pero nada impedía dimensionar ADEMÁS el over 2.5 y
// el ambos-marcan del mismo encuentro como si fueran tres apuestas independientes.
//
//   over 2.5 ~ ambos marcan   ρ = +0.558  [+0.546, +0.572]
//   gana el local ~ over 2.5  ρ = +0.164  [+0.151, +0.178]
//   gana el local ~ ambos m.  ρ = −0.141  [−0.154, −0.128]
//
// ===========================================================================
// EL SIGNO NO ES UN DETALLE
// ===========================================================================
// Las cifras están en DIRECCIÓN CANÓNICA: gana el local, hay over, marcan los dos.
// Respaldar el lado contrario en una de las dos invierte el signo.
//
// «Local + ambos marcan» sale NEGATIVA: es una cobertura parcial, no una concentración,
// y encogerla sería recortar un tamaño que no hacía falta recortar. Un modelo de
// correlación que tomara valores absolutos —que es lo que sale de suponer en vez de
// medir— se equivocaría en la dirección justo aquí.

/** Las familias de mercado que la app dimensiona. */
export type MarketKind = '1x2' | 'over_under' | 'btts' | 'otro';

/**
 * Hacia qué lado va la apuesta, respecto de la dirección en la que se midió.
 *
 * 'canonica'  = gana el local / hay over / marcan los dos
 * 'contraria' = gana el visitante / hay under / no marcan los dos
 *
 * El empate no es ninguna de las dos y por eso existe `otro`: su correlación con el
 * over no se midió, y devolver la del local sería inventarse un número con la
 * apariencia de uno medido.
 */
export type Side = 'canonica' | 'contraria' | 'otro';

export interface Position {
  /** Identificador único de la posición. */
  key: string;
  /** Qué partido. Dos posiciones con el mismo valor son del mismo encuentro. */
  matchKey: string;
  league: string;
  /** El día por el que cuenta, YYYY-MM-DD. */
  day: string;
  market: MarketKind;
  side: Side;
  /** Fracción del banco arriesgada. */
  fraction: number;
}

/**
 * La clave de un par de mercados, sin orden.
 *
 * Exportada para que NADIE tenga que escribirla a mano. Escrita a mano ya se coló una
 * vez —`over_under~btts` contra el `btts~over_under` que genera el orden alfabético— y
 * el fallo fue invisible porque el valor por defecto es prudente.
 */
export function pairKey(a: MarketKind, b: MarketKind): string {
  return [a, b].sort().join('~');
}

/**
 * Lo medido, con su intervalo. Se guarda el intervalo y no solo el punto porque es lo
 * que permite elegir un valor conservador sin inventárselo.
 */
export const MEASURED = {
  /**
   * Pares de mercados del mismo partido, en dirección canónica.
   *
   * Las claves se construyen con `pairKey` y NO se escriben a mano. Escritas a mano,
   * `over_under~btts` no encontraba nada —la búsqueda ordena alfabéticamente y genera
   * `btts~over_under`— y el par con la correlación MÁS ALTA de las tres caía en el
   * valor por defecto. No rompía nada visible porque el defecto es prudente, que es
   * justo lo que hace que un fallo así sobreviva.
   */
  sameMatch: Object.fromEntries(
    (
      [
        ['over_under', 'btts', 0.558, 0.546, 0.572],
        ['1x2', 'over_under', 0.164, 0.151, 0.178],
        ['1x2', 'btts', -0.141, -0.154, -0.128],
      ] as [MarketKind, MarketKind, number, number, number][]
    ).map(([a, b, rho, lo, hi]) => [pairKey(a, b), { rho, lo, hi }]),
  ) as Record<string, { rho: number; lo: number; hi: number }>,
  /** Partidos distintos, misma liga y jornada. Nulo. */
  sameLeagueDay: { rho: 0.0013, lo: -0.002, hi: 0.0047 },
  /** El control que valida el estimador. */
  control: { rho: -0.0002 },
  n: 65_505,
  blocks: 2063,
} as const;

/**
 * Lo que se USA para partidos distintos de la misma liga y jornada: el EXTREMO ALTO del
 * intervalo, no el punto.
 *
 * No es cautela decorativa ni un número inventado: 0.0047 es un límite que salió de la
 * misma medición, y usarlo cuesta un 3 % de tamaño con ocho apuestas. Cuando el coste
 * de equivocarse por el lado prudente es del 3 % y el de equivocarse por el otro es
 * apalancarse sin saberlo, la elección no está reñida.
 *
 * Lo que NO se hace es redondearlo a 0.05 o a 0.1 «por si acaso». Eso ya no sería la
 * medición sino una opinión con aspecto de dato.
 */
export const SAME_LEAGUE_DAY_RHO = MEASURED.sameLeagueDay.hi;

export interface Corr {
  rho: number;
  /** Por qué ese número. Una matriz de correlación sin explicación no se puede auditar. */
  reason: string;
}

/**
 * La correlación entre dos posiciones.
 *
 * El orden de los casos es el orden de la fuerza del vínculo, del más fuerte al más
 * débil, y termina en 0 explícito: «no hay vínculo conocido» es una respuesta, no un
 * hueco.
 */
export function correlation(a: Position, b: Position): Corr {
  if (a.key === b.key) return { rho: 1, reason: 'la misma posición' };

  if (a.matchKey === b.matchKey) {
    // ===========================================================================
    // MISMO PARTIDO, MISMO MERCADO: 1, Y ES UNA DECISIÓN, NO UNA MEDICIÓN
    // ===========================================================================
    // Dos selecciones del mismo mercado del mismo partido son excluyentes o casi. Su
    // correlación real es NEGATIVA, y ponerla negativa aquí haría que el optimizador
    // las tratara como una cobertura y abriera las dos — cuando apostar a los dos
    // lados de un 1X2 garantiza perder una de las dos patas.
    //
    // Así que se declara 1: el optimizador las ve como la misma apuesta y se queda con
    // una. Es conservador a propósito, y por eso está escrito que es una elección.
    if (a.market === b.market) {
      return {
        rho: 1,
        reason: 'mismo partido y mismo mercado: se tratan como una sola posición',
      };
    }
    const m = MEASURED.sameMatch[pairKey(a.market, b.market)];
    if (!m) {
      // Un par que no se midió. Devolver 0 sería afirmar independencia sin haberla
      // comprobado, en el único sitio donde SÍ se sabe que hay dependencia fuerte.
      return {
        rho: 0.5,
        reason: 'mismo partido, par de mercados sin medir: se supone alta por prudencia',
      };
    }
    // El signo se invierte si exactamente una de las dos va contra la dirección medida.
    const flip = (a.side === 'contraria') !== (b.side === 'contraria');
    // Con un lado 'otro' —el empate, por ejemplo— la dirección no está definida y el
    // signo no se puede aplicar. Se usa el valor absoluto: prudente, y dicho.
    const undefinedSide = a.side === 'otro' || b.side === 'otro';
    const rho = undefinedSide ? Math.abs(m.rho) : flip ? -m.rho : m.rho;
    return {
      rho,
      reason: undefinedSide
        ? `mismo partido, ${a.market}/${b.market}: |ρ| ${Math.abs(m.rho).toFixed(3)} (un lado sin dirección definida)`
        : `mismo partido, ${a.market}/${b.market}: ρ ${rho.toFixed(3)} medido${flip ? ', signo invertido por ir a lados opuestos' : ''}`,
    };
  }

  if (a.league === b.league && a.day === b.day) {
    return {
      rho: SAME_LEAGUE_DAY_RHO,
      reason: `misma liga y día: ρ ${SAME_LEAGUE_DAY_RHO.toFixed(4)} (extremo alto del intervalo medido; el punto es 0)`,
    };
  }

  return { rho: 0, reason: 'sin vínculo medido' };
}

/** La matriz completa. Simétrica, con unos en la diagonal por construcción. */
export function correlationMatrix(ps: Position[]): number[][] {
  const n = ps.length;
  const C: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    C[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const r = correlation(ps[i], ps[j]);
      C[i][j] = r.rho;
      C[j][i] = r.rho;
    }
  }
  return C;
}

/** Los vínculos que no son cero, para poder explicarlos. El más fuerte primero. */
export function links(ps: Position[]): { a: string; b: string; rho: number; reason: string }[] {
  const out: { a: string; b: string; rho: number; reason: string }[] = [];
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const r = correlation(ps[i], ps[j]);
      if (Math.abs(r.rho) < 1e-9) continue;
      out.push({ a: ps[i].key, b: ps[j].key, rho: r.rho, reason: r.reason });
    }
  }
  return out.sort((x, y) => Math.abs(y.rho) - Math.abs(x.rho));
}

export interface Aggregate {
  /** La suma de las fracciones: lo que se puede perder si fallan TODAS. */
  naive: number;
  /**
   * El tamaño de UNA apuesta que tendría la misma varianza que esta cartera.
   *
   * = sqrt(fᵀ·C·f). Con correlación perfecta vale exactamente la suma ingenua; con
   * independencia vale mucho menos (25 posiciones al 2 % → 10 % en vez de 50 %).
   */
  effective: number;
  /** effective / naive. 1 = ninguna diversificación; bajo = mucha. */
  concentration: number;
  positions: number;
}

/**
 * Las dos cifras, y por qué hacen falta las dos.
 *
 * `naive` responde «¿cuánto puedo perder?» y la respuesta no depende de la correlación:
 * si fallan todas, se pierde la suma, correlacionadas o no. Es el número que gobierna
 * los topes duros.
 *
 * `effective` responde «¿cuánto riesgo estoy corriendo?», que es otra pregunta: veinte
 * apuestas independientes al 2 % no son lo mismo que una del 40 %, aunque el peor caso
 * coincida. Es el número que gobierna el TAMAÑO, porque es el que entra en el
 * crecimiento logarítmico.
 *
 * Confundirlas es lo que produce las dos formas de equivocarse: usar solo la ingenua
 * rechaza carteras diversificadas perfectamente sanas, y usar solo la efectiva deja
 * pasar una concentración que puede vaciar el banco en una tarde.
 */
export function aggregateExposure(ps: Position[]): Aggregate {
  const f = ps.map((p) => p.fraction);
  const naive = f.reduce((a, x) => a + x, 0);
  if (ps.length === 0) return { naive: 0, effective: 0, concentration: 0, positions: 0 };
  const C = correlationMatrix(ps);
  let v = 0;
  for (let i = 0; i < f.length; i++) {
    for (let j = 0; j < f.length; j++) v += f[i] * f[j] * C[i][j];
  }
  // La forma cuadrática puede salir negativa si la matriz construida par a par no es
  // definida positiva —pasa cuando se mezclan correlaciones negativas medidas— y una
  // raíz de un negativo aquí sería un NaN propagándose hasta la pantalla.
  const effective = Math.sqrt(Math.max(0, v));
  return {
    naive,
    effective,
    concentration: naive > 0 ? effective / naive : 0,
    positions: ps.length,
  };
}
