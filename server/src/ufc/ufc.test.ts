// La UFC en sombra (seguimiento: NHL y UFC): la lectura de los CSV de Greco1899 sin inventar nada,
// el Elo de luchador, el backtest que no mira el orden de la fuente ni el holdout, y la ingesta que
// no escribe nada si falta un fichero. Nada sale a la red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { fechaUfc, cm, idDeUrl, leerArchivo, ingestarUfc, REPO_UFC } = await import('./ingest.ts');
const { UFC, predecir, actualizar, esFinalizacion } = await import('./model.ts');
const { recorrer, evaluarUfc, contraReferencias, perdidas, CALENTAMIENTO } = await import('./evaluacion.ts');
const { getDb, MIGRACIONES } = await import('../db.ts');
type PeleaUfc = import('./evaluacion.ts').PeleaUfc;

const U = 'http://ufcstats.com';
const TEXTOS = {
  'ufc_event_details.csv': [
    'EVENT,URL,DATE,LOCATION',
    `UFC 300: Pereira vs. Hill,${U}/event-details/aaaaaaaaaaaa0300,"April 13, 2024","Las Vegas, Nevada, USA"`,
    `UFC 301: Pantoja vs. Erceg,${U}/event-details/aaaaaaaaaaaa0301,"May 04, 2024","Rio de Janeiro, Brazil"`,
  ].join('\n'),
  'ufc_fighter_details.csv': [
    'FIRST,LAST,NICKNAME,URL',
    `Alex,Pereira,Poatan,${U}/fighter-details/bbbbbbbbbbbb0001`,
    `Jamahal,Hill,Sweet Dreams,${U}/fighter-details/bbbbbbbbbbbb0002`,
    `Alexandre,Pantoja,The Cannibal,${U}/fighter-details/bbbbbbbbbbbb0003`,
    `Steve,Erceg,Astroboy,${U}/fighter-details/bbbbbbbbbbbb0004`,
    `Bruno,Silva,Blindado,${U}/fighter-details/bbbbbbbbbbbb0005`,
    `Bruno,Silva,Bulldog,${U}/fighter-details/bbbbbbbbbbbb0006`,
  ].join('\n'),
  'ufc_fighter_tott.csv': [
    'FIGHTER,HEIGHT,WEIGHT,REACH,STANCE,DOB,URL',
    `Alex Pereira,"6' 4""",205 lbs.,"79""",Orthodox,"Jul 07, 1987",${U}/fighter-details/bbbbbbbbbbbb0001`,
    `Jamahal Hill,--,205 lbs.,--,,--,${U}/fighter-details/bbbbbbbbbbbb0002`,
  ].join('\n'),
  'ufc_fight_results.csv': [
    'EVENT,BOUT,OUTCOME,WEIGHTCLASS,METHOD,ROUND,TIME,TIME FORMAT,REFEREE,DETAILS,URL',
    `UFC 300: Pereira vs. Hill ,Alex Pereira vs. Jamahal Hill,W/L,Light Heavyweight Title Bout,KO/TKO ,1,3:14,5 Rnd,Marc Goddard,Punch,${U}/fight-details/cccccccccccc0001`,
    `UFC 300: Pereira vs. Hill ,Bruno Silva vs. Steve Erceg,L/W,Flyweight Bout,Decision - Unanimous ,3,5:00,3 Rnd,Herb Dean,,${U}/fight-details/cccccccccccc0002`,
    `UFC 301: Pantoja vs. Erceg ,Alexandre Pantoja vs. Steve Erceg,W/L,Flyweight Title Bout,Decision - Unanimous ,5,5:00,5 Rnd,Herb Dean,,${U}/fight-details/cccccccccccc0003`,
    `UFC 301: Pantoja vs. Erceg ,Jamahal Hill vs. Nadie Conocido,D/D,Light Heavyweight Bout,Decision - Split ,3,5:00,3 Rnd,Herb Dean,,${U}/fight-details/cccccccccccc0004`,
    `UFC 301: Pantoja vs. Erceg ,Alex Pereira vs. Jamahal Hill,NC/NC,Light Heavyweight Bout,Overturned ,1,1:00,3 Rnd,Herb Dean,,${U}/fight-details/cccccccccccc0005`,
    `UFC 999: Evento Sin Fecha ,Alex Pereira vs. Jamahal Hill,W/L,Light Heavyweight Bout,KO/TKO ,1,1:00,3 Rnd,Herb Dean,,${U}/fight-details/cccccccccccc0006`,
    `UFC 300: Pereira vs. Hill ,Alex Pereira y Jamahal Hill,W/L,Light Heavyweight Bout,KO/TKO ,1,1:00,3 Rnd,Herb Dean,,${U}/fight-details/cccccccccccc0007`,
  ].join('\n'),
};

test('fechas, medidas e ids de ufcstats; lo que no se entiende queda NULL', () => {
  assert.equal(fechaUfc('October 03, 2026'), '2026-10-03');
  assert.equal(fechaUfc('Jul 7, 1987'), '1987-07-07');
  assert.equal(fechaUfc('--'), null);
  assert.equal(cm(`6' 4"`), 193);
  assert.equal(cm('79"'), 200.7);
  assert.equal(cm('--'), null);
  assert.equal(idDeUrl(`${U}/fight-details/3f804eec9183e597`), '3f804eec9183e597');
  assert.equal(idDeUrl('sin id'), null);
});

test('leerArchivo: resultado por pelea, orden de la cartelera, nombres ambiguos sin atribuir y nada inventado', () => {
  const x = leerArchivo(TEXTOS);
  assert.equal(x.eventos.length, 2);
  assert.deepEqual(x.descartadas, { sinFecha: 1, ilegibles: 1 });
  const p = new Map(x.peleas.map((f) => [f.id, f]));
  assert.equal(p.size, 5);
  assert.equal(p.get('cccccccccccc0001')!.resultado, 'A');
  assert.equal(p.get('cccccccccccc0001')!.fecha, '2024-04-13');
  assert.equal(p.get('cccccccccccc0001')!.orden, 0, 'la estelar es la primera de la cartelera');
  assert.equal(p.get('cccccccccccc0002')!.orden, 1);
  assert.equal(p.get('cccccccccccc0002')!.resultado, 'B');
  assert.equal(p.get('cccccccccccc0002')!.ambigua, true, 'hay dos Bruno Silva: la pelea no se atribuye');
  assert.equal(p.get('cccccccccccc0002')!.luchador_a, null);
  assert.equal(p.get('cccccccccccc0002')!.luchador_b, 'bbbbbbbbbbbb0004');
  assert.equal(p.get('cccccccccccc0004')!.resultado, 'EMPATE');
  assert.equal(p.get('cccccccccccc0004')!.luchador_b, null, 'un nombre que no está en la lista de luchadores no se inventa');
  assert.equal(p.get('cccccccccccc0004')!.ambigua, false);
  assert.equal(p.get('cccccccccccc0005')!.resultado, 'NC');
  const pereira = x.luchadores.find((l) => l.id === 'bbbbbbbbbbbb0001')!;
  assert.deepEqual([pereira.altura_cm, pereira.alcance_cm, pereira.nacimiento], [193, 200.7, '1987-07-07']);
  const hill = x.luchadores.find((l) => l.id === 'bbbbbbbbbbbb0002')!;
  assert.deepEqual([hill.altura_cm, hill.alcance_cm, hill.nacimiento], [null, null, null]);
  assert.equal(x.luchadores.filter((l) => l.ambiguo).length, 2);
});

test('migración 15 e ingesta: todo o nada, y la segunda vez sustituye en lugar de duplicar', async () => {
  const m15 = MIGRACIONES.find((m) => m.version === 15)!;
  assert.equal(m15.destino, 'history');
  const d = getDb();
  d.exec('DELETE FROM ufc_fights; DELETE FROM ufc_fighters; DELETE FROM ufc_events;');
  const falla: typeof fetch = async (url) => new Response('no', { status: String(url).endsWith('ufc_fighter_tott.csv') ? 404 : 200 });
  await assert.rejects(ingestarUfc(falla), /404 para ufc_fighter_tott\.csv; no se ha escrito nada/);
  assert.equal((d.prepare('SELECT COUNT(*) AS n FROM ufc_fights').get() as { n: number }).n, 0);

  const pedidas: string[] = [];
  const bien: typeof fetch = async (url) => {
    pedidas.push(String(url));
    const fichero = String(url).split('/').at(-1) as keyof typeof TEXTOS;
    return new Response(TEXTOS[fichero]);
  };
  await ingestarUfc(bien);
  await ingestarUfc(bien);
  assert.ok(pedidas.every((u) => u.startsWith(`${REPO_UFC}/`)));
  assert.equal((d.prepare('SELECT COUNT(*) AS n FROM ufc_fights').get() as { n: number }).n, 5);
  assert.equal((d.prepare('SELECT COUNT(*) AS n FROM ufc_fighters').get() as { n: number }).n, 6);
  const sinFecha = d.prepare("SELECT COUNT(*) AS n FROM ufc_fights WHERE fecha IS NULL OR fecha = ''").get() as { n: number };
  assert.equal(sinFecha.n, 0);
  d.exec('DELETE FROM ufc_fights; DELETE FROM ufc_fighters; DELETE FROM ufc_events;');
});

test('el Elo de luchador: simétrico, el sin resultado no mueve nada, el debutante aprende más y finalizar puede contar más', () => {
  const a = predecir(1600, 1500);
  const b = predecir(1500, 1600);
  assert.ok(Math.abs(a.a - b.b) < 1e-12);
  assert.equal(predecir(1500, 1500).a, 0.5);
  assert.deepEqual(actualizar(1550, 1500, 'NC', 10, 10), [1550, 1500]);
  const [e1, e2] = actualizar(1500, 1500, 'EMPATE', 10, 10);
  assert.deepEqual([e1, e2], [1500, 1500], 'empate entre iguales: medio punto, nada que mover');
  const [veterano] = actualizar(1500, 1500, 'A', 10, 10);
  const [debutante] = actualizar(1500, 1500, 'A', 0, 10);
  assert.equal(veterano - 1500, UFC.k / 2);
  assert.equal(debutante - 1500, (UFC.k * UFC.factorProvisional) / 2);
  const conBono = { ...UFC, bonoFinalizacion: 0.5 };
  assert.equal(actualizar(1500, 1500, 'A', 10, 10, 'KO/TKO', conBono)[0] - 1500, (UFC.k * 1.5) / 2);
  assert.equal(actualizar(1500, 1500, 'A', 10, 10, 'Decision - Unanimous', conBono)[0] - 1500, UFC.k / 2);
  assert.ok(esFinalizacion('Submission ') && esFinalizacion("TKO - Doctor's Stoppage") && !esFinalizacion('Decision - Split') && !esFinalizacion(null));
});

// Una liga sintética: 40 luchadores con una fuerza fija; gana el más fuerte con probabilidad de Elo.
function liga(n: number, desde = 2015, girarFuente = false): PeleaUfc[] {
  let semilla = 7;
  const rnd = () => ((semilla = (semilla * 16807) % 2147483647) / 2147483647);
  const fuerza = Array.from({ length: 40 }, (_, i) => 1300 + i * 10);
  return Array.from({ length: n }, (_, i) => {
    const x = Math.floor(rnd() * 40);
    const z = (x + 1 + Math.floor(rnd() * 39)) % 40;
    const ganaX = rnd() < 1 / (1 + 10 ** ((fuerza[z] - fuerza[x]) / 400));
    const anio = desde + Math.floor((i / n) * (2027 - desde));
    // Como la fuente antes de ~2009: A es SIEMPRE el ganador (si se pide).
    const [a, b] = girarFuente ? (ganaX ? [x, z] : [z, x]) : [x, z];
    const res = girarFuente ? 'A' : ganaX ? 'A' : 'B';
    return { id: `f${i}`, fecha: `${anio}-06-${String(1 + (i % 28)).padStart(2, '0')}`, orden: 0, luchador_a: `L${String(a).padStart(2, '0')}`, luchador_b: `L${String(b).padStart(2, '0')}`, resultado: res, metodo: 'Decision - Unanimous', ambigua: 0 } as PeleaUfc;
  });
}

test('backtest: el orden de la fuente no cambia nada (aunque ponga siempre primero al ganador)', () => {
  const normal = liga(3000);
  // Mismas peleas, misma secuencia de ganadores, pero la fuente pone primero al ganador.
  const ganadorPrimero = normal.map((f) => (f.resultado === 'A' ? f : { ...f, luchador_a: f.luchador_b, luchador_b: f.luchador_a, resultado: 'A' as const }));
  const r1 = recorrer(normal).pasos;
  const r2 = recorrer(ganadorPrimero).pasos;
  assert.deepEqual(r1, r2);
  // Y un Elo que se aprovechara del orden acertaría siempre: el nuestro no se acerca.
  const ev = evaluarUfc(ganadorPrimero);
  assert.ok(ev.modelo!.accuracy! < 0.8, `acierto ${ev.modelo!.accuracy}`);
});

test('backtest: predice antes de actualizar, calienta, no puntúa el holdout ni lo no atribuido, y gana a la moneda cuando hay señal', () => {
  const peleas = liga(4000);
  peleas[100] = { ...peleas[100], ambigua: 1 };
  peleas[101] = { ...peleas[101], luchador_b: null };
  peleas[102] = { ...peleas[102], resultado: 'NC' };
  const r = recorrer(peleas);
  assert.equal(r.pasos[0].p, 0.5, 'la primera pelea se predice con los dos en 1500');
  assert.equal(r.sinAtribuir, 2);
  assert.equal(r.sinGanador, 1);
  // El calentamiento cuenta peleas atribuidas (el «sin resultado» también), y `pasos` solo trae las que tienen ganador.
  assert.ok(r.pasos.slice(0, CALENTAMIENTO - r.sinGanador).every((x) => !x.puntuable));
  assert.ok(r.pasos[CALENTAMIENTO].puntuable);
  assert.ok(r.pasos.filter((x) => x.anio >= 2026).every((x) => !x.puntuable), 'el holdout (2026 →) no se puntúa');
  assert.ok(r.holdoutExcluido > 0);
  const ev = evaluarUfc(peleas);
  assert.equal(ev.puntuadas, r.pasos.filter((x) => x.puntuable).length);
  assert.ok(ev.porAnio.every((x) => x.anio < 2026));
  const cr = contraReferencias(peleas);
  assert.equal(cr.todo.n, perdidas(r.pasos, () => true).length);
  const moneda = cr.todo.referencias.find((x) => x.nombre.startsWith('Moneda'))!;
  assert.ok(moneda.hi < 0, `con señal real el modelo gana a la moneda: Δ ${moneda.mean} [${moneda.lo}, ${moneda.hi}]`);
  assert.ok(cr.validacion.n > 0 && cr.validacion.n < cr.todo.n);
});

test('sin peleas no hay métricas inventadas', () => {
  const ev = evaluarUfc([]);
  assert.equal(ev.modelo, null);
  assert.match(ev.nota, /sin peleas en ufc_fights/);
});
