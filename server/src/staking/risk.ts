// Riesgo de la CARTERA de apuestas de papel abiertas, y los grupos de correlación.
//
// ===========================================================================
// LOS GRUPOS: REGLAS SENCILLAS Y A LA VISTA
// ===========================================================================
// No hay una matriz de correlaciones completa, y no se finge. Lo medido en este proyecto
// (staking/correlation.ts) dice dos cosas: entre partidos distintos de la misma liga y
// jornada la correlación es ~0; entre mercados del MISMO partido es alta. De ahí las
// reglas, y nada más:
//
//   evento:<deporte>:<id>        todo lo que se juega en el mismo partido (el ganador, el
//                                hándicap, el total del rival…) comparte resultado.
//   equipo:<deporte>:<id>        dos partidos abiertos del mismo equipo o jugador: si se
//   jugador:tenis:<id>           lesiona o rota, fallan juntos. Cada apuesta pertenece a los
//                                grupos de sus DOS participantes, porque su resultado
//                                depende de ambos.
//
// ===========================================================================
// LOS TOPES
// ===========================================================================
//   max_total_open_exposure   10 % del banco (el de la política, DEFAULT_CONFIG).
//   max_same_event_exposure    2 % (el tope por evento de la política).
//   max_same_team_exposure     3 %: algo más que un evento, porque dos partidos del mismo
//   max_same_player_exposure   3 %  equipo no son el mismo resultado, pero sin llegar a dos.
// Elegidos a mano, como los de la política. Solo RECORTAN: un importe nunca sube por esto,
// y lo ya apostado no se toca.

import { getDb } from '../db.ts';
import { DEFAULT_CONFIG } from './policy.ts';
import { politica } from './policyStore.ts';

export const LIMITES = {
  max_total_open_exposure: DEFAULT_CONFIG.maxTotalExposure,
  max_same_event_exposure: DEFAULT_CONFIG.maxPerEvent,
  max_same_team_exposure: 0.03,
  max_same_player_exposure: 0.03,
};

/** Los topes vigentes: los de la política versionada (Fase 3.5), con LIMITES como forma. */
export function limitesVigentes(): typeof LIMITES {
  const p = politica();
  return {
    max_total_open_exposure: p.staking.maxTotalExposure,
    max_same_event_exposure: p.staking.maxPerEvent,
    max_same_team_exposure: p.grupos.maxSameTeamExposure,
    max_same_player_exposure: p.grupos.maxSamePlayerExposure,
  };
}

/** Los grupos de una apuesta. El primero es su «grupo de correlación» principal: el evento. */
export function gruposDe(sport: string, eventId: string, participantes: string[]): string[] {
  const tipo = sport === 'tennis' ? 'jugador' : 'equipo';
  return [`evento:${sport}:${eventId}`, ...participantes.filter(Boolean).map((p) => `${tipo}:${sport}:${p}`)];
}

const limiteDe = (grupo: string) => {
  const L = limitesVigentes();
  return grupo.startsWith('evento:') ? L.max_same_event_exposure : grupo.startsWith('jugador:') ? L.max_same_player_exposure : L.max_same_team_exposure;
};

export interface Abierta {
  id: number;
  sport: string;
  stake: number;
  grupos: string[];
}

function abiertas(): Abierta[] {
  return (
    getDb().prepare("SELECT id, sport, stake, correlation_groups FROM paper_bets WHERE status = 'pending'").all() as {
      id: number; sport: string; stake: number; correlation_groups: string | null;
    }[]
  ).map((r) => ({ id: r.id, sport: r.sport, stake: r.stake, grupos: r.correlation_groups ? (JSON.parse(r.correlation_groups) as string[]) : [] }));
}

/**
 * El máximo que cabe en esta apuesta sin pasar ningún tope de sus grupos, con lo ya
 * abierto (más lo decidido en esta misma pasada, en `extra`).
 */
export function cabeEnGrupos(
  grupos: string[],
  banco: number,
  extra: Map<string, number> = new Map(),
  /** Otro banco (una estrategia): sus posiciones abiertas y sus límites. Por defecto, el banco de papel. */
  otro: { abiertas: Abierta[]; limiteDe: (grupo: string) => number } | null = null,
): { cabe: number; limitante: string | null } {
  const abierto = new Map<string, number>();
  for (const a of otro?.abiertas ?? abiertas()) for (const g of a.grupos) abierto.set(g, (abierto.get(g) ?? 0) + a.stake);
  for (const [g, v] of extra) abierto.set(g, (abierto.get(g) ?? 0) + v);
  const limite = otro?.limiteDe ?? limiteDe;
  let cabe = Infinity;
  let limitante: string | null = null;
  for (const g of grupos) {
    const hueco = Math.max(0, limite(g) * banco - (abierto.get(g) ?? 0));
    if (hueco < cabe) {
      cabe = hueco;
      limitante = g;
    }
  }
  return { cabe, limitante };
}

export interface RiesgoCartera {
  banco: number;
  total: { importe: number; pct: number; limite: number };
  porDeporte: { deporte: string; importe: number; pct: number }[];
  /** Grupos con más de una apuesta o cerca de su tope. */
  grupos: { grupo: string; apuestas: number; importe: number; pct: number; limite: number; excede: boolean }[];
  limites: typeof LIMITES;
  nota: string;
}

export function riesgoCartera(banco: number): RiesgoCartera {
  const xs = abiertas();
  const total = xs.reduce((a, x) => a + x.stake, 0);
  const porDeporte = new Map<string, number>();
  const porGrupo = new Map<string, { n: number; s: number }>();
  for (const x of xs) {
    porDeporte.set(x.sport, (porDeporte.get(x.sport) ?? 0) + x.stake);
    for (const g of x.grupos) {
      const v = porGrupo.get(g) ?? { n: 0, s: 0 };
      v.n++;
      v.s += x.stake;
      porGrupo.set(g, v);
    }
  }
  return {
    banco,
    total: { importe: total, pct: total / banco, limite: limitesVigentes().max_total_open_exposure },
    porDeporte: [...porDeporte].map(([deporte, importe]) => ({ deporte, importe, pct: importe / banco })).sort((a, b) => b.importe - a.importe),
    grupos: [...porGrupo]
      .map(([grupo, v]) => ({ grupo, apuestas: v.n, importe: v.s, pct: v.s / banco, limite: limiteDe(grupo), excede: v.s > limiteDe(grupo) * banco + 1e-9 }))
      .filter((g) => g.apuestas > 1 || g.pct >= g.limite * 0.8)
      .sort((a, b) => b.pct - a.pct),
    limites: LIMITES,
    nota:
      'Grupos por reglas (mismo evento; mismo equipo o jugador), no por una matriz de correlaciones medida: ' +
      'entre partidos distintos de la misma liga y jornada la correlación medida es ~0 (staking/correlation.ts).',
  };
}
