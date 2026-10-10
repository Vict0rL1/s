// Seguimiento (Fase 5.14): la estrella para seguir equipos, jugadores y partidos, y el hook
// que lee la lista una vez para toda la pantalla.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n';

export interface Seguido { id: number; kind: 'equipo' | 'jugador' | 'partido'; sport: string; league: string | null; ref_id: string; label: string; created_at: string }

const Ctx = createContext<{ seguidos: Seguido[]; recargar: () => void; disponible: boolean }>({ seguidos: [], recargar: () => {}, disponible: false });

export function SeguimientoProvider({ children }: { children: ReactNode }) {
  const [seguidos, setSeguidos] = useState<Seguido[]>([]);
  const [disponible, setDisponible] = useState(false);
  const recargar = useCallback(() => {
    fetch('/api/watchlist')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j: { seguidos: Seguido[] }) => {
        setSeguidos(j.seguidos);
        setDisponible(true);
      })
      .catch(() => setDisponible(false));
  }, []);
  useEffect(recargar, [recargar]);
  const v = useMemo(() => ({ seguidos, recargar, disponible }), [seguidos, recargar, disponible]);
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}

export function useSeguimiento() {
  return useContext(Ctx);
}

export function EstrellaSeguir({ kind, sport, league = null, refId, label, size = 16 }: { kind: Seguido['kind']; sport: string; league?: string | null; refId: string; label: string; size?: number }) {
  const { t } = useI18n();
  const { seguidos, recargar, disponible } = useSeguimiento();
  const actual = seguidos.find((s) => s.kind === kind && s.sport === sport && s.ref_id === refId);
  if (!disponible) return null;
  const alternar = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (actual) await fetch(`/api/watchlist/${actual.id}`, { method: 'DELETE' });
    else await fetch('/api/watchlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, sport, league, ref_id: refId, label }) });
    recargar();
  };
  return (
    <button onClick={(e) => void alternar(e)} data-icono="campana" aria-pressed={!!actual} aria-label={`${actual ? t('seguimiento.dejar') : t('seguimiento.seguir')}: ${label}`} title={actual ? t('seguimiento.dejar') : t('seguimiento.seguir')} className={`grid shrink-0 place-items-center rounded p-1 transition ${actual ? 'text-(--seleccion)' : 'text-(--ink-faint) hover:text-(--ink-body)'}`}>
      {/* Una campana, no una estrella (D13): la estrella es «Añadir a mi selección», y dos
          estrellas en la misma tarjeta se confundían. Seguir es recibir avisos: la campana. */}
      <svg width={size} height={size} viewBox="0 0 24 24" fill={actual ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
    </button>
  );
}
