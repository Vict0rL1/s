// The Odds API de mentira para pruebas que lanzan un proceso aparte (`npm run doctor`).
// Se carga con --import ANTES que la app: sustituye fetch y nunca sale a la red.
const cabeceras = { 'x-requests-remaining': '463', 'x-requests-used': '37', 'content-type': 'application/json' };
const EVENTO = {
  id: 'nba-1',
  sport_key: 'basketball_nba',
  commence_time: '2026-10-22T23:30:00Z',
  home_team: 'Boston Celtics',
  away_team: 'New York Knicks',
  bookmakers: [
    { key: 'pinnacle', title: 'Pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Boston Celtics', price: 1.6 }, { name: 'New York Knicks', price: 2.4 }] }] },
  ],
};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('127.0.0.1') || url.includes('localhost')) throw new TypeError('fetch failed');
  if (url.includes('/v4/sports/?')) {
    return new Response(JSON.stringify([{ key: 'basketball_nba', group: 'Basketball', active: true, has_outrights: false }]), { status: 200, headers: cabeceras });
  }
  if (url.includes('/v4/sports/basketball_nba/odds/')) return new Response(JSON.stringify([EVENTO]), { status: 200, headers: cabeceras });
  return new Response('[]', { status: 200, headers: cabeceras });
}) as typeof fetch;
