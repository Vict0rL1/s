// Colores de club (Fase 5.23): las cuatro ligas nuevas y la NBA actual casan con los nombres
// tal como los guarda la base; lo desconocido sale neutro, nunca inventado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crestColors } from './teamColors';

test('las ligas nuevas casan por el nombre largo de la base', () => {
  assert.deepEqual(crestColors('laliga', 'Club Atlético de Madrid'), { primary: '#cb3524', secondary: '#272e61', known: true });
  assert.equal(crestColors('laliga', 'FC Barcelona').primary, '#a50044');
  assert.equal(crestColors('seriea', 'FC Internazionale Milano').known, true);
  assert.equal(crestColors('bundesliga', '1. FC Köln').known, true);
  assert.equal(crestColors('ligue1', 'Paris Saint-Germain FC').primary, '#004170');
});

test('NBA: las 30 franquicias actuales, también con los ids cortos de la base', () => {
  for (const id of ['sixers', 'trailblazers', 'thunder', 'spurs', 'charlotte-hornets']) assert.equal(crestColors('nba', id).known, true, id);
});

test('lo que no está sale neutro', () => {
  assert.equal(crestColors('championship', 'Equipo Inventado FC').known, false);
});

// G6 (prueba en el navegador, 9 de octubre): las iniciales del escudo se leen sobre su color. La
// tinta se elegía por un umbral de luminancia (0,35) y no por contraste: blanco sobre el naranja
// de los Giants (SFN) daba 2,86:1, sobre el turquesa de Miami 2,66:1.
test('G6: la tinta del escudo pasa de 4,5:1 sobre el relleno, en todos los clubes conocidos', async () => {
  const { TEAM_COLORS } = await import('./teamColorsDatos');
  const { crestPaint } = await import('./teamColors');
  const { contraste } = await import('./contraste');
  const bajos: string[] = [];
  for (const [liga, tabla] of Object.entries(TEAM_COLORS)) {
    for (const [club, [primary, secondary]] of Object.entries(tabla)) {
      const p = crestPaint({ primary, secondary, known: true });
      const r = contraste(p.ink, p.fill);
      if (r < 4.5) bajos.push(`${liga}/${club} ${p.ink} sobre ${p.fill}: ${r.toFixed(2)}`);
    }
  }
  const neutro = crestPaint(crestColors('nba', 'Equipo Inventado'));
  assert.ok(contraste(neutro.ink, neutro.fill) >= 4.5);
  assert.deepEqual(bajos, []);
});
