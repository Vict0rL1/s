// E7 (revisión del 8 de octubre): la cabecera de la ficha de un partido es la probabilidad que
// enseña Destacados. Por HTTP, como lo ve la app: se sirve un partido, una ingesta mueve el Elo,
// y las dos pantallas siguen diciendo el mismo número (D1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { getDb } = await import('../db.ts');
const { guardarPartidos } = await import('../nhl/ingest.ts');
const { guardarEquipos } = await import('../nhl/repo.ts');
const { buildApp } = await import('../app.ts');
const { configAuth } = await import('../auth/mode.ts');
const { LimiteDeIntentos } = await import('../auth/rateLimit.ts');
type PartidoNhl = import('../nhl/ingest.ts').PartidoNhl;

const AHORA = new Date();
const dia = (d: number) => new Date(AHORA.getTime() + d * 86_400_000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

function partidos(n: number, desde: number, ganaMtl = false): PartidoNhl[] {
  const eq = ['TOR', 'BOS', 'NYR', 'MTL'];
  const out: PartidoNhl[] = [];
  for (let i = 0; i < n; i++) {
    const h = eq[i % 4];
    const a = eq[(i + 1 + (i % 3)) % 4];
    if (h === a) continue;
    const fuerza = (x: string) => (ganaMtl && x === 'MTL' ? 9 : 3 - eq.indexOf(x));
    const gh = 2 + (fuerza(h) > fuerza(a) ? 3 : 0);
    const ga = 2 + (fuerza(a) > fuerza(h) ? 3 : 0);
    out.push({ id: desde + i, season: 2025, game_type: 2, game_date: ymd(dia(-120 + Math.floor(i / 4))), home_id: h, away_id: a, home_name: null, away_name: null, home_goals: gh, away_goals: gh === ga ? ga + 1 : ga, final_period: null, fuente: 'sportsdataverse' });
  }
  return out;
}

test('E7: la cabecera de /api/nhl/games/:id es la probabilidad de /api/top-picks, también tras una ingesta', async () => {
  guardarPartidos(partidos(400, 2020020000));
  guardarEquipos();
  getDb()
    .prepare("INSERT INTO nhl_upcoming (id, commence_time, home_name, away_name, home_id, away_id, odds_home, odds_away, books, source, updated_at) VALUES ('odds-e7', ?, 'Toronto Maple Leafs', 'Montréal Canadiens', 'TOR', 'MTL', 1.5, 3.0, 4, 'live', ?)")
    .run(dia(1).toISOString(), AHORA.toISOString());
  const app = await buildApp({ auth: { config: configAuth({ APP_AUTH: 'off' }), limite: new LimiteDeIntentos() }, servirWeb: false, logger: false, entorno: { APP_AUTH: 'off' } });
  const cabecera = async () => {
    const r = await app.inject({ method: 'GET', url: '/api/nhl/games/odds-e7' });
    assert.equal(r.statusCode, 200, r.body);
    const f = r.json().prediction.final as { home: number; away: number };
    return Math.max(f.home, f.away);
  };
  const destacados = async () => {
    const r = await app.inject({ method: 'GET', url: '/api/top-picks?horas=48' });
    assert.equal(r.statusCode, 200, r.body);
    const p = (r.json().partidos as { eventoId: string; probabilidad: number }[]).find((x) => x.eventoId === 'odds-e7');
    assert.ok(p, 'el partido está en Destacados');
    return p.probabilidad;
  };
  const antes = await cabecera(); // se sirve: queda registrado
  assert.equal(await destacados(), antes);
  // Una ingesta mueve el Elo: el modelo de hoy diría otra cosa; las dos pantallas, lo publicado.
  guardarPartidos(partidos(200, 2020030000, true));
  guardarEquipos();
  const despues = await cabecera();
  assert.equal(despues, antes, 'la ficha sigue con lo publicado');
  assert.equal(await destacados(), despues, 'y es lo mismo que Destacados');
  await app.close();
});
