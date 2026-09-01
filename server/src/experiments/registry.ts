// El registro de experimentos: qué se probó, sobre qué datos, y cuántas veces.
//
// ===========================================================================
// EL PROBLEMA QUE RESUELVE
// ===========================================================================
// Un intervalo del 95 % significa «si esto fuera ruido, me equivocaría 1 de cada 20
// veces». Está bien para UNA comparación. Cuando llevas veinte hechas sobre los mismos
// partidos, esperas UNA falsa por pura aritmética — y esa es exactamente la que se
// publica, porque es la que salió bonita.
//
// En este proyecto ya habían pasado por el mismo archivo de fútbol: nueve valores del
// decay, cuatro pesos de Glicko, seis ablaciones, tres baselines, dos métodos de
// de-vig. Cada uno con su intervalo del 95 % citado como si fuera el único.
//
// Un registro no arregla eso por sí solo. Lo que hace es hacerlo VISIBLE: si el
// contador dice 24, el intervalo del 95 % del experimento 24 no vale lo que dice, y el
// script lo escribe en vez de dejar que el lector lo suponga.
//
// ===========================================================================
// POR QUÉ UN FICHERO VERSIONADO Y NO LA BASE DE DATOS
// ===========================================================================
// `data/tennis.db` está en .gitignore, se borra al reingerir y desaparece cuando el
// contenedor se recicla. Un registro que se puede perder no cuenta nada: el número que
// importa es «cuántas veces has mirado estos datos EN TOTAL», y ese número tiene que
// sobrevivir a todo. JSONL versionado en git: una línea por experimento, se ve en el
// diff, y no hay forma de bajar el contador sin que se note.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.ts';

export const REGISTRY_PATH = path.join(ROOT, 'experiments', 'registry.jsonl');

/**
 * Identidad del conjunto de datos.
 *
 * La corrección por comparaciones múltiples se aplica POR CONJUNTO: veinte pruebas
 * sobre el fútbol no encarecen el listón de una prueba sobre la NFL, porque no hay
 * forma de que el ruido del fútbol produzca un falso positivo en la NFL. Mezclarlos
 * sería tan incorrecto como no corregir.
 */
export interface DatasetId {
  sport: 'football' | 'nfl' | 'basketball' | 'baseball' | 'tennis';
  /** El tramo que se puntuó: 'validation' o 'holdout'. */
  split: 'validation' | 'holdout';
  /** Partidos evaluados. Va en la clave: cambiar el tamaño cambia el conjunto. */
  n: number;
}

export interface ExperimentResult {
  /** Diferencia de la métrica contra el baseline. Negativo = el candidato mejora. */
  delta: number;
  ciLo: number;
  ciHi: number;
  /** p bilateral del bootstrap emparejado. */
  p: number;
  n: number;
}

export interface Experiment {
  id: string;
  date: string;
  /** Qué se esperaba y por qué. Obligatoria: sin hipótesis esto es pesca de datos. */
  hypothesis: string;
  dataset: DatasetId;
  /** Qué estaba encendido. */
  features: string[];
  hyperparams: Record<string, number | string | boolean>;
  /**
   * En qué unidad está `delta`.
   *
   * 'elo' existe porque no todo lo que se mide es una diferencia de log loss: la
   * escala de la banda de fiabilidad se estimó en puntos Elo. Meterla en la columna de
   * log loss ponía un −135 al lado de un −0.005 y hacía ilegible la tabla entera.
   */
  metric: 'logloss' | 'brier' | 'rps' | 'roi' | 'elo';
  /** Contra qué se compara. Un delta sin baseline no significa nada. */
  baseline: string;
  result: ExperimentResult;
  verdict: 'shipped' | 'rejected' | 'inconclusive';
  notes?: string;
}

/** Una apertura del holdout final. Va en el mismo fichero, con su propio tipo. */
export interface UnlockEntry {
  kind: 'unlock';
  date: string;
  reason: string;
}

type Entry = (Experiment & { kind?: 'experiment' }) | UnlockEntry;

function append(entry: Entry): void {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.appendFileSync(REGISTRY_PATH, JSON.stringify(entry) + '\n');
}

export function recordUnlock(reason: string): void {
  append({ kind: 'unlock', date: new Date().toISOString(), reason });
}

/**
 * Apuntar un experimento.
 *
 * Se llama SIEMPRE, gane o pierda. Un registro donde solo se apuntan los aciertos
 * cuenta el denominador mal, y el denominador es justo lo que este fichero existe para
 * contar: no sirve de nada saber que el experimento 24 salió bien si los 23 fallidos
 * no están escritos en ninguna parte.
 */
export function recordExperiment(e: Omit<Experiment, 'id' | 'date'>): Experiment {
  const date = new Date().toISOString();
  const slug = e.hypothesis
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const full: Experiment = { ...e, id: `${slug}-${date.slice(0, 10)}`, date };
  append({ ...full, kind: 'experiment' });
  return full;
}

export function readRegistry(): { experiments: Experiment[]; unlocks: UnlockEntry[] } {
  if (!fs.existsSync(REGISTRY_PATH)) return { experiments: [], unlocks: [] };
  const experiments: Experiment[] = [];
  const unlocks: UnlockEntry[] = [];
  for (const line of fs.readFileSync(REGISTRY_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as Entry;
    if ((e as UnlockEntry).kind === 'unlock') unlocks.push(e as UnlockEntry);
    else experiments.push(e as Experiment);
  }
  return { experiments, unlocks };
}

/** La clave por la que se agrupan las comparaciones. */
export const datasetKey = (d: DatasetId): string => `${d.sport}/${d.split}`;

/**
 * Cuántos experimentos se han hecho ya sobre el mismo conjunto.
 *
 * Este es EL número. Es el que convierte «p = 0.03, significativo» en «p = 0.03 sobre
 * 24 intentos, o sea lo que se espera del ruido».
 */
export function familySize(d: DatasetId, registry = readRegistry().experiments): number {
  const key = datasetKey(d);
  return registry.filter((e) => datasetKey(e.dataset) === key).length;
}

// ===========================================================================
// CORRECCIÓN POR COMPARACIONES MÚLTIPLES
// ===========================================================================
// Se dan las dos, y no por indecisión: contestan preguntas distintas.
//
//   BONFERRONI controla la probabilidad de cometer AL MENOS UN error en toda la
//   familia. Es el listón que hay que pasar para poder decir «esto es real» de un
//   resultado suelto. Conservador a propósito.
//
//   BENJAMINI–HOCHBERG controla la PROPORCIÓN de falsos entre los que declaras
//   buenos. Es el listón razonable cuando lo que quieres es una lista de candidatos
//   para seguir mirando, no una afirmación definitiva sobre uno.
//
// Un resultado que pasa Bonferroni es fuerte. Uno que solo pasa BH es prometedor. Uno
// que no pasa ninguno es ruido con buena presentación.

/** El α que hay que exigirle a UN experimento dentro de una familia de k. */
export function bonferroniAlpha(k: number, alpha = 0.05): number {
  return alpha / Math.max(k, 1);
}

/**
 * Benjamini–Hochberg: qué experimentos sobreviven controlando la tasa de falsos
 * descubrimientos a `q`.
 *
 * Devuelve los índices (sobre el array de entrada) que se declaran significativos.
 */
export function benjaminiHochberg(pValues: number[], q = 0.05): Set<number> {
  const idx = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const m = idx.length;
  let cut = -1;
  for (let rank = 0; rank < m; rank++) {
    if (idx[rank].p <= ((rank + 1) / m) * q) cut = rank;
  }
  const out = new Set<number>();
  for (let rank = 0; rank <= cut; rank++) out.add(idx[rank].i);
  return out;
}

/**
 * p bilateral de un bootstrap emparejado, a partir de las diferencias remuestreadas.
 *
 * Es la proporción de remuestreos que cae al lado equivocado del cero, por dos. El
 * `+1` en numerador y denominador evita el p = 0 exacto: con 600 remuestreos lo único
 * que se puede afirmar es «menor que ~1/600», y escribir 0 sería prometer una
 * precisión que el número de remuestreos no da.
 */
export function bootstrapP(resampledDiffs: number[]): number {
  const n = resampledDiffs.length;
  // Las dos colas se cuentan con <= y >=, NO con «una es el complemento de la otra».
  // La primera versión hacía `n - count(d >= 0)` como si fuera count(d <= 0), y eso
  // solo es cierto cuando ningún remuestreo vale exactamente cero. Con una diferencia
  // idénticamente nula —una feature que está apagada y no cambia nada, que aquí hay
  // tres— TODOS valen cero: contaba 400 en una cola y 0 en la otra, y devolvía
  // p = 0.005 para la ausencia total de efecto. El resultado más nulo posible salía
  // como el más significativo de la tabla.
  const le = resampledDiffs.filter((d) => d <= 0).length;
  const ge = resampledDiffs.filter((d) => d >= 0).length;
  // El +1 evita el p = 0 exacto: con 400 remuestreos lo máximo que se puede afirmar
  // es «menor que ~1/400», y escribir 0 prometería una precisión que no se tiene.
  return Math.min(1, (2 * (Math.min(le, ge) + 1)) / (n + 1));
}
