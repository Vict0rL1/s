import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { maxDrawdown, peorRacha, tramo, rendimientoEnVivo, TRAMOS_EDGE } = await import('./betting.ts');
const { validacionEnVivo, probarMedia } = await import('./validation.ts');
const { getDb } = await import('../db.ts');

const cerca = (a: number | null | undefined, b: number, tol = 1e-9) => assert.ok(a != null && Math.abs(a - b) < tol, `${a} ≠ ${b}`);

test('drawdown: la mayor caída desde un máximo, no la suma de pérdidas', () => {
  const xs = [10, -30, 5, -20, 50].map((profit, i) => ({ profit, settled_at: `d${i}` }));
  const dd = maxDrawdown(xs, 1000)!;
  cerca(dd.importe, 45); // 1010 → 965
  cerca(dd.pct, 45 / 1010);
  assert.equal(dd.desde, 'd0');
  assert.equal(dd.hasta, 'd3');
  assert.equal(maxDrawdown([], 1000), null);
  // Solo subidas: no hay caída.
  assert.equal(maxDrawdown([{ profit: 5, settled_at: 'a' }], 1000)!.importe, 0);
});

test('racha: un empate devuelto no la corta ni la alarga; una ganada, sí la corta', () => {
  assert.equal(peorRacha(['lost', 'lost', 'push', 'lost', 'won', 'lost'].map((status) => ({ status }))), 3);
  assert.equal(peorRacha([]), 0);
});

test('el ROI prometido se pondera por importe, como el realizado', () => {
  const base = { sport: 'nfl', status: 'won', settled_at: null, p: null, clv: null };
  const t = tramo('x', [
    { ...base, odds: 2, stake: 10, profit: 10, edge: 0.02 },
    { ...base, odds: 2, stake: 30, profit: -30, edge: 0.1, status: 'lost' },
  ]);
  cerca(t.roi, -20 / 40);
  cerca(t.roiPrometido, (10 * 0.02 + 30 * 0.1) / 40);
  // Sin ventaja guardada, sale de p y la cuota (apuestas anteriores a guardarla).
  cerca(tramo('y', [{ ...base, odds: 2.5, stake: 10, profit: 15, edge: null, p: 0.5 }]).roiPrometido, 0.25);
});

// Apuestas liquidadas de verdad, por los mismos triggers que en producción: alta
// pendiente, cierre una vez, liquidación una vez.
const db = getDb();
let k = 0;
function apuesta(o: { sport?: string; odds: number; p: number; gana: boolean; stake?: number; clv?: number }) {
  k++;
  const stake = o.stake ?? 10;
  const { lastInsertRowid: id } = db
    .prepare(
      `INSERT INTO paper_bets (placed_at, sport, match_key, event_id, label, selection, p_model, p_market, odds, stake, bankroll_at,
         model_probability_calibrated, edge)
       VALUES (?, ?, ?, ?, 'A vs B', 'A', ?, 0.45, ?, ?, 1000, ?, ?)`,
    )
    .run(`2026-09-01T10:${String(k % 60).padStart(2, '0')}:00Z`, o.sport ?? 'football', `m${k}`, `e${k}`, o.p, o.odds, stake, o.p, o.p * o.odds - 1);
  if (o.clv != null) db.prepare('UPDATE paper_bets SET closing_odds = ?, clv = ? WHERE id = ?').run(o.odds / (1 + o.clv), o.clv, id);
  db.prepare("UPDATE paper_bets SET status = ?, profit = ?, settled_at = ? WHERE id = ?").run(
    o.gana ? 'won' : 'lost',
    o.gana ? stake * (o.odds - 1) : -stake,
    `2026-09-02T${String(Math.floor(k / 60) % 24).padStart(2, '0')}:${String(k % 60).padStart(2, '0')}:00Z`,
    id,
  );
}

// TEST NEGATIVO: el modelo promete +10 % en cada apuesta (p 0,55 a cuota 2,0) y gana una de
// cada tres. La prueba tiene que decir que rinde menos de lo prometido.
test('un modelo que sobrestima su ventaja sale «en contra» en «¿rinde lo prometido?»', () => {
  for (let i = 0; i < 60; i++) apuesta({ odds: 2, p: 0.55, gana: i % 3 === 0, sport: i % 2 ? 'football' : 'nfl', clv: 0.01 });
  const v = validacionEnVivo();
  assert.equal(v.promesa.n, 60);
  assert.equal(v.promesa.veredicto, 'en contra');
  assert.ok((v.promesa.hi as number) < 0);

  const r = rendimientoEnVivo();
  assert.equal(r.total.n, 60);
  assert.equal(r.aciertos, 20);
  cerca(r.aciertosEsperados, 60 * 0.55);
  cerca(r.total.roiPrometido, 0.1);
  cerca(r.total.roi, (20 * 10 - 40 * 10) / 600);
  assert.deepEqual(r.porDeporte.map((t) => [t.etiqueta, t.n]), [['football', 30], ['nfl', 30]]);
  assert.deepEqual(r.porCuota.map((t) => t.etiqueta), ['1,80 – 2,50']);
  assert.deepEqual(r.porEdge.map((t) => t.etiqueta), ['ventaja ≥ 10 %']);
  assert.ok(r.drawdown!.importe > 0);
  assert.equal(r.peorRacha, 2);
  cerca(r.total.clvMedio, 0.01);
});

// Y el reverso: un modelo que acierta lo que promete NO puede salir «en contra».
test('un modelo que rinde lo prometido no sale «en contra»', () => {
  // p 0,55 a cuota 2,0, y gana 33 de 60 (el 55 %): exactamente lo prometido.
  const xs = Array.from({ length: 60 }, (_, i) => (i < 33 ? 1 : -1) - 0.1);
  assert.equal(probarMedia(xs, 'x', true, String).veredicto, 'no concluyente');
});

test('señales por tramo de ventaja: solo se afirma algo cuando los intervalos no se tocan', () => {
  const ins = db.prepare(
    `INSERT INTO edge_signals (created_at, sport, event_id, selection, model_probability_calibrated, odds, edge, decision, stake, commence_time, closing_odds, clv)
     VALUES ('2026-09-01T10:00:00Z', 'football', ?, 'A', 0.5, 2.2, ?, 'rechazada', 0, '2026-09-01T18:00:00Z', 2.1, ?)`,
  );
  // Pequeñas: le ganan al cierre un 3 %. Grandes: pierden contra él un 2 %. Mucha muestra.
  for (let i = 0; i < 40; i++) ins.run(`s${i}`, 0.02, 0.03 + ((i % 5) - 2) * 0.002);
  for (let i = 0; i < 40; i++) ins.run(`g${i}`, 0.15, -0.02 + ((i % 5) - 2) * 0.002);
  const r = rendimientoEnVivo();
  assert.equal(r.senalesPorEdge.length, TRAMOS_EDGE.length);
  assert.equal(r.senalesPorEdge[0].n, 40);
  assert.equal(r.senalesPorEdge[0].veredicto, 'a favor');
  assert.equal(r.senalesPorEdge[3].veredicto, 'en contra');
  assert.match(r.lecturaEdge ?? '', /le ganan MENOS al cierre/);
});
