// Página de liga (Fase 5.13): la clasificación junto al puesto por Elo y la distribución
// simulada de final de temporada, con cómo se movieron esas probabilidades en la temporada.

import { useEffect, useState } from 'react';
import { Link, useParams, Navigate } from 'react-router';
import { Sparkline } from '../components/charts';
import { TeamCrest } from '../components/ui';
import { rutaEquipo } from '../rutas';
import { useI18n, formato } from '../i18n';
import { tieneSimulacion } from '../lib/simulacion';

interface Simulacion { season: number | null; motivo: string | null; etiqueta: string; corridas: number; calendario: { origen: string; pendientes: number; nota: string | null }; reglas: { etiquetaTop: string; descenso: number; puntos: unknown } | null; equipos: { id: string; nombre: string; grupo: string | null; actual: { puntos: number; jugados: number; victorias: number; empates: number; derrotas: number }; puntosEsperados: number; titulo: number; top: number; descenso: number }[] }
interface Historial { dias: { dia: string; equipos: { id: string; titulo: number; top: number; descenso: number }[] }[] }
interface Power { teams: { id: string; name: string; elo: number }[] }

const API: Record<string, string> = { football: '/api/football', basketball: '/api/basketball', baseball: '/api/baseball', nfl: '/api/nfl', nhl: '/api/nhl' };

export default function Liga() {
  const { sport = '', league = '' } = useParams();
  // La UFC no tiene ligas ni clasificación que simular: su «liga» es la pestaña.
  if (sport === 'ufc') return <Navigate to="/ufc" replace />;
  return <LigaDeEquipos sport={sport} league={league} />;
}

function LigaDeEquipos({ sport, league }: { sport: string; league: string }) {
  const { t, idioma } = useI18n();
  const f = formato(idioma);
  const [sim, setSim] = useState<Simulacion | null | 'error'>(null);
  const [hist, setHist] = useState<Historial | null>(null);
  const [power, setPower] = useState<Power | null>(null);
  useEffect(() => {
    let vivo = true;
    setSim(null);
    // Sin simulación para este deporte (la NHL, la UFC) ni se pide: era un 404 en consola (G9).
    if (tieneSimulacion(sport)) {
      fetch(`/api/simulation/season/${sport}/${encodeURIComponent(league)}`).then((r) => (r.ok ? r.json() : Promise.reject())).then((j) => vivo && setSim(j)).catch(() => vivo && setSim('error'));
      fetch(`/api/simulation/season/${sport}/${encodeURIComponent(league)}/historial`).then((r) => (r.ok ? r.json() : null)).then((j) => vivo && setHist(j)).catch(() => undefined);
    } else setSim('error');
    fetch(`${API[sport] ?? ''}/power?league=${encodeURIComponent(league)}&limit=60`).then((r) => (r.ok ? r.json() : null)).then((j) => vivo && setPower(j)).catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, [sport, league]);
  const rankElo = new Map((power?.teams ?? []).map((x, i) => [x.id, i + 1]));
  const historiaDe = (id: string) => (hist?.dias ?? []).map((d) => d.equipos.find((e) => e.id === id)?.top ?? 0);
  const porVictorias = sim && sim !== 'error' && sim.reglas?.puntos === 'victorias';
  return (
    <div>
      <p className="mb-1 text-[12px] text-(--ink-muted)">{t('liga.titulo')}</p>
      <h2 className="mb-1 text-[20px] font-semibold text-(--ink-strong)">{league.toUpperCase()}</h2>
      {sim === 'error' && !(power?.teams.length) && <p className="text-[14px] text-(--ink-soft)">{t('liga.sinDatos')}</p>}
      {/* Sin simulación (la NHL no la tiene), al menos la clasificación por Elo. */}
      {sim === 'error' && !!power?.teams.length && (
        <>
          <p className="mb-3 text-[13px] text-(--ink-muted)">{t('liga.soloElo')}</p>
          <ol className="divide-y divide-(--line) rounded-xl border border-(--line) text-[13px]">
            {power.teams.map((e, i) => (
              <li key={e.id} className="flex items-center gap-3 px-3 py-1.5">
                <span className="w-6 tabular-nums text-(--ink-muted)">{i + 1}</span>
                <Link to={rutaEquipo(sport, league, e.id)} className="flex min-w-0 flex-1 items-center gap-2 text-(--ink-body) underline-offset-2 hover:underline">
                  <TeamCrest league={league} name={e.name} code={e.id} size={20} />
                  <span className="break-words">{e.name}</span>
                </Link>
                <span className="tabular-nums text-(--ink-strong)">{Math.round(e.elo)}</span>
              </li>
            ))}
          </ol>
        </>
      )}
      {sim === null && <p className="text-[13px] text-(--ink-muted)">{t('comun.cargando')}</p>}
      {sim && sim !== 'error' && (
        <>
          <p className="mb-3 text-[13px] text-(--ink-muted)">
            {sim.motivo
              ? t('liga.sinSimulacion', { motivo: sim.motivo })
              : t('liga.resumen', { temporada: sim.season ?? '—', pendientes: sim.calendario.pendientes, origen: sim.calendario.origen === 'reconstruido' ? t('liga.reconstruido') : t('liga.deFuente'), corridas: f.numero(sim.corridas) })}
            {sim.calendario.nota && ` ${sim.calendario.nota}`}
          </p>
          <div className="overflow-x-auto rounded-xl border border-(--line)">
            <table className="w-full text-[13px]">
              <caption className="sr-only">{t('liga.tabla')}</caption>
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-(--ink-muted)">
                  <th scope="col" className="px-3 py-2">#</th>
                  <th scope="col" className="px-3 py-2">{t('liga.equipo')}</th>
                  <th scope="col" className="px-3 py-2 text-right">{t('liga.pj')}</th>
                  <th scope="col" className="px-3 py-2 text-right">{porVictorias ? t('liga.vd') : t('liga.pts')}</th>
                  <th scope="col" className="px-3 py-2 text-right">Elo</th>
                  {!sim.motivo && (
                    <>
                      <th scope="col" className="px-3 py-2 text-right">{t('liga.esperados')}</th>
                      <th scope="col" className="px-3 py-2 text-right">{t('liga.primero')}</th>
                      <th scope="col" className="px-3 py-2 text-right">{sim.reglas?.etiquetaTop ?? t('liga.arriba')}</th>
                      {(sim.reglas?.descenso ?? 0) > 0 && <th scope="col" className="px-3 py-2 text-right">{t('liga.descenso')}</th>}
                      <th scope="col" className="px-3 py-2">{t('liga.evolucion')}</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {[...sim.equipos]
                  .sort((a, b) => b.actual.puntos - a.actual.puntos || b.puntosEsperados - a.puntosEsperados)
                  .map((e, i) => (
                    <tr key={e.id} className="border-t border-(--line)">
                      <td className="px-3 py-1.5 tabular-nums text-(--ink-muted)">{i + 1}</td>
                      <td className="px-3 py-1.5">
                        <Link to={rutaEquipo(sport, league, e.id)} className="flex min-w-0 items-center gap-2 text-(--ink-body) underline-offset-2 hover:underline">
                          <TeamCrest league={league} name={e.nombre} code={e.id} size={20} />
                          <span className="break-words">{e.nombre}</span>
                          {e.grupo && <span className="text-[11px] text-(--ink-muted)">{e.grupo}</span>}
                        </Link>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{e.actual.jugados}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-(--ink-strong)">{porVictorias ? `${e.actual.victorias}-${e.actual.derrotas}${e.actual.empates ? `-${e.actual.empates}` : ''}` : e.actual.puntos}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-(--ink-soft)">{rankElo.has(e.id) ? `#${rankElo.get(e.id)}` : '—'}</td>
                      {!sim.motivo && (
                        <>
                          <td className="px-3 py-1.5 text-right tabular-nums">{f.numero(e.puntosEsperados, 1)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{f.porcentaje(e.titulo, 1)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{f.porcentaje(e.top, 1)}</td>
                          {(sim.reglas?.descenso ?? 0) > 0 && <td className="px-3 py-1.5 text-right tabular-nums">{f.porcentaje(e.descenso, 1)}</td>}
                          <td className="px-3 py-1.5"><Sparkline puntos={historiaDe(e.id)} etiqueta={t('liga.sparkline', { equipo: e.nombre })} /></td>
                        </>
                      )}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {!sim.motivo && <p className="mt-2 text-[11px] text-(--ink-faint)">{sim.etiqueta} {t('liga.notaEvolucion')}</p>}
        </>
      )}
    </div>
  );
}
