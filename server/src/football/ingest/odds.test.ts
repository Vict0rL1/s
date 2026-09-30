// La ingesta de fútbol de punta a punta, con The Odds API simulada: listado de ligas,
// una petición por liga, filas en fb_upcoming y la causa que se guarda para la pantalla.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simularFetch } from '../../test/setup.ts';

const { refreshFootballOdds } = await import('./odds.ts');
const { readOddsReason, readKeyOutcomes } = await import('../../oddsReason.ts');
const { getDb } = await import('../../db.ts');

const cabeceras = { 'x-requests-remaining': '480', 'x-requests-used': '20', 'content-type': 'application/json' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: cabeceras });

const SPORTS = [
  { key: 'soccer_epl', group: 'Soccer', title: 'EPL', active: true, has_outrights: false },
  { key: 'soccer_spain_la_liga', group: 'Soccer', title: 'La Liga', active: true, has_outrights: false },
];
// En el futuro para que la ventana de «hoy» no lo esconda.
const kickoff = new Date(Date.now() + 3 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const EVENTO = {
  id: 'epl-1',
  sport_key: 'soccer_epl',
  commence_time: kickoff,
  home_team: 'Arsenal',
  away_team: 'Chelsea',
  bookmakers: [
    {
      key: 'pinnacle',
      title: 'Pinnacle',
      markets: [{ key: 'h2h', outcomes: [{ name: 'Arsenal', price: 2.0 }, { name: 'Draw', price: 3.4 }, { name: 'Chelsea', price: 3.8 }] }],
    },
  ],
};

function api(porLiga: Record<string, () => Response>) {
  simularFetch((url) => {
    if (url.includes('/v4/sports/?')) return json(200, SPORTS);
    const key = /\/sports\/([^/]+)\/odds/.exec(url)?.[1] ?? '';
    const h = porLiga[key];
    if (!h) throw new Error(`petición inesperada: ${url}`);
    return h();
  });
}

test('EL FALLO QUE VISTE: 401 en una liga + otra vacía ya no se leen como «no hay partidos» a secas', async () => {
  api({
    soccer_epl: () => json(401, { message: 'API key is not valid', error_code: 'INVALID_KEY' }),
    soccer_spain_la_liga: () => json(200, []),
  });
  const r = await refreshFootballOdds(true);
  assert.equal(r.source, 'fixture', 'sin precios no puede marcarse como cuotas reales');
  const { reason, detail } = readOddsReason('fb_');
  assert.equal(reason, 'sin_eventos');
  assert.match(detail, /soccer_epl: .*401/, 'el 401 de la Premier tiene que llegar a la pantalla');
  const os = readKeyOutcomes('fb_');
  assert.deepEqual(
    os.map((o) => [o.key, o.ok, o.status, o.kind]),
    [
      ['soccer_epl', false, 401, 'clave_invalida'],
      ['soccer_spain_la_liga', true, 200, null],
    ],
  );
});

test('con precio: filas live con las tres cuotas, y sin causa guardada', async () => {
  api({ soccer_epl: () => json(200, [EVENTO]), soccer_spain_la_liga: () => json(200, []) });
  const r = await refreshFootballOdds(true);
  assert.equal(r.source, 'live');
  const fila = getDb().prepare("SELECT * FROM fb_upcoming WHERE id = 'epl-1'").get() as Record<string, unknown>;
  assert.equal(fila.source, 'live');
  assert.equal(fila.odds_home, 2.0);
  assert.equal(fila.odds_draw, 3.4);
  assert.equal(fila.odds_away, 3.8);
  assert.equal(readOddsReason('fb_').reason, null);
});

test('eventos SIN casas en la región no cuentan como cuotas reales', async () => {
  api({
    soccer_epl: () => json(200, [{ ...EVENTO, id: 'epl-2', bookmakers: [] }]),
    soccer_spain_la_liga: () => json(200, []),
  });
  const r = await refreshFootballOdds(true);
  assert.equal(r.source, 'fixture');
  const { reason, detail } = readOddsReason('fb_');
  assert.equal(reason, 'sin_eventos');
  assert.match(detail, /soccer_epl=1 eventos \(0 con precio, 0 casas\)/);
});
