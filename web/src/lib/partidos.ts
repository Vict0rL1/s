// Una fila de partido de cualquier deporte, en una forma común (Fase 5.11–5.12): lo justo para
// enlazar, listar y abrir la página de partido sin cinco versiones de lo mismo.

import type { EvaluacionConfianza, PrePartidoRef } from './trust';

export type DeporteId = 'football' | 'basketball' | 'baseball' | 'nfl' | 'nhl' | 'ufc' | 'tennis';

export interface PartidoComun {
  sport: DeporteId;
  id: string;
  league: string | null;
  cuando: string;
  casa: string;
  fuera: string;
  casaId: string | null;
  fueraId: string | null;
  /** [local, (empate,) visitante]: la probabilidad publicada, o null sin modelo. */
  probs: number[] | null;
  confianza: EvaluacionConfianza | null;
  prePartido: PrePartidoRef | null;
}

/** De dónde pedir UN partido (la misma forma que la lista de su deporte). */
export const URL_PARTIDO: Record<DeporteId, (id: string) => string> = {
  football: (id) => `/api/football/fixtures/${encodeURIComponent(id)}`,
  basketball: (id) => `/api/basketball/games/${encodeURIComponent(id)}`,
  baseball: (id) => `/api/baseball/games/${encodeURIComponent(id)}`,
  nfl: (id) => `/api/nfl/games/${encodeURIComponent(id)}`,
  nhl: (id) => `/api/nhl/games/${encodeURIComponent(id)}`,
  ufc: (id) => `/api/ufc/fights/${encodeURIComponent(id)}`,
  tennis: (id) => `/api/predictions/${encodeURIComponent(id)}`,
};

/** De dónde pedir los próximos de una liga (o tour). */
export const URL_PROXIMOS: Record<DeporteId, (league: string) => string> = {
  football: (l) => `/api/football/fixtures/upcoming?league=${encodeURIComponent(l)}`,
  basketball: (l) => `/api/basketball/games/upcoming?league=${encodeURIComponent(l)}`,
  baseball: (l) => `/api/baseball/games/upcoming?league=${encodeURIComponent(l)}`,
  nfl: (l) => `/api/nfl/games/upcoming?league=${encodeURIComponent(l)}`,
  // Una sola liga: la liga no se pasa; 64, los mismos que predice el ciclo pre-partido.
  nhl: () => '/api/nhl/games/upcoming?limit=64',
  // La UFC tampoco tiene ligas; 80, las que predice el ciclo pre-partido.
  ufc: () => '/api/ufc/fights/upcoming?limit=80',
  tennis: (l) => `/api/predictions?tour=${encodeURIComponent(l)}`,
};

type Fila = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function aComun(sport: DeporteId, item: Fila): PartidoComun | null {
  const g = (item.fixture ?? item.game ?? item.match ?? item.fight) as Fila | undefined;
  if (!g) return null;
  const pred = item.prediction as Fila | null | undefined;
  let probs: number[] | null = null;
  if (pred) {
    if (sport === 'football') {
      const f = (pred.final ?? pred.model) as Fila;
      probs = [num(f.home), num(f.draw), num(f.away)].every((x) => x != null) ? [f.home as number, f.draw as number, f.away as number] : null;
    } else if (sport === 'basketball') {
      const m = pred.model as Fila;
      const h = num(m?.probHome);
      probs = h == null ? null : [h, 1 - h];
    } else if (sport === 'baseball') {
      const m = pred.model as Fila;
      const h = num(m?.home);
      probs = h == null ? null : [h, 1 - h];
    } else if (sport === 'nhl' || sport === 'ufc') {
      const m = pred.final as Fila;
      const h = num(m?.home);
      probs = h == null ? null : [h, 1 - h];
    } else if (sport === 'nfl') {
      const m = (pred.final ?? pred.model) as Fila;
      const h = num(m?.home);
      const a = num(m?.away);
      probs = h == null || a == null ? null : [h / (h + a), a / (h + a)];
    } else {
      const m = pred.model as Fila;
      const p1 = num(m?.prob1);
      probs = p1 == null ? null : [p1, 1 - p1];
    }
  }
  const tenis = sport === 'tennis';
  return {
    sport,
    id: String(g.id),
    league: (tenis ? (g.tour as string) : (g.league as string)) ?? null,
    cuando: String(g.commence_time),
    casa: String(tenis ? g.p1_name : g.home_name),
    fuera: String(tenis ? g.p2_name : g.away_name),
    casaId: (tenis ? g.p1_id : g.home_id) == null ? null : String(tenis ? g.p1_id : g.home_id),
    fueraId: (tenis ? g.p2_id : g.away_id) == null ? null : String(tenis ? g.p2_id : g.away_id),
    probs,
    confianza: (item.confianza as EvaluacionConfianza | null | undefined) ?? null,
    prePartido: (item.prePartido as PrePartidoRef | null | undefined) ?? null,
  };
}

export const nombrePartido = (p: Pick<PartidoComun, 'sport' | 'casa' | 'fuera'>) => (p.sport === 'nfl' || p.sport === 'nhl' ? `${p.fuera} @ ${p.casa}` : `${p.casa} vs ${p.fuera}`);
