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

import { setMeta } from '../../db.ts';
import { basketballConfig } from '../../config.ts';
import { refreshBasketballOdds } from '../ingest/odds.ts';
import { actualizarHistoriaBaloncesto, type FuenteHistoria } from './actualizar.ts';
import { countGames, countTeams, getLeagueLatestDate } from '../repo.ts';
import { getBasketballTrackRecord, resolveGamePredictions } from '../trackRecord.ts';
import { conRegistro } from '../../ingest/runs.ts';

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

  const leagues = basketballConfig.leagues.filter((l) => !onlyLeague || l.id === onlyLeague);
  if (leagues.length === 0) throw new Error(`Liga desconocida: ${onlyLeague}`);

  const seasons = seasonsToFetch(seasonCount);
  console.log(
    `\n🏀 Actualizando baloncesto · temporadas ${seasons[0]}–${seasons[seasons.length - 1]}` +
      `${onlyLeague ? ` (${onlyLeague})` : ''} · fuente: ${source}`,
  );

  // Descargar todo primero y, por liga, borrar + insertar + recalcular en UNA transacción
  // (ver actualizar.ts): la base nunca se ve vacía mientras se descarga. El registro de
  // predicciones y las tablas de los otros deportes no se tocan.
  const historia = await actualizarHistoriaBaloncesto({ leagues, seasons, source: source as FuenteHistoria });
  const { total, fallidas: failed } = historia;

  if (total === 0 && countGames() === 0) {
    throw new Error(
      'No se ingirió ningún partido de baloncesto. Comprueba tu conexión: la ingesta usa ' +
        'ESPN (site.api.espn.com) y, como reserva para la NBA, un CSV alojado en GitHub.',
    );
  }
  if (failed.length) {
    console.warn(`\n⚠️  Ligas sin datos: ${failed.join(', ')}. El resto funciona con normalidad.`);
  }

  console.log(`\n▸ Elo recalculado · equipos con rating: ${JSON.stringify(historia.ratings)}`);

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

// Cada ejecución queda en ingestion_runs (ok o error con su mensaje): ver ingest/runs.ts.
conRegistro('update-data:bb', main).catch((err) => {
  console.error('\n❌ update-data:bb falló:', err.message);
  process.exit(1);
});
