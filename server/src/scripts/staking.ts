// CLI: `npm run staking [-- --bankroll 1000]`
//
// La capa de decisión, sobre los partidos que hay ahora mismo. Enseña, para cada
// candidata, qué puerta la paró o cuánto se arriesgaría — y después el DRAWDOWN
// esperado del plan entero, que es la parte que la gente no mira.

import { getDb } from '../db.ts';
import { listUpcoming } from '../football/repo.ts';
import { buildFootballPrediction } from '../football/predict.ts';
import { bestSelection, lossState, DEFAULT_CONFIG } from '../staking/policy.ts';
import { decideBook, type BookCandidate } from '../staking/book.ts';
import { readCalibration, calibrationMultiplier } from '../staking/calibration.ts';
import { simulate, type PlannedBet } from '../staking/drawdown.ts';
import { DEMO_SOURCE } from '../freshness.ts';

/**
 * La tabla de drawdown, con los escenarios de «¿y si el modelo es peor de lo que cree?».
 *
 * Los cuatro escenarios existen porque el primero es el menos informativo: supone que
 * la p del modelo es exacta, que es justo la hipótesis que Kelly necesita y que nunca
 * se cumple. Las otras tres desplazan las probabilidades hacia la moneda y enseñan el
 * MISMO plan con menos ventaja de la creída.
 */
function report(bets: PlannedBet[]): void {
  console.log(`\nDRAWDOWN ESPERADO — ${bets.length} apuestas, 5.000 caminos simulados`);
  console.log('  escenario                  retorno   caída mediana   caída p95   pierde   -50 %');
  const scenarios: [string, number][] = [
    ['el modelo tiene razón', 0],
    ['el modelo se equivoca 1/4', 0.25],
    ['el modelo se equivoca 1/2', 0.5],
    ['el modelo no sabe nada', 1],
  ];
  for (const [label, shift] of scenarios) {
    const r = simulate(bets, { pShift: shift });
    console.log(
      `  ${label.padEnd(26)} ${((r.expectedReturn * 100 >= 0 ? '+' : '') + (r.expectedReturn * 100).toFixed(2) + ' %').padStart(8)}   ` +
        `${(r.medianMaxDrawdown * 100).toFixed(2).padStart(11)} %   ` +
        `${(r.p95MaxDrawdown * 100).toFixed(2).padStart(7)} %   ` +
        `${(r.probLosing * 100).toFixed(0).padStart(5)} %   ${(r.probHalved * 100).toFixed(1).padStart(5)} %`,
    );
  }
  console.log('\n  La fila que importa NO es la primera. Las de abajo son el mismo plan si la');
  console.log('  ventaja es menor de lo que el modelo cree, y la caída del percentil 95 es lo');
  console.log('  que hay que poder aguantar sin dejarlo en el peor momento.');
}

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => (a.startsWith('--') ? [[a.slice(2), arr[i + 1]]] : [])),
) as Record<string, string>;
const bankroll = Number(args.bankroll) || 1000;
const cfg = DEFAULT_CONFIG;
const cal = readCalibration();

console.log('POLÍTICA DE RIESGO');
console.log(`  banco                    ${bankroll.toFixed(2)}`);
console.log(`  fracción de Kelly        ${cfg.kellyFraction === 0.25 ? '1/4' : '1/5'} (Kelly completo no es una opción del tipo)`);
console.log(`  tope por evento          ${(cfg.maxPerEvent * 100).toFixed(1)} % = ${(bankroll * cfg.maxPerEvent).toFixed(2)}`);
console.log(`  límite diario            ${(cfg.dailyLossLimit * 100).toFixed(1)} % = ${(bankroll * cfg.dailyLossLimit).toFixed(2)}`);
console.log(`  límite semanal           ${(cfg.weeklyLossLimit * 100).toFixed(1)} % = ${(bankroll * cfg.weeklyLossLimit).toFixed(2)}`);
console.log(`  ventaja mínima           ${(cfg.minEdge * 100).toFixed(1)} %`);
console.log(
  `  exposición máxima        ${(cfg.maxTotalExposure * 100).toFixed(1)} % = ${(bankroll * cfg.maxTotalExposure).toFixed(2)} a la vez`,
);
console.log(
  `  tope por día             ${(cfg.maxExposurePerDay * 100).toFixed(1)} % = ${(bankroll * cfg.maxExposurePerDay).toFixed(2)}`,
);
console.log(
  `  tope por liga            ${(cfg.maxExposurePerLeague * 100).toFixed(1)} % = ${(bankroll * cfg.maxExposurePerLeague).toFixed(2)}`,
);
console.log('  una sola selección por partido (los tres lados de un 1X2 son excluyentes)');
console.log('  Kelly de CARTERA: el tamaño de cada una depende de con quién comparte riesgo');

console.log('\nCALIBRACIÓN MEDIDA → MULTIPLICADOR DE TAMAÑO');
if (Object.keys(cal).length === 0) {
  console.log('  ⚠ No hay medición. El módulo falla CERRADO: todo a cero.');
  console.log('    Corre `npm run study:calibration`.');
}
for (const sport of ['football', 'nfl']) {
  const m = calibrationMultiplier(sport, cal);
  console.log(`  ${sport.padEnd(10)} ×${m.multiplier.toFixed(2)}`);
  console.log(`             ${m.reason}`);
}

const loss = lossState(bankroll, cfg);
console.log('\nESTADO DE PÉRDIDAS (apuestas ya resueltas)');
console.log(
  `  hoy     ${loss.today.toFixed(2)}  de  ${loss.dayLimit.toFixed(2)}   ${loss.dayBreached ? '⛔ OPERATIVA CORTADA' : 'ok'}`,
);
console.log(
  `  semana  ${loss.week.toFixed(2)}  de  ${loss.weekLimit.toFixed(2)}   ${loss.weekBreached ? '⛔ OPERATIVA CORTADA' : 'ok'}`,
);

// ---------------------------------------------------------------------------
// Las candidatas de hoy
// ---------------------------------------------------------------------------
const fixtures = listUpcoming() as unknown as {
  id: string;
  league: string;
  commence_time: string | null;
  home_name: string;
  away_name: string;
  home_id: string | null;
  away_id: string | null;
  odds_home: number | null;
  odds_draw: number | null;
  odds_away: number | null;
  source: string | null;
}[];

console.log(`\nCANDIDATAS — ${fixtures.length} partidos de fútbol en el calendario`);
const demo = fixtures.filter((f) => f.source === DEMO_SOURCE).length;
if (demo > 0) {
  console.log(
    `  ⚠ ${demo} con cuotas de DEMOSTRACIÓN, generadas por el propio modelo. Apostar contra`,
  );
  console.log('    tu propia salida no es una ventaja, es una identidad — se excluyen.');
}

// ===========================================================================
// LA CARTERA, NO UNA LISTA DE APUESTAS
// ===========================================================================
// Antes esto recorría los partidos acumulando exposición sobre la marcha, y eso tiene
// un fallo que no se ve: la primera de la lista se lleva el margen y la última se queda
// sin, por el orden en que salieron de la consulta. El orden de una consulta no es un
// criterio de riesgo. Ahora se recogen TODAS las candidatas y se dimensionan juntas.
const candidates: BookCandidate[] = [];
const meta = new Map<string, { event: string; label: string; p: number; odds: number; day: string }>();
let skipped = 0;

for (const f of fixtures) {
  if (f.source === DEMO_SOURCE) continue;
  if (!f.home_id || !f.away_id || f.odds_home == null || f.odds_draw == null || f.odds_away == null) {
    continue;
  }
  let pred;
  try {
    pred = buildFootballPrediction(f.league as never, f.home_id, f.away_id);
  } catch {
    skipped++;
    continue;
  }
  // UNA selección por partido, no una por resultado. Los tres lados de un 1X2 son
  // mutuamente excluyentes: dimensionarlos por separado construía posiciones sobre el
  // mismo partido donde una de las ramas pierde con certeza.
  const best = bestSelection([
    { label: f.home_name, p: pred.model.home, odds: f.odds_home, side: 'canonica' as const },
    { label: 'Empate', p: pred.model.draw, odds: f.odds_draw, side: 'otro' as const },
    { label: f.away_name, p: pred.model.away, odds: f.odds_away, side: 'contraria' as const },
  ], cfg);
  if (!best) continue;
  const day = (f.commence_time ?? 'sin-fecha').slice(0, 10);
  candidates.push({
    key: f.id,
    label: `${f.home_name} vs ${f.away_name} — ${best.label}`,
    sport: 'football',
    league: f.league,
    day,
    // El partido es la unidad de la correlación fuerte: dos mercados del mismo
    // encuentro comparten marcador, y eso es lo único que la medición encontró.
    matchKey: f.id,
    market: '1x2',
    side: best.side,
    p: best.p,
    odds: best.odds,
  });
  meta.set(f.id, { event: `${f.home_name} vs ${f.away_name}`, label: best.label, p: best.p, odds: best.odds, day });
}

const book = decideBook(candidates, bankroll, cfg, cal);
const placed = book.entries.filter((e) => e.stake > 0);
const blockedBy = new Map<string, number>();
for (const e of book.entries) {
  if (e.stake > 0) continue;
  blockedBy.set(e.blockedBy ?? '?', (blockedBy.get(e.blockedBy ?? '?') ?? 0) + 1);
}

let shown = 0;
for (const e of placed) {
  if (shown >= 8) break;
  shown++;
  const m = meta.get(e.key)!;
  console.log(`\n  ${m.event} — ${m.label} @ ${m.odds.toFixed(2)}`);
  for (const s of e.steps) console.log(`    ${s.gate.padEnd(22)} ${s.result}`);
  const solo = e.soloStake;
  console.log(
    `    → ARRIESGAR ${e.stake.toFixed(2)} (${(e.fraction * 100).toFixed(2)} % del banco)` +
      (Math.abs(solo - e.stake) > 0.005 ? `  · en solitario habrían sido ${solo.toFixed(2)}` : ''),
  );
}

console.log(
  `\n  ${placed.length} apuestas pasarían las ocho puertas · ${book.entries.length - placed.length} paradas · ` +
    `${book.totalStake.toFixed(2)} en riesgo (${((100 * book.totalStake) / bankroll).toFixed(1)} % del banco)`,
);
for (const [gate, n] of [...blockedBy].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(4)} × ${gate}`);
}

// ---------------------------------------------------------------------------
// Exposición agregada REAL contra la suma ingenua
// ---------------------------------------------------------------------------
console.log('\nEXPOSICIÓN AGREGADA');
console.log(
  `  suma ingenua        ${book.naiveStake.toFixed(2)}  (${((100 * book.naiveStake) / bankroll).toFixed(1)} % del banco)` +
    '  ← lo que pediría cada apuesta por su cuenta',
);
console.log(
  `  tras Kelly y topes  ${book.totalStake.toFixed(2)}  (${((100 * book.totalStake) / bankroll).toFixed(1)} % del banco)` +
    '  ← lo que se pone de verdad',
);
console.log(
  `  riesgo efectivo     ${(book.aggregate.effective * bankroll).toFixed(2)}  ` +
    `(${(100 * book.aggregate.effective).toFixed(1)} % del banco)  ← el tamaño de UNA apuesta equivalente`,
);
console.log(
  `  concentración       ${(100 * book.aggregate.concentration).toFixed(0)} %  ` +
    '(100 % = ninguna diversificación, todo falla junto)',
);
console.log(
  '\n  Las dos primeras responden «¿cuánto puedo perder?» y no dependen de la\n' +
    '  correlación: si fallan todas, se pierde la suma. La tercera responde «¿cuánto\n' +
    '  riesgo corro?», que es otra pregunta — veinte apuestas independientes al 2 % no\n' +
    '  son una del 40 %, aunque el peor caso coincida.',
);

if (book.caps.length > 0) {
  console.log('\n  TOPES QUE RECORTARON');
  for (const c of book.caps) {
    console.log(
      `    ${c.scope.padEnd(22)} tope ${c.limit.toFixed(2)} · ya en juego ${c.used.toFixed(2)} → ×${c.factor.toFixed(2)}`,
    );
  }
}
// ===========================================================================
// SIN CANDIDATAS REALES, UN EJEMPLO — Y DICHO QUE LO ES
// ===========================================================================
// La misma razón que la tabla de drawdown de más abajo: sin esto, la parte nueva de
// este módulo solo se ve el día que ya hay dinero en juego, que es el peor momento para
// descubrir cómo se lee. Los números son inventados; las correlaciones que los mueven,
// no — salen de `npm run study:correlation`.
if (placed.length === 0) {
  console.log('\nEJEMPLO ILUSTRATIVO DEL SIZING DE CARTERA (partidos inventados)');
  console.log('  Cuatro apuestas: tres en partidos distintos y DOS mercados del mismo');
  console.log('  encuentro, que es el caso que el sizing por apuesta aislada no veía.');
  const ej: BookCandidate[] = [
    { key: 'e1', label: 'A vs B — local', sport: 'football', league: 'epl', day: '2026-09-12', matchKey: 'm1', market: '1x2', side: 'canonica', p: 0.55, odds: 2.05 },
    { key: 'e2', label: 'A vs B — over 2.5', sport: 'football', league: 'epl', day: '2026-09-12', matchKey: 'm1', market: 'over_under', side: 'canonica', p: 0.58, odds: 1.95 },
    { key: 'e3', label: 'C vs D — local', sport: 'football', league: 'epl', day: '2026-09-12', matchKey: 'm2', market: '1x2', side: 'canonica', p: 0.55, odds: 2.05 },
    { key: 'e4', label: 'E vs F — local', sport: 'football', league: 'laliga', day: '2026-09-13', matchKey: 'm3', market: '1x2', side: 'canonica', p: 0.55, odds: 2.05 },
  ];
  const b = decideBook(ej, bankroll, cfg, cal);
  console.log('\n    apuesta                  en solitario   de cartera   factor');
  for (const e of b.entries) {
    console.log(
      `    ${e.label.padEnd(24)} ${e.soloStake.toFixed(2).padStart(12)} ${e.stake.toFixed(2).padStart(12)}   ×${e.portfolioFactor.toFixed(2)}`,
    );
  }
  console.log(
    `\n    suma ingenua ${b.naiveStake.toFixed(2)} · de cartera ${b.totalStake.toFixed(2)} · ` +
      `riesgo efectivo ${(b.aggregate.effective * bankroll).toFixed(2)} · ` +
      `concentración ${(100 * b.aggregate.concentration).toFixed(0)} %`,
  );
  for (const l of b.links) console.log(`    ρ ${l.rho >= 0 ? '+' : ''}${l.rho.toFixed(3)}  ${l.reason}`);
  console.log(
    '\n    Las dos del mismo partido se encogen entre sí; las de partidos distintos casi\n' +
      '    no, porque su correlación medida no se distingue de cero.',
  );
}

if (book.links.length > 0) {
  console.log('\n  CORRELACIONES QUE MOVIERON ALGO');
  for (const l of book.links.slice(0, 6)) {
    console.log(`    ρ ${l.rho >= 0 ? '+' : ''}${l.rho.toFixed(3)}  ${l.reason}`);
  }
  if (book.links.length > 6) console.log(`    … y ${book.links.length - 6} más`);
} else if (placed.length > 1) {
  console.log(
    '\n  Ninguna correlación relevante entre estas posiciones. No es un descuido: se\n' +
      '  midió y la correlación entre partidos DISTINTOS de la misma liga y jornada no se\n' +
      '  distingue de cero (`npm run study:correlation`). La que sí existe es entre\n' +
      '  mercados del MISMO partido, y aquí solo hay una apuesta por encuentro.',
  );
}
for (const n of book.notes) console.log(`\n  ${n}`);

const planned: (PlannedBet & { event: string; stake: number })[] = placed.map((e) => {
  const m = meta.get(e.key)!;
  return {
    label: m.label,
    event: m.event,
    p: m.p,
    odds: m.odds,
    fraction: e.fraction,
    stake: e.stake,
    // La tanda es EL DÍA en que se juega, no «todo lo de hoy»: lo que se liquida junto
    // es lo que se juega junto. Meter una semana entera en una sola liquidación haría
    // el drawdown poco informativo —una única oportunidad de caer— y agrupar de menos
    // subestimaría la cola. Se agrupa por lo que de verdad ocurre a la vez.
    round: m.day,
  };
});

// ---------------------------------------------------------------------------
// El drawdown, que es el número que decide si el plan es soportable
// ---------------------------------------------------------------------------
if (planned.length === 0) {
  console.log('\nSin apuestas reales que simular. Nada que arriesgar hoy es un resultado válido.');
  // Y aun así se enseña la tabla, con un plan INVENTADO y dicho: sin ella, la parte
  // más importante de este módulo solo se ve el día que ya hay dinero en juego, que es
  // el peor momento para descubrir cómo se lee.
  console.log('\nEJEMPLO ILUSTRATIVO (no son partidos reales, son números puestos a mano)');
  console.log('  20 apuestas al 2 % del banco, cuota 2.00, ventaja del 5 %, repartidas en');
  console.log('  4 jornadas de 5 — que es como caen de verdad, no todas el mismo día:');
  const ejemplo = Array.from({ length: 20 }, (_, i) => ({
    label: `ejemplo ${i + 1}`,
    p: 0.525,
    odds: 2,
    fraction: 0.02,
    // Cinco por jornada: dentro de una jornada se liquidan juntas, entre jornadas no.
    round: `jornada-${Math.floor(i / 5)}`,
  }));
  report(ejemplo);
} else {
  report(planned);
}
getDb();
