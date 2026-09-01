// Cuánto se fía uno del modelo, medido — y qué le hace eso al tamaño de la apuesta.
//
// ===========================================================================
// EL PROBLEMA QUE RESUELVE
// ===========================================================================
// Kelly toma p como si fuera exacta. Nunca lo es. Y el error de Kelly no es simétrico:
// quedarse corto cuesta un poco de crecimiento, pasarse cuesta el banco. Así que la
// fracción no puede ser una constante que alguien eligió — tiene que encogerse sola
// cuando el modelo que produce esa p está peor calibrado.
//
// ===========================================================================
// CÓMO SE MIDE
// ===========================================================================
// ECE (expected calibration error): se agrupan las predicciones por probabilidad dicha,
// y en cada grupo se compara con la frecuencia real. La media ponderada de esas
// diferencias es cuánto miente el modelo, en puntos de probabilidad. Un ECE de 0.01
// significa «cuando digo 40 %, pasa el 39 % o el 41 %».
//
// Y un segundo criterio que manda sobre el primero: si donde hay mercado el modelo es
// PEOR que la línea de cierre, no importa lo bien calibrado que esté consigo mismo. Una
// probabilidad bien calibrada pero peor que la del precio que estás pagando no es una
// ventaja, es una forma cara de estar de acuerdo con el mercado.
//
// ===========================================================================
// FALLA CERRADA
// ===========================================================================
// Sin medición no hay multiplicador por defecto: hay CERO. Un módulo de riesgo que
// asume «bien» cuando no sabe es un módulo de riesgo que no sirve, y este es
// precisamente el sitio donde un valor por defecto optimista cuesta dinero real. Si
// `experiments/calibration.json` no existe, el sizing es 0 y la razón se dice.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.ts';

export const CALIBRATION_PATH = path.join(ROOT, 'experiments', 'calibration.json');

export interface SportCalibration {
  /** Expected calibration error, en probabilidad. 0.01 = 1 punto porcentual. */
  ece: number;
  /** Predicciones sobre las que se midió. */
  n: number;
  /**
   * ¿Le gana el modelo a la línea de cierre?
   *
   * `true` mejor, `false` peor, `null` no se puede saber porque no hay cuotas
   * históricas para ese deporte. Los tres casos son distintos y el null NO es un
   * «probablemente sí».
   */
  beatsMarket: boolean | null;
  /** Diferencia de log loss contra el mercado, cuando se puede medir. */
  vsMarketLogLoss: number | null;
  measuredAt: string;
}

export type CalibrationFile = Record<string, SportCalibration>;

export function readCalibration(): CalibrationFile {
  if (!fs.existsSync(CALIBRATION_PATH)) return {};
  return JSON.parse(fs.readFileSync(CALIBRATION_PATH, 'utf8')) as CalibrationFile;
}

export function writeCalibration(c: CalibrationFile): void {
  fs.mkdirSync(path.dirname(CALIBRATION_PATH), { recursive: true });
  fs.writeFileSync(CALIBRATION_PATH, JSON.stringify(c, null, 2) + '\n');
}

/**
 * ECE a partir del cual el multiplicador llega a cero.
 *
 * 5 puntos porcentuales de error medio. Un modelo que dice 40 % cuando pasa el 45 % no
 * tiene una ventaja explotable: el margen típico de una casa es de 4-5 pp, así que un
 * error de ese tamaño se come cualquier ventaja antes de empezar.
 */
export const ECE_ZERO = 0.05;

export interface CalibrationDecision {
  multiplier: number;
  reason: string;
}

/**
 * El multiplicador de tamaño que merece un deporte, y por qué.
 *
 * Devuelve siempre la razón junto al número: un 0 sin explicación en una pantalla de
 * apuestas es indistinguible de un bug, y la gente lo trata como tal.
 */
export function calibrationMultiplier(
  sport: string,
  cal: CalibrationFile = readCalibration(),
): CalibrationDecision {
  const c = cal[sport];
  if (!c) {
    return {
      multiplier: 0,
      reason:
        `Sin calibración medida para ${sport}. Este módulo falla cerrado: sin medida, ` +
        'no hay tamaño. Corre `npm run study:calibration`.',
    };
  }
  // El veredicto contra el mercado manda sobre todo lo demás.
  if (c.beatsMarket === false) {
    return {
      multiplier: 0,
      reason:
        `Medido: el modelo de ${sport} es PEOR que la línea de cierre ` +
        `(${c.vsMarketLogLoss?.toFixed(5)} de log loss sobre ${c.n.toLocaleString('es')} partidos). ` +
        'Apostar contra un precio mejor que tu propia estimación es perder por definición.',
    };
  }
  const fromEce = Math.max(0, 1 - c.ece / ECE_ZERO);
  if (fromEce <= 0) {
    return {
      multiplier: 0,
      reason: `ECE de ${(c.ece * 100).toFixed(2)} pp en ${sport}: por encima del límite de ${(ECE_ZERO * 100).toFixed(0)} pp.`,
    };
  }
  // Sin comprobar contra mercado, tope de la mitad. No es prudencia decorativa: un
  // modelo puede estar impecablemente calibrado consigo mismo y aun así ser peor que
  // el precio, que es exactamente lo que le pasa al de la NFL — bien calibrado, y
  // perdiendo dinero. Mientras no haya cuotas con las que comprobarlo, la posibilidad
  // sigue abierta y el tamaño lo refleja.
  const cap = c.beatsMarket === null ? 0.5 : 1;
  const multiplier = Math.min(fromEce, cap);
  return {
    multiplier,
    reason:
      `ECE ${(c.ece * 100).toFixed(2)} pp sobre ${c.n.toLocaleString('es')} predicciones` +
      (c.beatsMarket === null
        ? ' · sin cuotas históricas para comprobarlo contra el mercado, así que tope de la mitad'
        : ' · mejor que la línea de cierre'),
  };
}
