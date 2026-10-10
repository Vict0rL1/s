// Historia del Elo de un equipo (Fase 5.12): la reproducción de la liga, que ya existe por
// deporte, anotando el rating ANTES de cada partido del equipo. Nada nuevo se modela: es el
// mismo Elo que pinta la ficha, visto a lo largo del tiempo. Cacheada por liga y día (una
// reproducción tarda de décimas a un par de segundos).

import type { SportId } from '../sports.ts';

export interface PuntoElo {
  fecha: string; // YYYY-MM-DD
  elo: number;
  rival: string;
  local: boolean;
}

export interface HistoriaElo {
  sport: SportId;
  league: string;
  teamId: string;
  puntos: PuntoElo[];
  generado: string;
  nota: string;
}

const cache = new Map<string, { dia: string; porEquipo: Map<string, PuntoElo[]> }>();

const iso = (yyyymmdd: string) => (/^\d{8}$/.test(yyyymmdd) ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}` : yyyymmdd.slice(0, 10));

async function reproducir(sport: Exclude<SportId, 'tennis'>, league: string): Promise<Map<string, PuntoElo[]>> {
  const por = new Map<string, PuntoElo[]>();
  const anota = (id: string, p: PuntoElo) => {
    const l = por.get(id) ?? [];
    l.push(p);
    por.set(id, l);
  };
  switch (sport) {
    case 'football': {
      const { loadMatches, replayMatches } = await import('../football/ratings.ts');
      replayMatches(loadMatches(league), {
        onMatch: ({ match, home, away }) => {
          const f = iso(match.match_date);
          anota(match.home_id, { fecha: f, elo: Math.round(home.elo), rival: match.away_id, local: true });
          anota(match.away_id, { fecha: f, elo: Math.round(away.elo), rival: match.home_id, local: false });
        },
      });
      break;
    }
    case 'basketball': {
      const { loadGames, replayGames } = await import('../basketball/ratings.ts');
      replayGames(loadGames(league), {
        onGame: ({ game, home, away }) => {
          const f = iso(game.game_date);
          anota(game.home_id, { fecha: f, elo: Math.round(home.elo), rival: game.away_id, local: !game.neutral });
          anota(game.away_id, { fecha: f, elo: Math.round(away.elo), rival: game.home_id, local: false });
        },
      });
      break;
    }
    case 'baseball': {
      const { loadGames, replayGames } = await import('../baseball/ratings.ts');
      replayGames(loadGames(league), {
        onGame: ({ game, home, away }) => {
          const f = iso(game.game_date);
          anota(game.home_id, { fecha: f, elo: Math.round(home.elo), rival: game.away_id, local: true });
          anota(game.away_id, { fecha: f, elo: Math.round(away.elo), rival: game.home_id, local: false });
        },
      });
      break;
    }
    case 'nfl': {
      const { listReplayGames } = await import('../nfl/repo.ts');
      const { replayGames } = await import('../nfl/ratings.ts');
      replayGames(listReplayGames(league), {
        onGame: ({ game, home, away }) => {
          const f = iso(game.game_date);
          anota(game.home_id, { fecha: f, elo: Math.round(home.elo), rival: game.away_id, local: !game.neutral });
          anota(game.away_id, { fecha: f, elo: Math.round(away.elo), rival: game.home_id, local: false });
        },
      });
      break;
    }
    case 'nhl': {
      // Una sola liga: el mismo recorrido que el backtest y la predicción publicada (nhl/ajuste.ts).
      const { leerPartidos } = await import('../nhl/evaluacion.ts');
      const { recorrer } = await import('../nhl/ajuste.ts');
      const partidos = leerPartidos();
      const pasos = recorrer(partidos);
      partidos.forEach((g, i) => {
        anota(g.home_id, { fecha: g.game_date, elo: Math.round(pasos[i].eloLocal), rival: g.away_id, local: true });
        anota(g.away_id, { fecha: g.game_date, elo: Math.round(pasos[i].eloVisitante), rival: g.home_id, local: false });
      });
      break;
    }
    case 'ufc': {
      // El mismo recorrido que el backtest y la predicción publicada (ufc/evaluacion.ts): el Elo de
      // antes de cada pelea con ganador. Sin local.
      const { leerPeleas, recorrer } = await import('../ufc/evaluacion.ts');
      for (const x of recorrer(leerPeleas()).pasos) {
        anota(x.ids[0], { fecha: x.fecha, elo: Math.round(x.elos[0]), rival: x.ids[1], local: false });
        anota(x.ids[1], { fecha: x.fecha, elo: Math.round(x.elos[1]), rival: x.ids[0], local: false });
      }
      break;
    }
  }
  return por;
}

export async function historiaElo(sport: Exclude<SportId, 'tennis'>, league: string, teamId: string, ahora = new Date()): Promise<HistoriaElo> {
  const dia = ahora.toISOString().slice(0, 10);
  const k = `${sport}|${league}`;
  let c = cache.get(k);
  if (!c || c.dia !== dia) {
    c = { dia, porEquipo: await reproducir(sport, league) };
    cache.set(k, c);
  }
  return {
    sport,
    league,
    teamId,
    puntos: c.porEquipo.get(teamId) ?? [],
    generado: ahora.toISOString(),
    nota: 'Elo antes de cada partido, de la misma reproducción que alimenta la ficha. Sin partido no hay punto: las pausas largas se ven como huecos.',
  };
}

/** Para los tests: olvidar lo reproducido. */
export function olvidarHistoriaElo(): void {
  cache.clear();
}
