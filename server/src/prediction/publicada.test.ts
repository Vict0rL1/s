// D1 (revisión del 8 de octubre): la ficha de un partido y Destacados tienen que decir el
// MISMO número. Destacados, «¿Acertó?», el banco de papel y las estrategias leen el registro
// (la primera predicción que se sirvió); las rutas calculaban de nuevo en cada petición, así
// que tras una ingesta o un cambio de cuotas la ficha decía otra cosa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { getDb } = await import('../db.ts');
const { guardarPartidos } = await import('../nhl/ingest.ts');
const { guardarEquipos } = await import('../nhl/repo.ts');
const { buildPrediction } = await import('../nhl/predict.ts');
const { matchKey } = await import('../nhl/trackRecord.ts');
const { describeRow } = await import('../routes/nhl.ts');
type PartidoNhl = import('../nhl/ingest.ts').PartidoNhl;
type NhlUpcomingRow = import('../nhl/repo.ts').NhlUpcomingRow;

const AHORA = new Date();
const dia = (d: number) => new Date(AHORA.getTime() + d * 86_400_000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Partidos entre cuatro equipos; `ganaMtl` da la vuelta al más flojo para mover su Elo. */
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

test('D1: la ficha enseña lo publicado y aparte lo que diría el modelo hoy', () => {
  guardarPartidos(partidos(400, 2020020000));
  guardarEquipos();
  const fila: NhlUpcomingRow = {
    id: 'odds-d1', league: 'nhl', season: 2026, game_id: null, commence_time: dia(1).toISOString(), home_name: 'Toronto Maple Leafs', away_name: 'Montréal Canadiens',
    home_id: 'TOR', away_id: 'MTL', odds_home: 1.5, odds_away: 3.0, total_line: null, odds_over: null, odds_under: null, books: 4, source: 'live', updated_at: AHORA.toISOString(),
  };
  const primera = describeRow(fila) as unknown as { prediction: { final: { home: number; away: number } } };
  const registrada = getDb().prepare('SELECT shown_home FROM nhl_prediction_log WHERE match_key = ?').get(matchKey(fila)) as { shown_home: number };
  assert.equal(primera.prediction.final.home, registrada.shown_home);

  // Llega una ingesta que cambia el Elo: el modelo de ahora dice otra cosa.
  guardarPartidos(partidos(200, 2020030000, true));
  guardarEquipos();
  const ahora = buildPrediction({ homeId: 'TOR', awayId: 'MTL', oddsHome: 1.5, oddsAway: 3.0 })!;
  assert.notEqual(ahora.final.home, registrada.shown_home, 'el fixture tiene que mover el modelo');

  const segunda = describeRow(fila) as unknown as { prediction: { final: { home: number; away: number }; publicada?: { en: string; actual: number[]; difiere: boolean } } };
  assert.equal(segunda.prediction.final.home, registrada.shown_home, 'la cabecera es la publicada, la misma que lee Destacados');
  assert.ok(Math.abs(segunda.prediction.final.home + segunda.prediction.final.away - 1) < 1e-9);
  assert.ok(segunda.prediction.publicada, 'trae lo publicado y cuándo');
  assert.deepEqual(segunda.prediction.publicada!.actual, [ahora.final.home, ahora.final.away], 'y aparte lo que diría el modelo hoy');
  assert.equal(segunda.prediction.publicada!.difiere, true);
  assert.match(segunda.prediction.publicada!.en, /^\d{4}-\d{2}-\d{2}T/);
});

test('D1: lo que lee Destacados y lo que lee la ficha salen del mismo sitio', async () => {
  const { publicadaDe } = await import('./publicada.ts');
  const { FUENTES, probSql } = await import('../today.ts');
  const f = FUENTES.find((x) => x.log === 'nhl_prediction_log')!;
  const fila = getDb().prepare(`SELECT match_key, ${probSql(f)} AS p FROM nhl_prediction_log`).get() as { match_key: string; p: number };
  assert.deepEqual(publicadaDe('nhl', fila.match_key)!.probs, [fila.p, 1 - fila.p]);
  assert.equal(publicadaDe('nhl', 'no-existe'), null);
});
