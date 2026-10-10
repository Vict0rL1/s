// La NHL publicada (seguimiento: NHL y UFC): nombres de las casas a equipos, calendario y cuotas a
// próximos sin duplicar partidos, la predicción (todo de una distribución), el registro de escritura
// única con su puntero, la liquidación del banco de papel y las rutas. Nada sale a la red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { resolverEquipo, nombreDe } = await import('./equipos.ts');
const { proximosDeCsv, guardarCalendario, agregarEvento, guardarEventos, HORIZONTE_DIAS } = await import('./proximos.ts');
const { guardarPartidos } = await import('./ingest.ts');
const { guardarEquipos, listUpcoming, getTeamInfo } = await import('./repo.ts');
const { buildPrediction } = await import('./predict.ts');
const { matchKey, logNhlPrediction, resolveNhlPredictions, getNhlTrackRecord, fechaNhl } = await import('./trackRecord.ts');
const { getDb, MIGRACIONES } = await import('../db.ts');
const { findGameResult } = await import('../results.ts');
const { candidatasPapel, liquidador } = await import('../paper/bankroll.ts');
const { reconstruirDesde } = await import('../recent/reconstruct.ts');
const { buildApp } = await import('../app.ts');
const { configAuth } = await import('../auth/mode.ts');
const { LimiteDeIntentos } = await import('../auth/rateLimit.ts');
type PartidoNhl = import('./ingest.ts').PartidoNhl;
type NhlUpcomingRow = import('./repo.ts').NhlUpcomingRow;

const AHORA = new Date();
const dia = (d: number) => new Date(AHORA.getTime() + d * 86_400_000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Una liga de cuatro equipos que juegan entre ellos: TOR el más fuerte, MTL el más flojo. */
function liga(n: number): PartidoNhl[] {
  const eq = ['TOR', 'BOS', 'NYR', 'MTL'];
  const out: PartidoNhl[] = [];
  for (let i = 0; i < n; i++) {
    const h = eq[i % 4];
    const a = eq[(i + 1 + (i % 3)) % 4];
    if (h === a) continue;
    const fuerza = (x: string) => 3 - eq.indexOf(x);
    const gh = 2 + (fuerza(h) > fuerza(a) ? 2 : 0) + (i % 2);
    const ga = 2 + (fuerza(a) > fuerza(h) ? 2 : 0);
    out.push({ id: 2020020000 + i, season: 2025, game_type: 2, game_date: ymd(dia(-120 + Math.floor(i / 4))), home_id: h, away_id: a, home_name: null, away_name: null, home_goals: gh, away_goals: gh === ga ? ga + 1 : ga, final_period: null, fuente: 'sportsdataverse' });
  }
  return out;
}

test('migraciones 16 y 17: próximos en la historia, el registro en el libro mayor', () => {
  assert.equal(MIGRACIONES.find((m) => m.version === 16)?.destino, 'history');
  assert.equal(MIGRACIONES.find((m) => m.version === 17)?.destino, 'ledger');
});

test('nombres de las casas → equipos: completo, apodo, alias; nunca se adivina entre los dos de Nueva York', () => {
  assert.equal(resolverEquipo('Toronto Maple Leafs')?.id, 'TOR');
  assert.equal(resolverEquipo('Montreal Canadiens')?.id, 'MTL', 'sin acento también');
  assert.equal(resolverEquipo('St Louis Blues')?.id, 'STL', 'sin punto también');
  assert.equal(resolverEquipo('Utah Hockey Club')?.id, 'UTA', 'el nombre de 2024-25');
  assert.equal(resolverEquipo('Rangers')?.id, 'NYR');
  assert.equal(resolverEquipo('New York'), null);
  assert.equal(resolverEquipo('Arizona Coyotes'), null, 'una franquicia que ya no juega no resuelve');
  assert.equal(resolverEquipo('Quebec Nordiques'), null);
  assert.equal(nombreDe('XYZ'), 'XYZ', 'un id desconocido se enseña tal cual, no se le inventa nombre');
});

test('calendario: solo lo que falta por jugar, hasta el horizonte, y no pisa la fila con precio', () => {
  const cab = 'game_id,season_full,game_type,game_date,game_time,home_team_abbr,away_team_abbr,home_team_name,away_team_name,home_score,away_score,game_state';
  const f = (id: number, d: Date, h: string, a: string, estado = 'FUT', tipo = 'R') => `${id},20262027,${tipo},${ymd(d)},${d.toISOString()},${h},${a},X,Y,,,${estado}`;
  const csv = [cab, f(1, dia(1), 'TOR', 'MTL'), f(2, dia(2), 'BOS', 'NYR'), f(3, dia(-1), 'TOR', 'BOS', 'OFF'), f(4, dia(3), 'TOR', 'NYR', 'FUT', 'PR'), f(5, dia(HORIZONTE_DIAS + 5), 'MTL', 'TOR')].join('\n');
  const xs = proximosDeCsv(csv);
  assert.deepEqual(xs.map((x) => x.game_id), [1, 2, 5], 'terminados y pretemporada fuera');
  getDb().exec('DELETE FROM nhl_upcoming');
  // Una fila con precio del partido 2 ya existe: el calendario no lo duplica.
  guardarEventos([{ id: 'ev2', commence_time: dia(2).toISOString(), home: 'Boston Bruins', away: 'New York Rangers', price: { 'Boston Bruins': 1.8, 'New York Rangers': 2.1 }, total: 6.5, over: 1.9, under: 1.9, books: 7 }], AHORA);
  assert.equal(guardarCalendario(xs, AHORA), 1, 'solo el 1: el 2 tiene precio y el 5 queda fuera del horizonte');
  const filas = getDb().prepare('SELECT id, source, home_id, away_id, home_name FROM nhl_upcoming ORDER BY commence_time').all() as { id: string; source: string; home_id: string; home_name: string }[];
  assert.deepEqual(filas.map((r) => [r.id, r.source]), [['nhl-1', 'schedule'], ['odds-ev2', 'live']]);
  assert.equal(filas[0].home_name, 'Toronto Maple Leafs', 'el nombre completo, no la ciudad del CSV');
  // Llega el precio del partido 1: sustituye a su fila del calendario, y otro TOR-MTL dos días después no se toca.
  getDb().prepare("INSERT INTO nhl_upcoming (id, commence_time, home_name, away_name, home_id, away_id, source, updated_at) VALUES ('nhl-9', ?, 'a', 'b', 'TOR', 'MTL', 'schedule', ?)").run(dia(3).toISOString(), AHORA.toISOString());
  guardarEventos([{ id: 'ev1', commence_time: dia(1).toISOString(), home: 'Toronto Maple Leafs', away: 'Montréal Canadiens', price: { 'Toronto Maple Leafs': 1.6, 'Montréal Canadiens': 2.4 }, total: 6, over: 1.9, under: 1.9, books: 5 }], AHORA);
  const ids = (getDb().prepare('SELECT id FROM nhl_upcoming ORDER BY id').all() as { id: string }[]).map((r) => r.id);
  assert.deepEqual(ids, ['nhl-9', 'odds-ev1'], 'ev2 ya no viene en esta respuesta (se poda); nhl-1 sustituida; nhl-9 intacta');
});

test('cuotas de un evento: mediana entre casas y la línea de total que ofrecen más casas con los dos lados', () => {
  const casa = (h: number, a: number, linea: number, o: number, u: number) => ({
    markets: [
      { key: 'h2h', outcomes: [{ name: 'Boston Bruins', price: h }, { name: 'Toronto Maple Leafs', price: a }] },
      { key: 'totals', outcomes: [{ name: 'Over', price: o, point: linea }, { name: 'Under', price: u, point: linea }] },
    ],
  });
  const ev = agregarEvento({ id: 'x', commence_time: '2026-10-10T23:00:00Z', home_team: 'Boston Bruins', away_team: 'Toronto Maple Leafs', bookmakers: [casa(1.8, 2.0, 6.5, 1.9, 1.9), casa(1.9, 1.95, 6.5, 2.0, 1.8), casa(1.85, 2.05, 5.5, 1.5, 2.5)] });
  assert.equal(ev.price['Boston Bruins'], 1.85);
  assert.equal(ev.total, 6.5);
  assert.equal(ev.over, 1.95);
  assert.equal(ev.books, 3);
});

test('la predicción: todo sale de una distribución y cuadra', () => {
  getDb().exec('DELETE FROM nhl_games');
  guardarPartidos(liga(400));
  guardarEquipos();
  const p = buildPrediction({ homeId: 'TOR', awayId: 'MTL', oddsHome: 1.4, oddsAway: 3.2, totalLine: 6 })!;
  assert.ok(p.model.home > 0.6, `el fuerte en casa es favorito: ${p.model.home}`);
  assert.ok(Math.abs(p.model.home + p.model.away - 1) < 1e-9);
  assert.deepEqual(p.final, p.model, 'sin post-proceso medido, lo publicado es el modelo');
  assert.ok(Math.abs(p.regulation.home + p.regulation.draw + p.regulation.away - 1) < 1e-3);
  assert.ok(p.regulation.home < p.model.home, 'a 60 minutos gana menos: parte va a la prórroga');
  assert.ok(Math.abs(p.total.over + p.total.under + p.total.push - 1) < 1e-3);
  assert.ok(p.total.push > 0, 'línea entera: el total exacto devuelve la apuesta');
  assert.equal(p.total.fromMarket, true);
  assert.ok(p.market.market && Math.abs(p.market.market.home + p.market.market.away - 1) < 1e-9);
  assert.ok(['differs_home', 'differs_away', 'agree'].includes(p.market.verdict));
  assert.ok(Math.abs(p.reasoning.factors.reduce((a, f) => a + f.pointsForHome, 0) - (p.teams.home.elo - p.teams.away.elo + 35)) < 0.1, 'los factores suman el argumento de la logística');
  const sinCasa = buildPrediction({ homeId: 'TOR', awayId: 'MTL' })!;
  assert.equal(sinCasa.market.verdict, 'no_market');
  assert.equal(sinCasa.total.fromMarket, false);
  assert.ok(!Number.isInteger(sinCasa.total.line), 'sin casa, media línea: sin push');
  assert.equal(buildPrediction({ homeId: 'TOR', awayId: 'QUE' }), null);
  assert.equal(getTeamInfo('TOR')!.name, 'Toronto Maple Leafs');
});

test('registro: la primera predicción manda, el puntero sigue al partido y el resultado llega del archivo', () => {
  const d = getDb();
  const cuando = dia(1).toISOString();
  const fila = (id: string, source: 'live' | 'schedule', odds: number | null): NhlUpcomingRow => ({
    id, league: 'nhl', season: 2026, game_id: null, commence_time: cuando, home_name: 'Toronto Maple Leafs', away_name: 'Montréal Canadiens', home_id: 'TOR', away_id: 'MTL',
    odds_home: odds, odds_away: odds ? 3.0 : null, total_line: null, odds_over: null, odds_under: null, books: odds ? 4 : 0, source, updated_at: AHORA.toISOString(),
  });
  const delCalendario = fila('nhl-77', 'schedule', null);
  const conPrecio = fila('odds-abc', 'live', 1.5);
  assert.equal(matchKey(delCalendario), matchKey(conPrecio), 'el mismo partido, la misma clave, venga de donde venga');
  assert.equal(matchKey(delCalendario), `nhl|${fechaNhl(cuando)}|MTL|TOR`);
  logNhlPrediction(delCalendario, buildPrediction({ homeId: 'TOR', awayId: 'MTL' })!);
  const antes = d.prepare('SELECT prob_home, market_prob_home, upcoming_id, model_version FROM nhl_prediction_log WHERE match_key = ?').get(matchKey(conPrecio)) as { prob_home: number; market_prob_home: number | null; upcoming_id: string; model_version: string };
  assert.equal(antes.market_prob_home, null);
  assert.match(antes.model_version, /^nhl-/);
  // Llega la fila con precio y se vuelve a servir: la predicción no cambia; el puntero, sí.
  d.prepare("INSERT INTO nhl_upcoming (id, commence_time, home_name, away_name, home_id, away_id, odds_home, odds_away, books, source, updated_at) VALUES ('odds-abc', ?, 'Toronto Maple Leafs', 'Montréal Canadiens', 'TOR', 'MTL', 1.5, 3.0, 4, 'live', ?)").run(cuando, AHORA.toISOString());
  logNhlPrediction(conPrecio, buildPrediction({ homeId: 'TOR', awayId: 'MTL', oddsHome: 1.5, oddsAway: 3.0 })!);
  const despues = d.prepare('SELECT prob_home, market_prob_home, upcoming_id FROM nhl_prediction_log WHERE match_key = ?').get(matchKey(conPrecio)) as { prob_home: number; market_prob_home: number | null; upcoming_id: string };
  assert.equal(despues.prob_home, antes.prob_home);
  assert.equal(despues.market_prob_home, null, 'el mercado del momento de la predicción no se rellena después');
  assert.equal(despues.upcoming_id, 'odds-abc');
  // Lo que dijo no se toca ni se borra (triggers del libro mayor).
  assert.throws(() => d.prepare('UPDATE nhl_prediction_log SET prob_home = 0.9 WHERE match_key = ?').run(matchKey(conPrecio)), /no se reescribe/);
  assert.throws(() => d.prepare('DELETE FROM nhl_prediction_log WHERE match_key = ?').run(matchKey(conPrecio)), /no se borra/);

  // El banco de papel la ve aunque no haya mercado registrado (reprecia con la cuota de ahora).
  const c = candidatasPapel(true).find((x) => x.sport === 'nhl');
  assert.ok(c, 'la NHL entra en las candidatas');
  assert.equal(c!.label, 'Montréal Canadiens @ Toronto Maple Leafs');
  assert.ok(Math.abs(c!.salidas[0].pMarket - (1 / 1.5) / (1 / 1.5 + 1 / 3)) < 1e-9);

  // El resultado llega al archivo (con fecha de Nueva York) y se anota; el banco liquida.
  guardarPartidos([{ id: 2026029999, season: 2026, game_type: 2, game_date: fechaNhl(cuando), home_id: 'TOR', away_id: 'MTL', home_name: null, away_name: null, home_goals: 4, away_goals: 3, final_period: null, fuente: 'sportsdataverse' }]);
  assert.equal(resolveNhlPredictions().resolved >= 1, true);
  assert.equal(liquidador()({ sport: 'nhl', match_key: matchKey(conPrecio), selection: 'Toronto Maple Leafs' })?.status, 'won');
  assert.deepEqual(findGameResult('nhl', { league: 'nhl', homeId: 'TOR', awayId: 'MTL', commenceTime: cuando }), { homeScore: 4, awayScore: 3, playedOn: fechaNhl(cuando).replace(/-/g, '') });
  const tr = getNhlTrackRecord();
  assert.equal(tr.resolved, 1);
  assert.ok(tr.totalMae != null);
});

test('reconstrucción: los partidos recientes del archivo, con el Elo de antes de cada uno', () => {
  const desde = ymd(dia(-130)).replace(/-/g, '');
  const r = reconstruirDesde(desde);
  const nhl = r.partidos.filter((p) => p.deporte === 'NHL');
  assert.ok(nhl.length > 0);
  assert.ok(nhl.every((p) => /^\d{8}$/.test(p.fecha) && Math.abs(p.probs[0] + p.probs[1] - 1) < 1e-9));
  assert.ok(r.sinHistoria.NHL > 0, 'los primeros de cada equipo no tienen historia suficiente');
});

test('rutas: próximos con predicción y confianza, ficha de equipo, y errores claros', async () => {
  getDb().prepare("INSERT OR REPLACE INTO nhl_upcoming (id, commence_time, home_name, away_name, home_id, away_id, source, updated_at) VALUES ('nhl-500', ?, 'Boston Bruins', 'New York Rangers', 'BOS', 'NYR', 'schedule', ?)").run(dia(2).toISOString(), AHORA.toISOString());
  const e = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;
  const app = await buildApp({ auth: { config: configAuth(e), limite: new LimiteDeIntentos() }, servirWeb: false, logger: false, entorno: e });
  await app.ready();
  const r = await app.inject({ method: 'GET', url: '/api/nhl/games/upcoming' });
  assert.equal(r.statusCode, 200, r.body);
  const juegos = r.json() as { game: { id: string }; prediction: { final: { home: number } } | null; confianza: unknown }[];
  const g = juegos.find((x) => x.game.id === 'nhl-500')!;
  assert.ok(g.prediction && g.confianza, 'con predicción y evaluación de confianza');
  assert.ok(listUpcoming().some((x) => x.id === 'nhl-500'));
  assert.equal((await app.inject({ method: 'GET', url: '/api/nhl/teams/tor' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/nhl/teams/QUE' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/nhl/predict', payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/simulation/season/nhl/nhl' })).statusCode, 404, 'sin simulación de temporada');
  await app.close();
});
