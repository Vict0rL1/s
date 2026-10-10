// Contrato de la API (Fase 3.3): la especificación lista cada ruta registrada, y las rutas
// con esquema de respuesta responden algo que lo cumple. Si una respuesta cambia de forma,
// esto falla antes de que lo descubra la pantalla.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { buildApp } = await import('../app.ts');
const { configAuth } = await import('../auth/mode.ts');
const { LimiteDeIntentos } = await import('../auth/rateLimit.ts');
const { validar, ESQUEMA_HEALTH, ESQUEMA_READY, ESQUEMA_FEATURES, ESQUEMA_DATOS_ESTADO, ESQUEMA_INGESTION_RUNS, ESQUEMA_SCHEDULER, ESQUEMA_POLICY, ESQUEMA_CANALES, ESQUEMA_EXPORT_JSON, ESQUEMA_FIABILIDAD, ESQUEMA_SEGMENTOS, ESQUEMA_MONITORIZACION, ESQUEMA_SIMULACION, ESQUEMA_TORNEO, ESQUEMA_COMBINADA, ESQUEMA_INTEL, ESQUEMA_ESTADO, ESQUEMA_ERRORES, ESQUEMA_AJUSTES, ESQUEMA_WATCHLIST, ESQUEMA_HISTORIA_ELO, ESQUEMA_HISTORIAL_SIMULACION, ESQUEMA_BUSQUEDA, ESQUEMA_CUOTAS_POR_CASA, ESQUEMA_ESTRATEGIAS, ESQUEMA_ESTRATEGIA, ESQUEMA_HISTORICO_ESTRATEGIA, ESQUEMA_APUESTAS_ESTRATEGIA, ESQUEMA_BANDEJA, ESQUEMA_CONTADOR_BANDEJA, ESQUEMA_MARCADAS, ESQUEMA_INFORMES, ESQUEMA_INFORME, ESQUEMA_INFORME_GENERADO, ESQUEMA_LINEAS, ESQUEMA_ARCHIVO, ESQUEMA_RENDIMIENTO, ESQUEMA_NHL_BACKTEST, ESQUEMA_UFC_BACKTEST } = await import('./schemas.ts');
const { reiniciarRegistro, registrar, arrancar, parar } = await import('../scheduler/registry.ts');

const rutas: { method: string | string[]; url: string }[] = [];
const e = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;
const app = await buildApp({ auth: { config: configAuth(e), limite: new LimiteDeIntentos() }, servirWeb: false, logger: false, entorno: e, onRoute: (r) => rutas.push(r) });
await app.ready();

test('validar: tipos, required, nullable, items y enum', () => {
  assert.deepEqual(validar({ ok: true }, ESQUEMA_HEALTH), []);
  assert.match(validar({ ok: 'sí' }, ESQUEMA_HEALTH).join(), /es string, se esperaba boolean/);
  assert.match(validar({}, ESQUEMA_HEALTH).join(), /\$\.ok: falta/);
  assert.match(validar({ ok: true, extra: 1 }, ESQUEMA_HEALTH).join(), /no prevista/);
  assert.deepEqual(validar({ layout: 'split', history: { ruta: 'x', mb: null }, ledger: null, backup: {}, retencion: { ultima: null, borradas: 0 } }, ESQUEMA_DATOS_ESTADO), []);
  assert.match(validar({ layout: 'otro', history: { ruta: 'x', mb: 1 }, ledger: null, backup: {}, retencion: { ultima: null, borradas: 0 } }, ESQUEMA_DATOS_ESTADO).join(), /no está en/);
});

test('la especificación OpenAPI lista todas las rutas registradas (salvo las del propio visor)', async () => {
  const res = await app.inject({ method: 'GET', url: '/openapi.json' });
  assert.equal(res.statusCode, 200);
  const spec = res.json() as { openapi: string; paths: Record<string, Record<string, unknown>> };
  assert.match(spec.openapi, /^3\./);
  const enSpec = new Set<string>();
  const sinBarra = (p: string) => (p.length > 1 ? p.replace(/\/$/, '') : p);
  for (const [p, metodos] of Object.entries(spec.paths)) for (const m of Object.keys(metodos)) enSpec.add(`${m.toUpperCase()} ${sinBarra(p)}`);
  const faltan: string[] = [];
  for (const r of rutas) {
    if (r.url.startsWith('/docs')) continue;
    const metodos = (Array.isArray(r.method) ? r.method : [r.method]).filter((m) => m !== 'HEAD' && m !== 'OPTIONS');
    const url = sinBarra(r.url.replace(/:([a-zA-Z_]+)/g, '{$1}').replace(/\*$/, '{*}'));
    for (const m of metodos) if (!enSpec.has(`${m} ${url}`)) faltan.push(`${m} ${url}`);
  }
  assert.deepEqual(faltan, [], 'rutas fuera de la especificación');
  assert.ok(Object.keys(spec.paths).length > 60, `${Object.keys(spec.paths).length} rutas documentadas`);
});

test('cada ruta con esquema responde algo que lo cumple', async () => {
  reiniciarRegistro();
  registrar({ nombre: 'contrato', descripcion: 'de prueba', cadenciaMin: 0, primeraEnMin: 0, fn: () => {} });
  arrancar();
  const casos: [string, unknown][] = [
    ['/health', ESQUEMA_HEALTH],
    ['/ready', ESQUEMA_READY],
    ['/api/features', ESQUEMA_FEATURES],
    ['/api/datos/estado', ESQUEMA_DATOS_ESTADO],
    ['/api/ingestion-runs', ESQUEMA_INGESTION_RUNS],
    ['/api/scheduler', ESQUEMA_SCHEDULER],
    ['/api/policy', ESQUEMA_POLICY],
    ['/api/notifications/canales', ESQUEMA_CANALES],
    ['/api/export/papel?formato=json', ESQUEMA_EXPORT_JSON],
    ['/api/evaluation/reliability?sport=nfl', ESQUEMA_FIABILIDAD],
    ['/api/evaluation/segmentos?sport=nfl', ESQUEMA_SEGMENTOS],
    ['/api/monitoring?sport=nfl', ESQUEMA_MONITORIZACION],
    ['/api/simulation/season/football/epl', ESQUEMA_SIMULACION],
    ['/api/simulation/torneo', ESQUEMA_TORNEO],
    ['/api/odds/intel', ESQUEMA_INTEL],
    ['/api/estado', ESQUEMA_ESTADO],
    ['/api/errores', ESQUEMA_ERRORES],
    ['/api/ajustes', ESQUEMA_AJUSTES],
    ['/api/watchlist', ESQUEMA_WATCHLIST],
    ['/api/elo/historia/football/epl/arsenal', ESQUEMA_HISTORIA_ELO],
    ['/api/simulation/season/football/epl/historial', ESQUEMA_HISTORIAL_SIMULACION],
    ['/api/buscar?q=ars', ESQUEMA_BUSQUEDA],
    ['/api/odds/casas/no-existe', ESQUEMA_CUOTAS_POR_CASA],
    ['/api/estrategias', ESQUEMA_ESTRATEGIAS],
    ['/api/estrategias/historico?sport=nfl', ESQUEMA_HISTORICO_ESTRATEGIA],
    ['/api/bandeja', ESQUEMA_BANDEJA],
    ['/api/bandeja/contador', ESQUEMA_CONTADOR_BANDEJA],
    ['/api/informes', ESQUEMA_INFORMES],
    ['/api/odds/lineas', ESQUEMA_LINEAS],
    ['/api/odds/lineas?sport=nfl&market=h2h', ESQUEMA_LINEAS],
    ['/api/archivo', ESQUEMA_ARCHIVO],
    ['/api/rendimiento', ESQUEMA_RENDIMIENTO],
    ['/api/archivo?sport=nfl&confianza=ALTA&banda=60–75 %&resultado=acierto&desde=2026-01-01&pagina=2', ESQUEMA_ARCHIVO],
  ];
  for (const [url, esquema] of casos) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, `${url} → ${res.statusCode} ${res.body.slice(0, 120)}`);
    assert.deepEqual(validar(res.json(), esquema as never), [], url);
  }
  // La NHL publicada: la evaluación del backtest con la que se publicó; sin partidos, sin métricas inventadas.
  const nhl = await app.inject({ method: 'GET', url: '/api/nhl/backtest' });
  assert.equal(nhl.statusCode, 200, nhl.body);
  assert.deepEqual(validar(nhl.json(), ESQUEMA_NHL_BACKTEST), [], '/api/nhl/backtest');
  assert.equal((nhl.json() as { modelo: unknown }).modelo, null, 'sin partidos no hay métricas inventadas');
  // La UFC publicada: lo mismo, sin interruptor; sin peleas, ni métricas ni prueba inventadas.
  const ufc = await app.inject({ method: 'GET', url: '/api/ufc/backtest' });
  assert.equal(ufc.statusCode, 200, ufc.body);
  assert.deepEqual(validar(ufc.json(), ESQUEMA_UFC_BACKTEST), [], '/api/ufc/backtest');
  assert.equal((ufc.json() as { modelo: unknown; prueba: unknown }).modelo, null);
  assert.equal((ufc.json() as { prueba: unknown }).prueba, null);
  const parlay = await app.inject({ method: 'POST', url: '/api/picks/parlay', payload: { patas: [{ sport: 'football', matchKey: 'a', cuando: '2026-10-10T15:00:00Z', p: 0.5, cuota: 2 }, { sport: 'football', matchKey: 'b', cuando: '2026-10-11T15:00:00Z', p: 0.4 }] } });
  assert.equal(parlay.statusCode, 200, parlay.body);
  assert.deepEqual(validar(parlay.json(), ESQUEMA_COMBINADA), [], '/api/picks/parlay');
  const malo = await app.inject({ method: 'POST', url: '/api/picks/parlay', payload: { patas: [] } });
  assert.equal(malo.statusCode, 400);
  // Ajustes, interruptores y seguimiento: escribir y leer, con lo inválido rechazado.
  const aj = await app.inject({ method: 'PUT', url: '/api/ajustes', payload: { tema: 'claro', deportesOcultos: ['tennis'] } });
  assert.equal(aj.statusCode, 200, aj.body);
  assert.equal((aj.json() as { ajustes: { tema: string } }).ajustes.tema, 'claro');
  assert.equal((await app.inject({ method: 'PUT', url: '/api/ajustes', payload: { tema: 'rosa' } })).statusCode, 400);
  const ff = await app.inject({ method: 'PATCH', url: '/api/features/api.docs', payload: { on: false } });
  assert.equal(ff.statusCode, 200, ff.body);
  const feats = (await app.inject({ method: 'GET', url: '/api/features' })).json() as { features: Record<string, { on: boolean; anulada: boolean }> };
  assert.equal(feats.features['api.docs'].on, false);
  assert.equal(feats.features['api.docs'].anulada, true);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/features/api.docs', payload: { on: null } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/features/no.existe', payload: { on: true } })).statusCode, 404);
  const w = await app.inject({ method: 'POST', url: '/api/watchlist', payload: { kind: 'equipo', sport: 'football', league: 'epl', ref_id: 'arsenal', label: 'Arsenal' } });
  assert.equal(w.statusCode, 200, w.body);
  assert.equal((await app.inject({ method: 'GET', url: '/api/watchlist' })).json().seguidos.length, 1);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/watchlist/${(w.json() as { id: number }).id}` })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/resultado/nfl/no-existe' })).statusCode, 404);
  const svg = await app.inject({ method: 'POST', url: '/api/picks/tarjeta.svg', payload: { patas: [{ sport: 'football', matchKey: 'a', cuando: '2026-10-10T15:00:00Z', p: 0.5, cuota: 2, seleccion: 'Arsenal' }] } });
  assert.equal(svg.statusCode, 200, svg.body);
  assert.match(svg.headers['content-type'] as string, /svg/);
  assert.match(svg.body, /Arsenal/);
  const imp = await app.inject({ method: 'POST', url: '/api/bets/import', payload: { csv: 'sport,event,market,selection,odds,stake,tags\nnfl,Jets @ Bills,moneyline,Bills,1.8,10,prueba|otra\nnfl,,moneyline,x,1.8,10,' } });
  assert.equal(imp.statusCode, 200, imp.body);
  assert.deepEqual([imp.json().importadas, imp.json().rechazadas.length], [1, 1]);
  const sug = await app.inject({ method: 'GET', url: '/api/bets/sugerencia?odds=2.1&prob=0.55' });
  assert.equal(sug.statusCode, 200);
  assert.ok((sug.json() as { fraccion: number }).fraccion > 0);
  // Laboratorio de estrategias (Fase 6.1): crear, listar sus apuestas, vista previa y archivar.
  const est = await app.inject({ method: 'POST', url: '/api/estrategias', payload: { nombre: 'Contrato', deportes: ['nfl'], staking: { minEdge: 0.04 } } });
  assert.equal(est.statusCode, 200, est.body);
  assert.deepEqual(validar(est.json(), ESQUEMA_ESTRATEGIA), [], 'POST /api/estrategias');
  const idEst = (est.json() as { id: number }).id;
  assert.equal((await app.inject({ method: 'POST', url: '/api/estrategias', payload: { nombre: 'Mala', staking: { kellyFraction: 1 } } })).statusCode, 400);
  const apE = await app.inject({ method: 'GET', url: `/api/estrategias/${idEst}/apuestas` });
  assert.deepEqual(validar(apE.json(), ESQUEMA_APUESTAS_ESTRATEGIA), [], 'apuestas de una estrategia');
  const prev = await app.inject({ method: 'POST', url: '/api/estrategias/historico', payload: { sport: 'nfl', staking: { minEdge: 0.05 }, calibracion: false } });
  assert.equal(prev.statusCode, 200, prev.body);
  assert.deepEqual(validar(prev.json(), ESQUEMA_HISTORICO_ESTRATEGIA), [], 'POST /api/estrategias/historico');
  assert.equal((await app.inject({ method: 'GET', url: '/api/estrategias/historico?sport=basketball' })).statusCode, 400, 'sin cuotas históricas');
  assert.equal((await app.inject({ method: 'GET', url: `/api/estrategias/historico?sport=football&id=${idEst}` })).statusCode, 400, 'la estrategia no apuesta fútbol');
  assert.equal((await app.inject({ method: 'POST', url: `/api/estrategias/${idEst}/archivar` })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/estrategias/${idEst}/archivar` })).statusCode, 400);
  // Informes y bandeja (Fase 6.4 y 6.7–6.9): generar el del día, leerlo, su PDF y el aviso.
  const gen = await app.inject({ method: 'POST', url: '/api/informes/generar', payload: { tipo: 'diario' } });
  assert.equal(gen.statusCode, 200, gen.body);
  assert.deepEqual(validar(gen.json(), ESQUEMA_INFORME_GENERADO), [], 'POST /api/informes/generar');
  const idInf = (gen.json() as { id: number }).id;
  assert.equal((await app.inject({ method: 'POST', url: '/api/informes/generar', payload: { tipo: 'diario' } })).json().nuevo, false);
  const inf = await app.inject({ method: 'GET', url: `/api/informes/${idInf}` });
  assert.deepEqual(validar(inf.json(), ESQUEMA_INFORME), [], 'GET /api/informes/:id');
  const pdf = await app.inject({ method: 'GET', url: `/api/informes/${idInf}/pdf` });
  assert.equal(pdf.statusCode, 200);
  assert.match(pdf.headers['content-type'] as string, /application\/pdf/);
  assert.ok(pdf.rawPayload.subarray(0, 8).toString('latin1').startsWith('%PDF-1.4'));
  assert.equal((await app.inject({ method: 'GET', url: '/api/informes/999999' })).statusCode, 404);
  const band = (await app.inject({ method: 'GET', url: '/api/bandeja?leida=0' })).json() as { avisos: { id: number; tipo: string }[] };
  assert.ok(band.avisos.some((a) => a.tipo === 'digest_listo'), 'el resumen avisa en la bandeja');
  const mar = await app.inject({ method: 'POST', url: '/api/bandeja/marcar', payload: { todas: true, leida: true } });
  assert.deepEqual(validar(mar.json(), ESQUEMA_MARCADAS), [], 'POST /api/bandeja/marcar');
  assert.equal((mar.json() as { noLeidas: number }).noLeidas, 0);
  assert.equal((await app.inject({ method: 'POST', url: '/api/bandeja/marcar', payload: { leida: true } })).statusCode, 400);
  const cad = await app.inject({ method: 'PATCH', url: '/api/scheduler/contrato', payload: { cadenciaMin: 30 } });
  assert.equal(cad.statusCode, 200, cad.body);
  assert.equal((cad.json() as { cadenciaMin: number; cadenciaPorDefecto: number }).cadenciaMin, 30);
  assert.equal((cad.json() as { cadenciaPorDefecto: number }).cadenciaPorDefecto, 0);
  parar();
  const r = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(r.statusCode, 503, 'sin el registro de trabajos, no está listo');
  await app.close();
});
