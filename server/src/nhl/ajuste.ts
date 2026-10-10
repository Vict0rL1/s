// El ajuste de la NHL, por el registro de experimentos (seguimiento: NHL y UFC).
//
// ===========================================================================
// EL PROTOCOLO, EL MISMO QUE EL DE LOS OTROS DEPORTES
// ===========================================================================
//     entrenamiento   2009-10 → 2023-24   se elige la configuración (rejilla) por su log loss
//     validación      2024-25             se mira UNA vez: la elegida contra la vigente, emparejadas
//     holdout final   2025-26 en adelante el Elo lo recorre (sigue el calendario) pero NO se puntúa
//
// La probabilidad de ganar del modelo es, por construcción, la del Elo (`predecir` busca el reparto de
// goles para que coincida), así que la rejilla puntúa el moneyline con `esperado(dr)` sin pasar por la
// Poisson: mismo número, mil veces más rápido. Los totales sí necesitan la Poisson y se puntúan aparte.

import { isFinalHoldout } from '../experiments/holdout.ts';
import { pairedBootstrap } from '../experiments/registry.ts';
import { NHL, actualizar, esperado, predecir, resultado60, type ParamsNhl } from './model.ts';
import type { PartidoNhl } from './ingest.ts';
import { CALENTAMIENTO } from './evaluacion.ts';

export interface Paso {
  temporada: number;
  /** Probabilidad de que gane el local (prórroga y tanda incluidas). */
  pLocal: number;
  y: 0 | 1;
  /** Goles del marcador final (la prórroga o la tanda cuentan uno, como en el acta de la NHL). */
  total: number;
  eloLocal: number;
  eloVisitante: number;
  /** Media de goles por partido de los partidos anteriores (para los totales). */
  golesPrevios: number | null;
  puntuable: boolean;
}

const llBin = (p: number, y: 0 | 1) => -Math.log(Math.min(1 - 1e-12, Math.max(1e-12, y === 1 ? p : 1 - p)));

/** Recorre los partidos en orden con unos parámetros: predice ANTES de actualizar. */
export function recorrer(partidos: PartidoNhl[], p: ParamsNhl = NHL, ventanaGoles = 1312): Paso[] {
  const elo = new Map<string, number>();
  const pasos: Paso[] = [];
  const goles: number[] = [];
  let sumaGoles = 0;
  let temporada: number | null = null;
  let vistos = 0;
  for (const g of partidos) {
    if (temporada !== null && g.season !== temporada && p.regresion > 0) {
      // Al empezar la temporada, cada Elo vuelve una parte hacia la media de la liga.
      const vals = [...elo.values()];
      const media = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
      for (const [k, v] of elo) elo.set(k, media + (v - media) * (1 - p.regresion));
    }
    temporada = g.season;
    const eh = elo.get(g.home_id) ?? p.inicial;
    const ea = elo.get(g.away_id) ?? p.inicial;
    const y: 0 | 1 = g.home_goals > g.away_goals ? 1 : 0;
    pasos.push({
      temporada: g.season,
      pLocal: esperado(eh + p.campo - ea),
      y,
      total: g.home_goals + g.away_goals,
      eloLocal: eh,
      eloVisitante: ea,
      golesPrevios: goles.length >= Math.min(ventanaGoles, 300) ? sumaGoles / goles.length : null,
      puntuable: vistos >= CALENTAMIENTO && !isFinalHoldout('nhl', g.season),
    });
    const [nh, na] = actualizar(eh, ea, g.home_goals, g.away_goals, false, p);
    elo.set(g.home_id, nh);
    elo.set(g.away_id, na);
    goles.push(g.home_goals + g.away_goals);
    sumaGoles += g.home_goals + g.away_goals;
    if (goles.length > ventanaGoles) sumaGoles -= goles.shift()!;
    vistos++;
  }
  return pasos;
}

/** Log loss del moneyline en unas temporadas. El holdout nunca entra: `puntuable` ya lo excluye. */
export function logLossEn(pasos: Paso[], temporadas: (t: number) => boolean): { n: number; ll: number; porPartido: number[] } {
  const xs = pasos.filter((x) => x.puntuable && temporadas(x.temporada));
  const porPartido = xs.map((x) => llBin(x.pLocal, x.y));
  return { n: xs.length, ll: porPartido.reduce((a, b) => a + b, 0) / Math.max(1, xs.length), porPartido };
}

export const VALIDACION = 2024;
export const esEntrenamiento = (t: number) => t < VALIDACION;
export const esValidacion = (t: number) => t === VALIDACION;

export interface Candidato {
  params: ParamsNhl;
  llEntrenamiento: number;
}

/** La rejilla: K, ventaja de campo y vuelta a la media entre temporadas. Se elige SOLO con el entrenamiento. */
export function rejilla(partidos: PartidoNhl[]): Candidato[] {
  const out: Candidato[] = [];
  for (const k of [4, 6, 8, 10, 12, 14])
    for (const campo of [20, 35, 50, 65])
      for (const regresion of [0, 0.2, 0.33, 0.5]) {
        const params = { ...NHL, k, campo, regresion };
        out.push({ params, llEntrenamiento: logLossEn(recorrer(partidos, params), esEntrenamiento).ll });
      }
  return out.sort((a, b) => a.llEntrenamiento - b.llEntrenamiento);
}

/** La elegida contra la vigente en la validación, emparejadas partido a partido. */
export function validar(partidos: PartidoNhl[], vigente: ParamsNhl, candidata: ParamsNhl) {
  const a = logLossEn(recorrer(partidos, vigente), esValidacion);
  const b = logLossEn(recorrer(partidos, candidata), esValidacion);
  const bs = pairedBootstrap(a.porPartido, b.porPartido);
  return { n: a.n, antes: a.ll, despues: b.ll, ...bs };
}

/**
 * La media de goles a 60 minutos que reproduce una media de goles del MARCADOR FINAL: el acta suma uno
 * cuando el partido acaba empatado a 60 (prórroga o tanda), así que final = reglamentario + P(empate).
 * Se resuelve para un partido igualado, por bisección.
 */
export function golesLigaDeFinal(mediaFinal: number, maxGoles = NHL.maxGoles): number {
  let lo = 0.5;
  let hi = mediaFinal;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const f = mid + resultado60(mid / 2, mid / 2, maxGoles).empata;
    if (f < mediaFinal) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Los totales: P(goles del marcador final > línea), con la media de goles de la liga FIJA (la vigente,
 * 6.0) o la de los últimos partidos jugados. Se puntúa en la validación, emparejado.
 */
export function validarTotales(partidos: PartidoNhl[], params: ParamsNhl, linea = 5.5) {
  const pasos = recorrer(partidos, params).filter((x) => x.puntuable && esValidacion(x.temporada));
  const fija: number[] = [];
  const movil: number[] = [];
  for (const x of pasos) {
    const yOver: 0 | 1 = x.total > linea ? 1 : 0;
    fija.push(llBin(predecir(x.eloLocal, x.eloVisitante, false, params, params.golesLiga).overTotal(linea), yOver));
    const g = x.golesPrevios == null ? params.golesLiga : golesLigaDeFinal(x.golesPrevios, params.maxGoles);
    movil.push(llBin(predecir(x.eloLocal, x.eloVisitante, false, params, g).overTotal(linea), yOver));
  }
  const media = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  return { n: pasos.length, linea, fija: media(fija), movil: media(movil), ...pairedBootstrap(fija, movil) };
}

/**
 * La prueba para publicar (docs/NHL.md, paso 3): el modelo contra las dos referencias, partido a
 * partido, en todo lo puntuable (cada predicción hecha antes del partido; sin el holdout).
 */
export function contraReferencias(partidos: PartidoNhl[], params: ParamsNhl = NHL) {
  const pasos = recorrer(partidos, params);
  const basico = new Map<string, number>();
  let localGana = 0;
  let vistos = 0;
  const modelo: number[] = [];
  const local: number[] = [];
  const elo: number[] = [];
  partidos.forEach((g, i) => {
    const x = pasos[i];
    const bh = basico.get(g.home_id) ?? 1500;
    const ba = basico.get(g.away_id) ?? 1500;
    const pb = esperado(bh + params.campo - ba);
    if (x.puntuable) {
      modelo.push(llBin(x.pLocal, x.y));
      local.push(llBin(localGana / Math.max(1, vistos), x.y));
      elo.push(llBin(pb, x.y));
    }
    basico.set(g.home_id, bh + 20 * (x.y - pb));
    basico.set(g.away_id, ba - 20 * (x.y - pb));
    if (x.y === 1) localGana++;
    vistos++;
  });
  const media = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  return {
    n: modelo.length,
    modelo: media(modelo),
    referencias: [
      { nombre: 'Siempre el local (tasa histórica)', ll: media(local), ...pairedBootstrap(local, modelo) },
      { nombre: 'Elo básico (sin margen ni Poisson)', ll: media(elo), ...pairedBootstrap(elo, modelo) },
    ],
  };
}
