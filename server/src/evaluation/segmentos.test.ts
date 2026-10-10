// Segmentos en vivo: las dimensiones salen de la predicción, y ninguna celda publica cifras
// por debajo del umbral.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { segmentos, dimensionesPrediccion, dimensionesApuesta, celdaPrediccion, celdaApuestas, MIN_CELDA_PREDICCIONES, MIN_CELDA_APUESTAS } = await import('./segmentos.ts');

test('dimensionesPrediccion: favorito, lado, banda, mes y día; el tenis no tiene local (C9: el desenlace no es un segmento)', () => {
  const d = dimensionesPrediccion('football', { p: [0.2, 0.3, 0.5], y: 1, version: null, cuando: '2026-03-07T20:00:00Z', liga: 'La Liga' });
  assert.equal(d.liga, 'La Liga');
  assert.equal(d.favorito, 'el visitante favorito');
  assert.equal(d.lado, 'al visitante', 'el lado que favoreció el modelo: se sabe antes del partido');
  assert.equal(d.resultado, undefined, 'segmentar por lo que pasó no selecciona nada');
  assert.equal(d['banda de probabilidad'], '50–60 %');
  assert.equal(d.mes, 'marzo');
  assert.equal(d['día de la semana'], 'sábado');
  const t = dimensionesPrediccion('tennis', { p: [0.7, 0.3], y: 1, version: null, cuando: null, liga: 'ATP' });
  assert.equal(t.favorito, 'el primero favorito');
  assert.equal(t.lado, 'al primero');
  assert.equal(t.resultado, undefined);
  assert.equal(t.mes, undefined);
});

test('dimensionesApuesta: el lado sale de la etiqueta (NFL es «fuera @ casa»)', () => {
  const base = { league: 'NFL', p_model: 0.4, commence_time: '2026-09-13T17:00:00Z', placed_at: '2026-09-12T10:00:00Z', clv: 0.02, profit: null, stake: 10, status: 'pending' };
  const a = dimensionesApuesta('nfl', { ...base, label: 'Jets @ Bills', selection: 'Bills' });
  assert.equal(a.lado, 'al local');
  assert.equal(a.favorito, 'contra el favorito');
  assert.equal(a['banda de probabilidad'], '60–70 %');
  const b = dimensionesApuesta('football', { ...base, label: 'Betis vs Sevilla', selection: 'Sevilla', p_model: 0.55 });
  assert.equal(b.lado, 'al visitante');
  assert.equal(b.favorito, 'al favorito');
});

test('las celdas no publican por debajo del umbral y sí por encima', () => {
  const pocas = Array.from({ length: MIN_CELDA_PREDICCIONES - 1 }, () => ({ p: [0.7, 0.3], y: 0, version: null, cuando: null, liga: null }));
  assert.equal(celdaPrediccion(pocas).publicada, false);
  assert.equal(celdaPrediccion(pocas).acierto, null);
  const bastantes = [...pocas, { p: [0.7, 0.3], y: 1, version: null, cuando: null, liga: null }];
  const c = celdaPrediccion(bastantes);
  assert.equal(c.publicada, true);
  assert.ok(Math.abs((c.acierto as number) - (MIN_CELDA_PREDICCIONES - 1) / MIN_CELDA_PREDICCIONES) < 1e-12);
  const apuesta = { league: null, label: 'A vs B', selection: 'A', p_model: 0.6, commence_time: null, placed_at: '2026-01-01T00:00:00Z', clv: 0.01, profit: 1, stake: 10, status: 'won' };
  assert.equal(celdaApuestas(Array.from({ length: MIN_CELDA_APUESTAS - 1 }, () => apuesta)).clvMedio, null);
  const ok = celdaApuestas(Array.from({ length: MIN_CELDA_APUESTAS }, () => apuesta));
  assert.ok(Math.abs((ok.clvMedio as number) - 0.01) < 1e-12);
  assert.ok(Math.abs((ok.roi as number) - 0.1) < 1e-12);
});

test('segmentos: agrupa por dimensión y la base vacía no rompe', () => {
  const xs = Array.from({ length: 120 }, (_, i) => ({ p: [0.8, 0.2], y: i % 5 === 0 ? 1 : 0, version: null, cuando: '2026-02-01T12:00:00Z', liga: i % 2 ? 'NBA' : 'Euroliga' }));
  const s = segmentos('basketball', xs, []);
  assert.equal(s.predicciones.n, 120);
  assert.equal(s.predicciones.dimensiones.liga.NBA.n, 60);
  assert.equal(s.predicciones.dimensiones.liga.NBA.publicada, false, '60 < 100');
  assert.equal(s.predicciones.dimensiones.mes.febrero.publicada, true);
  assert.equal(s.apuestas.n, 0);
  assert.deepEqual(s.umbrales, { predicciones: MIN_CELDA_PREDICCIONES, apuestas: MIN_CELDA_APUESTAS });
  const real = segmentos('tennis');
  assert.equal(real.predicciones.n, 0);
});
