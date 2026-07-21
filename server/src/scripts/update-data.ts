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
import { ingestTour, tourConfigs } from '../ingest/sackmann.ts';
import { recomputeRatings } from '../ingest/ratings.ts';
import { ingestOdds } from '../ingest/odds.ts';

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

  // Full rebuild keeps ratings correct and avoids duplicate matches.
  resetData();

  const tours = tourConfigs().filter((t) => !onlyTour || t.id === onlyTour);
  for (const tour of tours) {
    console.log(`\n▸ ${tour.label}`);
    const res = await ingestTour(tour, { fromYear, toYear });
    console.log(`  players: ${res.players}, matches: ${res.matches}`);
  }

  console.log('\n▸ Computing Elo ratings…');
  const ratings = recomputeRatings();
  console.log(`  rated players: ${JSON.stringify(ratings)}`);

  let oddsSource = 'skipped';
  if (!skipOdds) {
    console.log('\n▸ Fetching odds…');
    const odds = await ingestOdds();
    oddsSource = odds.source;
    console.log(`  ${odds.source} odds for ${odds.count} upcoming matches`);
  }

  setMeta('data_source', 'sackmann');
  setMeta('updated_at', new Date().toISOString());
  setMeta('odds_source', oddsSource);

  console.log('\n✅ Done. Start the app with:  npm run dev\n');
}

main().catch((err) => {
  console.error('\n❌ update-data failed:', err.message);
  console.error('   If you are offline or behind a firewall, run `npm run seed` instead.');
  process.exit(1);
});
