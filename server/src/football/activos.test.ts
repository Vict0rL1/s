// D14 (revisión del 8 de octubre): la tabla de Elo de la liga listaba TODOS los equipos con
// rating, también los que bajaron hace años. Solo los que juegan la liga: los de su última
// temporada en el archivo y los que tienen partido próximo (un recién ascendido).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { getDb } = await import('../db.ts');
const { getPowerRanking } = await import('./repo.ts');

test('D14: la tabla de Elo solo trae equipos activos de la liga', () => {
  const db = getDb();
  for (const [id, nombre] of [['ars', 'Arsenal'], ['che', 'Chelsea'], ['wat', 'Watford'], ['ips', 'Ipswich']]) {
    db.prepare("INSERT INTO fb_teams (id, league, name) VALUES (?, 'zz', ?)").run(id, nombre);
  }
  const elo = { ars: 1700, che: 1650, wat: 1500, ips: 1480 } as const;
  for (const [id, e] of Object.entries(elo)) db.prepare("INSERT INTO fb_team_ratings (team_id, league, elo, matches_played) VALUES (?, 'zz', ?, 38)").run(id, e);
  const partido = db.prepare("INSERT INTO fb_matches (league, season, match_date, home_id, away_id, home_goals, away_goals, result) VALUES ('zz', ?, ?, ?, ?, 1, 0, 'H')");
  partido.run(2019, '2019-10-01', 'wat', 'ars'); // el Watford bajó: su última temporada es la 2019
  partido.run(2025, '2025-10-01', 'ars', 'che');
  partido.run(2025, '2025-11-01', 'che', 'ars');
  // El Ipswich acaba de subir: sin partidos de esta temporada, pero con uno próximo.
  db.prepare("INSERT INTO fb_upcoming (id, league, commence_time, home_name, away_name, home_id, away_id, source, updated_at) VALUES ('u1', 'zz', '2026-10-20T15:00:00Z', 'Ipswich', 'Arsenal', 'ips', 'ars', 'live', '2026-10-09T00:00:00Z')").run();
  assert.deepEqual(getPowerRanking('zz' as never).map((t) => t.id), ['ars', 'che', 'ips']);
});
