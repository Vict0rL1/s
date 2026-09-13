// CLI: `npm run update-squads:fb [-- --season 2025-26]`
//
// Squads only, without touching results, ratings or odds.
//
// It has its own entry point because it has its own clock. Results change once a
// week; the injury list changes every day, and it is the part of the model that
// goes stale fastest — a striker ruled out on Friday is exactly the sort of thing
// that should be in Saturday's forecast without rebuilding fifteen seasons of Elo
// to get it there.

import { ingestFplPlayers } from '../ingest/fplPlayers.ts';
import { getSquad } from '../players.ts';
import { countTeams } from '../repo.ts';

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--season');
  const season = i >= 0 ? argv[i + 1] : undefined;
  const league = 'epl';

  if (countTeams(league) === 0) {
    throw new Error(
      'No hay equipos de la Premier League en la base. Corre `npm run update-data:fb` primero: ' +
        'las plantillas se emparejan contra los equipos que ya existen.',
    );
  }

  console.log('\n⚽ Actualizando plantillas de la Premier League…');
  const r = await ingestFplPlayers(league, season);
  console.log(`  ${r.players} jugadores de ${r.teams} equipos · temporada ${r.season}`);
  if (r.unmatched.length) {
    console.warn(
      `  ⚠️  sin emparejar: ${r.unmatched.join(', ')}\n` +
        '      (normal si el historial no llega a la temporada actual: son clubes ' +
        'que aún no aparecen en los resultados ingeridos, y tampoco tienen Elo)',
    );
  }

  // Say who is out, because that is the whole reason to run this.
  const teams = new Set<string>();
  const db = (await import('../../db.ts')).getDb();
  for (const row of db
    .prepare('SELECT DISTINCT team_id AS t FROM fb_players WHERE league = ?')
    .all(league) as unknown as { t: string }[]) {
    teams.add(row.t);
  }
  let flagged = 0;
  for (const t of [...teams].sort()) {
    const out = getSquad(league, t).filter((p) => p.regular && p.flaggedOut);
    if (out.length === 0) continue;
    flagged += out.length;
    console.log(`  ${t}: ${out.map((p) => `${p.name} (${p.flagReason ?? 'baja'})`).join(', ')}`);
  }
  console.log(
    `\n✅ ${flagged} bajas del once habitual detectadas.` +
      '\n   Ya están aplicadas en la pestaña ⚽ Fútbol; marca tú el resto cuando salga la alineación.\n',
  );
}

main().catch((err) => {
  console.error('\n❌ update-squads:fb falló:', err.message);
  process.exit(1);
});
