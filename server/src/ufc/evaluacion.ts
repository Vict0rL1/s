// El backtest de la UFC en sombra (seguimiento: NHL y UFC).
//
// ===========================================================================
// EL PROTOCOLO, EL MISMO QUE EL DE LOS OTROS DEPORTES
// ===========================================================================
//     entrenamiento   1993 → 2024     se elige la configuración (rejilla) por su log loss
//     validación      2025            se mira para elegir: la elegida contra la vigente, emparejadas
//     holdout final   2026 en adelante el Elo lo recorre (sigue el calendario) pero NO se puntúa
//
// Las peleas se recorren en orden (fecha y, dentro del evento, de la primera a la estelar), y cada
// una se predice ANTES de actualizar. Qué se puntúa:
//   · solo victorias (empates y «sin resultado» no tienen ganador que acertar; el empate sí mueve el
//     Elo medio punto);
//   · solo peleas atribuidas: si un nombre lo comparten dos luchadores, la pelea no se puntúa ni
//     mueve a nadie;
//   · tras las primeras CALENTAMIENTO peleas (con todos en 1500 no dicen nada).
//
// El orden de la fuente NUNCA entra: los dos de cada pelea se ordenan por su id de ufcstats (un
// orden que no sabe nada del combate), y las referencias son simétricas.

import { getDb } from '../db.ts';
import { evaluate, type Informe, type Prediccion } from '../evaluation/metrics.ts';
import { isFinalHoldout } from '../experiments/holdout.ts';
import { pairedBootstrap } from '../experiments/registry.ts';
import { avisoMuestra, type AvisoMuestra } from '../evaluation/sample.ts';
import { UFC, actualizar, esperado, predecir, type ParamsUfc, type ResultadoUfc } from './model.ts';

export const CALENTAMIENTO = 500;
export const VALIDACION = 2025;
export const esEntrenamiento = (anio: number) => anio < VALIDACION;
export const esValidacion = (anio: number) => anio === VALIDACION;

export interface PeleaUfc {
  id: string;
  fecha: string;
  orden: number;
  luchador_a: string | null;
  luchador_b: string | null;
  resultado: ResultadoUfc;
  metodo: string | null;
  ambigua: number | boolean;
}

export function leerPeleas(): PeleaUfc[] {
  return getDb()
    .prepare('SELECT id, fecha, orden, luchador_a, luchador_b, resultado, metodo, ambigua FROM ufc_fights ORDER BY fecha, orden DESC, id')
    .all() as unknown as PeleaUfc[];
}

/** La ficha de un luchador que no cambia con el tiempo (ufc_fighters): no trae información del futuro. */
export interface FichaUfc {
  nacimiento: string | null;
  alcance_cm: number | null;
}

export function leerFichas(): Map<string, FichaUfc> {
  const filas = getDb().prepare('SELECT id, nacimiento, alcance_cm FROM ufc_fighters').all() as unknown as ({ id: string } & FichaUfc)[];
  return new Map(filas.map((f) => [f.id, { nacimiento: f.nacimiento, alcance_cm: f.alcance_cm }]));
}

/**
 * Las diferencias entre los dos (el primero por id menos el otro), con lo sabido ANTES de la pelea.
 * Lo que falta es 0, no un rasgo aparte: que falte una medida depende en parte de cuánto peleó
 * después el luchador (docs/plans/ufc-combinado.md).
 */
export interface RasgosUfc {
  /** Diferencia de Elo del modelo, en logit. */
  elo: number;
  /** logit(récord suavizado) de uno menos el del otro. */
  record: number;
  /** Diferencia de edad el día de la pelea, en décadas. */
  edad: number;
  /** Diferencia de alcance, por 10 cm. */
  alcance: number;
  /** ln(1 + peleas en la UFC) de uno menos el del otro. */
  experiencia: number;
}

/** Una pelea puntuable o no: la probabilidad de que gane el PRIMERO por id, y si ganó. */
export interface PasoUfc {
  anio: number;
  /** YYYY-MM-DD del evento. */
  fecha: string;
  /** Los dos luchadores, el primero por id delante. */
  ids: [string, string];
  /** Su Elo ANTES de la pelea, en el mismo orden. */
  elos: [number, number];
  p: number;
  y: 0 | 1;
  puntuable: boolean;
  /** Las referencias, en el mismo orden (el primero por id). */
  ref: { experiencia: number; record: number; basico: number };
  rasgos: RasgosUfc;
}

const logit = (q: number) => Math.log(q / (1 - q));
const ANIO_MS = 365.25 * 86_400_000;
/** Años cumplidos el día de la pelea (con decimales); null si no hay fecha o no es plausible. */
export function edadEn(nacimiento: string | null | undefined, fecha: string): number | null {
  if (!nacimiento) return null;
  const t = (Date.parse(fecha) - Date.parse(nacimiento)) / ANIO_MS;
  return Number.isFinite(t) && t > 14 && t < 60 ? t : null;
}

/** Lo que se sabe de un luchador antes de una pelea. */
export interface LadoUfc {
  elo: number;
  /** Peleas atribuidas en la UFC antes de esta (empates y «sin resultado» incluidos). */
  peleas: number;
  victorias: number;
  ficha: FichaUfc | undefined;
}

/** El récord suavizado (Laplace) que usan la referencia «mejor récord» y el rasgo `record`. */
export const recordSuavizado = (l: Pick<LadoUfc, 'peleas' | 'victorias'>) => (l.victorias + 1) / (l.peleas + 2);

/**
 * Los rasgos de una pelea, del primero (x) menos el segundo (z). La MISMA función para el backtest y
 * para la UFC publicada: lo que se publica es lo que se midió.
 */
export function rasgosDe(x: LadoUfc, z: LadoUfc, fecha: string): RasgosUfc {
  const edX = edadEn(x.ficha?.nacimiento, fecha);
  const edZ = edadEn(z.ficha?.nacimiento, fecha);
  const alX = x.ficha?.alcance_cm ?? null;
  const alZ = z.ficha?.alcance_cm ?? null;
  return {
    elo: ((x.elo - z.elo) * Math.LN10) / 400,
    record: logit(recordSuavizado(x)) - logit(recordSuavizado(z)),
    edad: edX != null && edZ != null ? (edX - edZ) / 10 : 0,
    alcance: alX != null && alZ != null ? (alX - alZ) / 10 : 0,
    experiencia: Math.log1p(x.peleas) - Math.log1p(z.peleas),
  };
}

export interface Recorrido {
  pasos: PasoUfc[];
  sinAtribuir: number;
  sinGanador: number;
  holdoutExcluido: number;
  /**
   * Cómo queda cada luchador tras la última pelea recorrida: lo que usa la UFC publicada para
   * predecir la siguiente. Sale de ESTE recorrido para que lo publicado sea lo medido.
   */
  estado: { elo: Map<string, number>; peleas: Map<string, number>; victorias: Map<string, number> };
}

const llBin = (p: number, y: 0 | 1) => -Math.log(Math.min(1 - 1e-12, Math.max(1e-12, y === 1 ? p : 1 - p)));

/** Recorre las peleas en orden con unos parámetros (y las referencias a la vez). Sin fichas, edad y alcance valen 0. */
export function recorrer(peleas: PeleaUfc[], p: ParamsUfc = UFC, fichas: Map<string, FichaUfc> = new Map()): Recorrido {
  const elo = new Map<string, number>();
  const basico = new Map<string, number>();
  const peleasDe = new Map<string, number>();
  const victoriasDe = new Map<string, number>();
  // Tasas históricas de las referencias, con lo visto hasta la pelea anterior.
  let expGana = 0;
  let expN = 0;
  let recGana = 0;
  let recN = 0;
  let vistos = 0;
  let sinAtribuir = 0;
  let sinGanador = 0;
  let holdoutExcluido = 0;
  const pasos: PasoUfc[] = [];
  for (const f of peleas) {
    if (f.ambigua || !f.luchador_a || !f.luchador_b || f.luchador_a === f.luchador_b) {
      sinAtribuir++;
      continue;
    }
    // El primero por id: `x`; si en la fuente era B, se le da la vuelta al resultado.
    const girar = f.luchador_b < f.luchador_a;
    const x = girar ? f.luchador_b : f.luchador_a;
    const z = girar ? f.luchador_a : f.luchador_b;
    const res: ResultadoUfc = !girar || f.resultado === 'EMPATE' || f.resultado === 'NC' ? f.resultado : f.resultado === 'A' ? 'B' : 'A';
    const ex = elo.get(x) ?? p.inicial;
    const ez = elo.get(z) ?? p.inicial;
    const nx = peleasDe.get(x) ?? 0;
    const nz = peleasDe.get(z) ?? 0;
    const rx = ((victoriasDe.get(x) ?? 0) + 1) / (nx + 2);
    const rz = ((victoriasDe.get(z) ?? 0) + 1) / (nz + 2);
    const bx = basico.get(x) ?? 1500;
    const bz = basico.get(z) ?? 1500;
    const anio = Number(f.fecha.slice(0, 4));
    if (res === 'A' || res === 'B') {
      const y: 0 | 1 = res === 'A' ? 1 : 0;
      const tExp = expN ? expGana / expN : 0.5;
      const tRec = recN ? recGana / recN : 0.5;
      const enHoldout = isFinalHoldout('ufc', anio);
      if (enHoldout) holdoutExcluido++;
      pasos.push({
        anio,
        fecha: f.fecha,
        ids: [x, z],
        elos: [ex, ez],
        p: predecir(ex, ez).a,
        y,
        puntuable: vistos >= CALENTAMIENTO && !enHoldout,
        ref: {
          experiencia: nx === nz ? 0.5 : nx > nz ? tExp : 1 - tExp,
          record: rx === rz ? 0.5 : rx > rz ? tRec : 1 - tRec,
          basico: esperado(bx - bz),
        },
        rasgos: rasgosDe(
          { elo: ex, peleas: nx, victorias: victoriasDe.get(x) ?? 0, ficha: fichas.get(x) },
          { elo: ez, peleas: nz, victorias: victoriasDe.get(z) ?? 0, ficha: fichas.get(z) },
          f.fecha,
        ),
      });
      // Las tasas de las referencias aprenden DESPUÉS de predecir.
      if (nx !== nz) {
        expN++;
        if ((nx > nz) === (y === 1)) expGana++;
      }
      if (rx !== rz) {
        recN++;
        if ((rx > rz) === (y === 1)) recGana++;
      }
      if (y === 1) victoriasDe.set(x, (victoriasDe.get(x) ?? 0) + 1);
      else victoriasDe.set(z, (victoriasDe.get(z) ?? 0) + 1);
    } else {
      sinGanador++;
    }
    const [nex, nez] = actualizar(ex, ez, res, nx, nz, f.metodo, p);
    elo.set(x, nex);
    elo.set(z, nez);
    if (res !== 'NC') {
      const s = res === 'A' ? 1 : res === 'B' ? 0 : 0.5;
      const eb = esperado(bx - bz);
      basico.set(x, bx + 32 * (s - eb));
      basico.set(z, bz - 32 * (s - eb));
    }
    peleasDe.set(x, nx + 1);
    peleasDe.set(z, nz + 1);
    vistos++;
  }
  return { pasos, sinAtribuir, sinGanador, holdoutExcluido, estado: { elo, peleas: peleasDe, victorias: victoriasDe } };
}

type Fuente = 'modelo' | keyof PasoUfc['ref'] | 'moneda';
const prob = (x: PasoUfc, f: Fuente) => (f === 'modelo' ? x.p : f === 'moneda' ? 0.5 : x.ref[f]);

/** Log loss por pelea de una fuente, en los años que se digan. El holdout nunca entra. */
export function perdidas(pasos: PasoUfc[], anios: (a: number) => boolean, f: Fuente = 'modelo'): number[] {
  return pasos.filter((x) => x.puntuable && anios(x.anio)).map((x) => llBin(prob(x, f), x.y));
}
const media = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);

export const REFERENCIAS: { clave: Exclude<Fuente, 'modelo'>; nombre: string }[] = [
  { clave: 'moneda', nombre: 'Moneda al aire (50 %)' },
  { clave: 'experiencia', nombre: 'Más peleas en la UFC (tasa histórica)' },
  { clave: 'record', nombre: 'Mejor récord en la UFC (tasa histórica)' },
  { clave: 'basico', nombre: 'Elo básico (K 32, sin debutantes ni finalizaciones)' },
];

export interface EvaluacionUfc {
  peleas: number;
  puntuadas: number;
  holdoutExcluido: number;
  sinAtribuir: number;
  sinGanador: number;
  modelo: Informe | null;
  referencias: { nombre: string; logLoss: number | null }[];
  porAnio: { anio: number; n: number; logLoss: number | null }[];
  aviso: AvisoMuestra;
  nota: string;
}

export function evaluarUfc(peleas: PeleaUfc[] = leerPeleas(), p: ParamsUfc = UFC): EvaluacionUfc {
  const r = recorrer(peleas, p);
  const xs = r.pasos.filter((x) => x.puntuable);
  const preds: Prediccion[] = xs.map((x) => ({ p: [x.p, 1 - x.p], y: x.y === 1 ? 0 : 1 }));
  const anios = [...new Set(xs.map((x) => x.anio))].sort((a, b) => a - b);
  return {
    peleas: peleas.length,
    puntuadas: xs.length,
    holdoutExcluido: r.holdoutExcluido,
    sinAtribuir: r.sinAtribuir,
    sinGanador: r.sinGanador,
    modelo: preds.length ? evaluate('backtest', 'ufc', preds) : null,
    referencias: REFERENCIAS.map((ref) => {
      const v = perdidas(r.pasos, () => true, ref.clave);
      return { nombre: ref.nombre, logLoss: v.length ? media(v) : null };
    }),
    porAnio: anios.map((anio) => {
      const v = perdidas(r.pasos, (a) => a === anio);
      return { anio, n: v.length, logLoss: v.length ? media(v) : null };
    }),
    aviso: avisoMuestra(xs.length, 'predicciones'),
    nota:
      peleas.length === 0
        ? 'sin peleas en ufc_fights: corre npm run update-data:ufc donde la red alcance raw.githubusercontent.com.'
        : 'Sombra: no se publica nada hasta que el deporte pase la misma prueba que los demás (docs/UFC.md).',
  };
}

// --- El ajuste por el registro de experimentos ---

export interface Candidato {
  params: ParamsUfc;
  llEntrenamiento: number;
}

/** La rejilla: K, cuánto más aprende el debutante y cuánto cuenta finalizar. Se elige SOLO con el entrenamiento. */
export function rejilla(peleas: PeleaUfc[]): Candidato[] {
  const out: Candidato[] = [];
  for (const k of [24, 32, 40, 48, 64, 80])
    for (const factorProvisional of [1, 1.5, 2, 3])
      for (const bonoFinalizacion of [0, 0.25, 0.5]) {
        const params = { ...UFC, k, factorProvisional, bonoFinalizacion };
        out.push({ params, llEntrenamiento: media(perdidas(recorrer(peleas, params).pasos, esEntrenamiento)) });
      }
  return out.sort((a, b) => a.llEntrenamiento - b.llEntrenamiento);
}

/** La elegida contra la vigente en la validación, emparejadas pelea a pelea. */
export function validar(peleas: PeleaUfc[], vigente: ParamsUfc, candidata: ParamsUfc) {
  const a = perdidas(recorrer(peleas, vigente).pasos, esValidacion);
  const b = perdidas(recorrer(peleas, candidata).pasos, esValidacion);
  return { n: a.length, antes: media(a), despues: media(b), ...pairedBootstrap(a, b) };
}

/**
 * La prueba para publicar (docs/UFC.md): el modelo contra cada referencia, pelea a pelea, en todo lo
 * puntuable (cada predicción hecha antes de la pelea; sin el holdout) y, aparte, solo en la validación.
 */
export function contraReferencias(peleas: PeleaUfc[], params: ParamsUfc = UFC) {
  const { pasos } = recorrer(peleas, params);
  const tramo = (anios: (a: number) => boolean) => {
    const modelo = perdidas(pasos, anios);
    return {
      n: modelo.length,
      modelo: media(modelo),
      referencias: REFERENCIAS.map((ref) => {
        const v = perdidas(pasos, anios, ref.clave);
        return { nombre: ref.nombre, ll: media(v), ...pairedBootstrap(v, modelo) };
      }),
    };
  };
  return { todo: tramo(() => true), validacion: tramo(esValidacion) };
}
