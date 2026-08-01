// CLI: `npm run update-data:bsb [-- --seasons 8 --cache --skip-odds]`
//
// Refreshes baseball data, independently of the other three sports.
//
// SOURCES
//   Retrosheet (GitHub)  — the deep history the model was fitted on. One file per
//                          team per season, thirty files covering a season exactly
//                          once. The final score is counted off the plays, and
//                          that counter was verified game by game against
//                          Retrosheet's own official log (npm run verify:bsb).
//                          It publishes AFTER a season ends.
//   MLB Stats API        — the season in PROGRESS, which Retrosheet cannot supply.
//                          Free and keyless. Without it the ratings would always
//                          describe last year's rotations. --skip-live turns it off.
//
//   Only MLB has either. NPB and KBO show upcoming games and market prices, and
//   the interface says there is no model rather than inventing one.

import { getDb, setMeta } from '../../db.ts';
import { baseballConfig } from '../../config.ts';
import { ingestRetrosheet } from '../ingest/retrosheet.ts';
import { ingestMlbSeason } from '../ingest/mlbStatsApi.ts';
import { refreshBaseballOdds } from '../ingest/odds.ts';
import { recomputeBaseballRatings } from '../ratings.ts';
import { countGames, countTeams, getLeagueLatestDate } from '../repo.ts';
import { getBaseballTrackRecord, resolveBaseballPredictions } from '../trackRecord.ts';

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[a.slice(2)] = next;
      i++;
    } else args[a.slice(2)] = true;
  }
  return args;
}

/**
 * Seasons to fetch, newest first in the calendar sense.
 *
 * A baseball season runs inside one calendar year, so this is simpler than
 * football's — but the current year is only useful once it has started, and
 * asking for it in February just wastes thirty HTTP requests on 404s.
 */
function seasonsToFetch(count: number): number[] {
  const now = new Date();
  const current = now.getUTCMonth() + 1 >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(current - i);
  return out.reverse();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seasonCount = Number(args.seasons) || baseballConfig.history.seasons;
  const skipOdds = !!args['skip-odds'];
  const cache = !!args.cache;
  const skipLive = !!args['skip-live'];
  const fresh = !!args.fresh;

  const db = getDb();
  const seasons = seasonsToFetch(seasonCount);
  console.log(
    `\n⚾ Actualizando béisbol · temporadas ${seasons[0]}–${seasons[seasons.length - 1]}` +
      `${cache ? ' (con caché en disco)' : ''}`,
  );

  if (fresh) {
    // Opt-in: the ingest is idempotent thanks to the UNIQUE key, so a rebuild is
    // only needed when the parser itself has changed.
    db.exec('BEGIN');
    try {
      db.prepare("DELETE FROM bsb_games WHERE league = 'mlb'").run();
      db.prepare("DELETE FROM bsb_team_ratings WHERE league = 'mlb'").run();
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    console.log('  (--fresh: partidos y ratings de MLB borrados antes de reingerir)');
  }

  console.log('\n▸ Resultados (Retrosheet vía GitHub)…');
  const r = await ingestRetrosheet(seasons, 'mlb', {
    cache,
    onSeason: (s, n) =>
      console.log(n > 0 ? `  ${s}: ${n} partidos` : `  ${s}: sin datos (temporada aún no publicada)`),
  });
  console.log(
    `  total: ${r.games} partidos · ${r.teams} equipos · ${r.pitchers} lanzadores abridores`,
  );

  // The season in progress, which Retrosheet has not published yet.
  if (!skipLive) {
    const current = new Date().getUTCFullYear();
    console.log('\n▸ Temporada en curso (MLB Stats API)…');
    for (const season of [current, current - 1]) {
      if (r.seasons.includes(season)) continue; // already covered by Retrosheet
      try {
        const live = await ingestMlbSeason(season);
        console.log(
          `  ${season}: ${live.games} partidos terminados` +
            `${live.through ? ` (hasta ${live.through})` : ''}` +
            `${live.withStarters > 0 ? `, ${live.withStarters} con abridor` : ''}`,
        );
      } catch (e) {
        console.warn(`  ⚠️  ${season} no disponible: ${(e as Error).message}`);
      }
    }
  }

  console.log('\n▸ Calculando Elo y valoraciones de abridores…');
  console.log(`  equipos con rating: ${JSON.stringify(recomputeBaseballRatings())}`);

  for (const league of baseballConfig.leagues) {
    const latest = getLeagueLatestDate(league.id);
    if (!latest) continue;
    setMeta(`bsb_history_through_${league.id}`, latest);
    const y = Number(latest.slice(0, 4));
    const m = Number(latest.slice(4, 6));
    const monthsOld = (new Date().getUTCFullYear() - y) * 12 + (new Date().getUTCMonth() + 1 - m);
    console.log(`  ${league.name}: último partido ${latest}`);
    // Baseball's off-season is roughly five months (November to March), so
    // "stale" has to start later than that or every February would look broken.
    if (monthsOld > 6) {
      console.warn(
        `  ⚠️  El historial de ${league.name} termina hace ~${Math.round(monthsOld)} meses.\n` +
          `      Los Elo NO describen a las plantillas actuales.`,
      );
    }
  }

  if (!skipOdds) {
    console.log('\n▸ Partidos próximos, cuotas y abridores anunciados…');
    const odds = await refreshBaseballOdds();
    console.log(
      `  ${odds.count} partidos (${odds.source === 'live' ? 'cuotas reales' : 'demo, sin API key'})` +
        `${odds.leagues.length ? ` · ligas: ${odds.leagues.join(', ')}` : ''}`,
    );
    console.log(
      odds.withStarters > 0
        ? `  ${odds.withStarters} con los dos abridores anunciados`
        : '  sin abridores anunciados: el modelo usará el número uno de cada rotación y lo dirá',
    );
  }

  const scored = resolveBaseballPredictions();
  if (scored.resolved > 0) {
    const rec = getBaseballTrackRecord();
    console.log(
      `\n▸ Predicciones de béisbol resueltas: ${scored.resolved}` +
        (rec.brier != null ? `\n  Track record: Brier ${rec.brier.toFixed(4)} en ${rec.resolved}.` : ''),
    );
  }

  setMeta('bsb_data_source', 'retrosheet');
  setMeta('bsb_updated_at', new Date().toISOString());
  console.log(
    `\n✅ Listo. ${countTeams()} equipos y ${countGames()} partidos.` +
      `\n   Arranca con:  npm run dev   → pestaña ⚾ Béisbol\n`,
  );
}

main().catch((err) => {
  console.error('\n❌ update-data:bsb falló:', err.message);
  process.exit(1);
});
