// npm run update-data:naf
//
// Downloads the NFL archive, rebuilds the ratings, stores the remaining
// schedule as upcoming games, and — if there is an API key — overlays live
// bookmaker prices on top.
//
// The schedule step is why this tab works with no key at all: nflverse publishes
// the fixtures before the season starts, so there are real upcoming games to
// predict even when no price feed is configured. The card says where its numbers
// came from either way.

import { getDb, setMeta } from '../../db.ts';
import { nflConfig, env } from '../../config.ts';
import { fetchText, parseGames, parseTeams, storeGames, storeSchedule } from '../ingest/nflverse.ts';
import { refreshOdds } from '../ingest/odds.ts';
import { countGames, countTeams, getLeagueState, rebuildRatings } from '../repo.ts';
import { ELO_PER_POINT } from '../model.ts';

async function main(): Promise<void> {
  getDb();
  const { history, leagues } = nflConfig;
  const archived = leagues.filter((l) => l.nflverse);

  for (const league of archived) {
    console.log(`\n▸ ${league.name}`);
    console.log(`  Descargando ${history.gamesUrl}`);
    const csv = await fetchText(history.gamesUrl);

    // The teams file is a nicety: without it we fall back to the built-in name
    // table, and the ingest still succeeds. Failing the whole run because a
    // display name is missing would be the wrong trade.
    let names = new Map<string, string>();
    try {
      names = parseTeams(await fetchText(history.teamsUrl));
    } catch (err) {
      console.log(`  (nombres de equipo: usando la tabla interna — ${(err as Error).message})`);
    }

    const { games, fixtures } = parseGames(csv, history.fromSeason);
    const seasons = new Set(games.map((g) => g.season));
    const withLine = games.filter((g) => g.closeSpread != null).length;
    const withMl = games.filter((g) => g.closeMlHome != null).length;
    console.log(
      `  ${games.length} partidos jugados · ${seasons.size} temporadas ` +
        `(${Math.min(...seasons)}-${Math.max(...seasons)})`,
    );
    console.log(
      `  Líneas de cierre: spread/total en ${withLine} (${((100 * withLine) / games.length).toFixed(1)}%) · ` +
        `moneyline en ${withMl} (${((100 * withMl) / games.length).toFixed(1)}%)`,
    );

    storeGames(league.id, games, names);
    const scheduled = storeSchedule(league.id, fixtures, names);
    console.log(`  ${scheduled} partidos próximos desde el calendario oficial`);

    const built = rebuildRatings(league.id);
    const state = getLeagueState(league.id);
    console.log(`  Elo recalculado: ${built.teams} equipos sobre ${built.games} partidos`);
    console.log(
      `  Estado de la liga: ventaja de campo ${state.homeAdvantage.toFixed(1)} Elo ` +
        `(${(state.homeAdvantage / ELO_PER_POINT).toFixed(2)} puntos) · ` +
        `${state.leagueTotal.toFixed(1)} puntos por partido`,
    );
  }

  if (env.oddsApiKey) {
    console.log('\n▸ Cuotas en vivo');
    try {
      const n = await refreshOdds();
      console.log(`  ${n} partidos con precios de casas`);
    } catch (err) {
      console.log(`  Sin cuotas: ${(err as Error).message}`);
    }
  } else {
    console.log('\n▸ Cuotas: ODDS_API_KEY no configurada — se usan solo el calendario y el modelo.');
  }

  setMeta('naf:updatedAt', new Date().toISOString());
  console.log(`\n✅ Listo. ${countTeams()} equipos y ${countGames()} partidos en la base.`);
}

main().catch((err) => {
  console.error('\n❌', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
