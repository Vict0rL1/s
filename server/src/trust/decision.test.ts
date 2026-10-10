import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { evaluar, registrarEvaluacion, ultimaEvaluacion } = await import('./assess.ts');
const { ABSTENCION, familiaDeMotivo, FAMILIAS_MOTIVO } = await import('./decision.ts');
const { DEFAULT_CONFIG } = await import('../staking/policy.ts');
const { getDb } = await import('../db.ts');
type Ev = Parameters<typeof evaluar>[0];

const LN = Math.LN10 / 400;
const ahora = new Date();
const enHoras = (h: number) => new Date(ahora.getTime() + h * 3_600_000).toISOString();
const p0 = 1 / (1 + 10 ** (-100 / 400)); // 64 %, coherente con 100 pts de factores

const bueno = (over: Partial<Ev> = {}): Ev => ({
  sport: 'tennis',
  matchKey: 'atp|1|2|x',
  eventId: 'e1',
  commence: enHoras(20),
  outcomes: ['A', 'B'],
  probs: [p0, 1 - p0],
  factores: [
    { clave: 'rating', etiqueta: 'Elo', puntos: 90, rango: [1, 1], porQue: '' },
    { clave: 'form', etiqueta: 'Forma', puntos: 10, rango: [0.5, 1.5], porQue: '' },
  ],
  pendiente: LN,
  pendienteExacta: true,
  sigmaHueco: 25,
  fiabilidad: { nivel: 'high', margenPp: 1.5, motivos: [] },
  componentes: [],
  datos: [{ estado: 'ok', texto: 'todo', max: 100, puntos: 100 }],
  ood: [],
  regimen: { etiqueta: 'temporada', nota: null },
  odds: [1.8, 2.1], // ventaja +15 % en A
  oddsAt: enHoras(-0.5),
  books: 10,
  providerEventId: null,
  providerSelections: null,
  demo: false,
  ...over,
});

test('un partido con ventaja clara, datos completos y estable: BET, con su contrafactual', () => {
  const ev = evaluar(bueno(), { now: ahora });
  assert.equal(ev.decision.decision, 'BET', ev.decision.razones.join(' · '));
  assert.equal(ev.decision.seleccion?.nombre, 'A');
  assert.ok(ev.decision.factorStake <= 1);
  // El contrafactual sale de las reglas: cuota mínima = max((1+minEdge)/p, 1/(p−u)).
  const u = ev.incertidumbre.totalPp / 100;
  const cuotaMin = Math.max((1 + DEFAULT_CONFIG.minEdge) / p0, 1 / (p0 - u));
  assert.match(ev.decision.contrafactual[0], new RegExp(`por debajo de ${cuotaMin.toFixed(2).replace('.', ',')}`));
});

// EL CASO QUE MÁS IMPORTA: un número atractivo que no merece confianza.
test('ventaja aparente de +9 pp con datos pobres, poca historia y componentes en contra: NO BET', () => {
  const ev = evaluar(
    bueno({
      datos: [
        { estado: 'aviso', texto: 'solo 4 partidos recientes', max: 50, puntos: 0 },
        { estado: 'aviso', texto: 'historial en superficie insuficiente', max: 30, puntos: 0 },
        { estado: 'ok', texto: 'cuotas recientes', max: 20, puntos: 20 },
      ],
      ood: [{ grave: true, texto: 'jugador con solo 4 partidos registrados' }],
      fiabilidad: { nivel: 'low', margenPp: 10, motivos: ['pocos partidos'] },
      sigmaHueco: 160,
      componentes: [
        { nombre: 'Elo general', probs: [0.72, 0.28] },
        { nombre: 'Elo de superficie', probs: [0.52, 0.48] },
      ],
    }),
    { now: ahora },
  );
  assert.equal(ev.decision.decision, 'NO BET');
  const r = ev.decision.razones.join(' · ');
  assert.match(r, /calidad de datos 20\/100/);
  assert.match(r, /fuera de distribución/);
  assert.match(r, /no sobrevive a la incertidumbre|desaparece/);
  assert.equal(ev.confianza.nivel, 'BAJA');
  assert.equal(ev.decision.factorStake, 0);
});

test('sin ventaja mínima de la política, NO BET y qué cuota haría falta', () => {
  const ev = evaluar(bueno({ odds: [1.55, 2.6] }), { now: ahora }); // 0.64·1.55 = −0,8 %
  assert.equal(ev.decision.decision, 'NO BET');
  assert.match(ev.decision.contrafactual.join(' '), /cuota ≥/);
});

test('precio viejo: NO BET aunque todo lo demás esté bien', () => {
  const ev = evaluar(bueno({ oddsAt: enHoras(-(ABSTENCION.precioViejoHoras + 1)) }), { now: ahora });
  assert.equal(ev.decision.decision, 'NO BET');
  assert.match(ev.decision.razones.join(' '), /precio de hace 7 h/);
});

test('la predicción registrada desfasada de la actual: NO BET', () => {
  const ev = evaluar(bueno(), { now: ahora, pRegistrada: [0.75, 0.25] });
  assert.match(ev.decision.razones.join(' '), /desfasada/);
});

test('las señales leves recortan el importe y nunca lo suben', () => {
  const ev = evaluar(bueno({ ood: [{ grave: false, texto: 'pocos partidos (15)' }] }), { now: ahora });
  assert.equal(ev.decision.decision, 'BET');
  assert.equal(ev.decision.factorStake, 0.5);
});

test('demostración: SIN MERCADO, nunca BET', () => {
  assert.equal(evaluar(bueno({ demo: true }), { now: ahora }).decision.decision, 'SIN MERCADO');
});

test('las abstenciones se registran (append-only, solo si cambian, nunca tras el inicio)', () => {
  const malo = bueno({ odds: [1.55, 2.6] });
  const ev = evaluar(malo, { now: ahora });
  assert.equal(registrarEvaluacion(malo, ev, ahora), 'nueva');
  assert.equal(registrarEvaluacion(malo, ev, ahora), 'igual');
  const u = ultimaEvaluacion('tennis', 'atp|1|2|x');
  assert.equal(u?.decision, 'NO BET');
  assert.ok(u!.reasons.length > 0);
  assert.equal(registrarEvaluacion(malo, ev, new Date(Date.parse(malo.commence) + 1000)), 'empezado');
  assert.throws(() => getDb().prepare("UPDATE prediction_assessments SET decision = 'BET'").run(), /no se reescribe/);
  assert.throws(() => getDb().prepare('DELETE FROM prediction_assessments').run(), /no se borra/);
});

// FALLO ENCONTRADO: cada refresco reescribe la hora de las cuotas aunque el precio no cambie.
// Si la evaluación no se vuelve a guardar, el banco la ve «anterior a las cuotas actuales» y
// se abstiene para siempre. Una cuota re-observada exige una evaluación nueva.
test('una cuota re-observada (misma cuota, hora nueva) obliga a guardar una evaluación nueva', () => {
  const t0 = new Date(ahora.getTime() - 3 * 3_600_000);
  const e1 = bueno({ matchKey: 'atp|9|8|r', oddsAt: new Date(t0.getTime() - 60_000).toISOString() });
  assert.equal(registrarEvaluacion(e1, evaluar(e1, { now: t0 }), t0), 'nueva');
  const t1 = new Date(ahora.getTime() - 3_600_000);
  // Mismo partido y mismas cuotas, descargadas otra vez después de la evaluación.
  const e2 = { ...e1, oddsAt: new Date(t1.getTime() - 60_000).toISOString() };
  assert.equal(registrarEvaluacion(e2, evaluar(e2, { now: t1 }), t1), 'nueva');
  const u = ultimaEvaluacion('tennis', 'atp|9|8|r');
  assert.ok(u && u.assessed_at >= (e2.oddsAt as string), 'la última evaluación es posterior a las cuotas vigentes');
  // Sin nueva descarga, sigue sin duplicarse.
  assert.equal(registrarEvaluacion(e2, evaluar(e2, { now: t1 }), new Date(t1.getTime() + 60_000)), 'igual');
});

// Las dos piezas juntas: lo que la capa de confianza guarda es lo que el banco acepta, también
// después de un refresco de cuotas sin movimiento de precio.
test('integración: evaluación → refresco sin movimiento → el banco sigue pudiendo apostar', async () => {
  const { juicioDeConfianza } = await import('../paper/bankroll.ts');
  const t0 = new Date(ahora.getTime() - 2 * 3_600_000);
  const e = bueno({ matchKey: 'atp|5|6|int', oddsAt: new Date(t0.getTime() - 60_000).toISOString() });
  registrarEvaluacion(e, evaluar(e, { now: t0 }), t0);
  const refresco = new Date(ahora.getTime() - 30 * 60_000);
  const e2 = { ...e, oddsAt: refresco.toISOString() };
  registrarEvaluacion(e2, evaluar(e2, { now: new Date(refresco.getTime() + 60_000) }), new Date(refresco.getTime() + 60_000));
  const candidato = { sport: 'tennis', match_key: 'atp|5|6|int', oddsAt: refresco.toISOString(), salidas: [{ label: 'A', p: e.probs[0], odds: 1.8 }, { label: 'B', p: e.probs[1], odds: 2.1 }] };
  const j = juicioDeConfianza(candidato, 'A');
  assert.equal(j.apostar, true, j.razon ?? '');
  assert.equal(j.factor, 1);
});

// El doctor agrupa los motivos por familia (FAMILIAS_MOTIVO). Si una regla cambia su texto y
// deja de caer en una familia, saldría como «otro» y el diagnóstico de «el banco está ciego
// por cuotas viejas» dejaría de dispararse sin que nada fallara. Aquí se generan los textos
// con las reglas DE VERDAD, no copiados a mano.
test('todo motivo de abstención que generan las reglas cae en una familia', async () => {
  const { juicioDeConfianza } = await import('../paper/bankroll.ts');
  const casos = [
    bueno({ odds: [1.55, 2.6] }),
    bueno({ oddsAt: enHoras(-(ABSTENCION.precioViejoHoras + 1)) }),
    bueno({ demo: true }),
    bueno({ odds: null }),
    bueno({
      datos: [{ estado: 'aviso', texto: 'pocos partidos', max: 50, puntos: 0 }, { estado: 'ok', texto: 'cuotas', max: 20, puntos: 20 }],
      ood: [{ grave: true, texto: 'jugador con solo 4 partidos registrados' }],
      fiabilidad: { nivel: 'low', margenPp: 10, motivos: [] },
      sigmaHueco: 160,
      componentes: [{ nombre: 'Elo general', probs: [0.72, 0.28] }, { nombre: 'Elo de superficie', probs: [0.4, 0.6] }],
    }),
  ];
  const razones = casos.flatMap((e) => evaluar(e, { now: ahora }).decision.razones);
  razones.push(...evaluar(bueno(), { now: ahora, pRegistrada: [0.75, 0.25] }).decision.razones);
  // Las del banco: sin evaluación, evaluación anterior a las cuotas y con otra cuota.
  const cand = (k: string, oddsAt: string | null, cuota = 1.8) => ({ sport: 'tennis', match_key: k, oddsAt, salidas: [{ label: 'A', p: p0, odds: cuota }, { label: 'B', p: 1 - p0, odds: 2.1 }] });
  razones.push(juicioDeConfianza(cand('nunca|evaluado', null), 'A').razon!);
  const t0 = new Date(ahora.getTime() - 2 * 3_600_000);
  const e = bueno({ matchKey: 'atp|fam|1|x', oddsAt: new Date(t0.getTime() - 60_000).toISOString() });
  registrarEvaluacion(e, evaluar(e, { now: t0 }), t0);
  razones.push(juicioDeConfianza(cand('atp|fam|1|x', new Date(t0.getTime() + 60_000).toISOString()), 'A').razon!);
  razones.push(juicioDeConfianza(cand('atp|fam|1|x', e.oddsAt as string, 1.95), 'A').razon!);

  const familias = new Set(razones.map((r) => familiaDeMotivo(r).familia));
  for (const r of razones) assert.notEqual(familiaDeMotivo(r).familia, 'otro', `sin familia: «${r}»`);
  for (const f of ['sin ventaja mínima', 'precio viejo', 'sin mercado', 'calidad de datos', 'fuera de distribución', 'predicción desfasada', 'sin evaluación', 'evaluación anterior a las cuotas', 'evaluación con otra cuota']) {
    assert.ok(familias.has(f), `ningún caso genera «${f}»`);
  }
  assert.equal(familiaDeMotivo('abstención: precio de hace 9 h (máximo 6 h)').tuberia, true, 'el prefijo del banco no cambia la familia');
  assert.equal(familiaDeMotivo('algo que nadie ha escrito').familia, 'otro');
  assert.equal(new Set(FAMILIAS_MOTIVO.map((f) => f.familia)).size, FAMILIAS_MOTIVO.length, 'familias sin repetir');
});
