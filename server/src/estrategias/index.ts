// El laboratorio de estrategias (Fase 6.1).
//
// ===========================================================================
// QUÉ ES Y QUÉ NO ES
// ===========================================================================
// Varios bancos de papel con nombre, cada uno con su configuración (deportes, mercados,
// ventaja mínima, fracción de Kelly, topes, límites de pérdida, si respeta la capa de
// confianza). Apuestan EN PARALELO sobre las mismas candidatas que el banco principal —las
// filas del registro de predicciones con cuotas reales— y se comparan en CLV, ROI, drawdown y
// acierto con los mismos avisos de muestra que el resto de la app.
//
// No es otra forma de cambiar la política: el banco principal sigue apostando con la vigente.
// Una estrategia no se edita (cambiarla a mitad mezclaría dos hipótesis en un registro); se
// crea otra y se archiva la vieja.
//
// No toca ninguna probabilidad: lee las mismas que el banco principal, tal como se mostraron.

import { createHash } from 'node:crypto';
import { getDb } from '../db.ts';
import { featureEncendida } from '../features.ts';
import { decideEvent, desdeParaPerdidas, perdidasRealizadas, type StakingConfig } from '../staking/policy.ts';
import type { CalibrationFile } from '../staking/calibration.ts';
import { idPoliticaVigente, politica, politicaPorDefecto, validarPolitica } from '../staking/policyStore.ts';
import { roiDe } from '../evaluation/roi.ts';
import {
  BANCO_INICIAL,
  DIAS_CANCELACION,
  candidatasPapel,
  conMercadoActual,
  juicioDeConfianza,
  liquidador,
  providerId,
  type Candidato,
} from '../paper/bankroll.ts';
import { closingLine } from '../odds/snapshots.ts';
import { cabeEnGrupos, gruposDe, type Abierta } from '../staking/risk.ts';
import { anotarEnCubos, cabeEnCubos, cubosDe } from '../staking/cubos.ts';
import { avisoMuestra, type AvisoMuestra } from '../evaluation/sample.ts';
import { maxDrawdown } from '../evaluation/betting.ts';

export { STRATEGIES_SCHEMA } from './schema.ts';

export const DEPORTES_ESTRATEGIA = ['football', 'basketball', 'baseball', 'nfl', 'nhl', 'ufc', 'tennis'] as const;
/** El banco de papel solo apuesta ganador; el campo existe para cuando haya más. */
export const MERCADOS_ESTRATEGIA = ['h2h'] as const;
/** Estrategias activas a la vez: cada una es una pasada más por todas las candidatas. */
export const MAX_ACTIVAS = 12;

export interface ConfigEstrategia {
  deportes: string[];
  mercados: string[];
  staking: StakingConfig;
  /**
   * Los topes de grupo (mismo equipo, mismo jugador) congelados al crear (lote C, C5). Antes se
   * leían de la política VIGENTE en cada pasada: cambiarla en Ajustes cambiaba una estrategia ya
   * creada. Las anteriores a esto no lo tienen y usan la política de entonces.
   */
  grupos?: { maxSameTeamExposure: number; maxSamePlayerExposure: number };
  /** Si pasa por la capa de confianza (abstención y recorte), como el banco principal. */
  confianza: boolean;
  /**
   * Si respeta el freno de calibración medido (experiments/calibration.json): en un deporte donde
   * el modelo pierde contra el cierre, el tamaño es cero. Apagarlo es para estudiar ese freno.
   */
  calibracion: boolean;
}

export interface Estrategia {
  id: number;
  created_at: string;
  nombre: string;
  config: ConfigEstrategia;
  hash: string;
  nota: string | null;
  archived_at: string | null;
}

export interface PeticionEstrategia {
  nombre: string;
  nota?: string | null;
  deportes?: string[];
  mercados?: string[];
  staking?: Partial<StakingConfig>;
  confianza?: boolean;
  calibracion?: boolean;
}

const hashDe = (c: ConfigEstrategia) =>
  createHash('sha256')
    .update(JSON.stringify(c, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v)))
    .digest('hex')
    .slice(0, 16);

/** La configuración completa: la política vigente con los cambios encima. Lanza si no tiene sentido. */
export function configDe(p: PeticionEstrategia, base: StakingConfig = politica().staking): ConfigEstrategia {
  const deportes = [...new Set(p.deportes ?? [...DEPORTES_ESTRATEGIA])];
  if (deportes.length === 0) throw new Error('deportes: elige al menos uno');
  for (const d of deportes) if (!(DEPORTES_ESTRATEGIA as readonly string[]).includes(d)) throw new Error(`deportes: «${d}» no es un deporte de la app`);
  const mercados = [...new Set(p.mercados ?? ['h2h'])];
  for (const m of mercados) if (!(MERCADOS_ESTRATEGIA as readonly string[]).includes(m)) throw new Error(`mercados: «${m}» no se apuesta todavía (solo ganador, h2h)`);
  for (const k of Object.keys(p.staking ?? {})) if (!(k in base)) throw new Error(`staking.${k}: clave desconocida`);
  const staking = { ...base, ...p.staking } as StakingConfig;
  // Las mismas reglas que una versión de la política: los mismos rangos y la misma razón.
  validarPolitica({ ...politicaPorDefecto(), staking });
  const g = politica().grupos;
  return { deportes: deportes.sort(), mercados: mercados.sort(), staking, grupos: { maxSameTeamExposure: g.maxSameTeamExposure, maxSamePlayerExposure: g.maxSamePlayerExposure }, confianza: p.confianza !== false, calibracion: p.calibracion !== false };
}

/**
 * Los límites por grupo de una estrategia: su tope por partido para el evento y SUS topes de
 * equipo/jugador congelados (o los de la política vigente si es anterior a tenerlos). Un tope
 * de equipo nunca es menor que el tope por partido: existe para dos partidos abiertos del mismo
 * equipo, no para recortar una sola apuesta por debajo de lo que el banco le permite (C5).
 */
export function limitesDeEstrategia(c: ConfigEstrategia): (grupo: string) => number {
  const g = c.grupos ?? politica().grupos;
  return (grupo) =>
    grupo.startsWith('evento:')
      ? c.staking.maxPerEvent
      : grupo.startsWith('jugador:')
        ? Math.max(g.maxSamePlayerExposure, c.staking.maxPerEvent)
        : Math.max(g.maxSameTeamExposure, c.staking.maxPerEvent);
}

/**
 * Una calibración que deja el multiplicador en 1 para un deporte: lo que usa una estrategia con
 * el freno apagado. No se escribe en ningún sitio; vive lo que dura la decisión.
 */
export function sinFrenoDeCalibracion(sport: string): CalibrationFile {
  return { [sport]: { ece: 0, n: 0, beatsMarket: true, vsMarketLogLoss: null, measuredAt: 'laboratorio: freno de calibración apagado' } };
}

function fila(r: { id: number; created_at: string; nombre: string; config: string; hash: string; nota: string | null; archived_at: string | null }): Estrategia {
  return { ...r, config: JSON.parse(r.config) as ConfigEstrategia };
}

export function listarEstrategias(incluirArchivadas = true): Estrategia[] {
  const sql = `SELECT * FROM strategies ${incluirArchivadas ? '' : 'WHERE archived_at IS NULL'} ORDER BY archived_at IS NOT NULL, id`;
  return (getDb().prepare(sql).all() as Parameters<typeof fila>[0][]).map(fila);
}

export function estrategia(id: number): Estrategia | null {
  const r = getDb().prepare('SELECT * FROM strategies WHERE id = ?').get(id) as Parameters<typeof fila>[0] | undefined;
  return r ? fila(r) : null;
}

export function crearEstrategia(p: PeticionEstrategia, ahora = new Date()): Estrategia {
  const nombre = String(p.nombre ?? '').trim();
  if (nombre.length < 2 || nombre.length > 60) throw new Error('nombre: entre 2 y 60 caracteres');
  const config = configDe(p);
  const hash = hashDe(config);
  const activas = listarEstrategias(false);
  if (activas.length >= MAX_ACTIVAS) throw new Error(`ya hay ${MAX_ACTIVAS} estrategias activas: archiva alguna antes de crear otra`);
  if (activas.some((e) => e.nombre.toLowerCase() === nombre.toLowerCase())) throw new Error(`ya hay una estrategia activa llamada «${nombre}»`);
  const igual = activas.find((e) => e.hash === hash);
  if (igual) throw new Error(`la estrategia activa «${igual.nombre}» ya tiene exactamente esta configuración`);
  const nota = p.nota?.trim() ? p.nota.trim().slice(0, 500) : null;
  const r = getDb()
    .prepare('INSERT INTO strategies (created_at, nombre, config, hash, nota) VALUES (?, ?, ?, ?, ?)')
    .run(ahora.toISOString(), nombre, JSON.stringify(config), hash, nota);
  return { id: Number(r.lastInsertRowid), created_at: ahora.toISOString(), nombre, config, hash, nota, archived_at: null };
}

/** Archiva una vez. Desde entonces no apuesta; lo pendiente se sigue liquidando. */
export function archivarEstrategia(id: number, ahora = new Date()): Estrategia {
  const e = estrategia(id);
  if (!e) throw new Error(`no existe la estrategia ${id}`);
  if (e.archived_at) throw new Error(`la estrategia «${e.nombre}» ya está archivada`);
  getDb().prepare('UPDATE strategies SET archived_at = ? WHERE id = ? AND archived_at IS NULL').run(ahora.toISOString(), id);
  return { ...e, archived_at: ahora.toISOString() };
}

// ---------------------------------------------------------------------------
// EL ESTADO DE UN BANCO
// ---------------------------------------------------------------------------
export function bancoDe(id: number): number {
  const r = getDb().prepare("SELECT COALESCE(SUM(profit), 0) p FROM strategy_bets WHERE strategy_id = ? AND status <> 'pending'").get(id) as { p: number };
  return BANCO_INICIAL + r.p;
}

/**
 * Las apuestas abiertas de una estrategia con sus grupos de correlación. Las anteriores a la
 * migración 13 no los guardaron: cuentan con el de su partido (exacto desde el deporte y el id) y
 * sin equipos ni jugadores, que no se inventan.
 */
export function abiertasDe(id: number): Abierta[] {
  return (
    getDb().prepare("SELECT id, sport, event_id, stake, correlation_groups FROM strategy_bets WHERE strategy_id = ? AND status = 'pending'").all(id) as {
      id: number; sport: string; event_id: string; stake: number; correlation_groups: string | null;
    }[]
  ).map((r) => ({ id: r.id, sport: r.sport, stake: r.stake, grupos: r.correlation_groups ? (JSON.parse(r.correlation_groups) as string[]) : [`evento:${r.sport}:${r.event_id}`] }));
}

function expuestoDe(id: number): number {
  const r = getDb().prepare("SELECT COALESCE(SUM(stake), 0) s FROM strategy_bets WHERE strategy_id = ? AND status = 'pending'").get(id) as { s: number };
  return r.s;
}

/** Lo realizado hoy y esta semana (lunes a domingo, hora local), por fecha de liquidación. */
export function perdidasDe(id: number, now = new Date()): { hoy: number; semana: number } {
  const filas = getDb()
    .prepare("SELECT settled_at, profit FROM strategy_bets WHERE strategy_id = ? AND status <> 'pending' AND settled_at >= ?")
    .all(id, desdeParaPerdidas(now)) as { settled_at: string; profit: number }[];
  return perdidasRealizadas(filas, now);
}

// ---------------------------------------------------------------------------
// APOSTAR
// ---------------------------------------------------------------------------
export interface PasadaEstrategia {
  id: number;
  nombre: string;
  evaluadas: number;
  colocadas: number;
  rechazos: Record<string, number>;
}

/**
 * Una pasada de todas las estrategias activas sobre las candidatas de ahora.
 *
 * Las candidatas son las del banco principal SIN quitar lo que él ya apostó: cada estrategia
 * lleva su propio registro. Las de demostración no llegan nunca (`candidatasPapel` exige cuotas
 * reales), por la misma razón que el banco principal no apuesta contra precios inventados.
 */
export function colocarEstrategias(now = new Date(), candidatas?: Candidato[]): PasadaEstrategia[] {
  if (!featureEncendida('estrategias.laboratorio')) return [];
  const activas = listarEstrategias(false);
  if (activas.length === 0) return [];
  const todas = (candidatas ?? candidatasPapel(false)).map(conMercadoActual);
  const ventaja = (c: Candidato) => Math.max(...c.salidas.map((s) => s.p - s.pMarket));
  todas.sort((a, b) => ventaja(b) - ventaja(a));
  const ahora = now.toISOString();
  const db = getDb();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO strategy_bets (
       strategy_id, placed_at, sport, league, match_key, event_id, provider_event_id, label, selection, provider_selection,
       commence_time, p_model, p_market, odds, edge, stake, bankroll_at, kelly_fraction, trust_factor, correlation_groups, policy_version_id
     ) VALUES (?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?, ?)`,
  );
  const out: PasadaEstrategia[] = [];
  for (const e of activas) {
    const ya = new Set((db.prepare('SELECT event_id FROM strategy_bets WHERE strategy_id = ?').all(e.id) as { event_id: string }[]).map((r) => r.event_id));
    const banco = bancoDe(e.id);
    const perdidas = perdidasDe(e.id, now);
    let abierto = expuestoDe(e.id);
    // Topes por grupo de correlación (partido, equipo, jugador) sobre el banco de la estrategia: su
    // tope por partido y los de equipo y jugador de la política vigente. Solo recortan.
    const otro = { abiertas: abiertasDe(e.id), limiteDe: limitesDeEstrategia(e.config) };
    const enGrupos = new Map<string, number>();
    // Los topes por día y por liga de SU configuración (A6), con lo que ya tiene abierto.
    const cubos = cubosDe(db.prepare("SELECT commence_time, league, stake FROM strategy_bets WHERE strategy_id = ? AND status = 'pending'").all(e.id) as { commence_time: string | null; league: string | null; stake: number }[]);
    const pasada: PasadaEstrategia = { id: e.id, nombre: e.nombre, evaluadas: 0, colocadas: 0, rechazos: {} };
    const rechazo = (m: string) => (pasada.rechazos[m] = (pasada.rechazos[m] ?? 0) + 1);
    for (const c of todas) {
      if (!e.config.deportes.includes(c.sport) || ya.has(c.event_id) || c.commence <= ahora) continue;
      pasada.evaluadas++;
      const d = decideEvent(
        c.salidas.map((s) => ({ label: s.label, p: s.p, odds: s.odds })),
        { sport: c.sport, bankroll: banco, openExposure: abierto, perdidas },
        e.config.staking,
        e.config.calibracion === false ? sinFrenoDeCalibracion(c.sport) : undefined,
        now,
      );
      if (!d || d.stake <= 0) {
        rechazo(d?.blockedBy ?? 'ninguna salida con ventaja');
        continue;
      }
      let factor = 1;
      if (e.config.confianza) {
        const j = juicioDeConfianza(c, d.label, ahora);
        if (!j.apostar) {
          rechazo((j.razon ?? 'abstención').split(':')[0]);
          continue;
        }
        factor = j.factor;
      }
      const cubo = cabeEnCubos({ commence_time: c.commence, league: c.league }, banco, e.config.staking, cubos);
      if (cubo.cabe < 0.01) {
        rechazo(cubo.limitante!.split(' (')[0]);
        continue;
      }
      const grupos = gruposDe(c.sport, c.event_id, c.participantes);
      const { cabe } = cabeEnGrupos(grupos, banco, enGrupos, otro);
      const stake = Math.floor(Math.min(d.stake * factor, cabe, cubo.cabe) * 100) / 100;
      const s = c.salidas.find((x) => x.label === d.label);
      if (stake <= 0 && cabe < d.stake * factor) {
        rechazo('tope de grupo de correlación alcanzado');
        continue;
      }
      if (stake <= 0 || !s) {
        rechazo('el recorte de confianza deja el importe en cero');
        continue;
      }
      const r = ins.run(
        e.id, ahora, c.sport, c.league, c.match_key, c.event_id, providerId(c.event_id), c.label, s.label, s.proveedor,
        c.commence, s.p, s.pMarket, s.odds, d.edge, stake, banco, e.config.staking.kellyFraction, factor, JSON.stringify(grupos),
        idPoliticaVigente(),
      );
      if (Number(r.changes)) {
        for (const g of grupos) enGrupos.set(g, (enGrupos.get(g) ?? 0) + stake);
        anotarEnCubos(cubos, { commence_time: c.commence, league: c.league }, stake);
        abierto += stake;
        pasada.colocadas++;
        ya.add(c.event_id);
      }
    }
    out.push(pasada);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CERRAR Y LIQUIDAR
// ---------------------------------------------------------------------------
/** La cuota de cierre de lo que ya empezó, de los snapshots (la misma regla que el banco principal). */
export function cierreEstrategias(now = new Date()): { fijados: number } {
  const db = getDb();
  const sin = db
    .prepare('SELECT id, provider_event_id, provider_selection, commence_time, odds, placed_at FROM strategy_bets WHERE closing_odds IS NULL AND provider_event_id IS NOT NULL AND provider_selection IS NOT NULL AND commence_time IS NOT NULL AND commence_time <= ?')
    .all(now.toISOString()) as { id: number; provider_event_id: string; provider_selection: string; commence_time: string; odds: number; placed_at: string }[];
  const upd = db.prepare('UPDATE strategy_bets SET closing_odds = ?, closing_observed_at = ?, clv = ? WHERE id = ?');
  let fijados = 0;
  for (const a of sin) {
    const cl = closingLine(a.provider_event_id, 'h2h', a.provider_selection, a.commence_time);
    // Un cierre tiene que ser POSTERIOR a la apuesta (lote C, C8): si nadie volvió a pedir
    // cuotas, el «cierre» sería el snapshot con el que se apostó, y ese CLV no mide nada.
    if (!cl || cl.at <= a.placed_at) continue;
    upd.run(cl.consensus, cl.at, a.odds / cl.consensus - 1, a.id);
    fijados++;
  }
  return { fijados };
}

export function liquidarEstrategias(now = new Date()): { liquidadas: number } {
  if (!featureEncendida('estrategias.laboratorio')) return { liquidadas: 0 };
  cierreEstrategias(now);
  const db = getDb();
  const pend = db.prepare("SELECT * FROM strategy_bets WHERE status = 'pending' ORDER BY strategy_id, id").all() as {
    id: number; strategy_id: number; sport: string; match_key: string; selection: string; stake: number; odds: number; commence_time: string | null;
  }[];
  if (pend.length === 0) return { liquidadas: 0 };
  const resultado = liquidador();
  const upd = db.prepare('UPDATE strategy_bets SET status = ?, settled_at = ?, profit = ?, event_result = ?, bankroll_after = ? WHERE id = ?');
  const bancos = new Map<number, number>();
  let liquidadas = 0;
  for (const a of pend) {
    let final = resultado(a);
    if (!final) {
      if (a.commence_time && now.getTime() - Date.parse(a.commence_time) > DIAS_CANCELACION * 86_400_000) {
        final = { status: 'cancelled', resultado: `sin resultado ${DIAS_CANCELACION} días después del inicio` };
      } else continue;
    }
    const profit = final.status === 'won' ? Math.round(a.stake * (a.odds - 1) * 100) / 100 : final.status === 'lost' ? -a.stake : 0;
    const banco = (bancos.get(a.strategy_id) ?? bancoDe(a.strategy_id)) + profit;
    bancos.set(a.strategy_id, banco);
    upd.run(final.status, now.toISOString(), profit, final.resultado, Math.round(banco * 100) / 100, a.id);
    liquidadas++;
  }
  return { liquidadas };
}

// ---------------------------------------------------------------------------
// COMPARAR
// ---------------------------------------------------------------------------
export interface FilaComparacion {
  /** null = el banco principal (paper_bets, política vigente). */
  id: number | null;
  nombre: string;
  archivada: boolean;
  config: ConfigEstrategia | null;
  banco: number;
  beneficio: number;
  apuestas: number;
  liquidadas: number;
  pendientes: number;
  ganadas: number;
  perdidas: number;
  /** Beneficio / arriesgado en las liquidadas; null sin ninguna. */
  roi: number | null;
  /** Ganadas / (ganadas + perdidas); los empates devueltos no cuentan. */
  acierto: number | null;
  clvMedio: number | null;
  conCierre: number;
  drawdown: { importe: number; pct: number } | null;
  aviso: AvisoMuestra;
  /** Hay muestra para comparar esta fila con otra (≥ 30 liquidadas). */
  comparable: boolean;
  curva: { t: string; banco: number }[];
}

interface FilaApuesta {
  status: string;
  stake: number;
  profit: number | null;
  settled_at: string | null;
  clv: number | null;
}

export function resumenDe(xs: FilaApuesta[]): Omit<FilaComparacion, 'id' | 'nombre' | 'archivada' | 'config'> {
  const liq = xs.filter((a) => a.status !== 'pending').sort((a, b) => String(a.settled_at).localeCompare(String(b.settled_at)));
  const ganadas = liq.filter((a) => a.status === 'won').length;
  const perdidas = liq.filter((a) => a.status === 'lost').length;
  const arriesgado = liq.filter((a) => a.status === 'won' || a.status === 'lost').reduce((s, a) => s + a.stake, 0);
  const beneficio = liq.reduce((s, a) => s + (a.profit ?? 0), 0);
  const conClv = xs.filter((a) => a.clv != null);
  const dd = maxDrawdown(liq.map((a) => ({ profit: a.profit ?? 0, settled_at: a.settled_at })));
  let banco = BANCO_INICIAL;
  const curva = [{ t: liq[0]?.settled_at ?? new Date(0).toISOString(), banco }];
  for (const a of liq) {
    banco += a.profit ?? 0;
    curva.push({ t: a.settled_at ?? '', banco: Math.round(banco * 100) / 100 });
  }
  const aviso = avisoMuestra(liq.length, 'apuestas');
  return {
    banco: BANCO_INICIAL + beneficio,
    beneficio,
    apuestas: xs.length,
    liquidadas: liq.length,
    pendientes: xs.length - liq.length,
    ganadas,
    perdidas,
    roi: roiDe(beneficio, arriesgado),
    acierto: ganadas + perdidas > 0 ? ganadas / (ganadas + perdidas) : null,
    clvMedio: conClv.length ? conClv.reduce((s, a) => s + (a.clv as number), 0) / conClv.length : null,
    conCierre: conClv.length,
    drawdown: dd ? { importe: dd.importe, pct: dd.pct } : null,
    aviso,
    comparable: aviso.nivel !== 'insuficiente',
    curva: curva.length > 1 ? curva : [],
  };
}

/**
 * Todas las estrategias y el banco principal, lado a lado.
 *
 * El orden es el de creación, NO el de rendimiento: ordenar por ROI con once apuestas sería
 * coronar al azar. La pantalla solo resalta diferencias entre filas `comparable`.
 */
export function compararEstrategias(): { filas: FilaComparacion[]; nota: string } {
  const db = getDb();
  const principal = db.prepare('SELECT status, stake, profit, settled_at, clv FROM paper_bets').all() as unknown as FilaApuesta[];
  const filas: FilaComparacion[] = [{ id: null, nombre: 'Banco principal (política vigente)', archivada: false, config: null, ...resumenDe(principal) }];
  const sel = db.prepare('SELECT status, stake, profit, settled_at, clv FROM strategy_bets WHERE strategy_id = ?');
  for (const e of listarEstrategias(true)) {
    filas.push({ id: e.id, nombre: e.nombre, archivada: e.archived_at != null, config: e.config, ...resumenDe(sel.all(e.id) as unknown as FilaApuesta[]) });
  }
  return {
    filas,
    nota:
      'Mismas candidatas para todas: el registro de predicciones con cuotas reales. Con menos de 30 apuestas ' +
      'liquidadas una fila no se compara con otra. El CLV usa el cierre de consenso de los snapshots.',
  };
}

/** Las apuestas de una estrategia, las últimas primero. */
export function apuestasDe(id: number, limite = 100): Record<string, unknown>[] {
  return getDb().prepare('SELECT * FROM strategy_bets WHERE strategy_id = ? ORDER BY placed_at DESC, id DESC LIMIT ?').all(id, Math.min(500, limite)) as Record<string, unknown>[];
}
