// La historia del baloncesto: descargar TODO primero y escribir después (lote A, A5).
//
// Antes el script borraba bb_games, bb_teams y bb_team_ratings de cada liga y DESPUÉS
// descargaba, que son minutos. Mientras tanto el ciclo pre-partido (cada 15 min) registraba
// predicciones con Elo inicial (1500 contra 1500) en bb_prediction_log y prediction_snapshots,
// que son inmutables: quedaban para siempre. Ahora cada liga se reconstruye en UNA
// transacción —borrar, insertar, recalcular sus ratings— cuando ya está todo en memoria; si
// la descarga falla, la base queda como estaba.

import { getDb } from '../../db.ts';
import type { LeagueConfig } from '../types.ts';
import { descargarEspn, guardarEspn } from '../ingest/espn.ts';
import { cargarFiveThirtyEight, guardarFiveThirtyEight } from '../ingest/fivethirtyeight.ts';
import { cargarHoopr, guardarHoopr } from '../ingest/hoopr.ts';
import { recomputeBasketballRatings } from '../ratings.ts';

export type FuenteHistoria = 'auto' | 'espn' | '538';

export interface OpcionesHistoria {
  leagues: LeagueConfig[];
  /** Años de temporada de ESPN (la NBA 2024-25 es 2025). */
  seasons: number[];
  source: FuenteHistoria;
  /** `fetch` inyectable para ESPN (los tests no salen a la red). */
  fetch?: typeof fetch;
  log?: (linea: string) => void;
}

export interface ResultadoHistoria {
  /** Partidos guardados en total. */
  total: number;
  /** Ligas que se quedaron sin datos (la base no se tocó para ellas). */
  fallidas: string[];
  /** Equipos con rating por liga. */
  ratings: Record<string, number>;
  porLiga: Record<string, { teams: number; games: number; fuente: string }>;
}

/** Lo descargado de una liga, listo para guardarse: cada parte escribe sin transacción propia. */
interface Plan {
  fuente: string;
  guardar: () => { teams: number; games: number };
}

export async function actualizarHistoriaBaloncesto(o: OpcionesHistoria): Promise<ResultadoHistoria> {
  const log = o.log ?? ((l: string) => console.log(l));
  const db = getDb();
  const out: ResultadoHistoria = { total: 0, fallidas: [], ratings: {}, porLiga: {} };

  for (const league of o.leagues) {
    log(`\n▸ ${league.label}`);
    if (!league.espn) {
      log('  sin fuente de resultados disponible: se mostrarán los partidos y las cuotas del\n  mercado, pero no habrá modelo Elo. La app lo indica en la interfaz.');
      continue;
    }

    // 1. Todo a memoria. Nada de esto toca la base.
    const plan: Plan[] = [];
    if (o.source === '538') {
      if (league.id !== 'nba') {
        log('  --source 538 solo cubre la NBA; se omite.');
        continue;
      }
    } else {
      try {
        const d = await descargarEspn(league, o.seasons, { fetch: o.fetch, log });
        plan.push({ fuente: 'espn', guardar: () => guardarEspn(league, d) });
      } catch (e) {
        log(`  ⚠️  ESPN falló para ${league.id}: ${(e as Error).message}`);
        if (o.source === 'espn') {
          out.fallidas.push(league.id);
          continue;
        }
      }
    }
    if (plan.length === 0 && league.id === 'nba') {
      // Fallbacks, in the order that leaves the ratings least stale. FiveThirtyEight FIRST, and
      // the order is load-bearing: it carries the deep history AND establishes the canonical
      // team ids that hoopR then resolves into (see basketball/ingest/teamNames.ts).
      try {
        const games = await cargarFiveThirtyEight();
        plan.push({
          fuente: 'fivethirtyeight',
          guardar: () => {
            const r = guardarFiveThirtyEight(games);
            log(`  FiveThirtyEight: ${r.games} partidos reales (${r.from}–${r.to}), ${r.teams} franquicias`);
            return r;
          },
        });
      } catch (e) {
        log(`  ⚠️  ${(e as Error).message}`);
      }
      if (o.source !== '538') {
        try {
          const games = await cargarHoopr({ fromSeason: 2003 });
          if (games.length > 0) {
            plan.push({
              fuente: 'hoopr',
              guardar: () => {
                const r = guardarHoopr(games);
                log(
                  `  hoopR (GitHub, fuente ESPN): ${r.games} partidos, temporadas ${r.seasons[0]}–${r.seasons[r.seasons.length - 1]} — hasta ${r.through}` +
                    (r.unmatched > 0 ? `  ⚠️  ${r.unmatched} sin emparejar` : ''),
                );
                return r;
              },
            });
          }
        } catch (e) {
          log(`  ⚠️  hoopR falló: ${(e as Error).message}`);
        }
      }
    }
    if (plan.length === 0) {
      out.fallidas.push(league.id);
      continue;
    }

    // 2. UNA transacción por liga: borrar, guardar y recalcular sus ratings. Entre el BEGIN y el
    // COMMIT nadie ve la liga vacía; si algo falla, se deshace todo.
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM bb_games WHERE league = ?').run(league.id);
      db.prepare('DELETE FROM bb_teams WHERE league = ?').run(league.id);
      db.prepare('DELETE FROM bb_team_ratings WHERE league = ?').run(league.id);
      let games = 0;
      let teams = 0;
      for (const parte of plan) {
        const r = parte.guardar();
        games += r.games;
        teams = Math.max(teams, r.teams);
      }
      const ratings = recomputeBasketballRatings({ leagues: [league.id], enTransaccion: true });
      db.exec('COMMIT');
      out.ratings[league.id] = ratings[league.id] ?? 0;
      out.porLiga[league.id] = { teams, games, fuente: plan.map((p) => p.fuente).join('+') };
      out.total += games;
      log(`  equipos: ${teams}, partidos: ${games}, con rating: ${out.ratings[league.id]} (${out.porLiga[league.id].fuente})`);
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return out;
}
