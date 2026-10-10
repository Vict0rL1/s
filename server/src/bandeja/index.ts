// La bandeja (Fase 6.4): lo que la app avisó, dentro de la app, con leída/no leída.
//
// Entra TODO: cada notificación de `notificar()` y cada alerta de `emitirAlerta()`, haya o no un
// canal configurado. Sin canales, la bandeja es el único sitio donde se ve que el banco apostó o
// que un modelo deriva; con canales, es el sitio donde se marca qué ya se ha mirado.
//
// Nunca lanza: guardar un aviso no puede tumbar el ciclo que lo provocó.

import { getDb } from '../db.ts';
import { featureEncendida } from '../features.ts';

export { INBOX_SCHEMA } from './schema.ts';

export type Severidad = 'info' | 'aviso' | 'importante';

export interface Aviso {
  id: number;
  created_at: string;
  origen: 'notificacion' | 'alerta';
  tipo: string;
  severidad: Severidad;
  sport: string | null;
  match_key: string | null;
  titulo: string;
  cuerpo: string;
  url: string | null;
  alert_id: number | null;
  leida_at: string | null;
}

const LOGS: Record<string, { tabla: string; clave: string }> = {
  tennis: { tabla: 'prediction_log', clave: 'match_key' },
  football: { tabla: 'fb_prediction_log', clave: 'match_key' },
  basketball: { tabla: 'bb_prediction_log', clave: 'game_key' },
  baseball: { tabla: 'bsb_prediction_log', clave: 'match_key' },
  nfl: { tabla: 'naf_prediction_log', clave: 'match_key' },
  nhl: { tabla: 'nhl_prediction_log', clave: 'match_key' },
  ufc: { tabla: 'ufc_prediction_log', clave: 'match_key' },
};

/**
 * El enlace a la ficha de un partido a partir de su clave. La ficha se abre por el id de la
 * fila de próximos (lo busca en el registro de predicciones) y lleva la clave en `?clave=` para
 * que, si el partido ya no está en próximos, enseñe al menos el resultado.
 */
export function urlPartido(sport: string | null | undefined, matchKey: string | null | undefined): string | null {
  if (!sport || !matchKey) return null;
  const log = LOGS[sport];
  let id: string = matchKey;
  if (log) {
    try {
      const r = getDb().prepare(`SELECT upcoming_id AS u FROM ${log.tabla} WHERE ${log.clave} = ? LIMIT 1`).get(matchKey) as { u: string | null } | undefined;
      if (r?.u) id = r.u;
    } catch {
      // Sin registro: el enlace con la clave sirve igual para el resultado.
    }
  }
  return `/partido/${sport}/${encodeURIComponent(id)}?clave=${encodeURIComponent(matchKey)}`;
}

export function guardarEnBandeja(
  a: { origen: Aviso['origen']; tipo: string; severidad?: Severidad; sport?: string | null; matchKey?: string | null; titulo: string; cuerpo: string; url?: string | null; alertId?: number | null },
  ahora = new Date(),
): number | null {
  if (!featureEncendida('alertas.bandeja')) return null;
  try {
    const r = getDb()
      .prepare('INSERT INTO inbox (created_at, origen, tipo, severidad, sport, match_key, titulo, cuerpo, url, alert_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ahora.toISOString(), a.origen, a.tipo, a.severidad ?? 'info', a.sport ?? null, a.matchKey ?? null, a.titulo.slice(0, 200), a.cuerpo.slice(0, 2000), a.url ?? null, a.alertId ?? null);
    return Number(r.lastInsertRowid);
  } catch {
    return null;
  }
}

export interface FiltroBandeja {
  leida?: boolean;
  tipo?: string;
  sport?: string;
  /** Paginación por cursor: los anteriores a este id. */
  antesDe?: number;
  limite?: number;
}

export function listarBandeja(f: FiltroBandeja = {}): { avisos: Aviso[]; noLeidas: number; tipos: { tipo: string; n: number }[]; hayMas: boolean } {
  const db = getDb();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.leida === true) where.push('leida_at IS NOT NULL');
  if (f.leida === false) where.push('leida_at IS NULL');
  if (f.tipo) {
    where.push('tipo = ?');
    args.push(f.tipo);
  }
  if (f.sport) {
    where.push('sport = ?');
    args.push(f.sport);
  }
  if (f.antesDe) {
    where.push('id < ?');
    args.push(f.antesDe);
  }
  const limite = Math.max(1, Math.min(200, f.limite ?? 50));
  const filas = db.prepare(`SELECT * FROM inbox ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, limite + 1) as unknown as Aviso[];
  return {
    avisos: filas.slice(0, limite),
    hayMas: filas.length > limite,
    noLeidas: noLeidas(),
    tipos: db.prepare('SELECT tipo, COUNT(*) AS n FROM inbox GROUP BY tipo ORDER BY n DESC').all() as { tipo: string; n: number }[],
  };
}

export function noLeidas(): number {
  try {
    return (getDb().prepare('SELECT COUNT(*) AS n FROM inbox WHERE leida_at IS NULL').get() as { n: number }).n;
  } catch {
    return 0;
  }
}

/** Marca como leídas (o no leídas) unas cuantas, o todas. Devuelve cuántas cambiaron. */
export function marcar(objetivo: { ids?: number[]; todas?: boolean }, leida: boolean, ahora = new Date()): number {
  const db = getDb();
  const valor = leida ? ahora.toISOString() : null;
  const cond = leida ? 'leida_at IS NULL' : 'leida_at IS NOT NULL';
  if (objetivo.todas) return Number(db.prepare(`UPDATE inbox SET leida_at = ? WHERE ${cond}`).run(valor).changes);
  const ids = (objetivo.ids ?? []).filter((x) => Number.isInteger(x) && x > 0).slice(0, 500);
  if (ids.length === 0) return 0;
  return Number(db.prepare(`UPDATE inbox SET leida_at = ? WHERE ${cond} AND id IN (${ids.map(() => '?').join(',')})`).run(valor, ...ids).changes);
}
