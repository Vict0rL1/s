// A5: la ingesta de baloncesto vaciaba bb_games, bb_teams y bb_team_ratings ANTES de descargar
// (minutos), y el ciclo pre-partido registraba mientras tanto predicciones con Elo inicial en
// tablas inmutables. Ahora: se descarga todo a memoria y después, por liga y en UNA
// transacción, se borra, se inserta y se recalculan los ratings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../test/setup.ts';

const { getDb } = await import('../../db.ts');
const { actualizarHistoriaBaloncesto } = await import('./actualizar.ts');
const { basketballConfig } = await import('../../config.ts');
const { recomputeBasketballRatings } = await import('../ratings.ts');

const db = getDb();
const nba = basketballConfig.leagues.find((l) => l.id === 'nba')!;

// La base de partida: dos equipos, treinta partidos con el mismo ganador, y sus ratings.
db.prepare("INSERT INTO bb_teams (id, league, name) VALUES ('fuertes', 'nba', 'Fuertes'), ('flojos', 'nba', 'Flojos')").run();
const ins = db.prepare("INSERT INTO bb_games (league, season, game_date, home_id, away_id, home_pts, away_pts) VALUES ('nba', 2025, ?, ?, ?, ?, ?)");
for (let i = 0; i < 30; i++) {
  const dia = `2025${String(1 + (i % 6)).padStart(2, '0')}${String(1 + (i % 28)).padStart(2, '0')}`;
  if (i % 2) ins.run(dia, 'fuertes', 'flojos', 110, 95);
  else ins.run(dia, 'flojos', 'fuertes', 90, 108);
}
recomputeBasketballRatings();
const partidos = () => (db.prepare("SELECT COUNT(*) n FROM bb_games WHERE league = 'nba'").get() as { n: number }).n;
const ratings = () => db.prepare("SELECT team_id, elo, games_played FROM bb_team_ratings WHERE league = 'nba' ORDER BY team_id").all() as { team_id: string; elo: number; games_played: number }[];
const antes = ratings();
assert.equal(partidos(), 30);
assert.equal(antes.length, 2);
assert.ok(antes.find((r) => r.team_id === 'fuertes')!.elo > antes.find((r) => r.team_id === 'flojos')!.elo);

const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
const equipos = json({ sports: [{ leagues: [{ teams: [{ team: { id: '1', displayName: 'Fuertes' } }, { team: { id: '2', displayName: 'Flojos' } }] }] }] });
const partido = (fecha: string, local: string, visitante: string, pl: number, pv: number) => ({
  date: fecha,
  competitions: [{ date: fecha, status: { type: { completed: true } }, competitors: [{ homeAway: 'home', team: { displayName: local }, score: String(pl) }, { homeAway: 'away', team: { displayName: visitante }, score: String(pv) }] }],
});

test('A5: si la descarga falla, los partidos y los ratings quedan como estaban', async () => {
  const falla = (async () => {
    throw new Error('ESPN no contesta');
  }) as unknown as typeof fetch;
  const r = await actualizarHistoriaBaloncesto({ leagues: [nba], seasons: [2026], source: 'espn', fetch: falla, log: () => undefined });
  assert.deepEqual(r.fallidas, ['nba']);
  assert.equal(partidos(), 30);
  assert.deepEqual(ratings(), antes);
});

test('A5: DURANTE la descarga los partidos y los ratings siguen en la base; después, se reemplazan de una vez', async () => {
  const vistos: { partidos: number; ratings: number }[] = [];
  const simulado = (async (url: string) => {
    vistos.push({ partidos: partidos(), ratings: ratings().length });
    const u = String(url);
    if (u.endsWith('/teams')) return equipos;
    if (u.includes('/teams/1/schedule')) return json({ events: [partido('2026-01-10T00:00Z', 'Fuertes', 'Flojos', 100, 99), partido('2026-01-12T00:00Z', 'Flojos', 'Fuertes', 101, 90)] });
    if (u.includes('/teams/2/schedule')) return json({ events: [partido('2026-01-10T00:00Z', 'Fuertes', 'Flojos', 100, 99)] });
    return new Response('no', { status: 404 });
  }) as unknown as typeof fetch;
  const r = await actualizarHistoriaBaloncesto({ leagues: [nba], seasons: [2026], source: 'espn', fetch: simulado, log: () => undefined });
  assert.ok(vistos.length >= 3, `${vistos.length} descargas`);
  for (const v of vistos) assert.deepEqual(v, { partidos: 30, ratings: 2 }, 'mientras se descarga, nada se ha borrado');
  assert.deepEqual(r.fallidas, []);
  assert.equal(r.total, 2, 'el mismo partido visto desde los dos equipos cuenta una vez');
  assert.equal(partidos(), 2, 'la reconstrucción deja solo lo descargado');
  const despues = ratings();
  assert.equal(despues.length, 2);
  assert.notDeepEqual(despues, antes, 'los ratings se recalcularon con los partidos nuevos');
  assert.equal(despues.find((x) => x.team_id === 'flojos')!.games_played, 2);
});
