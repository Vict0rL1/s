// La UFC publicada: nombres de las casas a luchadores (sin parecidos), la cartelera de la UFC sin
// adivinar (otras organizaciones fuera, el debutante sin número), el orden canónico aunque la casa dé
// la vuelta, la predicción explicable y simétrica, el registro de escritura única, el resultado desde
// cualquier orden del archivo, la liquidación del banco (empate devuelto, «sin resultado» anulado),
// la reconstrucción y las rutas. Nada sale a la red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { normalizarNombre, resolverLuchador, olvidarIndice } = await import('./luchadores.ts');
const { agregarEvento, filtrarUfc, guardarPeleas } = await import('./proximos.ts');
const { guardarArchivo } = await import('./ingest.ts');
const { listUpcoming, getPowerRanking, olvidarEstado } = await import('./repo.ts');
const { buildPrediction } = await import('./predict.ts');
const { matchKey, logUfcPrediction, resolveUfcPredictions, getUfcTrackRecord, fechaUfc } = await import('./trackRecord.ts');
const { getDb, MIGRACIONES } = await import('../db.ts');
const { findGameResult } = await import('../results.ts');
const { candidatasPapel, liquidador } = await import('../paper/bankroll.ts');
const { reconstruirDesde } = await import('../recent/reconstruct.ts');
const { buildApp } = await import('../app.ts');
const { configAuth } = await import('../auth/mode.ts');
const { LimiteDeIntentos } = await import('../auth/rateLimit.ts');
type Archivo = import('./ingest.ts').Archivo;
type UfcUpcomingRow = import('./repo.ts').UfcUpcomingRow;
type EventoMma = import('./proximos.ts').EventoMma;

const AHORA = new Date();
const dia = (d: number) => new Date(AHORA.getTime() + d * 86_400_000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

// Ocho luchadores (ids de ufcstats: hexadecimales). Dos «Bruno Silva»: el nombre es ambiguo.
const L = {
  pereira: { id: '00000000000000a1', nombre: 'Alex Pereira', nac: '1993-07-07', alc: 200 },
  hill: { id: '00000000000000a2', nombre: 'Jamahal Hill', nac: '1991-05-19', alc: 201 },
  aldo: { id: '00000000000000a3', nombre: 'José Aldo', nac: '1986-09-09', alc: 179 },
  silva1: { id: '00000000000000a4', nombre: 'Bruno Silva', nac: '1990-03-16', alc: 188 },
  silva2: { id: '00000000000000a5', nombre: 'Bruno Silva', nac: '1989-07-13', alc: 165 },
  rountree: { id: '00000000000000a6', nombre: 'Khalil Rountree Jr.', nac: '1990-02-26', alc: 194 },
  erceg: { id: '00000000000000a7', nombre: 'Steve Erceg', nac: '1995-08-31', alc: 173 },
  pantoja: { id: '00000000000000a8', nombre: 'Alexandre Pantoja', nac: '1990-04-16', alc: 170 },
} as const;
const ACTIVOS = [L.pereira, L.hill, L.aldo, L.rountree, L.erceg, L.pantoja];

/** Un archivo de cinco años: peleas entre los seis activos, ganando más el más fuerte (el orden de ACTIVOS). */
function archivo(n: number): Archivo {
  const eventos: Archivo['eventos'] = [];
  const peleas: Archivo['peleas'] = [];
  let semilla = 3;
  const rnd = () => ((semilla = (semilla * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    const fecha = ymd(dia(-1800 + Math.floor((i * 1780) / n)));
    const ev = `e${String(i).padStart(14, '0')}`;
    eventos.push({ id: ev, nombre: `UFC ${i}`, fecha, lugar: null });
    const x = Math.floor(rnd() * ACTIVOS.length);
    const z = (x + 1 + Math.floor(rnd() * (ACTIVOS.length - 1))) % ACTIVOS.length;
    const ganaX = rnd() < (x < z ? 0.7 : 0.3);
    const [a, b] = [ACTIVOS[x], ACTIVOS[z]];
    peleas.push({ id: `f${String(i).padStart(15, '0')}`, evento_id: ev, fecha, orden: 0, luchador_a: a.id, luchador_b: b.id, nombre_a: a.nombre, nombre_b: b.nombre, resultado: ganaX ? 'A' : 'B', categoria: 'Light Heavyweight Bout', metodo: i % 3 ? 'KO/TKO' : 'Decision - Unanimous', asalto: 1 + (i % 3), tiempo: '1:00', ambigua: false });
  }
  const luchadores = Object.values(L).map((f) => ({ id: f.id, nombre: f.nombre, apodo: null, altura_cm: 180, alcance_cm: f.alc, guardia: 'Orthodox', nacimiento: f.nac, ambiguo: f.nombre === 'Bruno Silva' }));
  return { eventos, luchadores, peleas, descartadas: { sinFecha: 0, ilegibles: 0 } };
}

function cargar(n = 900): void {
  guardarArchivo(archivo(n));
  olvidarIndice();
  olvidarEstado();
}

test('migraciones 18 y 19: próximas en la historia, el registro en el libro mayor', () => {
  assert.equal(MIGRACIONES.find((m) => m.version === 18)?.destino, 'history');
  assert.equal(MIGRACIONES.find((m) => m.version === 19)?.destino, 'ledger');
});

test('nombres de las casas → luchadores: exactos tras normalizar, nunca por parecido, y los ambiguos sin id', () => {
  cargar();
  assert.equal(normalizarNombre('José Aldo Jr.'), 'jose aldo');
  assert.equal(normalizarNombre("Sean O'Malley"), 'sean omalley');
  assert.deepEqual(resolverLuchador('Jose Aldo'), { id: L.aldo.id }, 'sin tilde');
  assert.deepEqual(resolverLuchador('Khalil Rountree'), { id: L.rountree.id }, 'sin el «Jr.»');
  assert.deepEqual(resolverLuchador('ALEX PEREIRA'), { id: L.pereira.id });
  assert.deepEqual(resolverLuchador('Bruno Silva'), { id: null, motivo: 'ambiguo' }, 'dos con el mismo nombre: no se elige');
  assert.deepEqual(resolverLuchador('Alex Perei'), { id: null, motivo: 'desconocido' }, 'nada de parecidos');
  assert.deepEqual(resolverLuchador('Nadie Conocido'), { id: null, motivo: 'desconocido' });
});

test('cuotas de un evento: mediana entre casas', () => {
  const casa = (a: number, b: number) => ({ markets: [{ key: 'h2h', outcomes: [{ name: 'Alex Pereira', price: a }, { name: 'Jamahal Hill', price: b }] }] });
  const ev = agregarEvento({ id: 'x', commence_time: '2026-10-10T23:00:00Z', home_team: 'Alex Pereira', away_team: 'Jamahal Hill', bookmakers: [casa(1.5, 2.6), casa(1.6, 2.4), casa(1.55, 2.5)] });
  assert.equal(ev.price['Alex Pereira'], 1.55);
  assert.equal(ev.price['Jamahal Hill'], 2.5);
  assert.equal(ev.books, 3);
  // Con dos casas la mediana es una media: redondeada, sin el 1,9049999… de la coma flotante.
  const dos = agregarEvento({ id: 'y', commence_time: '2026-10-10T23:00:00Z', home_team: 'Alex Pereira', away_team: 'Jamahal Hill', bookmakers: [casa(1.91, 2.0), casa(1.9, 2.1)] });
  assert.equal(dos.price['Alex Pereira'], 1.905);
});

test('cartelera: solo la UFC (por los luchadores conocidos alrededor), el debutante sin id, y A siempre el de id menor', () => {
  cargar();
  const t = dia(3).getTime();
  const ev = (id: string, horas: number, uno: string, otro: string, pUno = 1.8, pOtro = 2.0): EventoMma => ({ id, commence_time: new Date(t + horas * 3_600_000).toISOString(), uno, otro, price: { [uno]: pUno, [otro]: pOtro }, books: 4 });
  const f = filtrarUfc([
    // La cartelera: tres peleas entre conocidos en cinco horas…
    ev('c1', 0, 'Jamahal Hill', 'Alex Pereira', 2.6, 1.5),
    ev('c2', 1, 'José Aldo', 'Steve Erceg'),
    ev('c3', 4, 'Alexandre Pantoja', 'Khalil Rountree'),
    // …y un debut en la misma cartelera.
    ev('c4', 2, 'Alex Pereira', 'Debutante Nuevo'),
    // Otra organización, otro día: nadie de la UFC.
    ev('p1', 72, 'Luchador Pfl', 'Otro Pfl'),
    // Dos ex de la UFC en otra organización, solos ese día: no hay cartelera de la UFC alrededor.
    ev('p2', 96, 'José Aldo', 'Alexandre Pantoja'),
  ]);
  assert.deepEqual(f.peleas.map((p) => p.id).sort(), ['odds-c1', 'odds-c2', 'odds-c3', 'odds-c4']);
  assert.equal(f.descartadas, 2);
  assert.equal(f.sinIdentificar, 1);
  const c1 = f.peleas.find((p) => p.id === 'odds-c1')!;
  // La casa puso primero a Hill (a2); A es Pereira (a1), y las cuotas van con su luchador.
  assert.deepEqual([c1.home_id, c1.away_id, c1.home_name, c1.odds_home, c1.odds_away], [L.pereira.id, L.hill.id, 'Alex Pereira', 1.5, 2.6]);
  const c4 = f.peleas.find((p) => p.id === 'odds-c4')!;
  assert.equal(c4.away_id, null, 'el debutante no se identifica: sin id, sin predicción');
  getDb().exec('DELETE FROM ufc_upcoming');
  assert.equal(guardarPeleas(f.peleas, AHORA), 4);
  assert.equal(listUpcoming().length, 4);
});

test('la predicción: suma 1, es simétrica, los aportes suman el logit y el récord cuadra', () => {
  cargar();
  const p = buildPrediction({ homeId: L.pereira.id, awayId: L.hill.id, oddsHome: 1.5, oddsAway: 2.6 })!;
  assert.ok(Math.abs(p.model.home + p.model.away - 1) < 1e-9);
  assert.deepEqual(p.final, p.model, 'sin post-proceso medido, lo publicado es el modelo');
  assert.ok(p.model.home > 0.5, `el más fuerte del archivo es favorito: ${p.model.home}`);
  const girada = buildPrediction({ homeId: L.hill.id, awayId: L.pereira.id })!;
  assert.ok(Math.abs(girada.model.home - p.model.away) < 1e-4, 'dar la vuelta a los dos da la vuelta a la probabilidad');
  const suma = p.factors.reduce((s, f) => s + f.logit, 0);
  assert.ok(Math.abs(suma - Math.log(p.model.home / p.model.away)) < 2e-3);
  assert.deepEqual(p.factors.map((f) => f.key), ['elo', 'record', 'edad', 'alcance', 'experiencia']);
  assert.ok(p.factors.find((f) => f.key === 'edad')!.diff! < 0, 'Pereira es más joven que Hill: diferencia negativa');
  for (const f of [p.fighters.home, p.fighters.away]) assert.equal(f.record.wins + f.record.losses + f.record.draws + f.record.noContests, f.fightsInDb);
  assert.ok(p.market.market && Math.abs(p.market.market.home + p.market.market.away - 1) < 1e-9);
  assert.equal(buildPrediction({ homeId: L.pereira.id, awayId: L.pereira.id }), null, 'contra sí mismo, nada');
  assert.equal(buildPrediction({ homeId: L.pereira.id, awayId: 'ffffffffffffffff' }), null);
  assert.ok(getPowerRanking(10).length >= 5);
});

test('registro: la primera predicción manda, el puntero sigue a la pelea y el resultado llega del archivo en cualquier orden', () => {
  cargar();
  const d = getDb();
  const cuando = dia(1).toISOString();
  const fila = (id: string, oddsA: number | null): UfcUpcomingRow => ({
    id, league: 'ufc', commence_time: cuando, home_name: 'Alex Pereira', away_name: 'Jamahal Hill', home_id: L.pereira.id, away_id: L.hill.id,
    odds_home: oddsA, odds_away: oddsA ? 2.6 : null, books: 4, source: 'live', updated_at: AHORA.toISOString(),
  });
  const primera = fila('odds-uno', 1.5);
  const otra = fila('odds-dos', 1.45);
  assert.equal(matchKey(primera), `ufc|${fechaUfc(cuando)}|${L.pereira.id}|${L.hill.id}`);
  assert.equal(matchKey(primera), matchKey(otra), 'la misma pelea con otro id de la casa: la misma clave');
  d.prepare("INSERT OR REPLACE INTO ufc_upcoming (id, commence_time, home_name, away_name, home_id, away_id, odds_home, odds_away, books, source, updated_at) VALUES ('odds-uno', ?, 'Alex Pereira', 'Jamahal Hill', ?, ?, 1.5, 2.6, 4, 'live', ?)").run(cuando, L.pereira.id, L.hill.id, AHORA.toISOString());
  logUfcPrediction(primera, buildPrediction({ homeId: L.pereira.id, awayId: L.hill.id, oddsHome: 1.5, oddsAway: 2.6 })!);
  const antes = d.prepare('SELECT prob_home, market_prob_home, upcoming_id, rasgos, model_version FROM ufc_prediction_log WHERE match_key = ?').get(matchKey(primera)) as { prob_home: number; market_prob_home: number; upcoming_id: string; rasgos: string; model_version: string };
  assert.match(antes.model_version, /^ufc-/);
  assert.deepEqual(Object.keys(JSON.parse(antes.rasgos)), ['elo', 'record', 'edad', 'alcance', 'experiencia']);
  d.prepare("INSERT OR REPLACE INTO ufc_upcoming (id, commence_time, home_name, away_name, home_id, away_id, odds_home, odds_away, books, source, updated_at) VALUES ('odds-dos', ?, 'Alex Pereira', 'Jamahal Hill', ?, ?, 1.45, 2.7, 4, 'live', ?)").run(cuando, L.pereira.id, L.hill.id, AHORA.toISOString());
  logUfcPrediction(otra, buildPrediction({ homeId: L.pereira.id, awayId: L.hill.id, oddsHome: 1.45, oddsAway: 2.7 })!);
  const despues = d.prepare('SELECT prob_home, market_prob_home, upcoming_id FROM ufc_prediction_log WHERE match_key = ?').get(matchKey(primera)) as { prob_home: number; market_prob_home: number; upcoming_id: string };
  assert.equal(despues.prob_home, antes.prob_home);
  assert.equal(despues.market_prob_home, antes.market_prob_home);
  assert.equal(despues.upcoming_id, 'odds-dos');
  assert.throws(() => d.prepare('UPDATE ufc_prediction_log SET prob_home = 0.9 WHERE match_key = ?').run(matchKey(primera)), /no se reescribe/);
  assert.throws(() => d.prepare("UPDATE ufc_prediction_log SET rasgos = '{}' WHERE match_key = ?").run(matchKey(primera)), /no se reescribe/);
  assert.throws(() => d.prepare('DELETE FROM ufc_prediction_log WHERE match_key = ?').run(matchKey(primera)), /no se borra/);

  // El banco de papel la ve, con las dos salidas y sin «@» (no hay local).
  const c = candidatasPapel(true).find((x) => x.sport === 'ufc');
  assert.ok(c, 'la UFC entra en las candidatas');
  assert.equal(c!.label, 'Alex Pereira vs Jamahal Hill');

  // El resultado llega al archivo con los dos AL REVÉS (la fuente pone primero a Hill) y gana Pereira.
  const a = archivo(900);
  a.eventos.push({ id: 'eventoreal000001', nombre: 'UFC Real', fecha: fechaUfc(cuando), lugar: null });
  a.peleas.push({ id: 'peleareal0000001', evento_id: 'eventoreal000001', fecha: fechaUfc(cuando), orden: 0, luchador_a: L.hill.id, luchador_b: L.pereira.id, nombre_a: 'Jamahal Hill', nombre_b: 'Alex Pereira', resultado: 'B', categoria: 'Light Heavyweight Title Bout', metodo: 'KO/TKO', asalto: 1, tiempo: '3:14', ambigua: false });
  guardarArchivo(a);
  olvidarEstado();
  assert.ok(resolveUfcPredictions().resolved >= 1);
  const r = d.prepare('SELECT home_score, away_score, outcome, metodo FROM ufc_prediction_log WHERE match_key = ?').get(matchKey(primera)) as { home_score: number; away_score: number; outcome: string; metodo: string };
  assert.deepEqual([r.home_score, r.away_score, r.outcome, r.metodo], [1, 0, 'A', 'KO/TKO'], 'desde el lado de la predicción: A (Pereira) ganó');
  assert.deepEqual(liquidador()({ sport: 'ufc', match_key: matchKey(primera), selection: 'Alex Pereira' }), { status: 'won', resultado: 'ganó Alex Pereira (KO/TKO)' });
  assert.equal(liquidador()({ sport: 'ufc', match_key: matchKey(primera), selection: 'Jamahal Hill' })?.status, 'lost');
  assert.deepEqual(findGameResult('ufc', { league: 'ufc', homeId: L.pereira.id, awayId: L.hill.id, commenceTime: cuando }), { homeScore: 1, awayScore: 0, playedOn: fechaUfc(cuando).replace(/-/g, '') });
  const tr = getUfcTrackRecord();
  assert.equal(tr.resolved, 1);
  assert.equal(tr.recent[0].method, 'KO/TKO');
});

test('banco: el empate devuelve la apuesta y el «sin resultado» la anula; ¿Acertó? no puntúa ninguno', () => {
  const d = getDb();
  const ins = (mk: string, outcome: 'EMPATE' | 'NC') =>
    d
      .prepare(
        `INSERT INTO ufc_prediction_log (match_key, home_id, away_id, home_name, away_name, prob_home, predicted_at, home_score, away_score, outcome, metodo, resolved_at)
         VALUES (?, ?, ?, 'José Aldo', 'Steve Erceg', 0.4, ?, 0, 0, ?, ?, ?)`,
      )
      .run(mk, L.aldo.id, L.erceg.id, AHORA.toISOString(), outcome, outcome === 'NC' ? 'Overturned' : 'Decision - Split', AHORA.toISOString());
  ins('ufc|empate', 'EMPATE');
  ins('ufc|nc', 'NC');
  assert.equal(liquidador()({ sport: 'ufc', match_key: 'ufc|empate', selection: 'José Aldo' })?.status, 'push');
  assert.equal(liquidador()({ sport: 'ufc', match_key: 'ufc|nc', selection: 'Steve Erceg' })?.status, 'void');
  const tr = getUfcTrackRecord();
  assert.equal(tr.sinGanador, 2);
  assert.equal(tr.resolved, 3, 'resueltas: la de Pereira y las dos sin ganador');
});

test('reconstrucción: las peleas recientes del archivo, con lo sabido antes de cada una', () => {
  cargar();
  const r = reconstruirDesde(ymd(dia(-200)).replace(/-/g, ''));
  const ufc = r.partidos.filter((p) => p.deporte === 'UFC');
  assert.ok(ufc.length > 0);
  assert.ok(ufc.every((p) => /^\d{8}$/.test(p.fecha) && Math.abs(p.probs[0] + p.probs[1] - 1) < 1e-9 && p.casaId < p.fueraId));
});

test('rutas: próximas con predicción y confianza, el debut sin número y dicho, ficha del luchador y errores claros', async () => {
  cargar();
  getDb().exec('DELETE FROM ufc_upcoming');
  const cuando = dia(2).toISOString();
  const ins = getDb().prepare("INSERT INTO ufc_upcoming (id, commence_time, home_name, away_name, home_id, away_id, odds_home, odds_away, books, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1.8, 2.0, 3, 'live', ?)");
  ins.run('odds-r1', cuando, 'José Aldo', 'Steve Erceg', L.aldo.id, L.erceg.id, AHORA.toISOString());
  ins.run('odds-r2', cuando, 'Alexandre Pantoja', 'Debutante Nuevo', L.pantoja.id, null, AHORA.toISOString());
  const e = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;
  const app = await buildApp({ auth: { config: configAuth(e), limite: new LimiteDeIntentos() }, servirWeb: false, logger: false, entorno: e });
  await app.ready();
  const r = await app.inject({ method: 'GET', url: '/api/ufc/fights/upcoming' });
  assert.equal(r.statusCode, 200, r.body);
  const peleas = r.json() as { fight: { id: string }; prediction: unknown; confianza: unknown; sinPrediccion: string | null }[];
  const conNumero = peleas.find((x) => x.fight.id === 'odds-r1')!;
  assert.ok(conNumero.prediction && conNumero.confianza, 'con predicción y evaluación de confianza');
  const debut = peleas.find((x) => x.fight.id === 'odds-r2')!;
  assert.equal(debut.prediction, null);
  assert.match(debut.sinPrediccion ?? '', /Debutante Nuevo.*debut/);
  assert.equal((await app.inject({ method: 'GET', url: `/api/ufc/fighters/${L.aldo.id}` })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/ufc/fighters/no-es-un-id' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/ufc/predict', payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/ufc/predict', payload: { a: L.aldo.id, b: L.erceg.id } })).statusCode, 200);
  assert.ok(((await app.inject({ method: 'GET', url: '/api/ufc/power' })).json() as { fighters: unknown[] }).fighters.length > 0);
  assert.equal((await app.inject({ method: 'GET', url: '/api/simulation/season/ufc/ufc' })).statusCode, 404, 'sin temporada que simular');
  // ¿Acertó?: el empate no es acierto ni fallo (antes caía en el índice del segundo), y la victoria enseña el método.
  const empate = (await app.inject({ method: 'GET', url: `/api/resultado/ufc/${encodeURIComponent('ufc|empate')}` })).json() as { resultado: string; acerto: boolean | null; marcador: string | null };
  assert.deepEqual([empate.resultado, empate.acerto, empate.marcador], ['empate', null, 'empate']);
  const nc = (await app.inject({ method: 'GET', url: `/api/resultado/ufc/${encodeURIComponent('ufc|nc')}` })).json() as { acerto: boolean | null; marcador: string | null };
  assert.deepEqual([nc.acerto, nc.marcador], [null, 'sin resultado']);
  const meta = (await app.inject({ method: 'GET', url: '/api/ufc/meta' })).json() as { counts: { fights: number }; model: { rasgos: string[] } };
  assert.ok(meta.counts.fights > 0);
  assert.equal(meta.model.rasgos.length, 5);
  await app.close();
});
