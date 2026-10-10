// La NHL con la segunda fuente (seguimiento: NHL y UFC): el CSV de sportsdataverse, el filtro de
// marcadores de relleno, el arreglo con las «team box» solo si cruzan TODOS los partidos, la
// migración 14 y el ajuste por el registro sin tocar el holdout. Nada sale a la red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { partidosDeCsv, marcadoresDegenerados, corregirConCajas, ingestarTemporadas, urlTemporada, urlCajas } = await import('./ingest.ts');
const { recorrer, logLossEn, golesLigaDeFinal, contraReferencias } = await import('./ajuste.ts');
const { NHL, resultado60 } = await import('./model.ts');
const { getDb } = await import('../db.ts');
type PartidoNhl = import('./ingest.ts').PartidoNhl;

const CABECERA = 'game_id,season_full,game_type,game_date,game_time,home_team_abbr,away_team_abbr,home_team_name,away_team_name,home_score,away_score,game_state';
const fila = (id: number, fecha: string, h: string, a: string, gh: number | string, ga: number | string, tipo = 'R', estado = 'OFF') =>
  `${id},20232024,${tipo},${fecha},${fecha}T00:00:00Z,${h},${a},${h} FC,${a} FC,${gh},${ga},${estado}`;

test('CSV de sportsdataverse: solo terminados de temporada regular y playoffs, sin inventar cómo acabaron', () => {
  const csv = [
    CABECERA,
    fila(2023020001, '2023-10-10', 'TBL', 'NSH', 5, 3),
    fila(2023030417, '2024-06-25', 'FLA', 'EDM', 2, 1, 'P'),
    fila(2023010001, '2023-09-25', 'TOR', 'MTL', 4, 1, 'PR'), // pretemporada
    fila(2023020002, '2023-10-11', 'PIT', 'CHI', '', '', 'R', 'FUT'), // sin jugar
    fila(2023020003, '2023-10-11', 'VGK', 'SEA', 2, 2), // empate imposible
  ].join('\n');
  const xs = partidosDeCsv(csv);
  assert.deepEqual(xs.map((x) => x.id), [2023020001, 2023030417]);
  assert.equal(xs[0].season, 2023);
  assert.equal(xs[1].game_type, 3);
  assert.equal(xs[0].final_period, null, 'la fuente no dice si hubo prórroga: NULL, no «REG»');
  assert.equal(xs[0].fuente, 'sportsdataverse');
});

const temporada = (n: number, marcador: (i: number) => [number, number]): PartidoNhl[] =>
  Array.from({ length: n }, (_, i) => {
    const [h, a] = marcador(i);
    const d = new Date(Date.UTC(2009, 9, 1) + Math.floor(i / 6) * 86_400_000).toISOString().slice(0, 10);
    return { id: 2009020001 + i, season: 2009, game_type: 2, game_date: d, home_id: `H${i % 16}`, away_id: `A${i % 16}`, home_name: null, away_name: null, home_goals: h, away_goals: a, final_period: null, fuente: 'sportsdataverse' as const };
  });

test('relleno: todos «3-2», o el local que gana siempre, se detectan; una temporada normal no', () => {
  assert.equal(marcadoresDegenerados(temporada(200, () => [3, 2])), true);
  assert.equal(marcadoresDegenerados(temporada(200, (i) => [4 + (i % 3), i % 4])), true, 'el local gana siempre');
  assert.equal(marcadoresDegenerados(temporada(200, (i) => (i % 9 < 5 ? [3 + (i % 3), 2] : [1, 2 + (i % 4)]))), false);
});

const cajas = (xs: PartidoNhl[], goles: (i: number) => [number, number], cambiar?: number) =>
  ['home_away,team_id,team_abbrev,team_name,goals']
    .concat(
      [...xs]
        .sort((a, b) => a.game_date.localeCompare(b.game_date) || a.id - b.id)
        .flatMap((g, i) => [`away,1,${i === cambiar ? 'XXX' : g.away_id},x,${goles(i)[1]}`, `home,2,${g.home_id},y,${goles(i)[0]}`]),
    )
    .join('\n');

test('cajas: se cruzan por orden de fecha y, si TODOS los partidos coinciden, dan los goles de verdad', () => {
  const xs = temporada(120, () => [3, 2]);
  const r = corregirConCajas(xs, cajas(xs, (i) => (i % 2 ? [1, 4] : [5, 2])));
  assert.ok('partidos' in r);
  assert.deepEqual([r.partidos[0].home_goals, r.partidos[0].away_goals, r.partidos[1].home_goals], [5, 2, 1]);
});

test('cajas: un solo partido que no cuadra rechaza la temporada entera', () => {
  const xs = temporada(120, () => [3, 2]);
  const r = corregirConCajas(xs, cajas(xs, () => [4, 1], 57));
  assert.ok('error' in r && /partido 58/.test(r.error));
  const corto = corregirConCajas(xs, cajas(xs.slice(1), () => [4, 1]));
  assert.ok('error' in corto, 'distinto número de partidos');
});

test('ingesta por temporadas: guarda las buenas, arregla las de relleno y rechaza sin escribir las que no cruzan', async () => {
  getDb().exec('DELETE FROM nhl_games');
  const variados = [[4, 2], [1, 3], [5, 1], [2, 4], [3, 2], [0, 1], [6, 3]];
  const buena = [CABECERA, ...Array.from({ length: 60 }, (_, i) => fila(2014020001 + i, `2014-10-${String(10 + (i % 20)).padStart(2, '0')}`, `H${i % 7}`, `A${i % 5}`, variados[i % 7][0], variados[i % 7][1]))].join('\n').replace(/20232024/g, '20142015');
  const rellenoXs = temporada(60, () => [3, 2]);
  const relleno = [CABECERA, ...rellenoXs.map((g) => fila(g.id, g.game_date, g.home_id, g.away_id, 3, 2))].join('\n').replace(/20232024/g, '20092010');
  const respuestas = new Map<string, string | number>([
    [urlTemporada(2015), buena],
    [urlTemporada(2010), relleno],
    [urlCajas(2010), cajas(rellenoXs, (i) => (i % 2 ? [2, 5] : [6, 1]))],
    [urlTemporada(2011), relleno.replace(/2009020/g, '2010020')],
    [urlCajas(2011), cajas(rellenoXs, () => [2, 1], 3)],
    [urlTemporada(2012), 404],
  ]);
  const f = (async (u: string) => {
    const r = respuestas.get(u);
    if (r === undefined || r === 404) return new Response('no', { status: 404 });
    return new Response(String(r), { status: 200 });
  }) as typeof fetch;
  const r = await ingestarTemporadas(2010, 2015, f);
  assert.deepEqual(r.corregidas, [2010]);
  assert.deepEqual(r.rechazadas.map((x) => x.anio), [2011]);
  assert.ok(r.sinFichero.includes(2012));
  const n = (sql: string) => (getDb().prepare(sql).get() as { n: number }).n;
  assert.equal(n('SELECT COUNT(*) n FROM nhl_games WHERE season = 2010'), 0, 'la temporada rechazada no deja ni una fila');
  assert.equal(n("SELECT COUNT(*) n FROM nhl_games WHERE season = 2009 AND home_goals = 3 AND away_goals = 2"), 0, 'ningún «3-2» de relleno');
  assert.equal(n('SELECT COUNT(*) n FROM nhl_games WHERE season = 2009'), 60);
  getDb().exec('DELETE FROM nhl_games');
});

test('migración 14: rehace nhl_games con final_period opcional y fuente, sin perder filas', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { MIGRACIONES } = await import('../db.ts');
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE nhl_games (id INTEGER PRIMARY KEY, season INTEGER NOT NULL, game_type INTEGER NOT NULL, game_date TEXT NOT NULL,
    home_id TEXT NOT NULL, away_id TEXT NOT NULL, home_name TEXT, away_name TEXT, home_goals INTEGER NOT NULL, away_goals INTEGER NOT NULL,
    final_period TEXT NOT NULL CHECK (final_period IN ('REG', 'OT', 'SO')), ingested_at TEXT NOT NULL)`);
  d.exec("INSERT INTO nhl_games VALUES (1, 2015, 2, '2015-10-07', 'TOR', 'MTL', null, null, 3, 2, 'OT', '2026-01-01')");
  const m14 = MIGRACIONES.find((m) => m.version === 14)!;
  m14.up(d, { ledger: 'main', fichero: 'history' });
  const fila14 = d.prepare('SELECT final_period, fuente FROM nhl_games WHERE id = 1').get() as { final_period: string; fuente: string };
  assert.deepEqual({ ...fila14 }, { final_period: 'OT', fuente: 'nhl-api' });
  d.exec("INSERT INTO nhl_games (id, season, game_type, game_date, home_id, away_id, home_goals, away_goals, final_period, fuente, ingested_at) VALUES (2, 2015, 2, '2015-10-08', 'A', 'B', 1, 0, NULL, 'sportsdataverse', 'x')");
  m14.up(d, { ledger: 'main', fichero: 'history' }); // idempotente
  assert.equal((d.prepare('SELECT COUNT(*) n FROM nhl_games').get() as { n: number }).n, 2);
  d.close();
});

test('ajuste: el holdout no se puntúa, y la vuelta a la media acerca los Elo al empezar temporada', () => {
  const xs: PartidoNhl[] = [];
  for (let t = 2022; t <= 2025; t++)
    for (let i = 0; i < 400; i++)
      xs.push({ id: t * 10000 + i, season: t, game_type: 2, game_date: `${t}-11-${String(1 + (i % 28)).padStart(2, '0')}`, home_id: i % 2 ? 'BUE' : 'MAL', away_id: i % 2 ? 'MAL' : 'BUE', home_name: null, away_name: null, home_goals: i % 2 ? 4 : 1, away_goals: i % 2 ? 1 : 3, final_period: null });
  xs.sort((a, b) => a.game_date.localeCompare(b.game_date) || a.id - b.id);
  const puntuado = logLossEn(recorrer(xs), (t) => t >= 2024);
  assert.equal(puntuado.n, 400, 'de 2024 en adelante solo se puntúa la 2024: la 2025 es holdout');
  const sin = recorrer(xs, { ...NHL, regresion: 0 });
  const con = recorrer(xs, { ...NHL, regresion: 0.5 });
  const primero2024 = xs.findIndex((x) => x.season === 2024);
  const brecha = (p: (typeof sin)[number]) => Math.abs(p.eloLocal - p.eloVisitante);
  assert.ok(brecha(con[primero2024]) < brecha(sin[primero2024]));
  const cr = contraReferencias(xs);
  assert.ok(cr.modelo < cr.referencias[0].ll, 'un equipo que gana siempre: el Elo lo aprende, la tasa del local no');
});

test('goles: de la media del acta (que suma uno si hubo empate a 60) a la de 60 minutos', () => {
  const g = golesLigaDeFinal(6.2);
  assert.ok(g < 6.2 && g > 5.8);
  assert.ok(Math.abs(g + resultado60(g / 2, g / 2).empata - 6.2) < 1e-6);
});
