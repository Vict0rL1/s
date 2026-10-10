// G5 (prueba en el navegador, 9 de octubre): el texto que escribe el servidor va en español y la
// web lo pinta tal cual («Lectura completa», el titular, los avisos de fiabilidad). Antes cada
// deporte hacía `(p * 100).toFixed(1)` y pegaba el «%»: «41.6%» al lado del «41,2 %» de la web.
// Se construye una predicción de cada deporte con una base temporal mínima y se lee todo su texto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { getDb } = await import('../db.ts');
const { seedDatabase } = await import('../ingest/seed.ts');

/** Un separador de miles («20.214») no es un decimal: tres cifras tras el punto y otra delante que no sea 0. */
const DECIMAL_CON_PUNTO = /(?<![\w.,])(?:0\.\d+|\d+\.(?!\d{3}(?!\d))\d+)/;
/** El «%» va separado por un espacio duro: ni pegado ni con un espacio que parta la línea. */
const PORCIENTO_MAL = /\d ?%/;

function textos(x: unknown, ruta = '', out: [string, string][] = []): [string, string][] {
  if (typeof x === 'string') out.push([ruta, x]);
  else if (Array.isArray(x)) x.forEach((v, i) => textos(v, `${ruta}[${i}]`, out));
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) textos(v, ruta ? `${ruta}.${k}` : k, out);
  return out;
}
function malEscritos(p: unknown): string[] {
  return textos(p)
    .filter(([, s]) => DECIMAL_CON_PUNTO.test(s) || PORCIENTO_MAL.test(s))
    .map(([r, s]) => `${r}: ${s}`);
}

test('G5: tenis, fútbol, baloncesto, béisbol y NFL escriben sus números en español', async () => {
  const db = getDb();
  seedDatabase();
  const { buildPrediction: tenis } = await import('../model/predict.ts');
  const jugadores = db.prepare("SELECT id FROM players WHERE tour = 'atp' LIMIT 2").all() as { id: number }[];
  const t = tenis('atp', jugadores[0].id, jugadores[1].id, 'Hard', { odds1: 1.35, odds2: 3.25 }, 5, 'Wimbledon');

  for (const [id, nombre] of [['ars', 'Arsenal'], ['che', 'Chelsea']]) db.prepare("INSERT INTO fb_teams (id, league, name) VALUES (?, 'epl', ?)").run(id, nombre);
  for (const [id, e] of [['ars', 1700], ['che', 1650]] as const) db.prepare("INSERT INTO fb_team_ratings (team_id, league, elo, matches_played) VALUES (?, 'epl', ?, 38)").run(id, e);
  const partido = db.prepare("INSERT INTO fb_matches (league, season, match_date, home_id, away_id, home_goals, away_goals, result) VALUES ('epl', 2025, ?, ?, ?, ?, ?, ?)");
  for (let i = 0; i < 20; i++) {
    const [gl, gv] = [i % 3, (i + 1) % 2];
    partido.run(`2025-0${1 + (i % 9)}-1${i % 10}`, i % 2 ? 'ars' : 'che', i % 2 ? 'che' : 'ars', gl, gv, gl > gv ? 'H' : gl < gv ? 'A' : 'D');
  }
  const { buildFootballPrediction } = await import('../football/predict.ts');
  const f = buildFootballPrediction('epl', 'ars', 'che', { oddsHome: 1.9, oddsDraw: 3.6, oddsAway: 4.2 });

  const { buildGamePrediction } = await import('../basketball/predict.ts');
  const b = buildGamePrediction('nba' as never, 'BOS', 'NYK', { homeOdds: 1.6, awayOdds: 2.4 });
  const { buildBaseballPrediction } = await import('../baseball/predict.ts');
  const m = buildBaseballPrediction('mlb' as never, 'NYY', 'BOS', { oddsHome: 1.8, oddsAway: 2.1 });

  for (const [id, nombre] of [['KC', 'Kansas City Chiefs'], ['BUF', 'Buffalo Bills']]) db.prepare("INSERT INTO naf_teams (id, league, name) VALUES (?, 'nfl', ?)").run(id, nombre);
  const { buildPrediction: nfl } = await import('../nfl/predict.ts');
  const n = nfl({ league: 'nfl' as never, homeId: 'KC', awayId: 'BUF', oddsHome: 1.7, oddsAway: 2.2, spreadLine: -3.5, totalLine: 47.5 });
  assert.ok(n, 'la NFL construye la predicción');

  const malas = [
    ...malEscritos(t.summary ?? t).map((s) => `tenis ${s}`),
    ...malEscritos(f.summary).map((s) => `fútbol ${s}`),
    ...malEscritos([b.summary, b.reasoning.text, b.reliability.reasons]).map((s) => `baloncesto ${s}`),
    ...malEscritos([m.summary, m.reliability.reasons]).map((s) => `béisbol ${s}`),
    ...malEscritos(n.summary ?? n).map((s) => `nfl ${s}`),
  ];
  assert.deepEqual(malas, []);
});
