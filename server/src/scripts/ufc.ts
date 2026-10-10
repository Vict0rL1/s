// CLI de la UFC (publicada en octubre de 2026: docs/UFC.md).
//   npm run update-data:ufc [-- --skip-odds]         baja el archivo de ufcstats (Greco1899/scrape_ufc_stats en GitHub) y, con clave, las peleas que vienen con sus cuotas
//   npm run backtest:ufc                             evalúa el modelo publicado (walk-forward por año) sin el holdout (2026 en adelante)
//   npm run backtest:ufc -- --ajustar [--registrar]  rejilla en 1993→2024, validación en 2025, prueba contra referencias
//   npm run backtest:ufc -- --combinado [--registrar] el segundo intento (docs/plans/ufc-combinado.md): Elo + récord (+ ficha)
import { ingestarUfc } from '../ufc/ingest.ts';
import { contraReferencias, leerFichas, leerPeleas, rejilla, validar, VALIDACION } from '../ufc/evaluacion.ts';
import { CANDIDATOS, LAMBDA, MODELO_PUBLICADO, evaluacionPublicada, evaluarCombinado, juegosWalkForward } from '../ufc/combinado.ts';
import { refrescarCuotas } from '../ufc/proximos.ts';
import { resolveUfcPredictions } from '../ufc/trackRecord.ts';
import { env } from '../config.ts';
import { getMeta, setMeta } from '../db.ts';
import { informeComun } from '../evaluation/report.ts';
import { bandasDeAcierto, writeCalibration } from '../staking/calibration.ts';
import { guardarWalkForward, walkForward } from '../evaluation/walkforward.ts';
import { UFC, type ParamsUfc } from '../ufc/model.ts';
import { recordExperiment } from '../experiments/registry.ts';
import { conRegistro } from '../ingest/runs.ts';

const args = process.argv.slice(2);
const f4 = (x: number) => x.toFixed(4);
const f5 = (x: number) => x.toFixed(5);

if (args[0] === 'ingestar') {
  try {
    const r = await conRegistro('ufc-greco1899', async () => {
      const x = await ingestarUfc(fetch);
      const ultimo = x.eventos.map((e) => e.fecha).sort().at(-1) ?? '—';
      const amb = x.peleas.filter((p) => p.ambigua).length;
      return {
        rowsAdded: x.peleas.length,
        detail: `${x.eventos.length} eventos (el último del ${ultimo}), ${x.luchadores.length} luchadores; ${amb} pelea(s) con un nombre ambiguo sin atribuir, ${x.descartadas.sinFecha} sin evento con fecha y ${x.descartadas.ilegibles} ilegible(s) descartadas`,
      };
    });
    setMeta('ufc:updatedAt', new Date().toISOString());
    console.log(`UFC: ${r.rowsAdded} peleas guardadas, ${r.detail}.`);
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  }
  // Las peleas que vienen solo llegan con las cuotas (la fuente del archivo trae las ya disputadas).
  if (!args.includes('--skip-odds')) {
    if (!env.oddsApiKey) console.log('UFC: sin ODDS_API_KEY no hay cartelera (las peleas que vienen llegan con las cuotas): npm run clave');
    else {
      try {
        const n = await refrescarCuotas(true);
        console.log(`UFC: ${n} pelea(s) de la UFC con cuotas · ${getMeta('ufc:descartadas') ?? 0} de otras organizaciones descartadas · ${getMeta('ufc:sinIdentificar') ?? 0} sin identificar (debut o nombre ambiguo)`);
      } catch (e) {
        console.error(`UFC: no se pudieron pedir las cuotas: ${(e as Error).message}`);
      }
    }
  }
  const res = resolveUfcPredictions();
  if (res.resolved) console.log(`UFC: ${res.resolved} predicción(es) en vivo con resultado.`);
} else if (args.includes('--combinado')) {
  const peleas = leerPeleas();
  if (peleas.length === 0) {
    console.error('✗ sin peleas en ufc_fights: corre antes npm run update-data:ufc');
    process.exit(1);
  }
  const r = evaluarCombinado(peleas, leerFichas());
  console.log(`\nUFC · segundo intento (docs/plans/ufc-combinado.md): logística simétrica walk-forward por año, λ ${LAMBDA}`);
  console.log(`Elección con el ENTRENAMIENTO (→ ${VALIDACION - 1}):`);
  for (const x of r.eleccion) console.log(`  ${x.candidato.padEnd(20)} [${CANDIDATOS[x.candidato].join(', ')}] log loss ${f5(x.llEntrenamiento)}${x.candidato === r.elegido ? '  ← elegido' : ''}`);
  console.log(`Pesos del ajuste que predice ${VALIDACION}: ${Object.entries(r.pesosValidacion).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(' · ')}`);
  for (const [nombre, t] of [
    ['todo lo puntuable, sin holdout', r.todo],
    [`solo la validación ${VALIDACION}`, r.validacion],
  ] as const) {
    console.log(`\n${r.elegido} contra las referencias, ${nombre} (${t.n} peleas): log loss ${f5(t.modelo)}`);
    for (const x of t.referencias) console.log(`  ${x.nombre.padEnd(52)} ${f5(x.ll)} · Δ ${f5(x.mean)} [${f5(x.lo)}, ${f5(x.hi)}] · p ${f4(x.p)}`);
    console.log(`  ${'Elo de luchador solo (el vigente)'.padEnd(52)} ${f5(t.contraElo.ll)} · Δ ${f5(t.contraElo.mean)} [${f5(t.contraElo.lo)}, ${f5(t.contraElo.hi)}] · p ${f4(t.contraElo.p)}`);
  }
  console.log(`\n${r.pasa ? '✓ PASA la prueba de publicación' : '✗ NO pasa la prueba de publicación'} · ${r.mejoraAlElo ? 'mejora al Elo solo en la validación' : 'no queda demostrado que mejore al Elo solo en la validación'}`);
  if (args.includes('--registrar')) {
    const v = r.validacion;
    const e1 = recordExperiment({
      hypothesis: `ufc: combinar el Elo de luchador con el récord${r.elegido === 'elo+record' ? '' : ', la edad, el alcance y la experiencia'} en una logística walk-forward mejora al Elo solo`,
      dataset: { sport: 'ufc', split: 'validation', n: v.n },
      features: [...CANDIDATOS[r.elegido]],
      hyperparams: { candidato: r.elegido, lambda: LAMBDA, candidatos: Object.keys(CANDIDATOS).join(' | '), eleccion: 'log loss walk-forward en el entrenamiento' },
      metric: 'logloss',
      baseline: 'Elo de luchador solo (vigente en la sombra)',
      result: { delta: v.contraElo.mean, ciLo: v.contraElo.lo, ciHi: v.contraElo.hi, p: v.contraElo.p, n: v.n },
      verdict: r.mejoraAlElo ? 'shipped' : v.contraElo.lo > 0 ? 'rejected' : 'inconclusive',
      featureChange: `Elo solo → logística ${r.elegido} [${CANDIDATOS[r.elegido].join(', ')}]`,
      trainPeriod: `walk-forward por año, 1994 → ${VALIDACION - 1}; elección entre ${Object.keys(CANDIDATOS).length} candidatos fijados antes (docs/plans/ufc-combinado.md)`,
      validationPeriod: `${VALIDACION}; el holdout (2026 en adelante) no entra ni en el ajuste ni en la puntuación`,
      metricsBefore: { logLoss: v.contraElo.ll },
      metricsAfter: { logLoss: v.modelo },
      accepted: r.mejoraAlElo,
      reason: r.mejoraAlElo ? 'mejora en validación con el intervalo por debajo de cero' : 'el intervalo no excluye el cero: el Elo solo sigue siendo el vigente',
    });
    console.log(`\nRegistrado: ${e1.id}`);
    const peor = v.referencias.reduce((a, b) => (b.mean > a.mean ? b : a));
    const e2 = recordExperiment({
      hypothesis: 'ufc (segundo intento): la logística Elo + récord (+ ficha) gana a las cuatro referencias fuera de muestra, la condición para publicar el deporte',
      dataset: { sport: 'ufc', split: 'validation', n: v.n },
      features: [...CANDIDATOS[r.elegido]],
      hyperparams: { candidato: r.elegido, lambda: LAMBDA },
      metric: 'logloss',
      baseline: `la referencia más dura en la validación: ${peor.nombre}`,
      result: { delta: peor.mean, ciLo: peor.lo, ciHi: peor.hi, p: peor.p, n: v.n },
      verdict: r.pasa ? 'shipped' : peor.lo > 0 ? 'rejected' : 'inconclusive',
      featureChange: 'publicar la UFC (entrar en SPORT_IDS) si gana a todas, en todo lo puntuable y en la validación',
      trainPeriod: `walk-forward por año 1994 → ${VALIDACION - 1} (${r.todo.n - v.n} peleas puntuables)`,
      validationPeriod: `${VALIDACION}; el holdout (2026 en adelante) no se puntúa`,
      metricsBefore: { logLoss: peor.ll },
      metricsAfter: { logLoss: v.modelo },
      accepted: r.pasa,
      reason: r.pasa ? 'gana a todas con el intervalo por debajo de cero en los dos tramos' : 'alguna referencia no queda descartada con el intervalo: la UFC sigue en sombra (último intento con estos datos)',
    });
    console.log(`Registrado: ${e2.id}`);
  }
} else if (args.includes('--ajustar')) {
  const peleas = leerPeleas();
  if (peleas.length === 0) {
    console.error('✗ sin peleas en ufc_fights: corre antes npm run update-data:ufc');
    process.exit(1);
  }
  const fmt = (p: ParamsUfc) => `K ${p.k}, debutantes ×${p.factorProvisional}, finalizar +${p.bonoFinalizacion}`;
  const c = rejilla(peleas);
  console.log(`\nUFC · rejilla en el ENTRENAMIENTO (→ ${VALIDACION - 1}), las cinco mejores y la vigente:`);
  for (const x of c.slice(0, 5)) console.log(`  ${fmt(x.params).padEnd(46)} log loss ${f5(x.llEntrenamiento)}`);
  const vig = c.find((x) => x.params.k === UFC.k && x.params.factorProvisional === UFC.factorProvisional && x.params.bonoFinalizacion === UFC.bonoFinalizacion);
  if (vig) console.log(`  ${('vigente: ' + fmt(vig.params)).padEnd(46)} log loss ${f5(vig.llEntrenamiento)}`);
  const elegida = c[0].params;
  const v = validar(peleas, UFC, elegida);
  console.log(`\nValidación ${VALIDACION} (${v.n} peleas), elegida contra vigente:`);
  console.log(`  log loss ${f5(v.antes)} → ${f5(v.despues)} · Δ ${f5(v.mean)} [${f5(v.lo)}, ${f5(v.hi)}] · p ${f4(v.p)}`);
  const mejora = v.hi < 0;
  const final = mejora ? elegida : UFC;
  const cr = contraReferencias(peleas, final);
  for (const [nombre, t] of [
    ['todo lo puntuable, sin holdout', cr.todo],
    [`solo la validación ${VALIDACION}`, cr.validacion],
  ] as const) {
    console.log(`\nModelo (${fmt(final)}) contra las referencias, ${nombre} (${t.n} peleas): log loss ${f5(t.modelo)}`);
    for (const r of t.referencias) console.log(`  ${r.nombre.padEnd(52)} ${f5(r.ll)} · Δ modelo ${f5(r.mean)} [${f5(r.lo)}, ${f5(r.hi)}] · p ${f4(r.p)}`);
  }
  if (args.includes('--registrar')) {
    const e1 = recordExperiment({
      hypothesis: 'ufc: ajustar K, cuánto más aprende el Elo de un debutante y cuánto cuenta ganar por KO o sumisión mejora el log loss frente a los valores de partida',
      dataset: { sport: 'ufc', split: 'validation', n: v.n },
      features: ['elo-luchador'],
      hyperparams: { k: elegida.k, factorProvisional: elegida.factorProvisional, bonoFinalizacion: elegida.bonoFinalizacion, rejilla: '6×4×3' },
      metric: 'logloss',
      baseline: `valores de partida (${fmt(UFC)})`,
      result: { delta: v.mean, ciLo: v.lo, ciHi: v.hi, p: v.p, n: v.n },
      verdict: mejora ? 'shipped' : v.lo > 0 ? 'rejected' : 'inconclusive',
      featureChange: `K ${UFC.k}→${elegida.k}, debutantes ×${UFC.factorProvisional}→×${elegida.factorProvisional}, finalizar +${UFC.bonoFinalizacion}→+${elegida.bonoFinalizacion}`,
      trainPeriod: `1993 → ${VALIDACION - 1} (elección por log loss en la rejilla)`,
      validationPeriod: `${VALIDACION}; el holdout (2026 en adelante) no se puntúa`,
      metricsBefore: { logLoss: v.antes },
      metricsAfter: { logLoss: v.despues },
      accepted: mejora,
      reason: mejora ? 'mejora en validación con el intervalo por debajo de cero: se adoptan (la UFC sigue en sombra hasta decidir su publicación)' : 'el intervalo no excluye el cero: se quedan los valores de partida',
    });
    console.log(`\nRegistrado: ${e1.id}`);
    const t = cr.validacion;
    const peor = t.referencias.reduce((a, b) => (b.mean > a.mean ? b : a));
    const pasa = t.referencias.every((r) => r.hi < 0) && cr.todo.referencias.every((r) => r.hi < 0);
    const e2 = recordExperiment({
      hypothesis: 'ufc: el Elo de luchador gana a las cuatro referencias (moneda, más peleas, mejor récord, Elo básico) fuera de muestra, la condición para publicar el deporte',
      dataset: { sport: 'ufc', split: 'validation', n: t.n },
      features: ['elo-luchador'],
      hyperparams: { k: final.k, factorProvisional: final.factorProvisional, bonoFinalizacion: final.bonoFinalizacion },
      metric: 'logloss',
      baseline: `la referencia más dura en la validación: ${peor.nombre}`,
      result: { delta: peor.mean, ciLo: peor.lo, ciHi: peor.hi, p: peor.p, n: t.n },
      verdict: pasa ? 'shipped' : peor.lo > 0 ? 'rejected' : 'inconclusive',
      featureChange: 'publicar la UFC (entrar en SPORT_IDS) si gana a todas, en todo lo puntuable y en la validación',
      trainPeriod: `walk-forward 1993 → ${VALIDACION - 1} (${cr.todo.n - t.n} peleas puntuables)`,
      validationPeriod: `${VALIDACION}; el holdout (2026 en adelante) no se puntúa`,
      metricsBefore: { logLoss: peor.ll },
      metricsAfter: { logLoss: t.modelo },
      accepted: pasa,
      reason: pasa ? 'gana a todas con el intervalo por debajo de cero en los dos tramos' : 'alguna referencia no queda descartada con el intervalo: la UFC sigue en sombra',
    });
    console.log(`Registrado: ${e2.id}`);
  }
} else {
  // El modelo publicado (docs/plans/ufc-combinado.md): walk-forward por año, sin el holdout.
  const peleas = leerPeleas();
  const fichas = leerFichas();
  const r = evaluacionPublicada(peleas, fichas);
  console.log(`\nUFC · ${r.peleas} peleas, ${r.puntuadas} puntuadas, ${r.holdoutExcluido} del holdout excluidas, ${r.sinAtribuir} sin atribuir, ${r.sinGanador} sin ganador.`);
  if (r.modelo) {
    const m = r.modelo;
    const ece = m.ece == null ? '—' : `${(m.ece * 100).toFixed(2)} pp`;
    console.log(`  modelo publicado (${MODELO_PUBLICADO}) log loss ${m.logLoss?.toFixed(4) ?? '—'} · Brier ${m.brier?.toFixed(4) ?? '—'} · acierto ${m.accuracy == null ? '—' : (m.accuracy * 100).toFixed(1) + ' %'} · ECE ${ece}`);
    console.log(`  ${'Elo de luchador solo'.padEnd(52)} log loss ${r.eloSolo?.toFixed(4) ?? '—'}`);
    for (const x of r.referencias) console.log(`  ${x.nombre.padEnd(52)} log loss ${x.logLoss?.toFixed(4) ?? '—'}`);
    for (const t of r.porAnio) console.log(`  ${t.anio}: ${t.n} peleas · log loss ${t.logLoss?.toFixed(4) ?? '—'}`);
    // Lo mismo que los otros seis backtests de referencia: la capa común de métricas, la calibración
    // que lee el módulo de riesgo (con sus bandas de acierto) y el walk-forward por periodos.
    informeComun('ufc', r.predicciones);
    const favs = r.predicciones.map((x) => ({ p: Math.max(x.p[0], x.p[1]), hit: (x.p[0] >= 0.5 ? 0 : 1) === x.y }));
    writeCalibration({
      ufc: { ece: m.ece ?? 1, n: m.n, beatsMarket: null, vsMarketLogLoss: null, bands: bandasDeAcierto(favs), measuredAt: new Date().toISOString() },
    });
    console.log('  calibración escrita en experiments/calibration.json (sin cuotas históricas: beatsMarket null)');
    const wf = walkForward('ufc', juegosWalkForward(peleas, fichas));
    console.log(`  walk-forward: ${wf.periodos.length} periodos, guardado en ${guardarWalkForward(wf)}`);
  }
  if (r.aviso.texto) console.log(`  ${r.aviso.texto}`);
  if (peleas.length === 0) console.log('  sin peleas en ufc_fights: corre npm run update-data:ufc donde la red alcance raw.githubusercontent.com.');
}
