import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simularFetch } from '../test/setup.ts';

const MIN = 60_000;

const { closingTargets, captureClosingOdds } = await import('./closingCapture.ts');
const { recordOddsResponse, closingLine } = await import('./snapshots.ts');
const { getDb } = await import('../db.ts');

const db = getDb();
// Horas RELATIVAS al reloj real: requestOdds sella cada observación con la hora de
// verdad, y un «ahora» simulado en otra fecha la dejaría fuera de la ventana.
const ahora = new Date();
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const INICIO = iso(ahora.getTime() + 20 * MIN); // dentro de 20 min
const MANANA = iso(ahora.getTime() - 9 * 60 * MIN); // visto hace nueve horas

function evento(id: string, local: number, commence = INICIO) {
  return {
    id,
    sport_key: 'soccer_epl',
    commence_time: commence,
    home_team: 'Arsenal',
    away_team: 'Chelsea',
    bookmakers: [{ key: 'pinnacle', title: 'P', markets: [{ key: 'h2h', outcomes: [{ name: 'Arsenal', price: local }, { name: 'Draw', price: 3.4 }, { name: 'Chelsea', price: 3.0 }] }] }],
  };
}
const apuesta = (evId: string, commence = INICIO) =>
  db
    .prepare(
      `INSERT INTO paper_bets (placed_at, sport, match_key, event_id, label, selection, p_model, p_market, odds, stake, bankroll_at,
         commence_time, provider_event_id, provider_selection, market)
       VALUES (?, 'football', ?, ?, 'Arsenal vs Chelsea', 'Arsenal', 0.52, 0.4, 2.5, 10, 1000, ?, ?, 'Arsenal', 'h2h')`,
    )
    .run(iso(ahora.getTime() - 10 * 60 * MIN), `k-${evId}`, evId, commence, evId);

// Visto por última vez hace nueve horas: para un partido de dentro de 20 min, eso no es un cierre.
recordOddsResponse('soccer_epl', 'h2h', { events: [evento('e1', 2.5)], fetchedAt: MANANA });
apuesta('e1');

test('una apuesta pendiente que empieza pronto y no se ha visto hace poco pide su liga', () => {
  assert.deepEqual(closingTargets(ahora), ['soccer_epl']);
});

test('fuera de la ventana (empieza en 3 h) todavía no se pide', () => {
  assert.deepEqual(closingTargets(new Date(ahora.getTime() - 3 * 60 * MIN)), []);
});

test('se pide una vez, queda en los snapshots, y el cierre ya es de 10 min antes', async () => {
  let peticiones = 0;
  simularFetch((url) => {
    peticiones++;
    assert.match(url, /\/sports\/soccer_epl\/odds\/.*markets=h2h/);
    return new Response(JSON.stringify([evento('e1', 2.3)]), { status: 200, headers: { 'x-requests-remaining': '400', 'x-requests-used': '100' } });
  });
  const r = await captureClosingOdds(() => {}, ahora);
  assert.deepEqual(r.pedidas, ['soccer_epl']);
  assert.equal(peticiones, 1);
  // Con la observación recién hecha, ya no hace falta pedir más.
  assert.deepEqual(closingTargets(new Date(ahora.getTime() + 5 * MIN)), []);
  const cierre = closingLine('e1', 'h2h', 'Arsenal', INICIO);
  assert.equal(cierre?.consensus, 2.3);
  assert.ok((cierre?.minutesBeforeStart ?? 999) <= 20, 'el cierre tiene que ser de justo antes del inicio');
});

test('un partido sin apuesta ni señal no gasta nada', () => {
  recordOddsResponse('soccer_efl_champ', 'h2h', { events: [{ ...evento('e2', 2.0), sport_key: 'soccer_efl_champ' }], fetchedAt: MANANA });
  assert.ok(!closingTargets(ahora).includes('soccer_efl_champ'));
});

test('si el freno de presupuesto no deja, se informa y no rompe nada', async () => {
  recordOddsResponse('soccer_spain_la_liga', 'h2h', { events: [{ ...evento('e3', 2.0), sport_key: 'soccer_spain_la_liga' }], fetchedAt: MANANA });
  apuesta('e3');
  // Cupo por debajo de la reserva: una petición automática no puede gastarlo.
  db.prepare("INSERT INTO meta (key, value) VALUES ('odds:requestsRemaining', '3') ON CONFLICT(key) DO UPDATE SET value = '3'").run();
  simularFetch(() => {
    throw new Error('no debería haber salido a la red');
  });
  const mensajes: string[] = [];
  const r = await captureClosingOdds((m) => mensajes.push(m), ahora);
  assert.deepEqual(r.frenadas, ['soccer_spain_la_liga']);
  assert.match(mensajes.join('\n'), /no se pudo observar soccer_spain_la_liga/);
});
