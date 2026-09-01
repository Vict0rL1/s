// La decisión: cuánto se arriesga, y cuándo no se arriesga nada.
//
// ===========================================================================
// SEPARADO DEL MODELO A PROPÓSITO
// ===========================================================================
// El modelo dice una probabilidad. Este fichero decide un dinero. Son responsabilidades
// distintas y aquí no entra ni un Elo: entran p, cuota, deporte y banco.
//
// La consecuencia práctica de separarlas es la que importa: se puede mejorar el modelo
// sin tocar el riesgo, y —más importante— se puede APRETAR EL RIESGO SIN TOCAR EL
// MODELO. Cuando las dos cosas viven en la misma función, subir un límite y mejorar una
// predicción se parecen demasiado.
//
// ===========================================================================
// LAS CINCO PUERTAS, EN ORDEN
// ===========================================================================
// Una apuesta tiene que pasar por todas. Se evalúan en este orden porque las primeras
// son las más baratas y las que más apuestas descartan:
//
//   1. ¿Hay ventaja al precio ofrecido?      → si no, cero
//   2. ¿Está el modelo lo bastante calibrado? → multiplica el tamaño, puede ser cero
//   3. Kelly fraccional (1/4 o 1/5)           → el tamaño base
//   4. Tope duro por evento                   → recorta
//   5. Límite de pérdida diario y semanal     → corta la operativa entera
//
// El paso 5 no recorta: CORTA. Un límite que reduce el tamaño en vez de parar es un
// límite que se puede cruzar apostando más veces, y entonces no es un límite.

import { getDb } from '../db.ts';
import { fractionalKelly, expectedValue, type KellyFraction } from './kelly.ts';
import { calibrationMultiplier, type CalibrationFile, readCalibration } from './calibration.ts';

export interface StakingConfig {
  /** Un cuarto o un quinto. El tipo no admite Kelly completo. */
  kellyFraction: KellyFraction;
  /** Tope duro por evento, como fracción del banco. */
  maxPerEvent: number;
  /** Pérdida diaria que corta la operativa, como fracción del banco. */
  dailyLossLimit: number;
  /** Pérdida semanal que corta la operativa, como fracción del banco. */
  weeklyLossLimit: number;
  /** Ventaja mínima al precio ofrecido para molestarse. */
  minEdge: number;
}

/**
 * Los valores por defecto, y por qué cada uno.
 *
 * kellyFraction 0.25 — un cuarto. Aguanta un error de estimación grande sin cambiar el
 *   signo del crecimiento esperado.
 *
 * maxPerEvent 0.02 — el 2 % del banco. Kelly fraccional YA limita, pero limita en
 *   función de p, y p es justo lo que puede estar mal. El tope es la red que no depende
 *   del modelo: con una p disparatada, Kelly pediría el 30 % del banco y esto lo corta
 *   en el 2 % sin necesidad de saber que la p estaba mal.
 *
 * dailyLossLimit 0.05 / weeklyLossLimit 0.10 — un mal día se aguanta; una mala semana
 *   se para. Los dos existen porque protegen de cosas distintas: el diario, de una tarde
 *   de mala suerte; el semanal, de que el modelo se haya roto sin avisar.
 *
 * minEdge 0.02 — dos puntos porcentuales. Por debajo, la diferencia entre la p del
 *   modelo y la del precio está dentro del error de las dos estimaciones.
 */
export const DEFAULT_CONFIG: StakingConfig = {
  kellyFraction: 0.25,
  maxPerEvent: 0.02,
  dailyLossLimit: 0.05,
  weeklyLossLimit: 0.1,
  minEdge: 0.02,
};

export interface StakeRequest {
  sport: string;
  /** Probabilidad del modelo para ESTA selección. */
  p: number;
  /** Cuota decimal ofrecida, con el margen de la casa dentro. */
  odds: number;
  bankroll: number;
}

export interface StakeDecision {
  /** Dinero a arriesgar. 0 significa no apostar. */
  stake: number;
  /** El mismo número como fracción del banco, que es como se piensa el riesgo. */
  fraction: number;
  /** Valor esperado por unidad al precio ofrecido. */
  edge: number;
  /** Cada paso, con lo que hizo. Es la explicación de por qué salió ese número. */
  steps: { gate: string; result: string }[];
  /** Qué paso lo dejó en cero, si alguno. */
  blockedBy: string | null;
}

/** Pérdida/ganancia realizada de una apuesta ya resuelta. */
function profitOf(row: {
  status: string;
  stake: number;
  odds: number;
  payout: number | null;
}): number {
  switch (row.status) {
    case 'won':
      return row.stake * (row.odds - 1);
    case 'lost':
      return -row.stake;
    case 'half_won':
      return (row.stake * (row.odds - 1)) / 2;
    case 'half_lost':
      return -row.stake / 2;
    case 'cashout':
      return (row.payout ?? row.stake) - row.stake;
    // pending y void no han movido dinero todavía.
    default:
      return 0;
  }
}

export interface LossState {
  today: number;
  week: number;
  dayLimit: number;
  weekLimit: number;
  dayBreached: boolean;
  weekBreached: boolean;
}

/**
 * Cuánto se lleva perdido hoy y esta semana, de las apuestas YA RESUELTAS.
 *
 * Resueltas y no pendientes: una apuesta abierta no es una pérdida, y contarla como tal
 * cortaría la operativa por partidos que todavía se están jugando. El riesgo vivo es
 * otra cosa y no es lo que estos límites gobiernan.
 *
 * La semana empieza el lunes, que es la convención con la que la gente piensa una
 * semana. No es arbitrario que esté escrito: con una ventana móvil de 7 días, el
 * límite se «renueva» un poco cada día y se puede sangrar indefinidamente sin llegar a
 * cruzarlo nunca.
 */
export function lossState(bankroll: number, cfg: StakingConfig, now = new Date()): LossState {
  const iso = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = iso(now);
  const monday = new Date(now);
  // getDay(): 0 = domingo. El lunes de esta semana está a (day + 6) % 7 días atrás.
  monday.setDate(monday.getDate() - ((now.getDay() + 6) % 7));
  const weekStart = iso(monday);

  const rows = getDb()
    .prepare(
      `SELECT placed_on, status, stake, odds, payout FROM bets
       WHERE placed_on >= ? AND status NOT IN ('pending', 'void')`,
    )
    .all(weekStart) as unknown as {
    placed_on: string;
    status: string;
    stake: number;
    odds: number;
    payout: number | null;
  }[];

  let week = 0;
  let day = 0;
  for (const r of rows) {
    const pl = profitOf(r);
    week += pl;
    if (r.placed_on === today) day += pl;
  }
  const dayLimit = -bankroll * cfg.dailyLossLimit;
  const weekLimit = -bankroll * cfg.weeklyLossLimit;
  return {
    today: day,
    week,
    dayLimit,
    weekLimit,
    dayBreached: day <= dayLimit,
    weekBreached: week <= weekLimit,
  };
}

/**
 * Cuánto arriesgar en una selección, y por qué.
 *
 * Devuelve SIEMPRE los pasos, también cuando el resultado es apostar. Un número sin la
 * cadena que lo produjo no se puede auditar, y esta es la parte del sistema donde un
 * error no se manifiesta como una excepción sino como dinero.
 */
export function decideStake(
  req: StakeRequest,
  cfg: StakingConfig = DEFAULT_CONFIG,
  cal: CalibrationFile = readCalibration(),
  now = new Date(),
): StakeDecision {
  const steps: StakeDecision['steps'] = [];
  const edge = expectedValue(req.p, req.odds);
  const zero = (gate: string): StakeDecision => ({
    stake: 0,
    fraction: 0,
    edge,
    steps,
    blockedBy: gate,
  });

  // --- 1. ¿Hay ventaja al precio ofrecido? ---
  steps.push({
    gate: '1 · ventaja al precio',
    result: `p ${(req.p * 100).toFixed(1)} % × cuota ${req.odds.toFixed(2)} = ${(edge >= 0 ? '+' : '') + (edge * 100).toFixed(2)} %`,
  });
  if (edge < cfg.minEdge) {
    steps.push({
      gate: '1 · ventaja al precio',
      result: `por debajo del mínimo de ${(cfg.minEdge * 100).toFixed(1)} % → no se apuesta`,
    });
    return zero('ventaja insuficiente');
  }

  // --- 2. Calibración del modelo ---
  const calib = calibrationMultiplier(req.sport, cal);
  steps.push({ gate: '2 · calibración', result: `×${calib.multiplier.toFixed(2)} — ${calib.reason}` });
  if (calib.multiplier <= 0) return zero('calibración insuficiente');

  // --- 3. Kelly fraccional ---
  const kelly = fractionalKelly(req.p, req.odds, cfg.kellyFraction);
  const sized = kelly * calib.multiplier;
  steps.push({
    gate: `3 · Kelly ${cfg.kellyFraction === 0.25 ? '1/4' : '1/5'}`,
    result: `${(kelly * 100).toFixed(2)} % del banco, ajustado a ${(sized * 100).toFixed(2)} % por calibración`,
  });

  // --- 4. Tope por evento ---
  const capped = Math.min(sized, cfg.maxPerEvent);
  steps.push({
    gate: '4 · tope por evento',
    result:
      capped < sized
        ? `RECORTADO del ${(sized * 100).toFixed(2)} % al ${(capped * 100).toFixed(2)} %`
        : `${(capped * 100).toFixed(2)} %, por debajo del tope del ${(cfg.maxPerEvent * 100).toFixed(1)} %`,
  });

  // --- 5. Límites de pérdida ---
  const loss = lossState(req.bankroll, cfg, now);
  steps.push({
    gate: '5 · límites de pérdida',
    result:
      `hoy ${loss.today.toFixed(2)} (límite ${loss.dayLimit.toFixed(2)}) · ` +
      `semana ${loss.week.toFixed(2)} (límite ${loss.weekLimit.toFixed(2)})`,
  });
  if (loss.dayBreached) return zero('límite de pérdida DIARIA alcanzado');
  if (loss.weekBreached) return zero('límite de pérdida SEMANAL alcanzado');

  return {
    stake: Math.round(capped * req.bankroll * 100) / 100,
    fraction: capped,
    edge,
    steps,
    blockedBy: null,
  };
}
