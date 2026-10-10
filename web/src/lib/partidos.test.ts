// Forma común de un partido (Fase 5.11): la probabilidad publicada de cada deporte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aComun, nombrePartido } from './partidos';

const g = { id: 'x', league: 'nfl', commence_time: '2026-10-10T17:00:00Z', home_name: 'Bills', away_name: 'Jets', home_id: 'BUF', away_id: 'NYJ' };

test('aComun: fútbol publica `final`; NFL a dos vías sin empate; tenis prob1', () => {
  const fb = aComun('football', { fixture: { ...g, league: 'epl' }, prediction: { final: { home: 0.5, draw: 0.3, away: 0.2 }, model: { home: 0.6, draw: 0.2, away: 0.2 } } });
  assert.deepEqual(fb?.probs, [0.5, 0.3, 0.2]);
  const nfl = aComun('nfl', { game: g, prediction: { model: { home: 0.6, away: 0.38, tie: 0.02 } } });
  assert.ok(nfl && Math.abs((nfl.probs as number[])[0] - 0.6 / 0.98) < 1e-12);
  assert.equal(nombrePartido(nfl!), 'Jets @ Bills');
  const t = aComun('tennis', { match: { id: 'm', tour: 'atp', commence_time: '2026-10-10T10:00:00Z', p1_name: 'A', p2_name: 'B', p1_id: 1, p2_id: 2 }, prediction: { model: { prob1: 0.7 } } });
  assert.deepEqual(t?.probs, [0.7, 0.30000000000000004]);
  assert.equal(t?.league, 'atp');
  assert.equal(aComun('basketball', { game: g, prediction: null })?.probs, null, 'sin modelo, sin probabilidad');
});

test('D1: la NFL en la ficha es la final publicada (la que lee Destacados), no la cruda', () => {
  const nfl = aComun('nfl', { game: g, prediction: { model: { home: 0.6, away: 0.38, tie: 0.02 }, final: { home: 0.55, away: 0.45 } } });
  assert.deepEqual(nfl!.probs, [0.55, 0.45]);
});
