// CLI de la NHL (Fase 8.1; publicada en el seguimiento: NHL y UFC).
//   npm run update-data:nhl                                   resultados (las dos últimas temporadas si ya hay archivo; si no,
//                                                             2009-10 → la actual), equipos, calendario y, con clave, cuotas
//   npm run update-data:nhl -- --desde 2016 --hasta 2025      solo esas temporadas (por el año en que acaban)
//   npm run update-data:nhl -- --skip-odds                    sin pedir cuotas (lo usa update-results)
//   npm run update-data:nhl -- --fuente nhl --desde 2015-10-01 --hasta 2025-06-30
//                                                             de la API de la NHL, semana a semana (dice si hubo prórroga)
//   npm run backtest:nhl                                      backtest de referencia: métricas comunes, calibración y walk-forward
//   npm run backtest:nhl -- --ajustar [--registrar]           rejilla en 2009-10→2023-24, validación en 2024-25
import { ingestarRango, ingestarTemporadas } from '../nhl/ingest.ts';
import { evaluarNhl, juegosWalkForward, leerPartidos } from '../nhl/evaluacion.ts';
import { contraReferencias, recorrer, rejilla, validar, validarTotales, VALIDACION } from '../nhl/ajuste.ts';
import { NHL } from '../nhl/model.ts';
import { guardarEquipos } from '../nhl/repo.ts';
import { refrescarCalendario, refrescarCuotas } from '../nhl/proximos.ts';
import { resolveNhlPredictions } from '../nhl/trackRecord.ts';
import { recordExperiment } from '../experiments/registry.ts';
import { conRegistro } from '../ingest/runs.ts';
import { env } from '../config.ts';
import { getDb, setMeta } from '../db.ts';
import { informeComun } from '../evaluation/report.ts';
import { bandasDeAcierto, writeCalibration } from '../staking/calibration.ts';
import { guardarWalkForward, walkForward } from '../evaluation/walkforward.ts';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args[0] === 'ingestar') {
  const fuente = opt('fuente') ?? 'sportsdataverse';
  try {
    if (fuente === 'nhl') {
      const desde = opt('desde') ?? '2015-10-01';
      const hasta = opt('hasta') ?? new Date().toISOString().slice(0, 10);
      const r = await conRegistro('nhl-api', async () => {
        const x = await ingestarRango(desde, hasta, fetch, (m) => console.log(m));
        return { rowsAdded: x.partidos, detail: `${x.semanas} semanas, ${desde} → ${x.partidos ? hasta : desde}` };
      });
      console.log(`NHL: ${r.rowsAdded} partidos terminados guardados (${r.detail}).`);
    } else if (fuente === 'sportsdataverse') {
      // La temporada en curso acaba el año que viene si ya empezó (septiembre en adelante).
      const hoy = new Date();
      const actual = hoy.getUTCMonth() >= 8 ? hoy.getUTCFullYear() + 1 : hoy.getUTCFullYear();
      // Con archivo, basta con las dos últimas temporadas (la que acaba y la en curso); sin él, todo.
      const hay = (getDb().prepare('SELECT COUNT(*) AS n FROM nhl_games').get() as { n: number }).n > 0;
      const desde = Number(opt('desde') ?? (hay ? actual - 1 : 2010));
      const hasta = Number(opt('hasta') ?? actual);
      const r = await conRegistro('nhl-sportsdataverse', async () => {
        const x = await ingestarTemporadas(desde, hasta, fetch, (m) => console.log(m));
        const sin = x.sinFichero.length ? `; sin fichero: ${x.sinFichero.join(', ')}` : '';
        const cor = x.corregidas.length ? `; corregidas con las cajas: ${x.corregidas.join(', ')}` : '';
        const rec = x.rechazadas.length ? `; RECHAZADAS: ${x.rechazadas.map((r) => `${r.anio} (${r.motivo})`).join('; ')}` : '';
        return { rowsAdded: x.partidos, detail: `${x.temporadas} temporadas (${desde - 1}-${String(desde).slice(2)} → ${hasta - 1}-${String(hasta).slice(2)})${sin}${cor}${rec}` };
      });
      console.log(`NHL: ${r.rowsAdded} partidos terminados guardados, ${r.detail}.`);
      console.log(`  ${guardarEquipos()} franquicias en nhl_teams`);
      try {
        console.log(`  ${await refrescarCalendario(actual)} partidos por jugar desde el calendario de la temporada`);
      } catch (e) {
        console.log(`  calendario: ${(e as Error).message} (los próximos se quedan como estaban)`);
      }
      if (args.includes('--skip-odds')) console.log('  cuotas: saltadas por --skip-odds (no se gasta cuota)');
      else if (!env.oddsApiKey) console.log('  cuotas: sin ODDS_API_KEY; la pestaña usa el calendario y el modelo');
      else console.log(`  cuotas: ${await refrescarCuotas()} partidos con precio de casas`);
      const res = resolveNhlPredictions();
      if (res.resolved) console.log(`  ${res.resolved} predicción(es) en vivo puntuadas con los resultados nuevos`);
      setMeta('nhl:updatedAt', new Date().toISOString());
    } else {
      throw new Error(`fuente desconocida «${fuente}»: usa sportsdataverse o nhl`);
    }
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  }
} else if (args.includes('--ajustar')) {
  const partidos = leerPartidos();
  if (partidos.length === 0) {
    console.error('✗ sin partidos en nhl_games: corre antes npm run update-data:nhl');
    process.exit(1);
  }
  const c = rejilla(partidos);
  console.log('\nNHL · rejilla en el ENTRENAMIENTO (2009-10 → 2023-24), las cinco mejores y la vigente:');
  const fmt = (p: typeof NHL) => `K ${p.k}, campo ${p.campo}, vuelta a la media ${p.regresion}`;
  for (const x of c.slice(0, 5)) console.log(`  ${fmt(x.params).padEnd(44)} log loss ${x.llEntrenamiento.toFixed(5)}`);
  const vig = c.find((x) => x.params.k === NHL.k && x.params.campo === NHL.campo && x.params.regresion === NHL.regresion);
  if (vig) console.log(`  ${('vigente: ' + fmt(vig.params)).padEnd(44)} log loss ${vig.llEntrenamiento.toFixed(5)}`);
  const elegida = c[0].params;
  const v = validar(partidos, NHL, elegida);
  console.log(`\nValidación ${VALIDACION}-${String(VALIDACION + 1).slice(2)} (${v.n} partidos), elegida contra vigente:`);
  console.log(`  log loss ${v.antes.toFixed(5)} → ${v.despues.toFixed(5)} · Δ ${v.mean.toFixed(5)} [${v.lo.toFixed(5)}, ${v.hi.toFixed(5)}] · p ${v.p.toFixed(4)}`);
  const tot = [5.5, 6.5].map((l) => validarTotales(partidos, elegida, l));
  for (const t of tot) {
    console.log(`  totales ${t.linea}: goles de la liga fijos (${NHL.golesLiga}) ${t.fija.toFixed(5)} → media de la última temporada ${t.movil.toFixed(5)} · Δ ${t.mean.toFixed(5)} [${t.lo.toFixed(5)}, ${t.hi.toFixed(5)}] · p ${t.p.toFixed(4)}`);
  }
  const cr = contraReferencias(partidos);
  console.log(`\nModelo vigente contra las referencias (${cr.n} partidos puntuables, 2009-10 → 2024-25, sin holdout): log loss ${cr.modelo.toFixed(5)}`);
  for (const r of cr.referencias) console.log(`  ${r.nombre.padEnd(36)} ${r.ll.toFixed(5)} · Δ modelo ${r.mean.toFixed(5)} [${r.lo.toFixed(5)}, ${r.hi.toFixed(5)}] · p ${r.p.toFixed(4)}`);
  if (args.includes('--registrar')) {
    const mejora = v.hi < 0;
    const e1 = recordExperiment({
      hypothesis: 'nhl: ajustar K, ventaja de campo y la vuelta a la media entre temporadas mejora el log loss del moneyline frente a los valores de partida',
      dataset: { sport: 'nhl', split: 'validation', n: v.n },
      features: ['elo-margen-goles'],
      hyperparams: { k: elegida.k, campo: elegida.campo, regresion: elegida.regresion, rejilla: '6×4×4' },
      metric: 'logloss',
      baseline: `valores de partida (K ${NHL.k}, campo ${NHL.campo}, sin vuelta a la media)`,
      result: { delta: v.mean, ciLo: v.lo, ciHi: v.hi, p: v.p, n: v.n },
      verdict: mejora ? 'shipped' : v.lo > 0 ? 'rejected' : 'inconclusive',
      featureChange: `K ${NHL.k}→${elegida.k}, campo ${NHL.campo}→${elegida.campo}, vuelta a la media ${NHL.regresion}→${elegida.regresion}`,
      trainPeriod: '2009-10 → 2023-24 (elección por log loss en la rejilla)',
      validationPeriod: `${VALIDACION}-${String(VALIDACION + 1).slice(2)}, mirada una vez; el holdout (2025-26 en adelante) no se puntúa`,
      metricsBefore: { logLoss: v.antes },
      metricsAfter: { logLoss: v.despues },
      accepted: mejora,
      reason: mejora ? 'mejora en validación con el intervalo por debajo de cero: se adoptan (la NHL sigue en sombra hasta decidir su publicación)' : 'el intervalo no excluye el cero: se quedan los valores de partida',
    });
    console.log(`\nRegistrado: ${e1.id}`);
    const t = tot[0];
    const mejoraT = t.hi < 0;
    const e2 = recordExperiment({
      hypothesis: 'nhl: los goles de la liga tomados de la media de la última temporada (y no fijos en 6.0) mejoran el log loss de los totales',
      dataset: { sport: 'nhl', split: 'validation', n: t.n },
      features: ['poisson-goles'],
      hyperparams: { linea: t.linea, ventana: 1312 },
      metric: 'logloss',
      baseline: `goles de la liga fijos en ${NHL.golesLiga}`,
      result: { delta: t.mean, ciLo: t.lo, ciHi: t.hi, p: t.p, n: t.n },
      verdict: mejoraT ? 'shipped' : t.lo > 0 ? 'rejected' : 'inconclusive',
      featureChange: 'golesLiga = media móvil de los últimos 1.312 partidos, pasada a goles a 60 minutos',
      trainPeriod: 'ninguno: la media se calcula con los partidos anteriores a cada uno',
      validationPeriod: `${VALIDACION}-${String(VALIDACION + 1).slice(2)}, línea ${t.linea}`,
      metricsBefore: { logLoss: t.fija },
      metricsAfter: { logLoss: t.movil },
      accepted: mejoraT,
      reason: mejoraT ? 'mejora en validación con el intervalo por debajo de cero: se adopta' : 'el intervalo no excluye el cero: se queda fija',
    });
    console.log(`Registrado: ${e2.id}`);
  }
} else {
  const partidos = leerPartidos();
  const r = evaluarNhl(partidos);
  console.log(`\nNHL · ${r.partidos} partidos, ${r.puntuados} puntuados, ${r.holdoutExcluido} del holdout excluidos.`);
  if (r.modelo) {
    const m = r.modelo;
    const ece = m.ece == null ? '—' : `${(m.ece * 100).toFixed(2)} pp`;
    console.log(`  modelo   log loss ${m.logLoss?.toFixed(4) ?? '—'} · Brier ${m.brier?.toFixed(4) ?? '—'} · ECE ${ece}`);
    for (const x of r.referencias) console.log(`  ${x.nombre.padEnd(36)} log loss ${x.logLoss?.toFixed(4) ?? '—'}`);
    for (const t of r.porTemporada) console.log(`  ${t.temporada}: ${t.n} partidos · log loss ${t.logLoss?.toFixed(4) ?? '—'}`);
    // El backtest de referencia deja lo mismo que los otros cinco: la capa común de métricas, la
    // calibración que lee el módulo de riesgo (con sus bandas de acierto) y el walk-forward por periodos.
    const pasos = recorrer(partidos).filter((x) => x.puntuable);
    informeComun('nhl', pasos.map((x) => ({ p: [x.pLocal, 1 - x.pLocal], y: x.y === 1 ? 0 : 1 })));
    const favs = pasos.map((x) => ({ p: Math.max(x.pLocal, 1 - x.pLocal), hit: (x.pLocal >= 0.5 ? 1 : 0) === x.y }));
    writeCalibration({
      nhl: { ece: m.ece ?? 1, n: m.n, beatsMarket: null, vsMarketLogLoss: null, bands: bandasDeAcierto(favs), measuredAt: new Date().toISOString() },
    });
    console.log('  calibración escrita en experiments/calibration.json (sin cuotas históricas: beatsMarket null)');
    const wf = walkForward('nhl', juegosWalkForward(partidos));
    console.log(`  walk-forward: ${wf.periodos.length} periodos, guardado en ${guardarWalkForward(wf)}`);
  }
  if (r.aviso.texto) console.log(`  ${r.aviso.texto}`);
  console.log(`  ${r.nota}`);
}
