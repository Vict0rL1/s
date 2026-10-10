import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { incrementar, fijar, renderPrometheus, reiniciarMetricas, valorDe, grupoDeRuta } = await import('./metrics.ts');

test('contadores y medidores en formato Prometheus, con etiquetas escapadas y ordenadas', () => {
  reiniciarMetricas();
  incrementar('http_peticiones_total', { grupo: '/api/today', status: 200 }, 'peticiones');
  incrementar('http_peticiones_total', { grupo: '/api/today', status: 200 });
  incrementar('http_peticiones_total', { status: 500, grupo: '/api/x"y' });
  fijar('odds_api_peticiones_restantes', 480, {}, 'cuota');
  assert.equal(valorDe('http_peticiones_total', { status: 200, grupo: '/api/today' }), 2);
  const t = renderPrometheus();
  assert.match(t, /^# HELP http_peticiones_total peticiones\n# TYPE http_peticiones_total counter\n/);
  assert.match(t, /http_peticiones_total\{grupo="\/api\/today",status="200"\} 2\n/);
  assert.match(t, /http_peticiones_total\{grupo="\/api\/x\\"y",status="500"\} 1\n/);
  assert.match(t, /# TYPE odds_api_peticiones_restantes gauge\nodds_api_peticiones_restantes 480\n/);
  assert.ok(t.endsWith('\n'));
});

test('grupoDeRuta agrupa por el PATRÓN de la ruta, nunca por la URL cruda (B6)', () => {
  assert.equal(grupoDeRuta('/api/football/fixtures/:id', '/api/football/fixtures/123?x=1'), '/api/football');
  assert.equal(grupoDeRuta('/api/today', '/api/today'), '/api/today');
  assert.equal(grupoDeRuta('/api/ingestion-runs', '/api/ingestion-runs?limit=3'), '/api/ingestion-runs');
  assert.equal(grupoDeRuta('/docs/static/*', '/docs/static/x.js'), '/docs');
  assert.equal(grupoDeRuta('/healthz', '/healthz'), '/healthz');
  // Lo que cae en la comodín de la web construida y lo que no tiene ruta: una etiqueta fija
  // cada uno. Antes, /apuestas, /wp-admin y cada sondeo eran una etiqueta nueva en memoria.
  assert.equal(grupoDeRuta('/*', '/apuestas'), 'estatico');
  assert.equal(grupoDeRuta('/*', '/wp-admin/x.php'), 'estatico');
  assert.equal(grupoDeRuta(undefined, '/no/existe/123'), 'sin-ruta');
  assert.equal(grupoDeRuta(null, '/api/no-existe'), 'sin-ruta');
});
