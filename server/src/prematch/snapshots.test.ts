// Instantáneas pre-partido: lo que se guarda, lo que no se puede guardar, y lo que no
// puede cambiar nunca.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { recordSnapshot, instantaneas, aFecha, horizontes, freezeFinals, finalPrePartido, cambios } = await import('./snapshots.ts');
const { evaluacionPorHorizonte } = await import('./evaluation.ts');
const { getDb } = await import('../db.ts');

const H = 3_600_000;
const db = getDb();
// Un partido dentro de 30 horas; el «reloj» de cada captura se pasa explícito.
const base = Date.parse('2026-11-10T12:00:00.000Z');
const INICIO = new Date(base + 30 * H).toISOString();
const a = (horasAntes: number) => new Date(Date.parse(INICIO) - horasAntes * H);

const snap = (over: Partial<Parameters<typeof recordSnapshot>[0]> = {}) => ({
  sport: 'baseball' as const,
  matchKey: 'mlb|nyy|bos|20261111',
  eventId: 'ev1',
  commence: INICIO,
  outcomes: ['Red Sox', 'Yankees'],
  probs: [0.55, 0.45],
  probsRaw: null,
  odds: [1.9, 2.0],
  oddsAt: a(31).toISOString(),
  dataAsOf: '2026-11-09T00:00:00.000Z',
  usaMercado: false,
  entradas: {
    abridorLocal: { etiqueta: 'abridor de Red Sox', valor: null },
    abridorVisit: { etiqueta: 'abridor de Yankees', valor: 'Cole' },
  },
  ...over,
});

test('la primera se guarda; la idéntica no; un cambio sí', () => {
  assert.equal(recordSnapshot(snap(), a(30)), 'nueva');
  assert.equal(recordSnapshot(snap(), a(29)), 'igual');
  assert.equal(recordSnapshot(snap({ probs: [0.5503, 0.4497] }), a(28.5)), 'igual', 'menos de 0,1 pp no es un cambio');
  assert.equal(instantaneas('baseball', 'mlb|nyy|bos|20261111').length, 1);
});

test('cruzar una marca deja una observación propia aunque nada cambie', () => {
  // Última fila a T-30h; ahora T-23h: se cruzó T-24h.
  assert.equal(recordSnapshot(snap(), a(23)), 'nueva');
  assert.equal(recordSnapshot(snap(), a(22)), 'igual');
});

test('el abridor confirmado a T-2h: nueva fila, con la causa registrada', () => {
  const r = recordSnapshot(
    snap({
      probs: [0.61, 0.39],
      oddsAt: a(2.5).toISOString(),
      entradas: {
        abridorLocal: { etiqueta: 'abridor de Red Sox', valor: 'Sale' },
        abridorVisit: { etiqueta: 'abridor de Yankees', valor: 'Cole' },
      },
    }),
    a(2),
  );
  assert.equal(r, 'nueva');
  const cs = cambios('baseball', 'mlb|nyy|bos|20261111');
  const ultimo = cs[cs.length - 1];
  assert.deepEqual(ultimo.deltaPp, [6, -6]);
  assert.deepEqual(ultimo.causas, ['abridor de Red Sox: sin dato → Sale']);
  assert.equal(ultimo.atribucion, 'única causa registrada');
});

// EL TEST QUE PIDE LA FASE: lo de T-24h no puede contener nada de T-1h.
test('T-24h NO ve la información que llegó después (el abridor de T-2h)', () => {
  // «Ahora» es después del partido: todas las marcas han llegado (G1: una marca futura está pendiente).
  const [t24, t6, t1, final] = horizontes('baseball', 'mlb|nyy|bos|20261111', INICIO, new Date(Date.parse(INICIO) + 1));
  assert.equal(t24.etiqueta, 'T-24h');
  assert.deepEqual(t24.fila?.probs, [0.55, 0.45]);
  assert.equal(t24.fila?.entradas.abridorLocal.valor, null, 'a T-24h el abridor no se conocía');
  assert.ok(Date.parse(t24.fila!.captured_at) <= Date.parse(t24.marca));
  assert.ok(Date.parse(t24.fila!.odds_at!) <= Date.parse(t24.fila!.captured_at), 'ni cuotas posteriores a la captura');
  // A T-6h tampoco se sabía; a T-1h y en la final, sí.
  assert.equal(t6.fila?.entradas.abridorLocal.valor, null);
  assert.equal(t1.fila?.entradas.abridorLocal.valor, 'Sale');
  assert.deepEqual(final.fila?.probs, [0.61, 0.39]);
  // «A fecha» nunca devuelve una fila posterior, aunque sea la más cercana.
  const justoAntes = aFecha('baseball', 'mlb|nyy|bos|20261111', new Date(a(2).getTime() - 1).toISOString());
  assert.deepEqual(justoAntes?.probs, [0.55, 0.45]);
});

test('la base rechaza instantáneas con datos o cuotas del futuro, o tomadas tras el inicio', () => {
  const ins = (captured: string, oddsAt: string | null, dataAsOf: string | null) => () =>
    db
      .prepare(
        `INSERT INTO prediction_snapshots (sport, match_key, commence_time, captured_at, outcomes, probs, odds_at, data_as_of, inputs)
         VALUES ('baseball', 'x', ?, ?, '[]', '[]', ?, ?, '{}')`,
      )
      .run(INICIO, captured, oddsAt, dataAsOf);
  assert.throws(ins(a(5).toISOString(), a(1).toISOString(), null), /CHECK/, 'cuotas de T-1h en una captura de T-5h');
  assert.throws(ins(a(5).toISOString(), null, a(1).toISOString()), /CHECK/, 'datos de T-1h en una captura de T-5h');
  assert.throws(ins(INICIO, null, null), /CHECK/, 'captura a la hora del inicio');
  assert.equal(recordSnapshot(snap(), new Date(Date.parse(INICIO) + 60_000)), 'empezado');
});

test('una instantánea no se reescribe ni se borra', () => {
  assert.throws(() => db.prepare("UPDATE prediction_snapshots SET probs = '[0.9,0.1]'").run(), /no se reescribe/);
  assert.throws(() => db.prepare('DELETE FROM prediction_snapshots').run(), /no se borra/);
});

test('al empezar, la final pre-partido se congela y ya no cambia', () => {
  assert.equal(freezeFinals(a(1)).congeladas, 0, 'antes del inicio no se congela nada');
  const despues = new Date(Date.parse(INICIO) + 10 * 60_000);
  assert.equal(freezeFinals(despues).congeladas, 1);
  const f = finalPrePartido('baseball', 'mlb|nyy|bos|20261111');
  assert.equal(f?.source, 'snapshot');
  assert.deepEqual(f?.probs, [0.61, 0.39]);
  // Volver a congelar no la toca; reescribirla o borrarla, la base no deja.
  assert.equal(freezeFinals(new Date(despues.getTime() + H)).congeladas, 0);
  assert.throws(() => db.prepare("UPDATE prematch_final SET probs = '[0.5,0.5]'").run(), /congelada/);
  assert.throws(() => db.prepare('DELETE FROM prematch_final').run(), /no se borra/);
  // Y el modelo «volviendo a ejecutarse» después del inicio no deja rastro.
  assert.equal(recordSnapshot(snap({ probs: [0.7, 0.3] }), despues), 'empezado');
  assert.deepEqual(finalPrePartido('baseball', 'mlb|nyy|bos|20261111')?.probs, [0.61, 0.39]);
});

test('sin instantáneas, la final sale del registro de predicciones (también anterior al partido)', () => {
  db.prepare(
    `INSERT INTO naf_prediction_log (match_key, league, upcoming_id, commence_time, home_id, away_id, home_name, away_name,
       prob_home, shown_home, market_prob_home, reliability, predicted_at)
     VALUES ('nfl|2026|10|buf|kc', 'nfl', 'u', ?, 'kc', 'buf', 'Chiefs', 'Bills', 0.6, 0.58, 0.57, 'high', ?)`,
  ).run(INICIO, a(40).toISOString());
  freezeFinals(new Date(Date.parse(INICIO) + 60_000));
  const f = finalPrePartido('nfl', 'nfl|2026|10|buf|kc');
  assert.equal(f?.source, 'prediction_log');
  assert.deepEqual(f?.probs, [0.58, 0.42]);
});

test('un movimiento sin cambio de entradas dice «causa exacta no disponible»', () => {
  const k = 'mlb|tor|bal|20261111';
  recordSnapshot(snap({ matchKey: k }), a(10));
  recordSnapshot(snap({ matchKey: k, probs: [0.58, 0.42] }), a(9));
  const [c] = cambios('baseball', k);
  assert.equal(c.atribucion, 'Causa exacta no disponible');
  assert.deepEqual(c.causas, []);
});

test('evaluación por horizonte: emparejada sobre los mismos partidos', () => {
  db.prepare(
    `INSERT INTO bsb_prediction_log (match_key, league, upcoming_id, commence_time, home_id, away_id, home_name, away_name,
       prob_home, reliability, predicted_at, home_runs, away_runs, resolved_at)
     VALUES ('mlb|nyy|bos|20261111', 'mlb', 'ev1', ?, 'bos', 'nyy', 'Red Sox', 'Yankees', 0.55, 'high', ?, 5, 2, ?)`,
  ).run(INICIO, a(30).toISOString(), INICIO);
  const mlb = evaluacionPorHorizonte().find((e) => e.deporte === 'baseball')!;
  assert.equal(mlb.emparejados, 1);
  const ll = Object.fromEntries(mlb.horizontes.map((h) => [h.etiqueta, h.informe.logLoss]));
  // Ganó el local: la final (0,61) tiene menos log loss que T-24h (0,55).
  assert.ok((ll['Final pre-partido'] as number) < (ll['T-24h'] as number));
});
