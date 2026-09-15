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
// LAS SEIS PUERTAS, EN ORDEN
// ===========================================================================
// Una apuesta tiene que pasar por todas. Se evalúan en este orden porque las primeras
// son las más baratas y las que más apuestas descartan:
//
//   1. ¿Hay ventaja al precio ofrecido?      → si no, cero
//   2. ¿Está el modelo lo bastante calibrado? → multiplica el tamaño, puede ser cero
//   3. Kelly fraccional (1/4 o 1/5)           → el tamaño base
//   4. Tope duro por evento                   → recorta
//   5. Límite de pérdida diario y semanal     → corta la operativa entera
//   6. Exposición total simultánea            → recorta hasta lo que quepa
//
// El paso 5 no recorta: CORTA. Un límite que reduce el tamaño en vez de parar es un
// límite que se puede cruzar apostando más veces, y entonces no es un límite.
//
// La puerta 6 se añadió DESPUÉS, al medir: 25 candidatas al 2 % sumaban el 50 % del
// banco expuesto de golpe, y cada una decía «2 %, prudente». Kelly y el tope por evento
// dimensionan cada apuesta como si fuera la única, y en un sábado no lo es.
//
// Y una regla que no es una puerta sino una forma de entrar: `decideEvent` elige UNA
// selección por partido. Los tres lados de un 1X2 son mutuamente excluyentes y
// dimensionarlos por separado —lo que esto hacía— construía tres posiciones sobre el
// mismo partido con una rama que pierde con certeza.

import { getDb } from '../db.ts';
import {
  fractionalKelly,
  expectedValue,
  expectedLogGrowth,
  type KellyFraction,
} from './kelly.ts';
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
  /**
   * Tope de dinero EN RIESGO A LA VEZ, como fracción del banco.
   *
   * Kelly y el tope por evento dimensionan cada apuesta como si fuera la única, y en un
   * sábado no lo es. Sin esto, 25 candidatas al 2 % suman el 50 % del banco expuesto de
   * golpe — medido, no supuesto — y el sizing de cada una decía «2 %, prudente».
   */
  maxTotalExposure: number;
  /**
   * Tope de exposición por DÍA, como fracción del banco.
   *
   * Distinto del tope total y no redundante con él: el total gobierna todo lo que está
   * vivo a la vez, incluidas las apuestas de un torneo que se resuelve el jueves. Este
   * gobierna lo que se juega EN UNA TARDE, que es la unidad en la que llega una mala
   * racha — quince partidos del sábado se liquidan juntos y su resultado es un solo
   * salto del banco, no quince pasos.
   */
  maxExposurePerDay: number;
  /**
   * Tope de exposición por LIGA, como fracción del banco.
   *
   * Existe por un motivo que la medición NO respalda y hay que decirlo: se midió la
   * correlación entre partidos de una misma liga y jornada y salió indistinguible de
   * cero (ver staking/correlation.ts). Así que esto no protege de una dependencia
   * medida, protege del RIESGO DE MODELO: si el Dixon-Coles de una liga concreta está
   * roto —datos mal cargados, un ascenso mal sembrado, una temporada corta— el fallo es
   * de esa liga entera y se lleva todas sus posiciones por delante a la vez. La
   * correlación de resultados es cero; la de «que mi modelo esté equivocado» no lo es, y
   * esa no se puede estimar con los mismos datos que produjeron el modelo.
   */
  maxExposurePerLeague: number;
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
  // 10 %: cinco apuestas al tope simultáneas. Por encima de eso, una mala jornada deja
  // de ser una mala jornada.
  maxTotalExposure: 0.1,
  // 6 % en un día: tres apuestas al tope. Es menos que el total a propósito — el total
  // puede repartirse entre varios días, y el día es donde una racha se concentra.
  maxExposurePerDay: 0.06,
  // 5 % por liga: la mitad del total. Con seis ligas configuradas, obliga a que el
  // banco no dependa de que el modelo de UNA de ellas esté bien.
  maxExposurePerLeague: 0.05,
};

export interface StakeRequest {
  sport: string;
  /** Probabilidad del modelo para ESTA selección. */
  p: number;
  /** Cuota decimal ofrecida, con el margen de la casa dentro. */
  odds: number;
  bankroll: number;
  /**
   * Dinero ya comprometido y sin resolver, incluyendo lo que se acaba de decidir en
   * esta misma tanda. Por defecto se lee de las apuestas pendientes en la base.
   *
   * Se pasa explícitamente porque al dimensionar una lista hay que ir acumulando: si
   * cada llamada consultara solo la base, las veinte apuestas de la lista se
   * dimensionarían todas como si fueran la primera.
   */
  openExposure?: number;
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

  // --- 6. Exposición total simultánea ---
  const open = req.openExposure ?? pendingExposure();
  const room = Math.max(0, cfg.maxTotalExposure * req.bankroll - open);
  const wanted = capped * req.bankroll;
  // Se REDONDEA HACIA ABAJO a céntimos, no al más cercano: redondear al más cercano
  // puede subir la apuesta por encima del tope que se acaba de aplicar, que es una
  // forma pequeña y tonta de que un límite no sea un límite.
  const stake = Math.floor(Math.min(wanted, room) * 100) / 100;
  steps.push({
    gate: '6 · exposición total',
    result:
      `${open.toFixed(2)} ya en riesgo de ${(cfg.maxTotalExposure * req.bankroll).toFixed(2)} · ` +
      (stake < wanted ? `RECORTADO de ${wanted.toFixed(2)} a ${stake.toFixed(2)}` : 'cabe entera'),
  });
  if (stake <= 0) return zero('sin margen de exposición: ya hay demasiado en juego');

  return {
    stake,
    fraction: stake / req.bankroll,
    edge,
    steps,
    blockedBy: null,
  };
}

/**
 * Una sola decisión por EVENTO, no una por resultado posible.
 *
 * Este es el bug que más caro salía. Los tres resultados de un 1X2 son mutuamente
 * excluyentes: dimensionarlos por separado daba tres apuestas sobre el mismo partido
 * —medido: 20 + 11,29 + 5,48 sobre un banco de 1.000— y una de las tres ramas pierde
 * dinero con certeza. Kelly sobre resultados excluyentes es una optimización CONJUNTA,
 * no tres independientes, y hacerlo mal siempre sobreapuesta.
 *
 * La solución práctica y la que se usa: se elige UNA selección y se dimensiona esa.
 * Renuncia a la ganancia teórica de repartir entre varias, y a cambio no puede
 * construir una posición que pierde pase lo que pase.
 *
 * Y se elige por CRECIMIENTO ESPERADO, no por ventaja. Es una distinción que parece
 * cosmética y no lo es: f* = ventaja / (cuota − 1), así que una selección a cuota alta
 * puede tener más ventaja y muchísimo menos Kelly. Con estas tres —0.15, 0.131 y 0.092
 * de ventaja— el orden coincide, pero solo por casualidad: sus Kelly son 0.115, 0.045 y
 * 0.022, y bastaría una cuota más larga para que el de más ventaja fuese el de menos
 * crecimiento. Se ordena por lo que el módulo entero está maximizando.
 */
export function decideEvent(
  selections: { label: string; p: number; odds: number }[],
  base: Omit<StakeRequest, 'p' | 'odds'>,
  cfg: StakingConfig = DEFAULT_CONFIG,
  cal: CalibrationFile = readCalibration(),
  now = new Date(),
): (StakeDecision & { label: string }) | null {
  const best = bestSelection(selections, cfg);
  if (!best) return null;
  const d = decideStake({ ...base, p: best.p, odds: best.odds }, cfg, cal, now);
  return { ...d, label: best.label };
}

/**
 * Cuál de las selecciones excluyentes se elige, sin dimensionarla.
 *
 * Extraída de `decideEvent` para que el sizing de cartera pueda elegir primero y
 * dimensionar después, con todas las candidatas ya sobre la mesa. Con la regla copiada
 * en dos sitios, la lista de la cartera y la decisión individual podrían discrepar
 * sobre qué lado del mismo partido se juega, y esa clase de desacuerdo no se nota hasta
 * que el número de la pantalla y el del informe son distintos.
 */
export function bestSelection<T extends { p: number; odds: number }>(
  selections: T[],
  cfg: StakingConfig = DEFAULT_CONFIG,
): T | null {
  if (selections.length === 0) return null;
  const growth = (s: { p: number; odds: number }): number =>
    expectedLogGrowth(s.p, s.odds, fractionalKelly(s.p, s.odds, cfg.kellyFraction));
  let best = selections[0];
  for (const s of selections) {
    if (growth(s) > growth(best)) best = s;
  }
  return best;
}

/**
 * Dinero comprometido en apuestas todavía sin resolver.
 *
 * `pending` únicamente: una apuesta resuelta ya no está en riesgo, esté ganada o
 * perdida, y contarla aquí bloquearía la operativa por dinero que ya volvió.
 */
export function pendingExposure(): number {
  const row = getDb()
    .prepare(`SELECT COALESCE(SUM(stake), 0) AS s FROM bets WHERE status = 'pending'`)
    .get() as unknown as { s: number };
  return row.s;
}

/**
 * Lo pendiente, partido por día y por liga.
 *
 * Un único total no puede gobernar tres topes distintos: 8 % repartido entre cuatro
 * ligas y cuatro días es una cartera; el mismo 8 % en una liga y un sábado es una sola
 * apuesta disfrazada de cuatro.
 */
export function exposureBreakdown(): {
  total: number;
  byDay: Map<string, number>;
  byLeague: Map<string, number>;
} {
  const rows = getDb()
    .prepare(`SELECT placed_on, league, stake FROM bets WHERE status = 'pending'`)
    .all() as unknown as { placed_on: string; league: string | null; stake: number }[];
  const byDay = new Map<string, number>();
  const byLeague = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    total += r.stake;
    byDay.set(r.placed_on, (byDay.get(r.placed_on) ?? 0) + r.stake);
    // Sin liga van a un cubo propio y no se reparten: meterlas en «todas» inventaría
    // exposición donde no la hay, y descartarlas la escondería.
    const lg = r.league ?? '(sin liga)';
    byLeague.set(lg, (byLeague.get(lg) ?? 0) + r.stake);
  }
  return { total, byDay, byLeague };
}
