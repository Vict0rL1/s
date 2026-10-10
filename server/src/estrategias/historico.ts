// «¿Qué habría pasado?» (Fase 6.1): una estrategia reproducida sobre el histórico con cuotas.
//
// ===========================================================================
// DE DÓNDE SALEN LOS PARTIDOS
// ===========================================================================
// Los backtests de tenis, fútbol y NFL ya recorren el histórico en orden y, para cada partido,
// tienen la probabilidad del modelo FUERA DE MUESTRA (los ratings se actualizan después de
// predecir) y la cuota histórica cuando la fuente la trae. Al correr la versión de referencia
// guardan esos partidos en `experiments/estrategias/<deporte>.json`, junto al walk-forward.
//
//   tenis    tennis-data.co.uk: media de casas al cierre.
//   NFL      nflverse: moneyline de cierre.
//   fútbol   football-data.co.uk: Pinnacle temprano y de cierre cuando están las dos (se apuesta
//            al temprano y el CLV se mide contra el cierre); si no, la cuota que haya.
//
// ===========================================================================
// LO QUE NO SE PUEDE REPRODUCIR, DICHO
// ===========================================================================
// · Con solo la cuota de cierre, el CLV es cero por construcción: se apuesta AL cierre. Se
//   devuelve DESCONOCIDO, no un 0 que parecería un resultado.
// · La capa de confianza no existía en el pasado (no hay evaluaciones guardadas de 2010): el
//   histórico aplica la política de apuestas y nada más, y lo dice.
// · El holdout final (fútbol 2026+, NFL 2024+) no entra: el fichero se escribe sin él y la
//   lectura lo vuelve a filtrar, por si alguien edita el fichero a mano.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.ts';
import { isFinalHoldout, FINAL_HOLDOUT_FROM, type EvaluationSport } from '../experiments/holdout.ts';
import { decideEvent, type StakingConfig } from '../staking/policy.ts';
import { calibrationMultiplier, readCalibration, type CalibrationFile } from '../staking/calibration.ts';
import { avisoMuestra, type AvisoMuestra } from '../evaluation/sample.ts';
import type { Juego } from '../evaluation/walkforward.ts';
import { roiDe } from '../evaluation/roi.ts';

export const DEPORTES_HISTORICO = ['tennis', 'football', 'nfl'] as const;
export type DeporteHistorico = (typeof DEPORTES_HISTORICO)[number];
export const ESTRATEGIAS_DIR = path.join(ROOT, 'experiments', 'estrategias');
const BANCO_INICIAL = 1000;

/** Un partido del histórico: [fecha, temporada, liga, y, p, cuotas, cierre|null]. */
type FilaCompacta = [string, number | null, string | null, number, number[], number[], number[] | null];

export interface FicheroHistorico {
  sport: DeporteHistorico;
  generado: string;
  fuente: string;
  modelVersion: string | null;
  holdoutDesde: number | null;
  /** Partidos con una cuota de cierre aparte de la apostada (solo fútbol con Pinnacle). */
  conCierreAparte: number;
  columnas: string[];
  juegos: FilaCompacta[];
}

export interface JuegoHistorico {
  fecha: string;
  temporada: number | null;
  liga: string | null;
  y: number;
  p: number[];
  cuotas: number[];
  cierre: number[] | null;
}

const enHoldout = (sport: string, temporada: number | null): boolean => {
  if (sport !== 'football' && sport !== 'nfl') return false;
  // Sin temporada no se puede saber de qué lado cae: fuera, por si acaso.
  return temporada == null || isFinalHoldout(sport as EvaluationSport, temporada);
};

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const r3 = (x: number) => Math.round(x * 1e3) / 1e3;
const fechaIso = (f: string) => (f.includes('-') ? f.slice(0, 10) : `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}`);

/** Los partidos del flujo de un backtest que sirven para reproducir una estrategia. */
export function juegosDeFlujo(sport: DeporteHistorico, flujo: Juego[]): JuegoHistorico[] {
  const out: JuegoHistorico[] = [];
  for (const j of flujo) {
    if (!j.modelo || j.empate || enHoldout(sport, j.temporada ?? null)) continue;
    const pin = j.pinnacle && j.pinnacle.temprana.every((o) => o > 1) && j.pinnacle.cierre.every((o) => o > 1) ? j.pinnacle : null;
    const cuotas = pin ? pin.temprana : j.cuotas;
    if (!cuotas || cuotas.length !== j.modelo.length || !cuotas.every((o) => o > 1)) continue;
    out.push({
      fecha: fechaIso(j.fecha),
      temporada: j.temporada ?? null,
      liga: j.segmento?.liga ?? (sport === 'nfl' ? 'NFL' : null),
      y: j.y,
      p: j.modelo.map(r4),
      cuotas: cuotas.map(r3),
      cierre: pin ? pin.cierre.map(r3) : null,
    });
  }
  return out.sort((a, b) => a.fecha.localeCompare(b.fecha));
}

/** Lo escribe la corrida de referencia de cada backtest. Sin partidos con cuota, no escribe nada. */
export function guardarHistorico(sport: DeporteHistorico, flujo: Juego[], meta: { fuente: string; modelVersion?: string | null }): string | null {
  const juegos = juegosDeFlujo(sport, flujo);
  if (juegos.length === 0) return null;
  fs.mkdirSync(ESTRATEGIAS_DIR, { recursive: true });
  const f: FicheroHistorico = {
    sport,
    generado: new Date().toISOString(),
    fuente: meta.fuente,
    modelVersion: meta.modelVersion ?? null,
    holdoutDesde: sport === 'tennis' ? null : FINAL_HOLDOUT_FROM[sport],
    conCierreAparte: juegos.filter((j) => j.cierre).length,
    columnas: ['fecha', 'temporada', 'liga', 'y', 'p', 'cuotas', 'cierre'],
    juegos: juegos.map((j) => [j.fecha, j.temporada, j.liga, j.y, j.p, j.cuotas, j.cierre]),
  };
  const ruta = path.join(ESTRATEGIAS_DIR, `${sport}.json`);
  // Una fila por partido: el diff de git enseña qué partidos cambiaron, no un bloque ilegible.
  const cuerpo = f.juegos.map((x) => JSON.stringify(x)).join(',\n');
  const { juegos: _j, ...cabecera } = f;
  void _j;
  fs.writeFileSync(ruta, `${JSON.stringify(cabecera, null, 1).replace(/\n}$/, '')},\n "juegos": [\n${cuerpo}\n]}\n`);
  return ruta;
}

export function leerHistorico(sport: DeporteHistorico, dir = ESTRATEGIAS_DIR): { meta: Omit<FicheroHistorico, 'juegos'>; juegos: JuegoHistorico[] } | null {
  try {
    const f = JSON.parse(fs.readFileSync(path.join(dir, `${sport}.json`), 'utf8')) as FicheroHistorico;
    const { juegos, ...meta } = f;
    return {
      meta,
      juegos: juegos
        .map(([fecha, temporada, liga, y, p, cuotas, cierre]) => ({ fecha, temporada, liga, y, p, cuotas, cierre }))
        .filter((j) => !enHoldout(sport, j.temporada)),
    };
  } catch {
    return null;
  }
}

export interface ResultadoHistorico {
  sport: DeporteHistorico;
  disponible: boolean;
  motivo: string | null;
  fuente: string | null;
  generado: string | null;
  partidos: number;
  desde: string | null;
  hasta: string | null;
  /** Temporadas cubiertas (la NFL de 2023 acaba en febrero de 2024 y sigue siendo 2023). */
  temporadas: { desde: number; hasta: number } | null;
  apuestas: number;
  ganadas: number;
  beneficio: number;
  bancoFinal: number;
  roi: number | null;
  acierto: number | null;
  drawdown: { importe: number; pct: number; desde: string | null; hasta: string | null } | null;
  /** null = DESCONOCIDO (solo hay cuota de cierre). */
  clvMedio: number | null;
  conClv: number;
  aviso: AvisoMuestra;
  curva: { fecha: string; banco: number }[];
  porTemporada: { temporada: string; apuestas: number; beneficio: number; roi: number | null }[];
  notas: string[];
}

const vacio = (sport: DeporteHistorico, motivo: string): ResultadoHistorico => ({
  sport, disponible: false, motivo, fuente: null, generado: null, partidos: 0, desde: null, hasta: null, temporadas: null, apuestas: 0, ganadas: 0,
  beneficio: 0, bancoFinal: BANCO_INICIAL, roi: null, acierto: null, drawdown: null, clvMedio: null, conClv: 0,
  aviso: avisoMuestra(0, 'apuestas'), curva: [], porTemporada: [], notas: [],
});

/** El lunes de la semana de una fecha YYYY-MM-DD. */
function lunesDe(fecha: string): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Reproduce una configuración de staking sobre los partidos de un deporte, en orden.
 *
 * Día a día: las apuestas de un día se dimensionan con el banco del inicio del día y con la
 * exposición acumulada de ese día (todas están abiertas a la vez), y se liquidan al final. Los
 * límites de pérdida diaria y semanal se aplican con lo realizado en la simulación, nunca con
 * el registro personal. Es la misma `decideEvent` que usa el banco de papel.
 */
export function reproducir(
  sport: DeporteHistorico,
  staking: StakingConfig,
  opts: { juegos?: JuegoHistorico[]; fuente?: string | null; generado?: string | null; cal?: CalibrationFile; desde?: string; hasta?: string } = {},
): ResultadoHistorico {
  let juegos = opts.juegos;
  let fuente = opts.fuente ?? null;
  let generado = opts.generado ?? null;
  if (!juegos) {
    const h = leerHistorico(sport);
    if (!h) return vacio(sport, `no hay histórico con cuotas para ${sport}: corre el backtest de referencia con datos que traigan cuotas (npm run backtest…).`);
    juegos = h.juegos;
    fuente = h.meta.fuente;
    generado = h.meta.generado;
  }
  juegos = juegos.filter((j) => !enHoldout(sport, j.temporada) && (!opts.desde || j.fecha >= opts.desde) && (!opts.hasta || j.fecha <= opts.hasta));
  if (juegos.length === 0) return vacio(sport, 'ningún partido con cuota histórica en ese rango.');
  const cal = opts.cal ?? readCalibration();
  const freno = calibrationMultiplier(sport, cal);

  let banco = BANCO_INICIAL;
  let pico = banco;
  let picoEn: string | null = null;
  let dd: ResultadoHistorico['drawdown'] = null;
  let semana = '';
  let realizadoSemana = 0;
  let apuestas = 0;
  let ganadas = 0;
  let arriesgado = 0;
  let clvSuma = 0;
  let conClv = 0;
  const curva: { fecha: string; banco: number }[] = [];
  const porTemp = new Map<string, { apuestas: number; beneficio: number; arriesgado: number }>();

  for (let i = 0; i < juegos.length; ) {
    const fecha = juegos[i].fecha;
    const lunes = lunesDe(fecha);
    if (lunes !== semana) {
      semana = lunes;
      realizadoSemana = 0;
    }
    let abierto = 0;
    let delDia = 0;
    for (; i < juegos.length && juegos[i].fecha === fecha; i++) {
      const j = juegos[i];
      const d = decideEvent(
        j.p.map((p, k) => ({ label: String(k), p, odds: j.cuotas[k] })),
        { sport, bankroll: banco, openExposure: abierto, perdidas: { hoy: 0, semana: realizadoSemana } },
        staking,
        cal,
        new Date(`${fecha}T12:00:00Z`),
      );
      if (!d || d.stake <= 0) continue;
      const k = Number(d.label);
      const gana = k === j.y;
      const beneficio = gana ? Math.round(d.stake * (j.cuotas[k] - 1) * 100) / 100 : -d.stake;
      abierto += d.stake;
      delDia += beneficio;
      apuestas++;
      arriesgado += d.stake;
      if (gana) ganadas++;
      if (j.cierre) {
        clvSuma += j.cuotas[k] / j.cierre[k] - 1;
        conClv++;
      }
      const t = String(j.temporada ?? fecha.slice(0, 4));
      const pt = porTemp.get(t) ?? { apuestas: 0, beneficio: 0, arriesgado: 0 };
      pt.apuestas++;
      pt.beneficio += beneficio;
      pt.arriesgado += d.stake;
      porTemp.set(t, pt);
    }
    if (delDia !== 0) {
      banco += delDia;
      realizadoSemana += delDia;
      if (banco > pico) {
        pico = banco;
        picoEn = fecha;
      }
      const caida = pico - banco;
      if (caida > (dd?.importe ?? 0)) dd = { importe: Math.round(caida * 100) / 100, pct: caida / pico, desde: picoEn, hasta: fecha };
      curva.push({ fecha, banco: Math.round(banco * 100) / 100 });
    }
  }

  const beneficio = banco - BANCO_INICIAL;
  const notas = [
    'Son los partidos con los que se desarrolló el modelo (entrenamiento y validación): el resultado es optimista por construcción y no sustituye al banco en vivo.',
    'La capa de confianza no se reproduce en el pasado (no hay evaluaciones históricas): solo la política de apuestas.',
    conClv === 0
      ? 'CLV DESCONOCIDO: la fuente solo trae la cuota de cierre y se apuesta a ella, así que el CLV sería cero por construcción.'
      : `CLV medido en ${conClv} apuestas con Pinnacle temprano (apostado) y de cierre.`,
  ];
  if (sport !== 'tennis') notas.push(`El holdout final (${sport === 'football' ? 'fútbol' : 'NFL'} ${FINAL_HOLDOUT_FROM[sport]}+) no entra.`);
  return {
    sport,
    disponible: true,
    motivo:
      apuestas === 0
        ? freno.multiplier <= 0
          ? `ninguna apuesta: el freno de calibración deja el tamaño en cero. ${freno.reason}`
          : 'con esta configuración no se habría apostado ningún partido.'
        : null,
    fuente,
    generado,
    partidos: juegos.length,
    desde: juegos[0].fecha,
    hasta: juegos[juegos.length - 1].fecha,
    temporadas: (() => {
      const ts = juegos.map((j) => j.temporada).filter((x): x is number => x != null);
      return ts.length ? { desde: Math.min(...ts), hasta: Math.max(...ts) } : null;
    })(),
    apuestas,
    ganadas,
    beneficio: Math.round(beneficio * 100) / 100,
    bancoFinal: Math.round(banco * 100) / 100,
    roi: roiDe(beneficio, arriesgado),
    acierto: apuestas > 0 ? ganadas / apuestas : null,
    drawdown: dd,
    clvMedio: conClv > 0 ? clvSuma / conClv : null,
    conClv,
    aviso: avisoMuestra(apuestas, 'apuestas'),
    curva: muestrear(curva, 300),
    porTemporada: [...porTemp].map(([temporada, v]) => ({ temporada, apuestas: v.apuestas, beneficio: Math.round(v.beneficio * 100) / 100, roi: roiDe(v.beneficio, v.arriesgado) })),
    notas,
  };
}

/** Como mucho `n` puntos, conservando el primero, el último y el mínimo de cada tramo. */
export function muestrear<T extends { banco: number }>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const paso = xs.length / n;
  const out: T[] = [];
  for (let k = 0; k < n; k++) {
    const tramo = xs.slice(Math.floor(k * paso), Math.max(Math.floor(k * paso) + 1, Math.floor((k + 1) * paso)));
    out.push(tramo.reduce((a, b) => (b.banco < a.banco ? b : a)));
  }
  out[out.length - 1] = xs[xs.length - 1];
  return out;
}

/** Qué deportes tienen histórico guardado, para la pantalla y el doctor. */
export function historicosDisponibles(dir = ESTRATEGIAS_DIR): { sport: DeporteHistorico; partidos: number; generado: string | null; fuente: string | null }[] {
  return DEPORTES_HISTORICO.map((sport) => {
    const h = leerHistorico(sport, dir);
    return { sport, partidos: h?.juegos.length ?? 0, generado: h?.meta.generado ?? null, fuente: h?.meta.fuente ?? null };
  });
}
