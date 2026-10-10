import { pct as pctFormato, num } from '../../lib/formato';
// Tipos y utilidades de Destacados (partido de TopPicks.tsx en la Fase 5).
import type { SportId } from '../../lib/theme';

export interface Opcion {
  nombre: string;
  p: number;
  cuota: number | null;
}
export interface Pick {
  deporte: string;
  sport: SportId;
  matchKey: string;
  eventoId: string;
  liga: string | null;
  cuando: string;
  partido: string;
  casa: string;
  fuera: string;
  casaId: string | null;
  fueraId: string | null;
  opciones: Opcion[];
  favorito: string;
  probabilidad: number;
  cuota: number | null;
  cuotaJusta: number;
  ventaja: number | null;
  casas: number | null;
  fiabilidad: string | null;
  confianza: {
    nivel: 'ALTA' | 'MEDIA' | 'BAJA';
    calidadDatos: number;
    estabilidad: string;
    desacuerdo: string;
    incertidumbrePp: number;
    decision: 'BET' | 'NO BET' | 'SIN MERCADO';
    motivo: string | null;
    evaluadaEn: string;
  } | null;
  historico: { franja: string; acierto: number; n: number } | null;
}
export interface Combinada {
  patas: number;
  independiente: number;
  conjunta: number;
  factorCorrelacion: number;
  vinculos: { a: string; b: string; rho: number; motivo: string }[];
  incompatibles: string[];
  cuotaCombinada: number | null;
  cuotaJusta: number | null;
  ventaja: number | null;
  etiqueta: string;
}
export interface Inteligencia {
  generado: string;
  ventanaHoras: number;
  eventos: number;
  steam: { eventId: string; partido: string; market: string; seleccion: string; desde: number; hasta: number; movimientoPp: number; minutos: number; casas: number }[];
  surebets: { eventId: string; partido: string; market: string; margenPct: number; patas: { seleccion: string; cuota: number; casa: string }[] }[];
  referencia: { eventId: string; partido: string; market: string; casa: string; selecciones: { seleccion: string; referencia: number; consenso: number; desviacionPp: number }[] }[];
  etiqueta: string;
}
export interface Respuesta {
  horizontes: number[];
  horas: number;
  generado: string;
  partidos: Pick[];
  sinPrediccion: number;
  demo: number;
}

export type Orden = 'confianza' | 'probabilidad' | 'ventaja' | 'hora';

export const AMBAR = 'var(--status-warning)';
export const RANGO: Record<string, number> = { ALTA: 0, MEDIA: 1, BAJA: 2 };

// Con Intl y en el idioma activo (lib/formato.ts). Aquí el porcentaje va sin decimales por defecto.
export const pct = (x: number, d = 0) => pctFormato(x, d);
export { num };
export const clave = (p: Pick) => `${p.sport}|${p.matchKey}`;
export const CLAVE_SEL = 'predictor.picks.seleccion';
export const CLAVE_HORAS = 'predictor.picks.horas';

export function leer<T>(k: string, def: T): T {
  try {
    const v = localStorage.getItem(k);
    return v == null ? def : (JSON.parse(v) as T);
  } catch {
    return def;
  }
}
export function guardar(k: string, v: unknown): void {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // No poder recordarlo no impide usarlo ahora.
  }
}
