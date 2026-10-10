// Simulación de temporada: determinista con semilla, coherente con la clasificación real,
// reconstrucción de la doble vuelta, caché diaria, y menos de 5 segundos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { simularTemporada, clasificacionDe, reglasDe, simulacionTemporada, simulacionDelDia, configSimulacion } = await import('./season.ts');
const { pendientesDe, reconstruirDobleVuelta, guardarCalendario, calendarioGuardado } = await import('./calendario.ts');
const { rng, elegir } = await import('./rng.ts');
const { getDb } = await import('../db.ts');

const equipos = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, nombre: `Equipo ${i}` }));
/** Cada par ida y vuelta; el mejor equipo (t0) gana con más probabilidad. */
function liga(): { homeId: string; awayId: string; p: number[] }[] {
  const out: { homeId: string; awayId: string; p: number[] }[] = [];
  for (const h of equipos) for (const a of equipos) {
    if (h === a) continue;
    const fuerzaH = 6 - Number(h.id.slice(1));
    const fuerzaA = 6 - Number(a.id.slice(1));
    const ph = 0.2 + (0.5 * fuerzaH) / (fuerzaH + fuerzaA);
    const pa = 0.2 + (0.5 * fuerzaA) / (fuerzaH + fuerzaA);
    out.push({ homeId: h.id, awayId: a.id, p: [ph, 1 - ph - pa, pa] });
  }
  return out;
}

test('rng: misma semilla, misma secuencia; elegir respeta las probabilidades', () => {
  const a = rng(7);
  const b = rng(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  assert.equal(elegir([0.2, 0.3, 0.5], 0.1), 0);
  assert.equal(elegir([0.2, 0.3, 0.5], 0.49), 1);
  assert.equal(elegir([0.2, 0.3, 0.5], 0.99), 2);
});

test('simularTemporada: determinista, probabilidades que suman 1, el mejor es el favorito al título', () => {
  const t0 = Date.now();
  const entrada = { equipos, clasificacion: {}, partidos: liga(), reglas: { puntos: [3, 1, 0] as [number, number, number], top: 2, descenso: 1 }, corridas: 10_000, semilla: 42 };
  const r1 = simularTemporada(entrada);
  const r2 = simularTemporada(entrada);
  assert.deepEqual(r1, r2, 'misma semilla, mismo resultado');
  assert.ok(Date.now() - t0 < 5000, 'dos corridas de 10.000 en menos de 5 s');
  assert.equal(r1[0].id, 't0');
  assert.ok(r1[0].titulo > 0.3 && r1[0].titulo > r1[5].titulo);
  assert.ok(Math.abs(r1.reduce((s, e) => s + e.titulo, 0) - 1) < 1e-9, 'un campeón por corrida');
  assert.ok(Math.abs(r1.reduce((s, e) => s + e.top, 0) - 2) < 1e-9, 'dos plazas arriba');
  assert.ok(Math.abs(r1.reduce((s, e) => s + e.descenso, 0) - 1) < 1e-9, 'una plaza de descenso');
  for (const e of r1) assert.ok(Math.abs(e.posiciones.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(r1[5].descenso > r1[0].descenso);
  // Con 10 partidos cada uno y 3/1/0, los puntos esperados están entre 0 y 30.
  for (const e of r1) assert.ok(e.puntosEsperados > 0 && e.puntosEsperados < 30);
});

test('simularTemporada: con grupos, el título y el top se cuentan dentro de cada grupo; con victorias los empates valen medio', () => {
  const eq = equipos.map((e, i) => ({ ...e, grupo: i % 2 ? 'B' : 'A' }));
  const r = simularTemporada({ equipos: eq, clasificacion: {}, partidos: liga().map((m) => ({ ...m, p: [m.p[0], m.p[2]] })), reglas: { puntos: 'victorias', top: 1, descenso: 0, grupos: true }, corridas: 2000, semilla: 1 });
  assert.ok(Math.abs(r.reduce((s, e) => s + e.titulo, 0) - 2) < 1e-9, 'un primero por grupo');
  const empates = simularTemporada({ equipos: eq.slice(0, 2), clasificacion: {}, partidos: [{ homeId: 't0', awayId: 't1', p: [0, 1, 0] }], reglas: { puntos: 'victorias', top: 1, descenso: 0 }, corridas: 10, semilla: 1 });
  assert.equal(empates[0].puntosEsperados, 0.5);
  assert.equal(empates[0].victoriasEsperadas, 0.5);
});

test('clasificacionDe: puntos, jugados y resultados de lo jugado', () => {
  const c = clasificacionDe([{ homeId: 'a', awayId: 'b', hg: 2, ag: 0 }, { homeId: 'b', awayId: 'a', hg: 1, ag: 1 }], { puntos: [3, 1, 0] });
  assert.deepEqual(c.a, { puntos: 4, jugados: 2, victorias: 1, empates: 1, derrotas: 0 });
  assert.deepEqual(c.b, { puntos: 1, jugados: 2, victorias: 0, empates: 1, derrotas: 1 });
  const v = clasificacionDe([{ homeId: 'a', awayId: 'b', hg: 20, ag: 20 }], { puntos: 'victorias' });
  assert.equal(v.a.puntos, 0.5);
});

test('reconstruirDobleVuelta: cada par ida y vuelta menos lo jugado; el calendario guardado se lee y se sustituye', () => {
  const r = reconstruirDobleVuelta(['a', 'b', 'c'], [{ homeId: 'a', awayId: 'b' }]);
  assert.equal(r.length, 5);
  assert.ok(!r.some((f) => f.homeId === 'a' && f.awayId === 'b'));
  assert.ok(r.some((f) => f.homeId === 'b' && f.awayId === 'a'));
  guardarCalendario('football', 'liga-test', 2027, [{ fecha: '20270301', homeId: 'a', awayId: 'b', neutral: false }, { fecha: '20270101', homeId: 'b', awayId: 'a', neutral: false }], 'test');
  assert.equal(calendarioGuardado('football', 'liga-test', 2027, '20270201').partidos.length, 1, 'solo desde la fecha');
  guardarCalendario('football', 'liga-test', 2027, [], 'test');
  assert.equal(calendarioGuardado('football', 'liga-test', 2027, '20000101').origen, 'ninguno');
});

test('reglasDe: liga concreta o la de defecto del deporte; el tenis no tiene', () => {
  assert.equal(reglasDe('football', 'epl')?.descenso, 3);
  assert.equal(reglasDe('football', 'liga-inventada')?.formato, 'doble vuelta');
  assert.equal(reglasDe('tennis', 'atp'), null);
  assert.equal(configSimulacion().corridas, 10_000);
});

test('simulacionTemporada con la base vacía: motivo claro, nada inventado; la caché diaria guarda una sola vez', async () => {
  const r = await simulacionTemporada('football', 'epl', new Date('2026-10-07T10:00:00Z'));
  assert.equal(r.motivo, 'sin partidos en la base');
  assert.equal(r.equipos.length, 0);
  assert.match(r.etiqueta, /no es una predicción publicada/);
  // Una liga sintética en la base: 4 equipos, dos partidos jugados; el resto se reconstruye.
  const db = getDb();
  for (const id of ['w', 'x', 'y', 'z']) db.prepare("INSERT OR IGNORE INTO fb_teams (id, league, name) VALUES (?, 'epl', ?)").run(id, id.toUpperCase());
  db.prepare("INSERT INTO fb_matches (league, season, match_date, home_id, away_id, home_goals, away_goals, result) VALUES ('epl', 2027, '20260901', 'w', 'x', 2, 0, 'H')").run();
  db.prepare("INSERT INTO fb_matches (league, season, match_date, home_id, away_id, home_goals, away_goals, result) VALUES ('epl', 2027, '20260901', 'y', 'z', 1, 1, 'D')").run();
  const s = await simulacionDelDia('football', 'epl', new Date('2026-10-07T10:00:00Z'));
  assert.equal(s.motivo, null);
  assert.equal(s.calendario.origen, 'reconstruido');
  assert.equal(s.calendario.pendientes + s.calendario.sinProbabilidad, 10, '12 pares menos 2 jugados');
  assert.equal(s.jugados, 2);
  assert.equal(s.equipos.length, 4);
  const otra = await simulacionDelDia('football', 'epl', new Date('2026-10-07T23:00:00Z'));
  assert.equal(otra.generado, s.generado, 'el mismo día se sirve de la caché');
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM simulation_runs WHERE league = 'epl'").get() as { n: number }).n, 1);
});

test('C6: pendiente es «sin resultado emparejado», no «fecha futura»', () => {
  const cal = [
    { fecha: '20260301', homeId: 'a', awayId: 'b', neutral: false }, // ya jugado (adelantado un día en los resultados)
    { fecha: '20260101', homeId: 'b', awayId: 'a', neutral: false }, // aplazado: fecha pasada y sin resultado
    { fecha: '20260210', homeId: 'c', awayId: 'a', neutral: false },
  ];
  const jugados = [{ homeId: 'a', awayId: 'b', hg: 1, ag: 0, fecha: '20260302' }];
  const p = pendientesDe(cal, jugados);
  assert.deepEqual(p.map((f) => `${f.homeId}-${f.awayId}`), ['b-a', 'c-a']);
  // Un par que se repite (dos partidos del mismo cruce en fechas distintas, como en la NBA) solo descuenta el jugado.
  const nba = [{ fecha: '20260110', homeId: 'x', awayId: 'y', neutral: false }, { fecha: '20260220', homeId: 'x', awayId: 'y', neutral: false }];
  assert.equal(pendientesDe(nba, [{ homeId: 'x', awayId: 'y', hg: 100, ag: 90, fecha: '20260110' }]).length, 1);
  // Sin fecha (calendario reconstruido): descuenta por par.
  assert.equal(pendientesDe([{ fecha: '', homeId: 'a', awayId: 'b', neutral: false }], jugados).length, 0);
});
