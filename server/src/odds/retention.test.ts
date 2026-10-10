// Retención de snapshots: lo que importa sobrevive, lo borrado va entero al archivo, y sin
// --confirmar no se toca ni una fila.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import '../test/setup.ts';

const { getDb, getMeta } = await import('../db.ts');
const { decidir, planificar, aplicar, MARCAS_HORAS } = await import('./retention.ts');

const INICIO = Date.parse('2026-06-01T18:00:00Z');
const h = (horasAntes: number) => new Date(INICIO - horasAntes * 3_600_000).toISOString();

function insertar(filas: { event_id: string; selection?: string; bookmaker?: string; observed_at: string; commence?: string | null }[]): number[] {
  const db = getDb();
  const ins = db.prepare(
    "INSERT INTO odds_snapshots (event_id, sport, league, market, selection, bookmaker, odds_decimal, commence_time, observed_at) VALUES (?, 'football', 'soccer_epl', 'h2h', ?, ?, 1.9, ?, ?)",
  );
  return filas.map((f) => Number(ins.run(f.event_id, f.selection ?? 'Casa', f.bookmaker ?? 'bet365', f.commence === undefined ? new Date(INICIO).toISOString() : f.commence, f.observed_at).lastInsertRowid));
}

test('decidir: apertura, última antes de T-24h/T-6h/T-1h, cierre y última observación se quedan; lo demás se va', () => {
  // Observaciones cada 3 h desde 72 h antes hasta 1 h después del inicio, misma casa y selección.
  const obs: number[] = [];
  for (let t = 72; t >= 0; t -= 3) obs.push(t);
  obs.push(-1);
  const filas = obs.map((t, i) => ({ id: i + 1, event_id: 'e1', market: 'h2h', selection: 'Casa', bookmaker: 'bet365', commence_time: new Date(INICIO).toISOString(), observed_at: h(t) }));
  const { conservar, borrar } = decidir(filas);
  const porHoras = (t: number) => filas.find((f) => f.observed_at === h(t))!.id;
  assert.ok(conservar.includes(porHoras(72)), 'apertura');
  for (const m of MARCAS_HORAS) {
    const ultimaAntes = Math.min(...obs.filter((t) => t >= m));
    assert.ok(conservar.includes(porHoras(ultimaAntes)), `última antes de T-${m}h (${ultimaAntes} h antes)`);
  }
  assert.ok(conservar.includes(porHoras(0)), 'cierre: la última antes del inicio');
  assert.ok(conservar.includes(porHoras(-1)), 'la última observación, siempre');
  assert.equal(conservar.length + borrar.length, filas.length);
  assert.ok(borrar.length > 0);
  assert.ok(!borrar.includes(porHoras(72)) && !borrar.includes(porHoras(0)));
  // Dos casas o dos selecciones no se mezclan: cada grupo tiene su apertura.
  const dos = decidir([
    ...filas.map((f) => ({ ...f, bookmaker: 'bet365' })),
    ...filas.map((f) => ({ ...f, id: f.id + 100, bookmaker: 'pinnacle' })),
  ]);
  assert.ok(dos.conservar.includes(1) && dos.conservar.includes(101), 'una apertura por casa');
  // Sin commence_time, solo apertura y última.
  const sin = decidir(filas.map((f) => ({ ...f, commence_time: null })));
  assert.deepEqual(sin.conservar, [filas[0].id, filas[filas.length - 1].id]);
});

test('planificar: exige ≥ 7 días y solo mira lo anterior al límite', () => {
  assert.throws(() => planificar(3), /al menos 7 días/);
  const ahora = new Date('2026-10-07T00:00:00Z');
  insertar([
    { event_id: 'reciente', observed_at: '2026-10-05T00:00:00Z' },
    { event_id: 'reciente', observed_at: '2026-10-05T01:00:00Z' },
    { event_id: 'reciente', observed_at: '2026-10-05T02:00:00Z' },
  ]);
  const plan = planificar(30, ahora);
  assert.equal(plan.limite, '2026-09-07T00:00:00.000Z');
  const ids = getDb().prepare("SELECT id FROM odds_snapshots WHERE event_id = 'reciente'").all() as { id: number }[];
  for (const { id } of ids) assert.ok(!plan.borrar.includes(id) && !plan.conservar.includes(id), 'lo reciente ni se considera');
});

test('aplicar: sin --confirmar nada cambia; con él, el archivo contiene exactamente lo borrado, lo conservado sigue y el trigger vuelve', () => {
  const db = getDb();
  const ahora = new Date('2026-10-07T00:00:00Z');
  const ids = insertar([72, 48, 30, 25, 20, 10, 7, 5, 2, 0.5].map((t) => ({ event_id: 'viejo', observed_at: h(t) })));
  const antes = (db.prepare('SELECT COUNT(*) AS n FROM odds_snapshots').get() as { n: number }).n;
  const plan = planificar(30, ahora);
  assert.ok(plan.borrar.length > 0 && plan.conservar.length >= 5);
  assert.deepEqual(aplicar(plan, { confirmar: false }), { borradas: 0, archivo: null });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM odds_snapshots').get() as { n: number }).n, antes, 'sin confirmar, intacto');
  // Lo que devuelve node:sqlite son objetos sin prototipo; por JSON, como viajarán al archivo.
  const filasABorrar = JSON.parse(JSON.stringify(plan.borrar.map((id) => db.prepare('SELECT * FROM odds_snapshots WHERE id = ?').get(id))));
  const r = aplicar(plan, { confirmar: true, ahora });
  assert.equal(r.borradas, plan.borrar.length);
  assert.ok(r.archivo && fs.existsSync(r.archivo));
  const lineas = zlib.gunzipSync(fs.readFileSync(r.archivo!)).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lineas.map((l) => l.id).sort((a, b) => a - b), [...plan.borrar].sort((a, b) => a - b), 'el archivo tiene exactamente los ids borrados');
  assert.deepEqual(lineas, filasABorrar, 'y las filas completas, tal cual estaban');
  for (const id of plan.conservar) assert.ok(db.prepare('SELECT 1 FROM odds_snapshots WHERE id = ?').get(id), `conservada ${id}`);
  for (const id of plan.borrar) assert.equal(db.prepare('SELECT 1 FROM odds_snapshots WHERE id = ?').get(id), undefined, `borrada ${id}`);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM odds_snapshots').get() as { n: number }).n, antes - plan.borrar.length);
  // El trigger está otra vez: un DELETE normal vuelve a fallar.
  assert.throws(() => db.exec(`DELETE FROM odds_snapshots WHERE id = ${ids[0]}`), /no se borra|RAISE|abort/i);
  assert.equal(getMeta('retention:last_at'), ahora.toISOString());
  assert.equal(getMeta('retention:last_removed'), String(plan.borrar.length));
  // Segunda pasada: ya no hay nada que borrar.
  assert.equal(planificar(30, ahora).borrar.length, 0);
});

test('B5: un partido aplazado se ancla en su ÚLTIMA hora de inicio, no en la primera', () => {
  const viejo = INICIO - 48 * 3_600_000;
  const hv = (horasAntes: number) => new Date(viejo - horasAntes * 3_600_000).toISOString();
  const filas = [
    { id: 1, event_id: 'ap', market: 'h2h', selection: 'Casa', bookmaker: 'bet365', commence_time: new Date(viejo).toISOString(), observed_at: hv(30) },
    { id: 2, event_id: 'ap', market: 'h2h', selection: 'Casa', bookmaker: 'bet365', commence_time: new Date(viejo).toISOString(), observed_at: hv(20) },
    // Aplazado 48 h: las observaciones nuevas traen la hora nueva.
    { id: 3, event_id: 'ap', market: 'h2h', selection: 'Casa', bookmaker: 'bet365', commence_time: new Date(INICIO).toISOString(), observed_at: h(25) },
    { id: 4, event_id: 'ap', market: 'h2h', selection: 'Casa', bookmaker: 'bet365', commence_time: new Date(INICIO).toISOString(), observed_at: h(7) },
    { id: 5, event_id: 'ap', market: 'h2h', selection: 'Casa', bookmaker: 'bet365', commence_time: new Date(INICIO).toISOString(), observed_at: h(2) },
    { id: 6, event_id: 'ap', market: 'h2h', selection: 'Casa', bookmaker: 'bet365', commence_time: new Date(INICIO).toISOString(), observed_at: h(0.5) },
    { id: 7, event_id: 'ap', market: 'h2h', selection: 'Casa', bookmaker: 'bet365', commence_time: new Date(INICIO).toISOString(), observed_at: h(-1) },
  ];
  const { conservar, borrar } = decidir(filas);
  assert.deepEqual(conservar, [1, 3, 4, 5, 6, 7], `apertura, T-24h, T-6h, T-1h y cierre respecto a la hora NUEVA, y la última; se va: ${borrar}`);
  assert.deepEqual(borrar, [2]);
});
