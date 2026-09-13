// Cuánto vale una ausencia, en goles esperados.
//
// ===========================================================================
// DE DÓNDE SALE EL NÚMERO
// ===========================================================================
// No de una opinión sobre lo bueno que es el jugador. Sale de una cadena en la que cada
// eslabón está medido o es aritmética:
//
//   1. La CUOTA del jugador en su equipo — qué parte de la producción ofensiva del once
//      habitual representa, y qué parte de sus minutos. Sale de la plantilla real.
//
//   2. Los PESOS de players.ts — cuánto cae el ataque por cada punto de cuota ausente
//      (0,31) y cuánto sube lo encajado (0,38). Están ajustados sobre tres temporadas de
//      alineaciones reales de la Premier, con el rival y el campo controlados, y son la
//      única señal de este proyecto que le ganó al Elo en vez de quedar absorbida.
//
//   3. La λ del partido — de ahí sale la conversión a goles, porque un 5 % de ataque
//      menos no vale lo mismo en un partido de 3,2 goles esperados que en uno de 1,9.
//
// El resultado es «−0,08 goles esperados para el Arsenal», que es una frase que se puede
// comprobar. Y como el impacto se calcula quitando al jugador y volviendo a evaluar el
// MISMO modelo, la suma de los impactos individuales no es exactamente el impacto del
// grupo: eso también se dice, porque las ausencias no se suman linealmente.
//
// ===========================================================================
// LO QUE NO SE DUPLICA
// ===========================================================================
// `TYPICAL_MISSING_ATTACK` (0,28) es la parte del once que falta de forma rutinaria, y
// el rating del equipo ya la lleva dentro. Si un jugador con el 25 % del ataque se
// lesiona, lo que sobra respecto a lo normal NO es 0,25 sino 0,25·(1−0,28). Aplicar el
// peso a la cuota cruda infla cada ausencia como un tercio, que es justo la dirección en
// la que un modelo así se hace el interesante.
//
// Eso ya lo hace `squadAvailability`. Este módulo NO lo recalcula: llama a aquella
// función con y sin el jugador y resta. Una segunda implementación de la misma regla es
// una segunda oportunidad de que se desincronicen.

import { getSquad, squadAvailability, type SquadAvailability } from '../football/players.ts';
import type { LeagueId } from '../football/types.ts';

export interface AbsenceImpact {
  playerId: string;
  playerName: string;
  position: string;
  /** Cuota del ataque del once habitual que representa, 0..1. */
  attackShare: number;
  /** Cuota de los minutos del once habitual. */
  minutesShare: number;
  /**
   * Probabilidad de que NO juegue, según la noticia. 1 = seguro fuera.
   *
   * El impacto se pondera por ella: una duda al 50 % vale la mitad que una baja segura,
   * que es lo correcto y lo que evita que una tarjeta grite por un «entrenó al margen».
   */
  missProbability: number;
  /** Goles esperados que pierde SU equipo por esta ausencia. Negativo. */
  goalsFor: number;
  /** Goles esperados que gana el RIVAL. Positivo. */
  goalsAgainst: number;
  /** Los dos juntos, en goles de diferencia. La cifra para ordenar. */
  net: number;
  kind: string;
  quote: string;
  /** De dónde viene: la fuente de plantillas, el usuario, o la alineación publicada. */
  source: 'noticia' | 'usuario' | 'alineacion';
  /**
   * Por qué el impacto es cero, cuando lo es.
   *
   * Un cero sin explicación se lee como «esta ausencia da igual», y casi nunca es eso:
   * lo normal es que el jugador no esté en el once observado —porque lleva cero minutos
   * esta temporada, que es justo lo que pasa con los lesionados de larga duración— y el
   * modelo no tenga forma de saber que era titular. Decirlo es la diferencia entre un
   * dato y un silencio.
   */
  zeroReason: string | null;
}

/**
 * El multiplicador de disponibilidad, con la opción de forzar a alguien disponible.
 *
 * ===========================================================================
 * EL CONTRAFACTUAL, Y POR QUÉ NO ES «AÑADIRLO A LA LISTA DE BAJAS»
 * ===========================================================================
 * La primera versión de esto medía el impacto llamando a `squadAvailability` con el
 * jugador AÑADIDO a la lista de bajas y restando. Salía cero para todos, y el motivo es
 * que la disponibilidad base YA trae aplicadas las bajas que publica la fuente: meter a
 * un lesionado en la lista de bajas no cambia nada porque ya estaba fuera.
 *
 * La pregunta correcta es la contraria — «¿cuánto valdría este partido si ESTE jugador
 * sí jugara?» — y por eso se fuerza su disponibilidad y se compara contra el estado
 * real. Ese es el número que significa algo: lo que cuesta su ausencia, no lo que
 * costaría volver a contarla.
 */
function availabilityWith(
  league: LeagueId,
  teamId: string,
  out: string[],
  availableIds: string[] = [],
): SquadAvailability {
  return squadAvailability(league, teamId, out, { availableIds });
}

/**
 * El impacto de cada ausencia, una a una.
 *
 * Cada jugador se evalúa SOLO —lo que costaría si faltara él y nadie más— y no de forma
 * incremental sobre los anteriores. Los dos números son legítimos y responden a
 * preguntas distintas; este es el que hace falta para ordenar una lista de noticias y
 * para poder decir «este es el que importa». El del grupo entero está en
 * `combinedImpact`.
 */
export function absenceImpacts(
  league: LeagueId,
  teamId: string,
  lambdaFor: number,
  lambdaAgainst: number,
  absences: {
    playerId: string;
    playerName: string;
    position: string;
    missProbability: number;
    kind: string;
    quote: string;
    source?: 'noticia' | 'usuario' | 'alineacion';
  }[],
): AbsenceImpact[] {
  // El estado REAL: como está el equipo ahora mismo, con todas sus bajas.
  const actual = availabilityWith(league, teamId, absences.filter((a) => a.missProbability >= 0.5).map((a) => a.playerId));
  const out: AbsenceImpact[] = [];
  for (const a of absences) {
    if (a.missProbability <= 0) continue;
    // El mismo equipo pero con ESTE jugador disponible. La diferencia entre los dos es
    // lo que cuesta su ausencia, que es lo que se quiere saber.
    const present = availabilityWith(
      league,
      teamId,
      absences.filter((x) => x.missProbability >= 0.5).map((x) => x.playerId),
      [a.playerId],
    );
    // `attack` baja al faltar y `defence` sube, así que los signos salen solos:
    // goalsFor negativo, goalsAgainst positivo.
    const goalsFor = lambdaFor * (actual.attack - present.attack) * a.missProbability;
    const goalsAgainst = lambdaAgainst * (actual.defence - present.defence) * a.missProbability;
    const info = actual.out.find((o) => o.id === a.playerId);
    out.push({
      playerId: a.playerId,
      playerName: a.playerName,
      position: a.position,
      attackShare: info?.attackShare ?? shareOf(actual, present, 'attack'),
      minutesShare: shareOf(actual, present, 'minutes'),
      missProbability: a.missProbability,
      goalsFor: round3(goalsFor),
      goalsAgainst: round3(goalsAgainst),
      net: round3(goalsFor - goalsAgainst),
      kind: a.kind,
      quote: a.quote,
      source: a.source ?? 'noticia',
      zeroReason:
        Math.abs(goalsFor) > 1e-9 || Math.abs(goalsAgainst) > 1e-9
          ? null
          : inXi(league, teamId, a.playerId)
            ? 'está en el once pero su cuota es cero'
            : 'no está en el once observado: lleva cero minutos esta temporada, así que ' +
              'el modelo no puede saber que era titular',
    });
  }
  return out.sort((x, y) => x.net - y.net);
}

/** La cuota que implica la diferencia entre los dos ajustes. */
function shareOf(actual: SquadAvailability, present: SquadAvailability, which: 'attack' | 'minutes'): number {
  const d =
    which === 'attack'
      ? actual.missingAttack - present.missingAttack
      : actual.missingMinutes - present.missingMinutes;
  return Math.round(Math.max(0, d) * 1000) / 1000;
}

/**
 * El impacto de TODAS las ausencias a la vez.
 *
 * No es la suma de las individuales, y la diferencia no es un error de redondeo: los
 * pesos se aplican sobre la cuota total que falta, así que dos ausencias juntas cuestan
 * algo menos que la suma de las dos por separado. La tarjeta enseña las dos cosas —el
 * desglose y el total— y dice que no cuadran a propósito.
 */
export function combinedImpact(
  league: LeagueId,
  teamId: string,
  lambdaFor: number,
  lambdaAgainst: number,
  absences: { playerId: string; missProbability: number }[],
): { goalsFor: number; goalsAgainst: number; net: number; players: number } {
  // Solo entran los que es MÁS probable que falten a que jueguen. `squadAvailability`
  // trabaja con una lista de bajas, que es binaria: no admite medios jugadores. Redondear
  // por probabilidad es la traducción honesta, y la alternativa —contar a todo el que
  // tenga una duda del 20 %— convertiría cualquier parte médico en una catástrofe.
  const outIds = absences.filter((a) => a.missProbability >= 0.5).map((a) => a.playerId);
  if (outIds.length === 0) return { goalsFor: 0, goalsAgainst: 0, net: 0, players: 0 };
  const actual = availabilityWith(league, teamId, outIds);
  // Todos ellos disponibles: el equipo al completo. Mismo contrafactual que arriba.
  const present = availabilityWith(league, teamId, outIds, outIds);
  const goalsFor = lambdaFor * (actual.attack - present.attack);
  const goalsAgainst = lambdaAgainst * (actual.defence - present.defence);
  return {
    goalsFor: round3(goalsFor),
    goalsAgainst: round3(goalsAgainst),
    net: round3(goalsFor - goalsAgainst),
    players: outIds.length,
  };
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** ¿Está este jugador en el once habitual que el modelo ha observado? */
function inXi(league: LeagueId, teamId: string, playerId: string): boolean {
  return getSquad(league, teamId).some((p) => p.id === playerId && p.regular);
}
