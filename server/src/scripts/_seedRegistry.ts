// Meter en el registro los experimentos que ya se hicieron antes de que existiera.
//
// ===========================================================================
// POR QUÉ SE APUNTAN HACIA ATRÁS
// ===========================================================================
// El registro se escribió DESPUÉS de correr una veintena de comparaciones sobre el
// mismo archivo de fútbol. Empezar a contar desde cero hoy daría un contador
// tranquilizador y falso: el listón de Bonferroni saldría dividido entre seis en vez
// de entre veintitantos, y los resultados de esta semana parecerían más sólidos de lo
// que son precisamente por haber olvidado los intentos anteriores.
//
// Así que se cargan a mano, con sus números reales tal y como salieron. Todos llevan
// `notes` diciendo que son retroactivos, porque un experimento reconstruido y uno
// registrado en el momento no merecen la misma confianza y el que los lea tiene que
// poder distinguirlos.
//
// Un aviso sobre el conjunto: estos se midieron cuando 2025 Y 2026 formaban el
// «reservado», antes de que 2026 se cerrara como holdout final. Se apuntan como
// `validation` porque es lo que eran de hecho — un conjunto que se miró muchas veces
// para elegir. Ese es justamente el problema que el holdout viene a arreglar.
//
// Se ejecuta UNA vez: `npm run seed:experiments`. Es idempotente por id.

import fs from 'node:fs';
import { recordExperiment, readRegistry, type Experiment } from '../experiments/registry.ts';

type Seed = Omit<Experiment, 'id' | 'date'>;

const RETRO = 'Registrado retroactivamente: se midió antes de que existiera el registro.';

/** El conjunto de entonces: 2025 + 2026, que es lo que se llamaba «reservado». */
const OLD_SET = { sport: 'football' as const, split: 'validation' as const, n: 7898 };
const NFL_SET = { sport: 'nfl' as const, split: 'validation' as const, n: 2750 };

const SEEDS: Seed[] = [
  {
    hypothesis: 'RD estilo Glicko encogiendo el hueco de Elo mejora el log loss',
    dataset: OLD_SET,
    features: ['glicko-rd'],
    hyperparams: { glickoWeight: 1, rdC: 105, rdPerMonth: 20 },
    metric: 'logloss',
    baseline: 'modelo publicado',
    result: { delta: 0.00008, ciLo: 0.00004, ciHi: 0.00012, p: 0.005, n: 7898 },
    verdict: 'rejected',
    notes: `${RETRO} Los cuatro pesos probados (0.25/0.5/0.75/1) empeoraban de forma monótona, así que ni se llevó al conjunto reservado. Código borrado.`,
  },
  {
    hypothesis: 'la distancia de viaje explica el residuo del visitante',
    dataset: { sport: 'football', split: 'validation', n: 6024 },
    features: ['travel-distance'],
    hyperparams: { fuente: 'jokecamp stadiums', cobertura: '21%' },
    metric: 'logloss',
    baseline: 'modelo publicado',
    // El cribado dio pendiente −0.0687 por 1.000 km con t = −2.10 → p ≈ 0.036.
    result: { delta: -0.0687, ciLo: -0.1328, ciHi: -0.0046, p: 0.036, n: 6024 },
    verdict: 'rejected',
    notes: `${RETRO} Señal real (t = −2.10, ~48 Elo por 1.000 km) pero NO se construyó: la única fuente de coordenadas alcanzable cubre el 21 % de los partidos y el 0 % de cinco ligas. Rechazado por cobertura, no por el efecto.`,
  },
  {
    hypothesis: 'Shin reparte el vig mejor que el multiplicativo',
    dataset: NFL_SET,
    features: ['devig-shin'],
    hyperparams: { metodo: 'shin', zMediana: 0.0249 },
    metric: 'logloss',
    baseline: 'de-vig multiplicativo',
    result: { delta: -0.00014, ciLo: -0.0005, ciHi: 0.00022, p: 0.45, n: 5281 },
    verdict: 'rejected',
    notes: `${RETRO} 5.281 moneylines de cierre. Gana 13 de 20 temporadas y el signo cambia entre tramos de margen. Implementación conservada: la medición está hecha en el mercado más eficiente que existe (2,72 % de margen), no en el 1X2 donde se usaría.`,
  },
  {
    hypothesis: 'el de-vig de potencia mejora sobre el multiplicativo',
    dataset: NFL_SET,
    features: ['devig-power'],
    hyperparams: { metodo: 'potencia' },
    metric: 'logloss',
    baseline: 'de-vig multiplicativo',
    result: { delta: -0.00015, ciLo: -0.00052, ciHi: 0.00021, p: 0.44, n: 5281 },
    verdict: 'rejected',
    notes: `${RETRO} Control de la comparación de Shin: si algo ganase, había que saber si era por ser Shin o por no ser proporcional.`,
  },
  {
    hypothesis: 'ELO_SIGMA_C medido (105) describe el error mejor que el 240 puesto a mano',
    dataset: { sport: 'football', split: 'validation', n: 30321 },
    features: ['reliability-band'],
    hyperparams: { eloSigmaC: 105, antes: 240 },
    metric: 'elo',
    baseline: 'ELO_SIGMA_C = 240',
    // El delta es la ESTIMACIÓN PUNTUAL (82 − 240 = −158) con su intervalo derivado
    // del de C: [55 − 240, 104 − 240]. La primera versión ponía aquí −135, que es lo
    // que se acabó publicando, y −135 cae FUERA de [−185, −136]: un intervalo que no
    // contiene su propia estimación, que es justo lo que la comprobación del registro
    // en verify:data está puesta para cazar. Lo cazó. El valor que se publica va en
    // `notes`, que es donde debe ir, porque publicar el extremo conservador es una
    // decisión de producto y no el resultado de la medición.
    result: { delta: -158, ciLo: -185, ciHi: -136, p: 0.001, n: 30321 },
    verdict: 'shipped',
    notes: `${RETRO} NO es una diferencia de log loss sino una estimación por descomposición de varianza: C = 82, IC 95 % [55, 104]. 240 predice diez veces el error observado en el tramo de pocos partidos. SE PUBLICÓ 105 —el extremo alto del intervalo, no la estimación puntual— porque quedarse corto de banda promete una precisión que no se tiene.`,
  },
  {
    hypothesis: 'el modelo de fútbol le gana al Elo pelado',
    dataset: OLD_SET,
    features: ['goal-model', 'dixon-coles', 'attack-defence'],
    hyperparams: {},
    metric: 'logloss',
    baseline: 'B3 Elo simple',
    result: { delta: -0.00472, ciLo: -0.00792, ciHi: -0.00154, p: 0.004, n: 7992 },
    verdict: 'shipped',
    notes: `${RETRO} De los 0.06303 que el modelo le saca a la constante, 0.05832 (93 %) ya los da el Elo pelado.`,
  },
  {
    hypothesis: 'el modelo de la NFL le gana a la línea de cierre',
    dataset: NFL_SET,
    features: ['nfl-full-model'],
    hyperparams: {},
    metric: 'logloss',
    baseline: 'B1 mercado (cierre sin vig)',
    result: { delta: 0.02162, ciLo: 0.01474, ciHi: 0.02837, p: 0.0036, n: 2750 },
    verdict: 'rejected',
    notes: `${RETRO} Significativamente PEOR que el mercado. Y pierde más dinero que los baselines tontos: −6,64 % contra −5,51 % y −5,12 %.`,
  },
];

const existing = new Set(readRegistry().experiments.map((e) => e.hypothesis));
let added = 0;
for (const s of SEEDS) {
  if (existing.has(s.hypothesis)) continue;
  recordExperiment(s);
  added++;
}
console.log(`${added} experimentos históricos añadidos (${SEEDS.length - added} ya estaban).`);
console.log(`Total en el registro: ${readRegistry().experiments.length}`);
void fs;
