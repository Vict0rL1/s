// CLI: `npm run update-data [-- --from 2015 --to 2025 --tour atp --skip-odds]`
//
// Refreshes real data:
//   1. Downloads historical matches from Jeff Sackmann's repos (per season CSV).
//   2. Recomputes Elo ratings from scratch.
//   3. Fetches live bookmaker odds from The Odds API (needs ODDS_API_KEY),
//      or generates Elo-derived fixtures when no key / out of season.
//
// Needs internet access. In offline/restricted environments use `npm run seed`.

import fs from 'node:fs';
import path from 'node:path';
import { getDb, resetData, setMeta } from '../db.ts';
import { RAW_DIR, toursConfig } from '../config.ts';
import { ingestRankings, ingestTour, preflight, tourConfigs } from '../ingest/sackmann.ts';
import { recomputeRatings } from '../ingest/ratings.ts';
import { refreshOdds } from '../ingest/odds.ts';
import { ingestTennisData } from '../ingest/tennisData.ts';
import { getTrackRecord, resolvePredictions } from '../trackRecord.ts';

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
  // Where the history comes from:
  //   auto (default) — the configured GitHub source per tour, falling back to
  //                    tennis-data.co.uk for any tour that source can't serve
  //                    (which is how the WTA gets data at all).
  //   tml            — GitHub only, the previous behaviour.
  //   tennis-data    — tennis-data.co.uk only: fewer per-match stats, but it
  //                    carries historical odds for every match.
  const source = typeof args.source === 'string' ? args.source : 'auto';
  if (!['auto', 'tml', 'tennis-data'].includes(source)) {
    throw new Error(`--source desconocido: ${source} (usa auto, tml o tennis-data)`);
  }

  // `--fresh` deletes the download cache (data/raw) so the next run re-fetches
  // from scratch. Needed to escape a stale mirror: cached CSVs and an existing
  // clone are reused by design, so a plain re-run would keep the old data.
  if (args.fresh) {
    // Clear cached CSVs and clones, but KEEP anything the user placed manually
    // (ZIPs / unzipped folders) — that copy is the whole point of the manual route.
    let kept = 0;
    if (fs.existsSync(RAW_DIR)) {
      for (const entry of fs.readdirSync(RAW_DIR)) {
        if (entry === '.gitkeep') continue;
        if (entry.toLowerCase().endsWith('.zip')) {
          kept++;
          continue;
        }
        if (entry === 'repos') {
          for (const repoDir of fs.readdirSync(path.join(RAW_DIR, 'repos'))) {
            const full = path.join(RAW_DIR, 'repos', repoDir);
            // A manual copy has no .git; keep it, drop clones and stale unzips.
            if (!fs.existsSync(path.join(full, '.git')) && !repoDir.endsWith('-unzipped')) {
              kept++;
              continue;
            }
            fs.rmSync(full, { recursive: true, force: true });
          }
          continue;
        }
        fs.rmSync(path.join(RAW_DIR, entry), { recursive: true, force: true });
      }
    }
    fs.mkdirSync(RAW_DIR, { recursive: true });
    console.log(
      `\n🧹 Caché de descargas borrada (data/raw)` +
        (kept ? `; se conservan ${kept} copia(s) manual(es).` : ': se volverá a descargar todo.'),
    );
  }

  getDb();
  console.log(`\n⟳ Updating data ${fromYear}–${toYear}${onlyTour ? ` (${onlyTour})` : ''}…`);

  const tours = tourConfigs().filter((t) => !onlyTour || t.id === onlyTour);
  if (tours.length === 0) throw new Error(`Tour desconocido: ${onlyTour}`);

  // Preflight: confirm we can reach the data source BEFORE wiping existing data.
  // Skipped when GitHub isn't being used, so a network that blocks it doesn't
  // stop an ingest that never needed it.
  if (source !== 'tennis-data') {
    console.log('\n▸ Comprobando conexión con la fuente de datos (GitHub)…');
    const found = await preflight(tours[0]);
    console.log(`  OK — ${found} jugadores disponibles.`);
  }

  // Full rebuild keeps ratings correct and avoids duplicate matches.
  resetData();

  // One unreachable tour shouldn't lose the other: ingest what we can and warn.
  let totalMatches = 0;
  const failed: string[] = [];
  for (const tour of tours) {
    console.log(`\n▸ ${tour.label}`);
    let got = 0;
    let gitHubError: string | null = null;

    if (source !== 'tennis-data') {
      try {
        const res = await ingestTour(tour, { fromYear, toYear });
        console.log(`  players: ${res.players}, matches: ${res.matches}`);
        got = res.matches;
        // Official rankings: lets the app show a player's real rank/points even
        // if the match history doesn't cover their career.
        const ranked = await ingestRankings(tour);
        if (ranked) console.log(`  rankings oficiales: ${ranked} filas procesadas`);
      } catch (e) {
        gitHubError = (e as Error).message;
        if (source === 'tml') console.warn(`  ⚠️  No se pudo descargar ${tour.id}: ${gitHubError}`);
      }
    }

    // tennis-data.co.uk: either asked for explicitly, or as the fallback for a
    // tour GitHub couldn't serve. This is what gives the WTA any data at all.
    if (source === 'tennis-data' || (source === 'auto' && got === 0)) {
      if (gitHubError) {
        console.warn(`  ⚠️  GitHub no sirvió ${tour.id} (${gitHubError}).`);
        console.log(`  ↳ Probando tennis-data.co.uk (incluye cuotas históricas)…`);
      }
      try {
        const seasons = await ingestTennisData(tour.id, { fromYear, toYear });
        const n = seasons.reduce((a, s2) => a + s2.matches, 0);
        const withOdds = seasons.reduce((a, s2) => a + s2.withOdds, 0);
        if (n > 0) {
          console.log(`  tennis-data.co.uk: ${n} partidos, ${withOdds} con cuotas históricas`);
          got += n;
        }
      } catch (e) {
        console.warn(`  ⚠️  tennis-data.co.uk falló para ${tour.id}: ${(e as Error).message}`);
      }
    }

    if (got === 0) failed.push(tour.id);
    totalMatches += got;
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

  // Score the app's own past predictions against the results just ingested.
  // This is what turns the prediction log into a real, measured track record.
  const scored = resolvePredictions();
  if (scored.resolved > 0) {
    const rec = getTrackRecord();
    console.log(
      `\n▸ Predicciones resueltas con los nuevos resultados: ${scored.resolved}` +
        (rec.accuracy != null
          ? `\n  Track record acumulado: ${(rec.accuracy * 100).toFixed(1)}% de acierto ` +
            `en ${rec.resolved} predicciones (Brier ${rec.brier}).`
          : ''),
    );
  }

  if (!skipOdds) {
    console.log('\n▸ Fetching odds…');
    const odds = await refreshOdds();
    console.log(`  ${odds.source} odds for ${odds.count} upcoming matches`);
  }

  setMeta('data_source', source === 'tennis-data' ? 'tennis-data' : 'sackmann');
  setMeta('updated_at', new Date().toISOString());

  console.log('\n✅ Done. Start the app with:  npm run dev\n');
}

main().catch((err) => {
  console.error('\n❌ update-data failed:', err.message);
  console.error('   If you are offline or behind a firewall, run `npm run seed` instead.');
  process.exit(1);
});
