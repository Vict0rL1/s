// CLI: `npm run update-data [-- --from 2015 --to 2025 --tour atp --skip-odds]`
//
// Refreshes real data:
//   1. Downloads historical matches from Jeff Sackmann's repos (per season CSV).
//   2. Recomputes Elo ratings from scratch.
//   3. Fetches live bookmaker odds from The Odds API (needs ODDS_API_KEY),
//      or generates Elo-derived fixtures when no key / out of season.
//
// Needs internet access. In offline/restricted environments use `npm run seed`.

import { getDb, resetData, setMeta } from '../db.ts';
import { toursConfig } from '../config.ts';
import { ingestTour, preflight, tourConfigs } from '../ingest/sackmann.ts';
import { recomputeRatings } from '../ingest/ratings.ts';
import { refreshOdds } from '../ingest/odds.ts';

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fromYear = Number(args.from) || toursConfig.history.startYear;
  const toYear = Number(args.to) || new Date().getFullYear();
  const onlyTour = typeof args.tour === 'string' ? args.tour : null;
  const skipOdds = !!args['skip-odds'];

  getDb();
  console.log(`\n⟳ Updating data ${fromYear}–${toYear}${onlyTour ? ` (${onlyTour})` : ''}…`);

  const tours = tourConfigs().filter((t) => !onlyTour || t.id === onlyTour);
  if (tours.length === 0) throw new Error(`Tour desconocido: ${onlyTour}`);

  // Preflight: confirm we can reach the data source BEFORE wiping existing data.
  console.log('\n▸ Comprobando conexión con la fuente de datos (GitHub)…');
  const found = await preflight(tours[0]);
  console.log(`  OK — ${found} jugadores disponibles.`);

  // Full rebuild keeps ratings correct and avoids duplicate matches.
  resetData();

  // One unreachable tour shouldn't lose the other: ingest what we can and warn.
  let totalMatches = 0;
  const failed: string[] = [];
  for (const tour of tours) {
    console.log(`\n▸ ${tour.label}`);
    try {
      const res = await ingestTour(tour, { fromYear, toYear });
      console.log(`  players: ${res.players}, matches: ${res.matches}`);
      totalMatches += res.matches;
    } catch (e) {
      failed.push(tour.id);
      console.warn(`  ⚠️  No se pudo descargar ${tour.id}: ${(e as Error).message}`);
    }
  }

  if (totalMatches === 0) {
    throw new Error(
      'No se descargó ningún partido. Puede ser un bloqueo de red a GitHub — ' +
        'prueba con otra red y vuelve a ejecutar `npm run update-data`. ' +
        'Mientras tanto, `npm run seed` deja la app funcionando con datos de ejemplo.',
    );
  }
  if (failed.length) {
    console.warn(
      `\n⚠️  Circuitos no descargados: ${failed.join(', ')}. ` +
        `El resto de la app funciona; reintenta más tarde para completarlos.`,
    );
  }

  // Warn loudly if the newest match is old: stale history means stale Elo (a
// mirror can be years behind, so today's top players would be missing).
  const latest = getDb()
    .prepare('SELECT MAX(tourney_date) AS d FROM matches')
    .get() as unknown as { d: string | null };
  if (latest.d) {
    setMeta('history_through', latest.d);
    const year = Number(latest.d.slice(0, 4));
    const month = Number(latest.d.slice(4, 6));
    const monthsOld =
      (new Date().getUTCFullYear() - year) * 12 + (new Date().getUTCMonth() + 1 - month);
    console.log(`\n  Último partido en los datos: ${latest.d}`);
    if (monthsOld > 6) {
      console.warn(
        `  ⚠️  ATENCIÓN: el historial termina hace ~${Math.round(monthsOld / 12 * 10) / 10} años.\n` +
          `      Los Elo NO reflejan a los jugadores actuales y las predicciones serán poco fiables.\n` +
          `      Suele pasar al caer en un repositorio espejo desactualizado. Intenta de nuevo\n` +
          `      desde una red que no bloquee github.com/JeffSackmann para obtener datos al día.`,
      );
    }
  }

  console.log('\n▸ Computing Elo ratings…');
  const ratings = recomputeRatings();
  console.log(`  rated players: ${JSON.stringify(ratings)}`);

  if (!skipOdds) {
    console.log('\n▸ Fetching odds…');
    const odds = await refreshOdds();
    console.log(`  ${odds.source} odds for ${odds.count} upcoming matches`);
  }

  setMeta('data_source', 'sackmann');
  setMeta('updated_at', new Date().toISOString());

  console.log('\n✅ Done. Start the app with:  npm run dev\n');
}

main().catch((err) => {
  console.error('\n❌ update-data failed:', err.message);
  console.error('   If you are offline or behind a firewall, run `npm run seed` instead.');
  process.exit(1);
});
