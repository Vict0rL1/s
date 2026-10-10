// De la predicción de cada deporte a lo que necesita la capa de confianza.
//
// Todo sale de la predicción que la app ya calcula y de la fila del partido. Lo que un
// deporte no puede saber se marca DESCONOCIDO, nunca se rellena. Los rangos plausibles de
// cada factor están escritos aquí, con su motivo, porque son supuestos y hay que poder
// discutirlos.

import type { Prediction } from '../model/predict.ts';
import type { UpcomingRow } from '../types.ts';
import type { FbPrediction } from '../football/predict.ts';
import type { FbUpcomingRow } from '../football/types.ts';
import type { GamePrediction } from '../basketball/predict.ts';
import type { UpcomingGameRow } from '../basketball/types.ts';
import type { BsbPrediction } from '../baseball/predict.ts';
import type { BsbUpcomingRow } from '../baseball/types.ts';
import type { NafPrediction } from '../nfl/predict.ts';
import type { NafUpcomingRow } from '../nfl/types.ts';
import { SPREAD_WIN_LOGIT } from '../nfl/predict.ts';
import type { NhlPrediction } from '../nhl/predict.ts';
import type { NhlUpcomingRow } from '../nhl/repo.ts';
import type { UfcPrediction } from '../ufc/predict.ts';
import type { UfcUpcomingRow } from '../ufc/repo.ts';
import { OFFSEASON_GAP_DAYS } from '../basketball/predict.ts';
import { getPlayerInfo } from '../repo.ts';
import { versionsFor } from '../versions.ts';
import { fechaDeDatos } from '../prematch/snapshots.ts';
import { deTenis, deFutbol, deBaloncesto, deBeisbol, deNfl, deNhl, deUfc } from '../prematch/adapters.ts';
import { ok, aviso, desconocido, graduado, cuotasRecientes, archivoAlDia } from './dataQuality.ts';
import type { EventoConfianza, Factor, ItemDato, Ood } from './types.ts';

const ELO = Math.LN10 / 400;
const logit = (p: number) => Math.log(Math.max(p, 1e-9) / Math.max(1 - p, 1e-9));

/** Rango por clave de factor: el supuesto y su motivo. */
const RANGOS: Record<string, { rango: [number, number]; porQue: string }> = {
  rating: { rango: [1, 1], porQue: 'el rating es la incertidumbre, no un supuesto: va aparte' },
  elo: { rango: [1, 1], porQue: 'el rating es la incertidumbre, no un supuesto: va aparte' },
  home: { rango: [0.75, 1.25], porQue: 'ventaja de campo estimada con error: ±25 %' },
  form: { rango: [0.5, 1.5], porQue: 'la forma sale de una ventana corta de partidos: ±50 %' },
  h2h: { rango: [0, 1.5], porQue: 'el cara a cara puede ser ruido de pocos partidos' },
  layoff: { rango: [0.5, 1.5], porQue: 'el efecto de la inactividad varía mucho entre jugadores' },
  rest: { rango: [0.5, 1.5], porQue: 'el efecto del descanso es medio, no el de este equipo' },
  offseason: { rango: [0.75, 1.25], porQue: 'cuánto rating cruza el verano varía por equipo' },
};

function factores(fs: { key: string; label: string; points: number }[], extra: Record<string, { rango: [number, number]; porQue: string }> = {}): Factor[] {
  return fs.map((f) => {
    const r = extra[f.key] ?? RANGOS[f.key] ?? { rango: [0.5, 1.5] as [number, number], porQue: 'sin medición específica: ±50 %' };
    return { clave: f.key, etiqueta: f.label, puntos: f.points, rango: r.rango, porQue: r.porQue };
  });
}

/** Pendiente exacta en modelos logísticos: logit(p) / Σ factores (los factores SON el argumento). */
function pendienteExacta(p0: number, fs: Factor[], defecto: number): number {
  const suma = fs.reduce((a, f) => a + f.puntos, 0);
  return Math.abs(suma) >= 5 ? logit(p0) / suma : defecto;
}

function sigmaDesdeMargen(margenPp: number, probs: number[], pendiente: number): number | null {
  const top = Math.max(...probs);
  const d = pendiente * top * (1 - top);
  return d > 0 ? margenPp / 100 / d : null;
}

const fechaDatos = (s: Parameters<typeof versionsFor>[0]) => fechaDeDatos(versionsFor(s).data_version);
const sinOdds = (id: string) => id.replace(/^odds-/, '');

// ---------------------------------------------------------------------------
// TENIS
// ---------------------------------------------------------------------------
export function confianzaTenis(row: UpcomingRow, p: Prediction, now = new Date()): EventoConfianza | null {
  const snap = deTenis(row, p);
  if (!snap) return null;
  const fs = factores(p.reasoning.factors.map((f) => ({ key: f.key, label: f.label, points: f.pointsForP1 })));
  const pend = pendienteExacta(p.model.prob1, fs, ELO);
  const escala = pend / ELO;
  const curva = (a: number, b: number) => 1 / (1 + 10 ** (((b - a) * escala) / 400));
  const componentes = [{ nombre: 'Elo general (sin superficie, forma ni H2H)', probs: [curva(p.ratings.p1.overall, p.ratings.p2.overall), 0] }];
  if (p.ratings.p1.surface != null && p.ratings.p2.surface != null) {
    componentes.push({ nombre: `Elo de superficie (${p.surface.toLowerCase()})`, probs: [curva(p.ratings.p1.surface, p.ratings.p2.surface), 0] });
  }
  componentes.push({ nombre: 'Modelo completo', probs: [p.model.prob1, 0] });
  for (const c of componentes) c.probs[1] = 1 - c.probs[0];

  const em = p.reliability.effectiveMatches;
  const minM = Math.min(em.p1, em.p2);
  const datos: ItemDato[] = [
    ['Hard', 'Clay', 'Grass'].includes(p.surface) ? ok(`Superficie confirmada (${p.surface})`, 10) : aviso(`Superficie sin confirmar (${p.surface || 'desconocida'})`, 10),
    graduado(minM, 10, 25, 25, (v) => `${Math.round(v)} partidos efectivos detrás del rating con menos historia`),
  ];
  const dias = Math.max(p.fitness.p1.daysSinceLastMatch ?? 0, p.fitness.p2.daysSinceLastMatch ?? 0);
  datos.push(dias <= 60 ? ok(`Ambos jugadores con partidos recientes (máximo ${dias} días sin jugar)`, 15) : aviso(`Un jugador lleva ${dias} días sin jugar`, 15));
  datos.push(p.h2h.total > 0 ? ok(`Cara a cara disponible (${p.h2h.total} partidos)`, 5) : aviso('Sin cara a cara previo', 5, 5));
  const r1 = row.p1_id != null ? getPlayerInfo(row.tour, row.p1_id)?.ranking : null;
  const r2 = row.p2_id != null ? getPlayerInfo(row.tour, row.p2_id)?.ranking : null;
  if (r1 && r2) {
    const viejo = [r1.date, r2.date].map((d) => (now.getTime() - Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8))) / 86_400_000);
    datos.push(Math.max(...viejo) <= 21 ? ok('Ranking oficial reciente', 5) : aviso(`Ranking oficial de hace ${Math.round(Math.max(...viejo))} días`, 5));
  } else datos.push(aviso('Sin ranking oficial de algún jugador', 5));
  const retiros = p.fitness.p1.retirements + p.fitness.p2.retirements;
  datos.push(retiros > 0 ? aviso(`${retiros} retirada(s) reciente(s): posible problema físico (no es un parte médico)`, 5) : ok('Sin retiradas recientes', 5));
  datos.push(desconocido('Lesiones: la app no tiene una fuente de partes médicos del tenis'));
  datos.push(cuotasRecientes(row.updated_at, row.source === 'fixture', now));
  datos.push(archivoAlDia(fechaDatos('tennis'), now));

  const ood: Ood[] = [];
  for (const [nombre, n] of [[row.p1_name, em.p1], [row.p2_name, em.p2]] as const) {
    if (n < 10) ood.push({ grave: true, texto: `${nombre} tiene solo ${Math.round(n)} partidos efectivos registrados` });
    else if (n < 20) ood.push({ grave: false, texto: `${nombre} tiene pocos partidos (${Math.round(n)})` });
  }
  if (dias > 180) ood.push({ grave: true, texto: `vuelve tras ${Math.round(dias / 30)} meses sin competir` });
  const mes = Number(row.commence_time.slice(5, 7));
  return {
    sport: 'tennis', matchKey: snap.matchKey, eventId: row.id, commence: row.commence_time,
    outcomes: snap.outcomes, probs: snap.probs, factores: fs, pendiente: pend, pendienteExacta: true,
    sigmaHueco: sigmaDesdeMargen(p.reliability.marginPp, snap.probs, pend),
    fiabilidad: { nivel: p.reliability.level, margenPp: p.reliability.marginPp, motivos: p.reliability.reasons },
    componentes, datos, ood,
    regimen: mes === 1 ? { etiqueta: 'inicio de temporada', nota: 'enero: ratings del curso anterior y jugadores que vuelven del parón' } : { etiqueta: 'temporada', nota: null },
    odds: snap.odds, oddsAt: row.updated_at ?? null, books: row.books,
    providerEventId: row.id, providerSelections: [row.p1_name, row.p2_name], demo: row.source === 'fixture',
  };
}

// ---------------------------------------------------------------------------
// FÚTBOL
// ---------------------------------------------------------------------------
export function confianzaFutbol(row: FbUpcomingRow, p: FbPrediction, now = new Date()): EventoConfianza | null {
  const snap = deFutbol(row, p);
  if (!snap) return null;
  const lineupsPublicadas = p.news.lineup.home != null && p.news.lineup.away != null;
  const fs = factores(p.reasoning.factors.map((f) => ({ key: f.key, label: f.label, points: f.pointsForHome })), {
    squad: lineupsPublicadas
      ? { rango: [0.75, 1.25], porQue: 'bajas confirmadas con la alineación: ±25 % por el impacto estimado' }
      : { rango: [0, 1.5], porQue: 'bajas según noticias, sin alineación publicada: pueden no jugar o pesar más' },
  });
  const homePts = p.reasoning.factors.find((f) => f.key === 'home')?.pointsForHome ?? 0;
  const e = 1 / (1 + 10 ** (-(p.teams.home.elo + homePts - p.teams.away.elo) / 400));
  const d = p.model.draw;
  const componentes = [
    { nombre: 'Elo (con el empate del modelo)', probs: [(1 - d) * e, d, (1 - d) * (1 - e)] },
    { nombre: 'Dixon-Coles (crudo)', probs: [p.model.home, p.model.draw, p.model.away] },
    { nombre: 'Publicada (calibrada)', probs: [p.final.home, p.final.draw, p.final.away] },
  ];
  const minM = Math.min(p.teams.home.matchesInDb, p.teams.away.matchesInDb);
  const horas = (Date.parse(row.commence_time) - now.getTime()) / 3_600_000;
  const datos: ItemDato[] = [
    graduado(minM, 15, 38, 25, (v) => `${v} partidos en el archivo del equipo con menos historia`),
    lineupsPublicadas
      ? ok('Alineaciones publicadas', 20)
      : horas > 1.5
        ? aviso('Alineaciones aún sin publicar (normal hasta ~1 h antes)', 20, 10)
        : aviso('Alineaciones sin publicar a menos de hora y media del inicio', 20),
    p.teams.home.seededFrom || p.teams.away.seededFrom ? aviso('Recién ascendido: su Elo viene de la división inferior', 10, 5) : ok('Ningún recién ascendido', 10),
    ok(`Campo: ${p.neutral ? 'neutral' : `${row.home_name} en casa`} (según el calendario del proveedor)`, 5),
    p.news.applied.home.length + p.news.applied.away.length + p.news.watching.home.length + p.news.watching.away.length > 0
      ? ok('Bajas y dudas consultadas en noticias', 5)
      : aviso('Sin noticias de bajas para este partido (puede no haber, o no haberse consultado)', 5, 2.5),
    cuotasRecientes(row.updated_at, row.source === 'fixture', now),
    archivoAlDia(fechaDatos('football'), now),
  ];
  const ood: Ood[] = [];
  for (const s of [p.teams.home, p.teams.away]) {
    if (!s.seededFrom && s.matchesInDb < 8) ood.push({ grave: true, texto: `${s.name} tiene solo ${s.matchesInDb} partidos en esta liga` });
    if (s.seededFrom) ood.push({ grave: false, texto: `${s.name} acaba de subir: rating trasplantado de ${s.seededFrom}` });
  }
  const mes = Number(row.commence_time.slice(5, 7));
  return {
    sport: 'football', matchKey: snap.matchKey, eventId: row.id, commence: row.commence_time,
    outcomes: snap.outcomes, probs: snap.probs, factores: fs, pendiente: ELO, pendienteExacta: false,
    sigmaHueco: sigmaDesdeMargen(p.reliability.marginPp, snap.probs, ELO),
    fiabilidad: { nivel: p.reliability.level, margenPp: p.reliability.marginPp, motivos: p.reliability.reasons },
    componentes, datos, ood,
    regimen: mes === 8 ? { etiqueta: 'inicio de temporada', nota: 'agosto: plantillas nuevas y ratings del curso anterior' } : { etiqueta: 'temporada', nota: null },
    odds: snap.odds, oddsAt: row.updated_at ?? null, books: row.books,
    providerEventId: row.id, providerSelections: [row.home_name, 'Draw', row.away_name], demo: row.source === 'fixture',
  };
}

// ---------------------------------------------------------------------------
// NBA (y demás ligas de baloncesto)
// ---------------------------------------------------------------------------
export function confianzaBaloncesto(row: UpcomingGameRow, p: GamePrediction, now = new Date()): EventoConfianza | null {
  const snap = deBaloncesto(row, p);
  if (!snap) return null;
  const fs = factores(p.reasoning.factors.map((f) => ({ key: f.key, label: f.label, points: f.pointsForHome })));
  const pend = pendienteExacta(p.model.probHome, fs, ELO);
  const minG = Math.min(p.teams.home.gamesInDb, p.teams.away.gamesInDb);
  // El modelo no lleva la cuenta de partidos de la temporada; sí sabe cuánto lleva cada
  // equipo sin jugar. Un parón mayor que OFFSEASON_GAP_DAYS es un verano: el mismo umbral
  // con el que el modelo aplica la regresión de pretemporada.
  const paron = Math.max(p.teams.home.daysRest ?? 0, p.teams.away.daysRest ?? 0);
  const trasVerano = paron > OFFSEASON_GAP_DAYS;
  const datos: ItemDato[] = [
    graduado(minG, 20, 82, 25, (v) => `${v} partidos en el archivo del equipo con menos historia`),
    p.teams.home.daysRest != null && p.teams.away.daysRest != null
      ? ok(`Descanso calculado (${p.teams.home.daysRest} y ${p.teams.away.daysRest} días)`, 15)
      : aviso('Descanso desconocido de algún equipo', 15),
    trasVerano ? aviso(`Primer partido tras ${paron} días de parón: rating del curso anterior, regresado`, 10, 5) : ok('Temporada en marcha (sin parón largo)', 10),
    desconocido('Lesiones: la app no tiene un parte de lesiones de la NBA'),
    desconocido('Alineación titular: no hay fuente'),
    desconocido('Cambios de plantilla: no hay fuente de traspasos'),
    cuotasRecientes(row.updated_at, row.source === 'fixture', now),
    archivoAlDia(fechaDatos('basketball'), now),
  ];
  const ood: Ood[] = [];
  if (minG < 20) ood.push({ grave: true, texto: `un equipo tiene solo ${minG} partidos en el archivo` });
  if (trasVerano) ood.push({ grave: false, texto: 'primer partido de la temporada: rating del curso anterior' });
  const mes = Number(row.commence_time.slice(5, 7));
  return {
    sport: 'basketball', matchKey: snap.matchKey, eventId: row.id, commence: row.commence_time,
    outcomes: snap.outcomes, probs: snap.probs, factores: fs, pendiente: pend, pendienteExacta: true,
    sigmaHueco: sigmaDesdeMargen(p.reliability.marginPp, snap.probs, pend),
    fiabilidad: { nivel: p.reliability.level, margenPp: p.reliability.marginPp, motivos: p.reliability.reasons },
    // Los mismos dos componentes que el backtest da al ensemble en sombra: el modelo y
    // el modelo sin el ajuste por descanso (quitado en el logit con la pendiente exacta).
    componentes: [
      { nombre: 'Modelo completo (crudo)', probs: [p.model.probHome, 1 - p.model.probHome] },
      { nombre: 'Modelo sin descanso', probs: (() => {
        const q = 1 / (1 + Math.exp(-(logit(p.model.probHome) - pend * (p.teams.home.restAdjustment - p.teams.away.restAdjustment))));
        return [q, 1 - q];
      })() },
    ], datos, ood,
    regimen:
      trasVerano
        ? { etiqueta: 'inicio de temporada', nota: `primer partido tras ${paron} días sin jugar` }
        : mes >= 4 && mes <= 6 && Number(row.commence_time.slice(8, 10)) >= (mes === 4 ? 15 : 1)
          ? { etiqueta: 'posibles playoffs (por fecha)', nota: 'el calendario no marca playoffs: se deduce de la fecha' }
          : { etiqueta: 'temporada regular', nota: null },
    odds: snap.odds, oddsAt: row.updated_at ?? null, books: row.books,
    providerEventId: row.id, providerSelections: [row.home_name, row.away_name], demo: row.source === 'fixture',
  };
}

// ---------------------------------------------------------------------------
// MLB
// ---------------------------------------------------------------------------
export function confianzaBeisbol(row: BsbUpcomingRow, p: BsbPrediction, now = new Date()): EventoConfianza | null {
  const snap = deBeisbol(row, p);
  if (!snap) return null;
  const ambos = !!p.teams.home.starter.name && !!p.teams.away.starter.name;
  const fs = factores(p.reasoning.factors.map((f) => ({ key: f.key, label: f.label, points: f.pointsForHome })), {
    pitching: ambos
      ? { rango: [0.7, 1.3], porQue: 'abridores anunciados; su rating es ruidoso (pocas aperturas por año): ±30 %' }
      : { rango: [0, 1.3], porQue: 'algún abridor sin anunciar: puede salir uno medio (0) o el supuesto' },
  });
  const pitch = fs.find((f) => f.clave === 'pitching')?.puntos ?? 0;
  const sinAbridores = 1 / (1 + Math.exp(-(logit(p.model.home) - ELO * pitch)));
  const minStarts = Math.min(p.teams.home.starter.starts, p.teams.away.starter.starts);
  const datos: ItemDato[] = [
    ambos ? ok('Abridores anunciados (probables de MLB, no confirmación oficial)', 25) : aviso('Algún abridor sin anunciar', 25),
    ambos ? graduado(minStarts, 3, 10, 10, (v) => `${v} aperturas del abridor con menos historia`) : aviso('Historial del abridor: sin abridor', 10),
    p.park ? ok(`Estadio conocido (${p.park.name}, factor ${p.park.factor.toFixed(2)})`, 10) : aviso('Estadio desconocido', 10),
    graduado(Math.min(p.teams.home.gamesInDb, p.teams.away.gamesInDb), 60, 162, 15, (v) => `${v} partidos del equipo con menos historia`),
    desconocido('Clima y viento: no hay previsión'),
    desconocido('Bullpen: no hay datos de uso reciente'),
    desconocido('Alineación titular: no hay fuente'),
    cuotasRecientes(row.updated_at, row.source === 'fixture', now),
    archivoAlDia(fechaDatos('baseball'), now),
  ];
  const ood: Ood[] = [];
  for (const s of [p.teams.home.starter, p.teams.away.starter]) {
    if (s.name && s.starts === 0) ood.push({ grave: true, texto: `${s.name}: abridor sin aperturas registradas (debut o sin historial)` });
    else if (s.name && s.starts < 3) ood.push({ grave: false, texto: `${s.name}: solo ${s.starts} aperturas` });
  }
  const mes = Number(row.commence_time.slice(5, 7));
  return {
    sport: 'baseball', matchKey: snap.matchKey, eventId: row.id, commence: row.commence_time,
    outcomes: snap.outcomes, probs: snap.probs, factores: fs, pendiente: ELO, pendienteExacta: false,
    sigmaHueco: sigmaDesdeMargen(p.reliability.marginPp, snap.probs, ELO),
    fiabilidad: { nivel: p.reliability.level, margenPp: p.reliability.marginPp, motivos: p.reliability.reasons },
    componentes: pitch
      ? [
          { nombre: 'Elo de equipos (sin abridores)', probs: [sinAbridores, 1 - sinAbridores] },
          { nombre: 'Modelo con abridores', probs: [p.model.home, p.model.away] },
        ]
      : [],
    datos, ood,
    regimen: mes >= 10 ? { etiqueta: 'postemporada (por fecha)', nota: null } : mes <= 4 ? { etiqueta: 'inicio de temporada', nota: 'marzo–abril' } : { etiqueta: 'temporada regular', nota: null },
    odds: snap.odds, oddsAt: row.updated_at ?? null, books: row.books,
    providerEventId: row.id, providerSelections: [row.home_name, row.away_name], demo: row.source === 'fixture',
  };
}

// ---------------------------------------------------------------------------
// NFL
// ---------------------------------------------------------------------------
export function confianzaNfl(row: NafUpcomingRow, p: NafPrediction, now = new Date()): EventoConfianza | null {
  const snap = deNfl(row, p);
  if (!snap) return null;
  const qb = [p.quarterbacks.home, p.quarterbacks.away];
  const fs = factores(p.reasoning.factors.map((f) => ({ key: f.key, label: f.label, points: f.pointsForHome })), {
    qb: { rango: [0, 1.25], porQue: 'QB SUPUESTO (el último que jugó), no confirmado: desde un titular medio hasta un 25 % más' },
  });
  const pend = SPREAD_WIN_LOGIT.b; // logit por punto de margen (la curva margen→victoria de la app)
  const qbPts = fs.find((f) => f.clave === 'qb')?.puntos ?? 0;
  const crudaHome = p.model.home / (p.model.home + p.model.away);
  const sinQb = 1 / (1 + Math.exp(-(logit(crudaHome) - pend * qbPts)));
  const cubierto = ['dome', 'closed'].includes(String(p.conditions?.roof ?? '').toLowerCase());
  const datos: ItemDato[] = [
    qb.every((q) => q?.name) ? aviso(`QB supuestos, no confirmados (${qb.map((q) => q?.name).join(' vs ')})`, 25, 12.5) : aviso('QB titular desconocido', 25),
    p.conditions?.roof ? ok(`Techo del estadio: ${p.conditions.roof}`, 5) : aviso('Techo del estadio desconocido', 5),
    cubierto ? ok('Estadio cubierto: el clima no influye', 10) : desconocido('Clima y viento: no hay previsión'),
    desconocido('Lesiones: no hay parte de lesiones'),
    ok(`Campo: ${row.neutral ? 'neutral' : `${row.home_name} en casa`}`, 5),
    graduado(Math.min(p.teams.home.gamesInDb, p.teams.away.gamesInDb), 17, 50, 15, (v) => `${v} partidos del equipo con menos historia`),
    cuotasRecientes(row.updated_at, row.source === 'fixture', now),
    archivoAlDia(fechaDatos('nfl'), now),
  ];
  const ood: Ood[] = [];
  for (const q of qb) if (q?.name && q.starts < 3) ood.push({ grave: q.starts === 0, texto: `QB ${q.name} con ${q.starts} salidas como titular` });
  if (p.reasoning.factors.some((f) => f.key === 'offseason')) ood.push({ grave: false, texto: 'primer partido tras la pretemporada: rating regresado a la media' });
  const semana = row.week ?? 0;
  return {
    sport: 'nfl', matchKey: snap.matchKey, eventId: row.id, commence: row.commence_time,
    outcomes: snap.outcomes, probs: snap.probs, factores: fs, pendiente: pend, pendienteExacta: false,
    sigmaHueco: sigmaDesdeMargen(p.reliability.marginPp, snap.probs, pend),
    fiabilidad: { nivel: p.reliability.level, margenPp: p.reliability.marginPp, motivos: p.reliability.reasons },
    componentes: [
      { nombre: 'Modelo sin QB', probs: [sinQb, 1 - sinQb] },
      { nombre: 'Modelo (margen, crudo)', probs: [crudaHome, 1 - crudaHome] },
      { nombre: 'Publicada (mezcla con mercado)', probs: [p.final.home, p.final.away] },
    ],
    datos, ood,
    regimen: semana >= 19 ? { etiqueta: 'playoffs', nota: null } : semana > 0 && semana <= 4 ? { etiqueta: 'primeras 4 semanas', nota: null } : { etiqueta: 'temporada regular', nota: null },
    odds: snap.odds, oddsAt: row.updated_at ?? null, books: row.books,
    providerEventId: sinOdds(row.id), providerSelections: [row.home_name, row.away_name], demo: row.source === 'fixture',
  };
}

// ---------------------------------------------------------------------------
// NHL
// ---------------------------------------------------------------------------
export function confianzaNhl(row: NhlUpcomingRow, p: NhlPrediction, now = new Date()): EventoConfianza | null {
  const snap = deNhl(row, p);
  if (!snap) return null;
  const fs = factores(p.reasoning.factors.map((f) => ({ key: f.key, label: f.label, points: f.pointsForHome })));
  // El moneyline ES la logística del Elo (predict busca los goles para reproducirla): pendiente exacta.
  const pend = pendienteExacta(p.model.home, fs, ELO);
  const sinCampo = 1 / (1 + 10 ** (-(p.teams.home.elo - p.teams.away.elo) / 400));
  const datos: ItemDato[] = [
    desconocido('Portero titular: el calendario no lo trae y es lo que más mueve un partido'),
    desconocido('Lesiones y bajas: no hay fuente'),
    desconocido('Partidos seguidos (back-to-back): no se miran'),
    graduado(Math.min(p.teams.home.gamesInDb, p.teams.away.gamesInDb), 40, 164, 25, (v) => `${v} partidos del equipo con menos historia`),
    ok(`Campo: ${row.home_name} en casa`, 5),
    cuotasRecientes(row.updated_at, false, now),
    archivoAlDia(fechaDatos('nhl'), now),
  ];
  const ood: Ood[] = [];
  for (const t of [p.teams.home, p.teams.away]) {
    if (t.gamesInDb < 40) ood.push({ grave: t.gamesInDb < 10, texto: `${t.name}: solo ${t.gamesInDb} partidos en el archivo` });
    if (t.lastDate && (now.getTime() - Date.parse(t.lastDate)) / 86_400_000 > 100) ood.push({ grave: false, texto: `${t.name}: primer partido tras el verano (Elo de la temporada pasada)` });
  }
  const mes = Number(row.commence_time.slice(5, 7));
  return {
    sport: 'nhl', matchKey: snap.matchKey, eventId: row.id, commence: row.commence_time,
    outcomes: snap.outcomes, probs: snap.probs, factores: fs, pendiente: pend, pendienteExacta: true,
    sigmaHueco: sigmaDesdeMargen(p.reliability.marginPp, snap.probs, pend),
    fiabilidad: { nivel: p.reliability.level, margenPp: p.reliability.marginPp, motivos: p.reliability.reasons },
    componentes: [
      { nombre: 'Elo sin ventaja de campo', probs: [sinCampo, 1 - sinCampo] },
      { nombre: 'Modelo (Elo + campo)', probs: [p.model.home, p.model.away] },
    ],
    datos, ood,
    regimen: mes >= 4 && mes <= 6 ? { etiqueta: 'final de temporada o playoffs (por fecha)', nota: null } : mes === 10 ? { etiqueta: 'inicio de temporada', nota: 'octubre: Elo del curso anterior' } : { etiqueta: 'temporada regular', nota: null },
    odds: snap.odds, oddsAt: row.updated_at ?? null, books: row.books,
    providerEventId: sinOdds(row.id), providerSelections: [row.home_name, row.away_name], demo: false,
  };
}

/**
 * La UFC. Los factores son lo que cada rasgo aporta al logit de la logística publicada, pasado a
 * puntos de Elo (÷ ln10/400) para que la pendiente sea la de un Elo y exacta: la suma de los aportes
 * ES el logit de la probabilidad.
 */
const RANGOS_UFC: Record<string, { rango: [number, number]; porQue: string }> = {
  record: { rango: [0.5, 1.5], porQue: 'peso pequeño de la logística (≈0,15), con poca señal propia además del Elo: ±50 %' },
  edad: { rango: [0.75, 1.25], porQue: 'peso estable en cada ajuste anual desde 2007 (−0,56 a −0,68 por década): ±25 %' },
  alcance: { rango: [0.5, 1.5], porQue: 'peso pequeño y sin medir por separado: ±50 %' },
  experiencia: { rango: [0.5, 1.5], porQue: 'su peso bajó de 0,43 a 0,13 entre 2007 y 2025: ±50 %' },
};

export function confianzaUfc(row: UfcUpcomingRow, p: UfcPrediction, now = new Date()): EventoConfianza | null {
  const snap = deUfc(row, p);
  if (!snap) return null;
  const fs = factores(
    p.factors.map((f) => ({ key: f.key, label: f.label, points: f.logit / ELO })),
    RANGOS_UFC,
  );
  const pend = pendienteExacta(p.model.home, fs, ELO);
  const soloElo = 1 / (1 + 10 ** (-(p.fighters.home.elo - p.fighters.away.elo) / 400));
  const A = p.fighters.home;
  const B = p.fighters.away;
  const datos: ItemDato[] = [
    desconocido('Peleas fuera de la UFC: no hay fuente (un veterano de otra organización empieza como debutante)'),
    desconocido('Lesiones, cambio de categoría y corte de peso: no hay fuente'),
    graduado(Math.min(A.fightsInDb, B.fightsInDb), 3, 8, 25, (v) => `${v} peleas en la UFC del luchador con menos historia`),
    p.rasgos.edad !== 0 ? ok('Fecha de nacimiento de los dos', 5) : aviso('Falta la fecha de nacimiento de alguno: la edad no entra', 5),
    A.reachCm != null && B.reachCm != null ? ok('Alcance de los dos', 5) : aviso('Falta el alcance de alguno: no entra', 5),
    cuotasRecientes(row.updated_at, false, now),
    archivoAlDia(fechaDatos('ufc'), now),
  ];
  const ood: Ood[] = [];
  for (const f of [A, B]) {
    if (f.fightsInDb < 3) ood.push({ grave: f.fightsInDb === 0, texto: `${f.name}: ${f.fightsInDb === 0 ? 'debuta en la UFC' : `solo ${f.fightsInDb} peleas en la UFC`}` });
    if (f.lastDate && (now.getTime() - Date.parse(f.lastDate)) / 86_400_000 > 540) ood.push({ grave: false, texto: `${f.name}: más de año y medio sin pelear en la UFC` });
  }
  return {
    sport: 'ufc', matchKey: snap.matchKey, eventId: row.id, commence: row.commence_time,
    outcomes: snap.outcomes, probs: snap.probs, factores: fs, pendiente: pend, pendienteExacta: true,
    sigmaHueco: sigmaDesdeMargen(p.reliability.marginPp, snap.probs, pend),
    fiabilidad: { nivel: p.reliability.level, margenPp: p.reliability.marginPp, motivos: p.reliability.reasons },
    componentes: [
      { nombre: 'Elo de luchador solo', probs: [soloElo, 1 - soloElo] },
      { nombre: 'Modelo (Elo + récord + edad, alcance y experiencia)', probs: [p.model.home, p.model.away] },
    ],
    datos, ood,
    regimen: { etiqueta: 'sin temporadas (la UFC pelea todo el año)', nota: null },
    odds: snap.odds, oddsAt: row.updated_at ?? null, books: row.books,
    providerEventId: sinOdds(row.id), providerSelections: [row.home_name, row.away_name], demo: false,
  };
}
