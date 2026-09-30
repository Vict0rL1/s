import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simularFetch } from './test/setup.ts';

const { classifyFailure, requestOdds, aggregateH2H, summarizeEvents, OddsApiError, outcomeOk, outcomeError } =
  await import('./oddsApi.ts');
const { decideReason } = await import('./oddsReason.ts');

/** Una respuesta como las de la API v4, con sus cabeceras de cupo. */
function respuesta(status: number, body: unknown, remaining = '480'): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'x-requests-remaining': remaining, 'x-requests-used': '20', 'content-type': 'application/json' },
  });
}

const EVENTO = {
  id: 'ev1',
  sport_key: 'soccer_epl',
  commence_time: '2026-10-03T14:00:00Z',
  home_team: 'Arsenal',
  away_team: 'Chelsea',
  bookmakers: [
    {
      key: 'pinnacle',
      title: 'Pinnacle',
      last_update: '2026-10-01T10:00:00Z',
      markets: [{ key: 'h2h', outcomes: [{ name: 'Arsenal', price: 2.0 }, { name: 'Draw', price: 3.4 }, { name: 'Chelsea', price: 3.8 }] }],
    },
    {
      key: 'bet365',
      title: 'Bet365',
      last_update: '2026-10-01T11:00:00Z',
      markets: [{ key: 'h2h', outcomes: [{ name: 'Arsenal', price: 2.1 }, { name: 'Draw', price: 3.3 }, { name: 'Chelsea', price: 3.6 }] }],
    },
  ],
};

test('clasifica cada código de la API v4 con su causa', () => {
  assert.equal(classifyFailure(401, '{"message":"x","error_code":"INVALID_KEY"}').kind, 'clave_invalida');
  assert.equal(classifyFailure(401, '{"error_code":"OUT_OF_USAGE_CREDITS"}').kind, 'sin_creditos');
  assert.equal(classifyFailure(429, '{"error_code":"EXCEEDED_FREQ_LIMIT"}').kind, 'limite_ritmo');
  assert.equal(classifyFailure(404, '{"error_code":"UNKNOWN_SPORT"}').kind, 'deporte_desconocido');
  assert.equal(classifyFailure(422, '{"error_code":"INVALID_REGION"}').kind, 'parametros_invalidos');
  assert.equal(classifyFailure(503, '').kind, 'error_proveedor');
  // El código del proveedor viaja en el mensaje: es lo que se busca en su documentación.
  assert.match(classifyFailure(401, '{"error_code":"INVALID_KEY"}').message, /INVALID_KEY/);
});

test('una respuesta 200 devuelve los eventos y deja la petición bien formada', async () => {
  let pedida = '';
  simularFetch((url) => {
    pedida = url;
    return respuesta(200, [EVENTO]);
  });
  const r = await requestOdds('soccer_epl', { manual: true });
  assert.equal(r.events.length, 1);
  assert.equal(r.malformed, 0);
  assert.match(pedida, /\/v4\/sports\/soccer_epl\/odds\/\?apiKey=/);
  assert.match(pedida, /regions=eu/);
  assert.match(pedida, /markets=h2h/);
  assert.match(pedida, /oddsFormat=decimal/);
});

// TEST NEGATIVO: el fallo que existía. 404 y 422 se convertían en «no hay partidos».
for (const [status, kind] of [
  [404, 'deporte_desconocido'],
  [422, 'parametros_invalidos'],
  [401, 'clave_invalida'],
  [429, 'limite_ritmo'],
] as const) {
  test(`un HTTP ${status} LANZA ${kind}, nunca devuelve lista vacía`, async () => {
    simularFetch(() => respuesta(status, { error_code: 'X' }));
    await assert.rejects(
      () => requestOdds('soccer_epl', { manual: true }),
      (e: unknown) => e instanceof OddsApiError && e.kind === kind && e.status === status,
    );
  });
}

test('sin red es `sin_red`, no un 500 ni un vacío', async () => {
  simularFetch(() => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(
    () => requestOdds('soccer_epl', { manual: true }),
    (e: unknown) => e instanceof OddsApiError && e.kind === 'sin_red',
  );
});

test('algo que no es una lista es `respuesta_invalida`', async () => {
  simularFetch(() => respuesta(200, { message: 'mantenimiento' }));
  await assert.rejects(
    () => requestOdds('soccer_epl', { manual: true }),
    (e: unknown) => e instanceof OddsApiError && e.kind === 'respuesta_invalida',
  );
});

test('los eventos mal formados se cuentan, no se inventan', async () => {
  simularFetch(() => respuesta(200, [EVENTO, { id: 'roto' }, { id: 'x', commence_time: 'no es fecha', bookmakers: [] }]));
  const r = await requestOdds('soccer_epl', { manual: true });
  assert.equal(r.events.length, 1);
  assert.equal(r.malformed, 2);
});

test('el cupo de las cabeceras se guarda en cada respuesta', async () => {
  simularFetch(() => respuesta(200, [], '463'));
  await requestOdds('soccer_epl', { manual: true });
  const { getQuota } = await import('./oddsQuota.ts');
  assert.equal(getQuota().remaining, 463);
});

test('agregación h2h: mediana por resultado, casas con mercado y marca más nueva', () => {
  const a = aggregateH2H(EVENTO);
  assert.ok(Math.abs(a.price.Arsenal - 2.05) < 1e-9);
  assert.ok(Math.abs(a.price.Draw - 3.35) < 1e-9);
  assert.equal(a.books, 2);
  assert.equal(a.sourceUpdatedAt, '2026-10-01T11:00:00.000Z');
});

test('resumen: eventos, con precio, casas y mercados', () => {
  const sinCasas = { ...EVENTO, id: 'ev2', bookmakers: [] };
  const s = summarizeEvents([EVENTO, sinCasas]);
  assert.deepEqual(s, { eventos: 2, conPrecio: 1, casas: ['bet365', 'pinnacle'], mercados: ['h2h'] });
});

// ---------------------------------------------------------------------------
// La causa que se enseña
// ---------------------------------------------------------------------------
const okVacio = (key: string) =>
  outcomeOk(key, { events: [], credits: 1, fetchedAt: '2026-10-01T00:00:00Z', malformed: 0 });

test('EL FALLO QUE HABÍA: una liga con 401 y otra vacía ya no esconden el 401', () => {
  const err = new OddsApiError('clave_invalida', 'soccer_epl: The Odds API rechazó la clave (HTTP 401).', 401);
  const d = decideReason([outcomeError('soccer_epl', err), okVacio('soccer_spain_la_liga')], 0);
  assert.equal(d.reason, 'sin_eventos');
  assert.match(d.detail, /401/, 'el detalle tiene que conservar el error de la otra liga');
});

test('todas las ligas fallan → fuente_falla con el error de cada una', () => {
  const e1 = new OddsApiError('sin_creditos', 'créditos agotados (HTTP 401)', 401);
  const d = decideReason([outcomeError('soccer_epl', e1), outcomeError('soccer_efl_champ', e1)], 0);
  assert.equal(d.reason, 'fuente_falla');
  assert.match(d.detail, /soccer_epl: créditos agotados/);
});

test('todo frenado por presupuesto → presupuesto', () => {
  const d = decideReason([outcomeError('soccer_epl', new Error('ritmo del mes'), true)], 0);
  assert.equal(d.reason, 'presupuesto');
});

test('eventos sin casas → sin_eventos que dice cuántos eventos y casas vinieron', () => {
  const o = outcomeOk('soccer_epl', {
    events: [{ ...EVENTO, bookmakers: [] }],
    credits: 1,
    fetchedAt: '2026-10-01T00:00:00Z',
    malformed: 0,
  });
  const d = decideReason([o], 0);
  assert.equal(d.reason, 'sin_eventos');
  assert.match(d.detail, /soccer_epl=1 eventos \(0 con precio, 0 casas\)/);
});

test('con precio no hay causa', () => {
  assert.equal(decideReason([okVacio('soccer_epl')], 3).reason, null);
});
