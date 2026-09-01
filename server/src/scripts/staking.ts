// CLI: `npm run staking [-- --bankroll 1000]`
//
// La capa de decisión, sobre los partidos que hay ahora mismo. Enseña, para cada
// candidata, qué puerta la paró o cuánto se arriesgaría — y después el DRAWDOWN
// esperado del plan entero, que es la parte que la gente no mira.

import { getDb } from '../db.ts';
import { listUpcoming } from '../football/repo.ts';
import { buildFootballPrediction } from '../football/predict.ts';
import { decideStake, lossState, DEFAULT_CONFIG } from '../staking/policy.ts';
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

const planned: (PlannedBet & { event: string; stake: number })[] = [];
let blocked = 0;
const blockedBy = new Map<string, number>();
let shown = 0;

for (const f of fixtures) {
  if (f.source === DEMO_SOURCE) continue;
  if (!f.home_id || !f.away_id || f.odds_home == null || f.odds_draw == null || f.odds_away == null) {
    continue;
  }
  let pred;
  try {
    pred = buildFootballPrediction(f.league as never, f.home_id, f.away_id);
  } catch {
    continue;
  }
  const sides: [string, number, number][] = [
    [f.home_name, pred.model.home, f.odds_home],
    ['Empate', pred.model.draw, f.odds_draw],
    [f.away_name, pred.model.away, f.odds_away],
  ];
  for (const [label, p, odds] of sides) {
    const d = decideStake({ sport: 'football', p, odds, bankroll }, cfg, cal);
    if (d.stake <= 0) {
      blocked++;
      blockedBy.set(d.blockedBy ?? '?', (blockedBy.get(d.blockedBy ?? '?') ?? 0) + 1);
      continue;
    }
    planned.push({
      label,
      event: `${f.home_name} vs ${f.away_name}`,
      p,
      odds,
      fraction: d.fraction,
      stake: d.stake,
    });
    if (shown < 8) {
      shown++;
      console.log(`\n  ${f.home_name} vs ${f.away_name} — ${label} @ ${odds.toFixed(2)}`);
      for (const s of d.steps) console.log(`    ${s.gate.padEnd(22)} ${s.result}`);
      console.log(`    → ARRIESGAR ${d.stake.toFixed(2)} (${(d.fraction * 100).toFixed(2)} % del banco)`);
    }
  }
}

console.log(`\n  ${planned.length} apuestas pasarían las cinco puertas · ${blocked} paradas:`);
for (const [gate, n] of [...blockedBy].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(4)} × ${gate}`);
}

// ---------------------------------------------------------------------------
// El drawdown, que es el número que decide si el plan es soportable
// ---------------------------------------------------------------------------
if (planned.length === 0) {
  console.log('\nSin apuestas reales que simular. Nada que arriesgar hoy es un resultado válido.');
  // Y aun así se enseña la tabla, con un plan INVENTADO y dicho: sin ella, la parte
  // más importante de este módulo solo se ve el día que ya hay dinero en juego, que es
  // el peor momento para descubrir cómo se lee.
  console.log('\nEJEMPLO ILUSTRATIVO (no son partidos reales, son números puestos a mano)');
  console.log('  20 apuestas al 2 % del banco, cuota 2.00, con una ventaja real del 5 %:');
  const ejemplo = Array.from({ length: 20 }, (_, i) => ({
    label: `ejemplo ${i + 1}`,
    p: 0.525,
    odds: 2,
    fraction: 0.02,
  }));
  report(ejemplo);
} else {
  report(planned);
}
getDb();
