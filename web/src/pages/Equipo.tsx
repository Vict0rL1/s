// Página de equipo (Fase 5.12): Elo, balance, forma y local/fuera; la historia del Elo; los
// próximos partidos con su probabilidad; y lo que la simulación de temporada dice del equipo.
// Es una URL: se puede compartir.

import { useEffect, useState } from 'react';
import { Link, useParams, Navigate } from 'react-router';
import { LineChart, Histogram } from '../components/charts';
import { TeamCrest } from '../components/ui';
import { EstrellaSeguir } from '../components/seguimiento';
import { rutaLiga, rutaPartido } from '../rutas';
import { aComun, nombrePartido, URL_PROXIMOS, type DeporteId, type PartidoComun } from '../lib/partidos';
import { useI18n, formato } from '../i18n';
import { tieneSimulacion } from '../lib/simulacion';

interface Historia { puntos: { fecha: string; elo: number; rival: string; local: boolean }[]; nota: string }
interface Simulacion { season: number | null; motivo: string | null; etiqueta: string; reglas: { etiquetaTop: string; descenso: number } | null; equipos: { id: string; nombre: string; puntosEsperados: number; titulo: number; top: number; descenso: number; posiciones: number[] }[] }
type Registro = { wins: number; losses: number; draws?: number; ties?: number };
interface Info { gf?: number | null; ga?: number | null; goalsFor?: number | null; goalsAgainst?: number | null; ppg?: number | null; oppg?: number | null; rs?: number | null; ra?: number | null; pf?: number | null; pa?: number | null; pythagorean?: number | null; rotation?: { id: string; name: string; starts: number; runsPer9: number | null; rating: number | null }[];
  id: string; name: string; elo: number; eloRank: number; record?: Registro; homeRecord?: Registro; awayRecord?: Registro; form?: { date: string; opponentName: string | null; home: boolean; result: 'W' | 'D' | 'L' }[]; matchesInDb?: number; gamesInDb?: number; conference?: string | null; division?: string | null }

const API: Record<string, string> = { football: '/api/football', basketball: '/api/basketball', baseball: '/api/baseball', nfl: '/api/nfl', nhl: '/api/nhl' };
// La NHL es una sola liga: su ficha va sin liga en la ruta.
const urlFicha = (sport: string, league: string, id: string) => (sport === 'nhl' ? `/api/nhl/teams/${encodeURIComponent(id)}` : `${API[sport] ?? ''}/teams/${encodeURIComponent(league)}/${encodeURIComponent(id)}`);
const rec = (r?: Registro) => (r ? `${r.wins}-${r.losses}${r.draws ? `-${r.draws}` : r.ties ? `-${r.ties}` : ''}` : '—');

export default function Equipo() {
  const { sport = '', league = '', id = '' } = useParams();
  // En la UFC no hay equipos: la ficha es la del luchador.
  if (sport === 'ufc') return <Navigate to={`/luchador/${encodeURIComponent(id)}`} replace />;
  return <FichaEquipo sport={sport} league={league} id={id} />;
}

function FichaEquipo({ sport, league, id }: { sport: string; league: string; id: string }) {
  const { t, idioma } = useI18n();
  const f = formato(idioma);
  const [info, setInfo] = useState<Info | null | 'error'>(null);
  const [hist, setHist] = useState<Historia | null>(null);
  const [sim, setSim] = useState<Simulacion | null | 'no'>(null);
  const [proximos, setProximos] = useState<PartidoComun[]>([]);
  useEffect(() => {
    let vivo = true;
    setInfo(null);
    fetch(urlFicha(sport, league, id))
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j: Info) => vivo && setInfo(j))
      .catch(() => vivo && setInfo('error'));
    fetch(`/api/elo/historia/${sport}/${encodeURIComponent(league)}/${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : null)).then((j) => vivo && setHist(j)).catch(() => undefined);
    // Un 404 es «esta liga no tiene simulación» (la NHL), no algo que siga cargando.
    // Sin simulación para este deporte (la NHL, la UFC) ni se pide: era un 404 en consola (G9).
    if (tieneSimulacion(sport)) fetch(`/api/simulation/season/${sport}/${encodeURIComponent(league)}`).then((r) => (r.ok ? r.json() : 'no')).then((j) => vivo && setSim(j)).catch(() => vivo && setSim('no'));
    else setSim('no');
    if (sport in URL_PROXIMOS) {
      fetch(URL_PROXIMOS[sport as DeporteId](league))
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: Record<string, unknown>[]) => {
          if (!vivo) return;
          setProximos(rows.map((r) => aComun(sport as DeporteId, r)).filter((p): p is PartidoComun => !!p && (p.casaId === id || p.fueraId === id)).slice(0, 8));
        })
        .catch(() => undefined);
    }
    return () => {
      vivo = false;
    };
  }, [sport, league, id]);
  const simulada = sim === 'no' ? null : sim;
  const yo = simulada?.equipos.find((e) => e.id === id) ?? null;
  const serie = hist?.puntos.map((p) => ({ x: Date.parse(p.fecha), y: p.elo })) ?? [];
  const nombre = info && info !== 'error' ? info.name : id;
  return (
    <div>
      <p className="mb-1 text-[12px] text-(--ink-muted)">
        <Link to={rutaLiga(sport, league)} className="underline-offset-2 hover:underline">{league.toUpperCase()}</Link> › {t('equipo.titulo')}
      </p>
      <div className="mb-4 flex items-center gap-3">
        <TeamCrest league={league} name={nombre} code={id} size={44} />
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-[20px] font-semibold text-(--ink-strong)">{nombre}</h2>
          {info && info !== 'error' && (
            <p className="text-[13px] text-(--ink-soft)">
              {t('equipo.resumen', { elo: Math.round(info.elo), rango: info.eloRank, partidos: info.matchesInDb ?? info.gamesInDb ?? '—' })}
              {info.conference && ` · ${info.conference}${info.division ? ` / ${info.division}` : ''}`}
            </p>
          )}
        </div>
        <EstrellaSeguir kind="equipo" sport={sport} league={league} refId={id} label={nombre} size={22} />
      </div>
      {info === 'error' && <p className="text-[14px] text-(--ink-soft)">{t('equipo.noExiste')}</p>}
      {info === null && <p className="text-[13px] text-(--ink-muted)">{t('comun.cargando')}</p>}
      {info && info !== 'error' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-xl border border-(--line) p-4">
            <h3 className="mb-2 text-[15px] font-semibold text-(--ink-strong)">{t('equipo.balance')}</h3>
            <dl className="grid grid-cols-3 gap-2 text-[13px]">
              <div><dt className="text-(--ink-muted)">{t('equipo.total')}</dt><dd className="tabular-nums text-(--ink-strong)">{rec(info.record)}</dd></div>
              <div><dt className="text-(--ink-muted)">{t('equipo.enCasa')}</dt><dd className="tabular-nums text-(--ink-strong)">{rec(info.homeRecord)}</dd></div>
              <div><dt className="text-(--ink-muted)">{t('equipo.fuera')}</dt><dd className="tabular-nums text-(--ink-strong)">{rec(info.awayRecord)}</dd></div>
            </dl>
            {info.form && info.form.length > 0 && (
              <>
                <h4 className="mb-1 mt-3 text-[12px] font-medium uppercase tracking-wide text-(--ink-muted)">{t('equipo.forma')}</h4>
                <ul className="flex flex-wrap gap-1">
                  {info.form.slice(0, 10).map((x, i) => (
                    <li key={i} title={`${x.date}: ${x.home ? 'vs' : '@'} ${x.opponentName ?? '?'}`} className="grid h-6 w-6 place-items-center rounded text-[11px] font-semibold" style={{ backgroundColor: x.result === 'W' ? 'rgba(25,158,112,0.2)' : x.result === 'L' ? 'rgba(217,89,38,0.2)' : 'var(--raised-2)', color: x.result === 'W' ? 'var(--profit-text)' : x.result === 'L' ? 'var(--loss-text)' : 'var(--ink-body)' }}>
                      {t(x.result === 'W' ? 'equipo.g' : x.result === 'L' ? 'equipo.p' : 'equipo.e')}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
          {(() => {
            const a = info.gf ?? info.goalsFor ?? info.ppg ?? info.rs ?? info.pf ?? null;
            const c = info.ga ?? info.goalsAgainst ?? info.oppg ?? info.ra ?? info.pa ?? null;
            if (a == null && c == null && info.pythagorean == null && !info.rotation?.length) return null;
            return (
              <section className="rounded-xl border border-(--line) p-4">
                <h3 className="mb-2 text-[15px] font-semibold text-(--ink-strong)">{t('equipo.masDatos')}</h3>
                <dl className="grid grid-cols-3 gap-2 text-[13px]">
                  <div><dt className="text-(--ink-muted)">{t('equipo.aFavor')}</dt><dd className="tabular-nums text-(--ink-strong)">{a == null ? '—' : f.numero(a, 1)}</dd></div>
                  <div><dt className="text-(--ink-muted)">{t('equipo.enContra')}</dt><dd className="tabular-nums text-(--ink-strong)">{c == null ? '—' : f.numero(c, 1)}</dd></div>
                  {info.pythagorean != null && <div><dt className="text-(--ink-muted)" title={t('equipo.pitagoricoNota')}>{t('equipo.pitagorico')}</dt><dd className="tabular-nums text-(--ink-strong)">{f.porcentaje(info.pythagorean, 1)}</dd></div>}
                </dl>
                {info.rotation && info.rotation.length > 0 && (
                  <table className="mt-3 w-full text-[13px]">
                    <caption className="mb-1 text-left text-[12px] font-medium uppercase tracking-wide text-(--ink-muted)">{t('equipo.rotacion')}</caption>
                    <thead><tr className="text-left text-(--ink-muted)"><th scope="col" className="py-1 pr-2">{t('equipo.lanzador')}</th><th scope="col" className="py-1 pr-2 text-right">{t('equipo.aperturas')}</th><th scope="col" className="py-1 text-right">{t('equipo.vsEsperado')}</th></tr></thead>
                    <tbody>{info.rotation.map((r) => (<tr key={r.id} className="border-t border-(--line)"><td className="py-1 pr-2 break-words text-(--ink-body)">{r.name}</td><td className="py-1 pr-2 text-right tabular-nums">{r.starts}</td><td className="py-1 text-right tabular-nums">{r.rating != null ? `${r.rating <= 1 ? '−' : '+'}${Math.abs(Math.round((r.rating - 1) * 100))} %` : '—'}</td></tr>))}</tbody>
                  </table>
                )}
              </section>
            );
          })()}
          <section className="rounded-xl border border-(--line) p-4">
            <h3 className="mb-2 text-[15px] font-semibold text-(--ink-strong)">{t('equipo.historiaElo')}</h3>
            {serie.length > 1 ? <LineChart series={[{ nombre: 'Elo', puntos: serie }]} formatoX={(x) => f.fecha(new Date(x).toISOString(), { month: 'short', year: '2-digit' })} /> : <p className="text-[13px] text-(--ink-muted)">{t('equipo.sinHistoria')}</p>}
            {hist && <p className="mt-1 text-[11px] text-(--ink-faint)">{hist.nota}</p>}
          </section>
          <section className="rounded-xl border border-(--line) p-4">
            <h3 className="mb-2 text-[15px] font-semibold text-(--ink-strong)">{t('equipo.proximos')}</h3>
            {proximos.length === 0 ? (
              <p className="text-[13px] text-(--ink-muted)">{t('equipo.sinProximos')}</p>
            ) : (
              <ul className="space-y-1 text-[13px]">
                {proximos.map((p) => {
                  const local = p.casaId === id;
                  const prob = p.probs ? (local ? p.probs[0] : p.probs[p.probs.length - 1]) : null;
                  return (
                    <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <Link to={rutaPartido(sport, p.id)} className="min-w-0 break-words text-(--ink-body) underline-offset-2 hover:underline">{nombrePartido(p)}</Link>
                      <span className="text-(--ink-muted)">
                        {f.fecha(p.cuando)}
                        {prob != null && <span className="ml-2 tabular-nums text-(--ink-strong)" title={t('equipo.probGanar')}>{f.porcentaje(prob)}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <section className="rounded-xl border border-(--line) p-4">
            <h3 className="mb-2 text-[15px] font-semibold text-(--ink-strong)">{t('equipo.simulacion')}</h3>
            {sim === null && <p className="text-[13px] text-(--ink-muted)">{t('comun.cargando')}</p>}
            {sim === 'no' && <p className="text-[13px] text-(--ink-muted)">{t('equipo.sinSimulacionLiga')}</p>}
            {simulada && simulada.motivo && <p className="text-[13px] text-(--ink-muted)">{t('liga.sinSimulacion', { motivo: simulada.motivo })}</p>}
            {simulada && !simulada.motivo && yo && (
              <>
                <dl className="grid grid-cols-2 gap-2 text-[13px] sm:grid-cols-4">
                  <div><dt className="text-(--ink-muted)">{t('liga.esperados')}</dt><dd className="tabular-nums text-(--ink-strong)">{f.numero(yo.puntosEsperados, 1)}</dd></div>
                  <div><dt className="text-(--ink-muted)">{t('liga.primero')}</dt><dd className="tabular-nums text-(--ink-strong)">{f.porcentaje(yo.titulo, 1)}</dd></div>
                  <div><dt className="text-(--ink-muted)">{simulada.reglas?.etiquetaTop ?? t('liga.arriba')}</dt><dd className="tabular-nums text-(--ink-strong)">{f.porcentaje(yo.top, 1)}</dd></div>
                  {(simulada.reglas?.descenso ?? 0) > 0 && <div><dt className="text-(--ink-muted)">{t('liga.descenso')}</dt><dd className="tabular-nums text-(--ink-strong)">{f.porcentaje(yo.descenso, 1)}</dd></div>}
                </dl>
                <div className="mt-2">
                  <Histogram titulo={t('equipo.posicionFinal')} valores={yo.posiciones} etiquetas={yo.posiciones.map((_, i) => String(i + 1))} />
                </div>
                <p className="mt-1 text-[11px] text-(--ink-faint)">{simulada.etiqueta}</p>
              </>
            )}
            {simulada && !simulada.motivo && !yo && <p className="text-[13px] text-(--ink-muted)">{t('equipo.fueraSimulacion')}</p>}
          </section>
        </div>
      )}
    </div>
  );
}
