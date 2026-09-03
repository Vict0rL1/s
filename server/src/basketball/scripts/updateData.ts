// CLI: `npm run update-data:bb [-- --league nba --seasons 8 --source auto --skip-odds]`
//
// Refreshes basketball data, independently of tennis: running this never touches
// the tennis tables, and `npm run update-data` never touches these.
//
//   1. Team registry + completed games for every configured league.
//   2. Elo ratings recomputed from scratch.
//   3. Upcoming games + bookmaker odds (or a demo slate without a key).
//   4. Any basketball prediction whose result just arrived gets scored.
//
// SOURCES (--source)
//   auto (default) — ESPN for every league that has a feed. If ESPN is
//                    unreachable for the NBA, falls back to the FiveThirtyEight
//                    history file so the tab still has real data to work with.
//   espn           — ESPN only.
//   538            — the FiveThirtyEight file only. Real NBA games but ONLY up to
//                    2015, so ratings will not describe today's teams. Useful for
//                    `npm run backtest:bb` and on networks that block ESPN.

import { getDb, setMeta } from '../../db.ts';
import { basketballConfig } from '../../config.ts';
import { ingestEspnLeague } from '../ingest/espn.ts';
import { ingestFiveThirtyEight } from '../ingest/fivethirtyeight.ts';
import { ingestHoopr } from '../ingest/hoopr.ts';
import { refreshBasketballOdds } from '../ingest/odds.ts';
import { recomputeBasketballRatings } from '../ratings.ts';
import { countGames, countTeams, getLeagueLatestDate } from '../repo.ts';
import { getBasketballTrackRecord, resolveGamePredictions } from '../trackRecord.ts';

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    // Both forms. `--flag=value` used to be swallowed whole: the key became
    // "flag=value", nothing ever looked it up, and the flag silently did nothing —
    // which reads exactly like the feature being broken.
    const eq = a.indexOf('=');
    if (eq > 2) {
      args[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[a.slice(2)] = next;
      i++;
    } else args[a.slice(2)] = true;
  }
  return args;
}

/**
 * ESPN season years to pull. A season is labelled by the year it ENDS in (the NBA
 * 2024-25 season is 2025), and the new season starts in the autumn, so before
 * ~August the current season year is this calendar year.
 */
function seasonsToFetch(count: number): number[] {
  const now = new Date();
  const current = now.getUTCMonth() + 1 >= 8 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(current - i);
  return out.reverse();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const onlyLeague = typeof args.league === 'string' ? args.league : null;
  const seasonCount = Number(args.seasons) || basketballConfig.history.seasons;
  const skipOdds = !!args['skip-odds'];
  const source = typeof args.source === 'string' ? args.source : 'auto';
  if (!['auto', 'espn', '538'].includes(source)) {
    throw new Error(`--source desconocido: ${source} (usa auto, espn o 538)`);
  }

  const db = getDb();
  const leagues = basketballConfig.leagues.filter((l) => !onlyLeague || l.id === onlyLeague);
  if (leagues.length === 0) throw new Error(`Liga desconocida: ${onlyLeague}`);

  const seasons = seasonsToFetch(seasonCount);
  console.log(
    `\n🏀 Actualizando baloncesto · temporadas ${seasons[0]}–${seasons[seasons.length - 1]}` +
      `${onlyLeague ? ` (${onlyLeague})` : ''} · fuente: ${source}`,
  );

  // Full rebuild of games/teams keeps ratings correct and avoids duplicates. The
  // prediction log and the tennis tables are deliberately untouched.
  db.exec('BEGIN');
  try {
    for (const l of leagues) {
      db.prepare('DELETE FROM bb_games WHERE league = ?').run(l.id);
      db.prepare('DELETE FROM bb_teams WHERE league = ?').run(l.id);
      db.prepare('DELETE FROM bb_team_ratings WHERE league = ?').run(l.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const failed: string[] = [];
  let total = 0;

  for (const league of leagues) {
    console.log(`\n▸ ${league.label}`);
    if (!league.espn) {
      console.log(
        `  sin fuente de resultados disponible: se mostrarán los partidos y las cuotas del\n` +
          `  mercado, pero no habrá modelo Elo. La app lo indica en la interfaz.`,
      );
      continue;
    }
    if (source === '538') {
      if (league.id !== 'nba') {
        console.log('  --source 538 solo cubre la NBA; se omite.');
        continue;
      }
    } else {
      try {
        const res = await ingestEspnLeague(league, seasons);
        console.log(`  equipos: ${res.teams}, partidos: ${res.games}`);
        total += res.games;
        continue;
      } catch (e) {
        console.warn(`  ⚠️  ESPN falló para ${league.id}: ${(e as Error).message}`);
        if (source === 'espn') {
          failed.push(league.id);
          continue;
        }
      }
    }

    // Fallbacks, in the order that leaves the ratings least stale.
    if (league.id === 'nba') {
      let got = 0;
      // FiveThirtyEight FIRST, and the order is load-bearing. It carries the deep
      // history the model was fitted on (1946-2015) AND it establishes the canonical
      // team ids — hoopR then resolves its own spellings into them rather than
      // creating a second copy of every franchise. Reversing these two split the NBA
      // into 98 teams; see basketball/ingest/teamNames.ts.
      try {
        const res = await ingestFiveThirtyEight();
        console.log(
          `  FiveThirtyEight: ${res.games} partidos reales (${res.from}–${res.to}), ${res.teams} franquicias`,
        );
        got += res.games;
      } catch (e) {
        console.warn(`  ⚠️  ${(e as Error).message}`);
      }
      // Then hoopR, which is ESPN's own schedule mirrored into GitHub — so it reaches
      // the CURRENT season on a network that blocks ESPN itself. Before this existed,
      // a blocked ESPN dropped the tab all the way back to 2015.
      if (source !== '538') {
        try {
          const res = await ingestHoopr({ fromSeason: 2003 });
          if (res.games > 0) {
            console.log(
              `  hoopR (GitHub, fuente ESPN): ${res.games} partidos, ` +
                `temporadas ${res.seasons[0]}–${res.seasons[res.seasons.length - 1]}` +
                ` — hasta ${res.through}` +
                (res.unmatched > 0 ? `  ⚠️  ${res.unmatched} sin emparejar` : ''),
            );
            got += res.games;
          }
        } catch (e) {
          console.warn(`  ⚠️  hoopR falló: ${(e as Error).message}`);
        }
      }
      if (got === 0) failed.push(league.id);
      total += got;
    } else {
      failed.push(league.id);
    }
  }

  if (total === 0 && countGames() === 0) {
    throw new Error(
      'No se ingirió ningún partido de baloncesto. Comprueba tu conexión: la ingesta usa ' +
        'ESPN (site.api.espn.com) y, como reserva para la NBA, un CSV alojado en GitHub.',
    );
  }
  if (failed.length) {
    console.warn(`\n⚠️  Ligas sin datos: ${failed.join(', ')}. El resto funciona con normalidad.`);
  }

  console.log('\n▸ Calculando Elo…');
  console.log(`  equipos con rating: ${JSON.stringify(recomputeBasketballRatings())}`);

  // Warn loudly when the newest game is old — stale ratings do not describe the
  // teams playing tonight, and that is the failure mode users cannot see.
  for (const league of leagues) {
    const latest = getLeagueLatestDate(league.id);
    if (!latest) continue;
    setMeta(`bb_history_through_${league.id}`, latest);
    const y = Number(latest.slice(0, 4));
    const m = Number(latest.slice(4, 6));
    const monthsOld =
      (new Date().getUTCFullYear() - y) * 12 + (new Date().getUTCMonth() + 1 - m);
    console.log(`  ${league.name}: último partido ${latest}`);
    if (monthsOld > 4) {
      console.warn(
        `  ⚠️  El historial de ${league.name} termina hace ~${Math.round(monthsOld)} meses.\n` +
          `      Los Elo NO describen a las plantillas actuales. Vuelve a ejecutarlo con acceso\n` +
          `      a ESPN para datos al día.`,
      );
    }
  }

  if (!skipOdds) {
    console.log('\n▸ Partidos próximos y cuotas…');
    const odds = await refreshBasketballOdds();
    console.log(
      `  ${odds.count} partidos (${odds.source === 'live' ? 'cuotas reales' : 'demo, sin API key'})` +
        `${odds.leagues.length ? ` · ligas: ${odds.leagues.join(', ')}` : ''}`,
    );
  }

  const scored = resolveGamePredictions();
  if (scored.resolved > 0) {
    const rec = getBasketballTrackRecord();
    console.log(
      `\n▸ Predicciones de baloncesto resueltas: ${scored.resolved}` +
        (rec.accuracy != null
          ? `\n  Track record: ${(rec.accuracy * 100).toFixed(1)}% en ${rec.resolved} predicciones (Brier ${rec.brier}).`
          : ''),
    );
  }

  setMeta('bb_data_source', source === '538' ? 'fivethirtyeight' : 'espn');
  setMeta('bb_updated_at', new Date().toISOString());
  console.log(
    `\n✅ Listo. ${countTeams()} equipos y ${countGames()} partidos en la base.` +
      `\n   Arranca con:  npm run dev   → pestaña 🏀 Baloncesto\n`,
  );
}

main().catch((err) => {
  console.error('\n❌ update-data:bb falló:', err.message);
  process.exit(1);
});
