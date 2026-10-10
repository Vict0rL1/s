// Lo PUBLICADO de un partido: la primera predicción que se sirvió, tal como se enseñó.
//
// El registro de cada deporte (`*_prediction_log`) se escribe la primera vez que se sirve un
// partido y no se reescribe. Destacados, «¿Acertó?», el banco de papel y las estrategias leen
// de ahí. Las rutas, en cambio, calculan la predicción en cada petición, y ese cálculo se mueve
// con las cuotas y con cada ingesta: la ficha decía un número y Destacados otro (D1 de la
// revisión del 8 de octubre de 2026).
//
// Ahora la cabecera de la ficha y de la pestaña es la publicada, y lo que diría el modelo hoy
// va aparte, en `prediction.publicada.actual`, para que la tarjeta lo cuente si difiere.
//
// Las columnas son las mismas que lee `today.ts` (probSql: la enseñada si existe, la cruda si
// no). Un test comprueba que las dos lecturas coinciden.

import { getDb } from '../db.ts';
import type { SportId } from '../sports.ts';

interface Columnas {
  log: string;
  clave: string;
  /** Una expresión por resultado; con dos resultados basta la del primero (el otro es 1 − p). */
  probs: string[];
}

const COLUMNAS: Record<SportId, Columnas> = {
  football: { log: 'fb_prediction_log', clave: 'match_key', probs: ['COALESCE(shown_home, prob_home)', 'COALESCE(shown_draw, prob_draw)', 'COALESCE(shown_away, prob_away)'] },
  basketball: { log: 'bb_prediction_log', clave: 'game_key', probs: ['prob_home'] },
  baseball: { log: 'bsb_prediction_log', clave: 'match_key', probs: ['prob_home'] },
  nfl: { log: 'naf_prediction_log', clave: 'match_key', probs: ['COALESCE(shown_home, prob_home)'] },
  nhl: { log: 'nhl_prediction_log', clave: 'match_key', probs: ['COALESCE(shown_home, prob_home)'] },
  ufc: { log: 'ufc_prediction_log', clave: 'match_key', probs: ['COALESCE(shown_home, prob_home)'] },
  tennis: { log: 'prediction_log', clave: 'match_key', probs: ['prob1'] },
};

export interface Publicada {
  /** Cuándo se publicó (predicted_at del registro). */
  en: string;
  /** Las probabilidades publicadas, en el orden de la tarjeta: [local, (empate,) visitante]. */
  probs: number[];
}

/** Lo publicado de un partido, o null si todavía no se ha registrado. */
export function publicadaDe(sport: SportId, clave: string): Publicada | null {
  const c = COLUMNAS[sport];
  const sel = c.probs.map((e, i) => `${e} AS p${i}`).join(', ');
  const r = getDb().prepare(`SELECT ${sel}, predicted_at AS en FROM ${c.log} WHERE ${c.clave} = ?`).get(clave) as Record<string, number | string | null> | undefined;
  if (!r) return null;
  const ps = c.probs.map((_, i) => r[`p${i}`]);
  if (ps.some((p) => typeof p !== 'number' || !Number.isFinite(p))) return null;
  const probs = ps.length === 1 ? [ps[0] as number, 1 - (ps[0] as number)] : (ps as number[]);
  return { en: String(r.en), probs };
}

/** Diferencia (en probabilidad) a partir de la que la tarjeta dice «el modelo hoy diría…». */
export const UMBRAL_DIFIERE = 0.005;

/** Dónde lleva cada deporte su cabecera, y cómo leerla y escribirla. */
const CABECERA: Record<SportId, { leer: (p: Record<string, unknown>) => number[]; escribir: (p: Record<string, unknown>, probs: number[]) => void }> = {
  football: {
    leer: (p) => {
      const f = p.final as { home: number; draw: number; away: number };
      return [f.home, f.draw, f.away];
    },
    escribir: (p, [home, draw, away]) => {
      p.final = { ...(p.final as object), home, draw, away };
    },
  },
  basketball: {
    leer: (p) => {
      const m = p.model as { probHome: number; probAway: number };
      return [m.probHome, m.probAway];
    },
    escribir: (p, [probHome, probAway]) => {
      p.model = { ...(p.model as object), probHome, probAway };
    },
  },
  baseball: dosLados('model'),
  nfl: dosLados('final'),
  nhl: dosLados('final'),
  ufc: dosLados('final'),
  tennis: {
    leer: (p) => {
      const m = p.model as { prob1: number; prob2: number };
      return [m.prob1, m.prob2];
    },
    escribir: (p, [prob1, prob2]) => {
      p.model = { ...(p.model as object), prob1, prob2 };
    },
  },
};

function dosLados(campo: 'model' | 'final') {
  return {
    leer: (p: Record<string, unknown>) => {
      const m = p[campo] as { home: number; away: number };
      return [m.home, m.away];
    },
    escribir: (p: Record<string, unknown>, [home, away]: number[]) => {
      p[campo] = { ...(p[campo] as object), home, away };
    },
  };
}

/**
 * Pone lo publicado en la cabecera de una predicción recién calculada y deja el cálculo de
 * ahora en `prediction.publicada.actual`. Sin registro (partido de demostración, predicción
 * ajustada por el usuario, o aún sin registrar) no toca nada.
 */
export function aplicarPublicada<P extends object>(sport: SportId, clave: string | null | undefined, prediction: P): P {
  if (!clave) return prediction;
  const pub = publicadaDe(sport, clave);
  if (!pub) return prediction;
  const p = prediction as unknown as Record<string, unknown>;
  const cab = CABECERA[sport];
  const actual = cab.leer(p);
  if (actual.length !== pub.probs.length) return prediction;
  cab.escribir(p, pub.probs);
  const difiere = actual.some((x, i) => Math.abs(x - pub.probs[i]) >= UMBRAL_DIFIERE);
  p.publicada = { en: pub.en, actual, difiere };
  return prediction;
}
