// CLI: `npm run update-data:fb [-- --league epl --seasons 8 --source auto --skip-odds]`
//
// Refreshes football data, independently of the other two sports.
//
// SOURCES (--source)
//   auto (default) — football-data.co.uk (current seasons AND historical 1X2
//                    odds). Falls back to the GitHub-hosted footballcsv mirror
//                    for any league that source can't serve.
//   football-data  — football-data.co.uk only.
//   footballcsv    — the GitHub mirror only. Real matches with no odds, and it
//                    lags a few seasons, so ratings won't describe this weekend.
//
// SQUADS (--skip-squads to leave them alone)
//   Premier League player data comes from the FPL mirror on GitHub: minutes,
//   attacking output per 90, and who is injured or suspended right now. It is the
//   only signal measured in this project that the Elo did not already contain —
//   see docs/FOOTBALL.md.

import { getDb, setMeta } from '../../db.ts';
import { footballConfig } from '../../config.ts';
import { ingestFootballCsv } from '../ingest/footballcsv.ts';
import {
  ingestOpenFootball,
  seasonLabels as openfootballSeasons,
} from '../ingest/openfootball.ts';
import { ingestFootballData } from '../ingest/footballData.ts';
import { ingestFplPlayers } from '../ingest/fplPlayers.ts';
import { refreshFootballOdds } from '../ingest/odds.ts';
import { recomputeFootballRatings } from '../ratings.ts';
import { countMatches, countTeams, getLeagueLatestDate } from '../repo.ts';
import { getFootballTrackRecord, resolveFootballPredictions } from '../trackRecord.ts';

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    // `--flag=value` too: written as one token it used to become the key
    // "flag=value", which nothing looks up, so the flag silently did nothing.
    const eq = a.indexOf('=');
    if (eq > 2) { args[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { args[a.slice(2)] = next; i++; } else args[a.slice(2)] = true;
  }
  return args;
}

/** European seasons are labelled by the year they END in. */
function seasonsToFetch(count: number): number[] {
  const now = new Date();
  const current = now.getUTCMonth() + 1 >= 7 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(current - i);
  return out.reverse();
}

function seasonLabels(seasons: number[]): string[] {
  return seasons.map((end) => `${end - 1}-${String(end % 100).padStart(2, '0')}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const onlyLeague = typeof args.league === 'string' ? args.league : null;
  const seasonCount = Number(args.seasons) || footballConfig.history.seasons;
  const skipOdds = !!args['skip-odds'];
  const skipSquads = !!args['skip-squads'];
  const source = typeof args.source === 'string' ? args.source : 'auto';
  if (!['auto', 'football-data', 'footballcsv'].includes(source)) {
    throw new Error(`--source desconocido: ${source} (usa auto, football-data o footballcsv)`);
  }

  const db = getDb();
  const leagues = footballConfig.leagues.filter((l) => !onlyLeague || l.id === onlyLeague);
  if (leagues.length === 0) throw new Error(`Liga desconocida: ${onlyLeague}`);

  const seasons = seasonsToFetch(seasonCount);
  console.log(
    `\n⚽ Actualizando fútbol · temporadas ${seasons[0]}–${seasons[seasons.length - 1]}` +
      `${onlyLeague ? ` (${onlyLeague})` : ''} · fuente: ${source}`,
  );

  // Full rebuild per league. The prediction log and the other sports' tables are
  // deliberately untouched.
  db.exec('BEGIN');
  try {
    for (const l of leagues) {
      db.prepare('DELETE FROM fb_matches WHERE league = ?').run(l.id);
      db.prepare('DELETE FROM fb_teams WHERE league = ?').run(l.id);
      db.prepare('DELETE FROM fb_team_ratings WHERE league = ?').run(l.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const noModel: string[] = [];
  let total = 0;

  for (const league of leagues) {
    console.log(`\n▸ ${league.label}`);
    if (!league.footballData && !league.footballcsv && !league.openfootball) {
      console.log(
        '  sin fuente de resultados: se mostrarán los partidos y las cuotas del mercado,\n' +
          '  pero no habrá modelo Elo. La app lo indica en la interfaz.',
      );
      noModel.push(league.id);
      continue;
    }

    let got = 0;
    // openfootball FIRST, and it is the source that matters: it is the only one that
    // reaches the current season. football-data.co.uk then runs anyway, because it
    // carries the closing ODDS that this one does not and that the market comparison
    // depends on — the two are complements, not alternatives.
    if (source !== 'footballcsv' && source !== 'football-data' && league.openfootball) {
      try {
        const r = await ingestOpenFootball(league, openfootballSeasons(seasonCount));
        if (r.matches > 0) {
          console.log(
            `  openfootball: ${r.matches} partidos, temporadas ${r.seasons.join(', ')}` +
              ` — hasta ${r.through}` +
              (r.withHalfTime > 0 ? ` · ${r.withHalfTime} con marcador al descanso` : ''),
          );
          got += r.matches;
        } else {
          console.log('  openfootball: sin partidos para esta liga');
        }
      } catch (e) {
        console.warn(`  ⚠️  openfootball falló: ${(e as Error).message}`);
      }
    }

    if (source !== 'footballcsv' && league.footballData) {
      try {
        const r = await ingestFootballData(league, seasons);
        if (r.matches > 0) {
          console.log(
            `  football-data.co.uk: ${r.matches} partidos (${r.withOdds} con cuotas 1X2), ` +
              `temporadas ${r.seasons.join(', ')}`,
          );
          got += r.matches;
        }
      } catch (e) {
        console.warn(`  ⚠️  football-data.co.uk falló: ${(e as Error).message}`);
      }
    }

    // The old mirror only as a last resort now.
    if (got === 0 && source !== 'football-data' && league.footballcsv) {
      try {
        const r = await ingestFootballCsv(league, seasonLabels(seasons.length >= 20 ? seasons : seasonsToFetch(21)));
        if (r.matches > 0) {
          console.log(
            `  footballcsv (GitHub): ${r.matches} partidos reales, ${r.seasons.length} temporadas` +
              ` — sin cuotas, y puede ir varias temporadas por detrás`,
          );
          got += r.matches;
        }
      } catch (e) {
        console.warn(`  ⚠️  footballcsv falló: ${(e as Error).message}`);
      }
    }

    if (got === 0) noModel.push(league.id);
    total += got;
  }

  if (total === 0 && countMatches() === 0) {
    throw new Error(
      'No se ingirió ningún partido. La ingesta usa football-data.co.uk y, como reserva, ' +
        'un espejo alojado en GitHub. Comprueba tu conexión y vuelve a intentarlo.',
    );
  }
  if (noModel.length) {
    console.warn(
      `\n⚠️  Ligas sin modelo: ${noModel.join(', ')}. Seguirán mostrando partidos y cuotas del mercado.`,
    );
  }

  console.log('\n▸ Calculando Elo…');
  console.log(`  equipos con rating: ${JSON.stringify(recomputeFootballRatings())}`);

  for (const league of leagues) {
    const latest = getLeagueLatestDate(league.id);
    if (!latest) continue;
    setMeta(`fb_history_through_${league.id}`, latest);
    const y = Number(latest.slice(0, 4));
    const m = Number(latest.slice(4, 6));
    const monthsOld = (new Date().getUTCFullYear() - y) * 12 + (new Date().getUTCMonth() + 1 - m);
    console.log(`  ${league.name}: último partido ${latest}`);
    // A football league has a real summer break, so "stale" starts later than in
    // basketball — but 5+ months means we missed the season restart.
    if (monthsOld > 5) {
      console.warn(
        `  ⚠️  El historial de ${league.name} termina hace ~${Math.round(monthsOld)} meses.\n` +
          `      Los Elo NO describen a las plantillas actuales.`,
      );
    }
  }

  // Squads come AFTER the results ingest, because matching FPL's club names
  // needs the teams to already be in the database.
  if (!skipSquads && leagues.some((l) => l.id === 'epl')) {
    console.log('\n▸ Plantillas (Premier League)…');
    try {
      const sq = await ingestFplPlayers('epl');
      console.log(
        `  ${sq.players} jugadores de ${sq.teams} equipos · temporada ${sq.season}` +
          (sq.unmatched.length ? `\n  ⚠️  sin emparejar: ${sq.unmatched.join(', ')}` : ''),
      );
    } catch (e) {
      // Never fatal: squads are an extra layer, and the team model works without
      // them. Saying so beats failing an otherwise successful update.
      console.warn(`  ⚠️  plantillas no disponibles: ${(e as Error).message}`);
    }
  }

  if (!skipOdds) {
    console.log('\n▸ Partidos próximos y cuotas…');
    const odds = await refreshFootballOdds();
    console.log(
      `  ${odds.count} partidos (${odds.source === 'live' ? 'cuotas reales' : 'demo, sin API key'})` +
        `${odds.promoted ? ` · ${odds.promoted} recién ascendidos con Elo trasladado` : ''}` +
        `${odds.leagues.length ? ` · ligas: ${odds.leagues.join(', ')}` : ''}`,
    );
  }

  const scored = resolveFootballPredictions();
  if (scored.resolved > 0) {
    const rec = getFootballTrackRecord();
    console.log(
      `\n▸ Predicciones de fútbol resueltas: ${scored.resolved}` +
        (rec.rps != null ? `\n  Track record: RPS ${rec.rps} en ${rec.resolved} predicciones.` : ''),
    );
  }

  setMeta('fb_data_source', source);
  setMeta('fb_updated_at', new Date().toISOString());
  console.log(
    `\n✅ Listo. ${countTeams()} equipos y ${countMatches()} partidos.` +
      `\n   Arranca con:  npm run dev   → pestaña ⚽ Fútbol\n`,
  );
}

main().catch((err) => {
  console.error('\n❌ update-data:fb falló:', err.message);
  process.exit(1);
});
