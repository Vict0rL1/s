// La capa entre el modelo y la pantalla. Tres pasos, en este orden y no en otro.
//
//     cruda  →  [1] calibrar  →  [2] mezclar con el mercado  →  [3] encoger  →  final
//
// ===========================================================================
// POR QUÉ ESE ORDEN
// ===========================================================================
// Calibrar va PRIMERO porque el peso de la mezcla se ajusta suponiendo que las dos
// entradas dicen la verdad sobre sí mismas. Si el modelo está inflado en el centro,
// mezclarlo antes de arreglarlo hace que el peso ajustado absorba dos cosas a la vez —el
// error de calibración y la falta de información— y entonces ya no significa «cuánto sé
// yo que el mercado no sepa», que es lo único que ese número debería significar.
//
// El encogimiento va DENTRO de la mezcla y no después: es el peso el que se encoge, no
// la probabilidad. Aplicarlo después sería mover la probabilidad final hacia el mercado
// una segunda vez, y ya se movió una.
//
// ===========================================================================
// LO QUE SE ENSEÑA
// ===========================================================================
// Se devuelven las DOS: la cruda y la final. No por transparencia decorativa — la cruda
// es la que dice si el modelo aporta algo. Si la final se parece siempre al mercado,
// mirar solo la final haría creer que el modelo acierta cuando lo que acierta es el
// precio que ya estaba en la pantalla.

import { applyIsotonic } from './isotonic.ts';
import { applyPlatt } from './platt.ts';
import { blend } from './blend.ts';
import { getPostprocess, type SportPostprocess } from './params.ts';

export interface PostprocessResult {
  /** Lo que dice el modelo, sin tocar. */
  raw: number[];
  /** Tras calibrar. Igual que `raw` si no hay calibrador. */
  calibrated: number[];
  /** Lo que se publica: calibrada y mezclada con el mercado si había precio y peso. */
  final: number[];
  /** Qué se aplicó de verdad, para poder decirlo en la tarjeta. */
  applied: {
    calibrator: 'platt' | 'isotonic' | 'ninguno';
    /** Peso efectivo del modelo tras encoger. `null` si no se mezcló. */
    weight: number | null;
    /** Discrepancia con el mercado, en nats. `null` si no había precio. */
    disagreement: number | null;
    /** Por qué no se mezcló, cuando no se mezcló. */
    note?: string;
  };
}

/** Renormaliza y protege de ceros: todo lo que sale de aquí es una distribución válida. */
function normalise(p: number[]): number[] {
  const clipped = p.map((x) => Math.max(1e-9, x));
  const sum = clipped.reduce((s, x) => s + x, 0);
  return clipped.map((x) => x / sum);
}

function calibrate(raw: number[], pp: SportPostprocess): number[] {
  if (pp.calibrator === 'platt' && pp.platt) return normalise(applyPlatt(pp.platt, raw));
  if (pp.calibrator === 'isotonic' && pp.isotonic && pp.isotonic.length === raw.length) {
    // Una curva por resultado y luego renormalizar: las tres curvas se ajustan por
    // separado (una-contra-el-resto) y nada garantiza que sumen 1, así que la suma se
    // impone al final. Es el precio de no suponer ninguna forma.
    return normalise(raw.map((p, k) => applyIsotonic(pp.isotonic![k], p)));
  }
  return raw;
}

/**
 * @param sport   clave del fichero de parámetros ('football', 'nfl'…)
 * @param raw     probabilidades del modelo, en el mismo orden con el que se ajustó
 * @param market  probabilidades del mercado YA SIN MARGEN, o null si no hay precio
 */
export function postprocess(
  sport: string,
  raw: number[],
  market: number[] | null,
): PostprocessResult {
  const pp = getPostprocess(sport);
  if (!pp) {
    return {
      raw,
      calibrated: raw,
      final: raw,
      applied: {
        calibrator: 'ninguno',
        weight: null,
        disagreement: null,
        note: 'sin parámetros ajustados: corre `npm run study:postprocess`',
      },
    };
  }

  const calibrated = calibrate(raw, pp);

  if (!market || !pp.blend) {
    return {
      raw,
      calibrated,
      final: calibrated,
      applied: {
        calibrator: pp.calibrator,
        weight: null,
        disagreement: market ? null : null,
        note: !market
          ? 'sin precio para este partido'
          : (pp.measured.blendNote ?? 'sin peso ajustado para este deporte'),
      },
    };
  }

  const b = blend(calibrated, normalise(market), pp.blend);
  return {
    raw,
    calibrated,
    final: normalise(b.probs),
    applied: {
      calibrator: pp.calibrator,
      weight: b.weight,
      disagreement: b.disagreement,
    },
  };
}
