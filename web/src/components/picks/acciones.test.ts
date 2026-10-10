// Exportaciones de «Mi selección» (Fase 5.15): .ics válido, texto legible y borrador correcto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { borradorDe, comoIcs, comoTexto, patasDe } from './acciones';
import type { Pick } from './tipos';

const pick = (over: Partial<Pick> = {}): Pick => ({
  deporte: 'Fútbol', sport: 'football', matchKey: 'k1', eventoId: 'e1', liga: 'epl', cuando: '2026-10-10T15:00:00.000Z', partido: 'Arsenal vs Chelsea', casa: 'Arsenal', fuera: 'Chelsea', casaId: 'arsenal', fueraId: 'chelsea',
  opciones: [{ nombre: 'Arsenal', p: 0.5, cuota: 2.1 }, { nombre: 'Empate', p: 0.25, cuota: 3.4 }, { nombre: 'Chelsea', p: 0.25, cuota: 3.6 }],
  favorito: 'Arsenal', probabilidad: 0.5, cuota: 2.1, cuotaJusta: 2, ventaja: 0.05, casas: 6, fiabilidad: 'high', confianza: null, historico: null, ...over,
});

test('comoIcs: un VEVENT por partido con CRLF, hora UTC y la probabilidad en la descripción', () => {
  const crudo = comoIcs([pick(), pick({ matchKey: 'k2', partido: 'Betis, Sevilla; derbi' })], new Date('2026-10-07T10:00:00Z'));
  for (const l of crudo.split('\r\n')) assert.ok(new TextEncoder().encode(l).length <= 75, `línea de más de 75 octetos: ${l}`);
  const ics = crudo.replace(/\r\n /g, '');
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.equal(ics.match(/BEGIN:VEVENT/g)?.length, 2);
  assert.match(ics, /DTSTART:20261010T150000Z/);
  assert.match(ics, /DTEND:20261010T170000Z/);
  assert.match(ics, /DESCRIPTION:Arsenal: 50\\,0\u00a0% según el modelo/, 'la coma decimal también se escapa');
  assert.ok(ics.includes('SUMMARY:Betis\\, Sevilla\\; derbi'), 'comas y punto y coma escapados');
  assert.ok(comoIcs([pick({ partido: 'a\\b' })]).includes('SUMMARY:a\\\\b'), 'la barra invertida también se escapa');
});

test('comoTexto y borradorDe: una pata va como ganador; varias, como combinada con la conjunta', () => {
  assert.match(comoTexto([pick()], null), /Arsenal vs Chelsea — Arsenal 50,0\u00a0% @ 2,10/);
  const uno = borradorDe([pick()], null);
  assert.equal(uno.market, 'moneyline');
  assert.equal(uno.selection, 'Arsenal');
  assert.equal(uno.match_key, 'k1');
  const comb = { patas: 2, independiente: 0.25, conjunta: 0.26, factorCorrelacion: 1.04, vinculos: [], incompatibles: [], cuotaCombinada: 4.41, cuotaJusta: 3.85, ventaja: 0.15, etiqueta: '' };
  const dos = borradorDe([pick(), pick({ matchKey: 'k2', sport: 'nfl', partido: 'Jets @ Bills', favorito: 'Bills' })], comb);
  assert.equal(dos.market, 'other');
  assert.equal(dos.sport, 'other', 'deportes distintos');
  assert.equal(dos.odds, 4.41);
  assert.equal(dos.model_prob, 0.26);
  assert.deepEqual(patasDe([pick()])[0].indice, 0);
});
