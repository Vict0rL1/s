// Búsqueda global (Fase 5.17): Ctrl/Cmd+K, equipos, jugadores, partidos, ligas y páginas.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useI18n } from '../../i18n';
import { DeporteIcono } from '../icons';
import { useDialogo } from '../ui/useDialogo';

interface Resultado { tipo: 'equipo' | 'jugador' | 'partido' | 'liga' | 'pagina'; sport: string; league: string | null; id: string; etiqueta: string; detalle: string | null; ruta: string }

const TIPO: Record<Resultado['tipo'], string> = { equipo: 'Equipo', jugador: 'Jugador', partido: 'Partido', liga: 'Liga', pagina: 'Página' };

export default function Buscador() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [abierto, setAbierto] = useState(false);
  const [q, setQ] = useState('');
  const [res, setRes] = useState<Resultado[]>([]);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const paginas: Resultado[] = [
    ['/destacados', t('nav.destacados')], ['/apuestas', t('nav.apuestas')], ['/confianza', t('nav.confianza')], ['/confianza/diagnostico', t('nav.diagnostico')], ['/ajustes', t('nav.ajustes')], ['/glosario', t('nav.glosario')],
    ['/futbol', 'Fútbol'], ['/baloncesto', 'Baloncesto'], ['/beisbol', 'Béisbol'], ['/nfl', 'NFL'], ['/tenis', 'Tenis'],
  ].map(([ruta, etiqueta]) => ({ tipo: 'pagina', sport: 'picks', league: null, id: ruta, etiqueta, detalle: null, ruta }));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setAbierto((o) => !o);
      } else if (e.key === 'Escape') setAbierto(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (abierto) setTimeout(() => input.current?.focus(), 0);
    else {
      setQ('');
      setRes([]);
    }
  }, [abierto]);
  useEffect(() => {
    const n = q.trim().toLowerCase();
    const propias = n.length >= 2 ? paginas.filter((p) => p.etiqueta.toLowerCase().includes(n)) : [];
    if (n.length < 2) {
      setRes([]);
      return;
    }
    let vivo = true;
    const timer = setTimeout(() => {
      fetch(`/api/buscar?q=${encodeURIComponent(n)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((j: { resultados: Resultado[] }) => vivo && setRes([...propias, ...j.resultados]))
        .catch(() => vivo && setRes(propias));
      setSel(0);
    }, 150);
    return () => {
      vivo = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  // Foco atrapado, devuelto al botón y fondo quieto (G11): era aria-modal sin nada de eso.
  const dialogo = useRef<HTMLDivElement>(null);
  useDialogo(abierto, () => setAbierto(false), dialogo);
  const ir = (r: Resultado) => {
    setAbierto(false);
    navigate(r.ruta);
  };
  return (
    <>
      <button onClick={() => setAbierto(true)} aria-label={t('nav.buscar')} title={`${t('nav.buscar')} (Ctrl/Cmd+K)`} className="inline-flex items-center gap-1.5 rounded-full border border-(--line) px-2.5 py-1 text-[12px] text-(--ink-soft) hover:bg-(--raised)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <span className="hidden sm:inline">{t('nav.buscar')}</span>
        <kbd className="hidden rounded border border-(--line) px-1 text-[10px] text-(--ink-muted) lg:inline">⌘K</kbd>
      </button>
      {abierto && (
        <div className="fixed inset-0 z-[70] bg-black/50 p-4 pt-[10vh]" onClick={() => setAbierto(false)}>
          <div ref={dialogo} role="dialog" aria-modal="true" aria-label={t('buscar.titulo')} className="mx-auto w-full max-w-lg rounded-xl border border-(--line) bg-(--surface-card) shadow-xl" onClick={(e) => e.stopPropagation()}>
            <input
              ref={input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(res.length - 1, s + 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
                else if (e.key === 'Enter' && res[sel]) ir(res[sel]);
              }}
              placeholder={t('buscar.placeholder')}
              aria-label={t('buscar.titulo')}
              className="w-full rounded-t-xl border-b border-(--line) bg-transparent px-4 py-3 text-[15px] text-(--ink-strong) outline-none placeholder:text-(--ink-muted)"
            />
            <ul role="listbox" className="max-h-[50vh] overflow-y-auto p-1">
              {q.trim().length >= 2 && res.length === 0 && <li className="px-3 py-2 text-[13px] text-(--ink-muted)">{t('buscar.nada')}</li>}
              {res.map((r, i) => (
                <li key={`${r.tipo}|${r.sport}|${r.id}`} role="option" aria-selected={i === sel}>
                  <button onClick={() => ir(r)} onMouseEnter={() => setSel(i)} className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] ${i === sel ? 'bg-(--raised-2) text-(--ink-strong)' : 'text-(--ink-body)'}`}>
                    {r.tipo !== 'pagina' && <DeporteIcono nombre={r.sport} size={16} />}
                    <span className="min-w-0 flex-1 break-words">{r.etiqueta}{r.detalle && <span className="text-(--ink-muted)"> · {r.detalle.length > 12 && /^\d{4}-/.test(r.detalle) ? new Date(r.detalle).toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : r.detalle}</span>}</span>
                    <span className="shrink-0 text-[11px] uppercase tracking-wide text-(--ink-muted)">{TIPO[r.tipo]}</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="border-t border-(--line) px-3 py-1.5 text-[11px] text-(--ink-faint)">{t('buscar.atajo')}</p>
          </div>
        </div>
      )}
    </>
  );
}
