// Página de partido (Fase 5.11): el destino para compartir. La tarjeta del deporte (con su
// desglose, la matriz de marcadores o el clima donde existen, y la capa de confianza con el
// «qué pasaría si»), la deriva pre-partido T-24h → final, el movimiento de cuotas por casa y
// «¿Acertó?» cuando hay resultado. El ?clave= permite abrirla aunque el partido ya no esté en
// la lista de próximos.

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import FootballCard from '../components/football/MatchCard';
import BasketballCard from '../components/basketball/GameCard';
import BaseballCard from '../components/baseball/GameCard';
import NflCard from '../components/nfl/GameCard';
import NhlCard from '../components/nhl/GameCard';
import UfcCard from '../components/ufc/FightCard';
import TennisCard from '../components/MatchCard';
import { LineChart } from '../components/charts';
import { EstrellaSeguir } from '../components/seguimiento';
import { aComun, nombrePartido, URL_PARTIDO, type DeporteId, type PartidoComun } from '../lib/partidos';
import { rutaEquipo, rutaJugador, rutaLuchador, RUTA_DE_PESTANA } from '../rutas';
import { avisoSinDeriva, nombreDelPrePartido, type PrePartido } from '../lib/trust';
import { useI18n, formato } from '../i18n';
import { PROFIT_COLOR, LOSS_COLOR } from '../lib/theme';

interface Resultado { casa: string; fuera: string; cuando: string | null; probabilidades: number[]; resuelto: boolean; resultado: 'casa' | 'empate' | 'fuera' | null; marcador: string | null; probabilidadDada: number | null; acerto: boolean | null }
interface PorCasa { casas: string[]; series: { casa: string; seleccion: string; puntos: { at: string; cuota: number }[] }[] }

const DEPORTES: DeporteId[] = ['football', 'basketball', 'baseball', 'nfl', 'nhl', 'ufc', 'tennis'];

/**
 * La ficha, con una clave por partido (D8): al pasar de un partido a otro sin salir de la ruta,
 * React reutilizaba el componente y la ficha nueva enseñaba un rato la deriva, el resultado y las
 * cuotas por casa de la anterior. Con la clave, cada partido empieza de cero.
 */
export default function Partido() {
  const { sport = '', id = '' } = useParams();
  return <FichaPartido key={`${sport}/${id}`} sport={sport} id={id} />;
}

function FichaPartido({ sport, id }: { sport: string; id: string }) {
  const [q] = useSearchParams();
  const navigate = useNavigate();
  const { t, idioma } = useI18n();
  const f = formato(idioma);
  const deporte = (DEPORTES.includes(sport as DeporteId) ? sport : null) as DeporteId | null;
  const [item, setItem] = useState<Record<string, unknown> | null | 'error'>(null);
  const [pre, setPre] = useState<PrePartido | null>(null);
  const [res, setRes] = useState<Resultado | null>(null);
  const [casas, setCasas] = useState<PorCasa | null>(null);
  const [seleccion, setSeleccion] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);

  useEffect(() => {
    if (!deporte) return;
    let vivo = true;
    setItem(null);
    fetch(URL_PARTIDO[deporte](id))
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j: Record<string, unknown>) => vivo && setItem(j))
      .catch(() => vivo && setItem('error'));
    fetch(`/api/odds/casas/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: PorCasa | null) => vivo && setCasas(j))
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, [deporte, id]);

  const comun: PartidoComun | null = deporte && item && item !== 'error' ? aComun(deporte, item) : null;
  // Lo publicado manda en la cabecera (lo mismo que Destacados); si el modelo de hoy ya dice otra
  // cosa, se cuenta aquí en vez de cambiar el número en silencio.
  const publicada = item && item !== 'error' ? ((item.prediction as { publicada?: { en: string; actual: number[]; difiere: boolean } } | null)?.publicada ?? null) : null;
  const clave = comun?.prePartido?.matchKey ?? comun?.confianza?.matchKey ?? q.get('clave');

  useEffect(() => {
    if (!deporte || !clave) return;
    let vivo = true;
    fetch(`/api/prematch/${deporte}/${encodeURIComponent(clave)}`).then((r) => (r.ok ? r.json() : null)).then((j) => vivo && setPre(j)).catch(() => undefined);
    fetch(`/api/resultado/${deporte}/${encodeURIComponent(clave)}`).then((r) => (r.ok ? r.json() : null)).then((j) => vivo && setRes(j)).catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, [deporte, clave]);

  if (!deporte) return <p className="text-[14px] text-(--ink-soft)">{t('partido.deporteDesconocido')}</p>;

  const abrirEquipo = (league: string, teamId: string) => navigate(rutaEquipo(deporte, league, teamId));
  const abrirJugador = (tour: string, pid: number) => navigate(rutaJugador(tour, pid));
  const nombre = comun ? nombrePartido(comun) : res ? nombrePartido({ sport: deporte, casa: res.casa, fuera: res.fuera }) : id;
  const copiar = async () => {
    const url = new URL(window.location.href);
    if (clave) url.searchParams.set('clave', clave);
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      setCopiado(false);
    }
  };

  // Deriva T-24h → final: la probabilidad del primer resultado en cada horizonte capturado.
  const deriva = (pre?.horizontes ?? []).filter((h) => h.fila).map((h) => ({ x: Date.parse(h.fila!.captured_at), y: h.fila!.probs[0] * 100, etiqueta: h.etiqueta }));
  const seleccionesCasas = [...new Set((casas?.series ?? []).map((s) => s.seleccion))];
  const sel = seleccion ?? seleccionesCasas[0] ?? null;
  const seriesCasas = (casas?.series ?? []).filter((s) => s.seleccion === sel && s.puntos.length > 0).map((s) => ({ nombre: s.casa, puntos: s.puntos.map((p) => ({ x: Date.parse(p.at), y: p.cuota })) }));

  return (
    <div>
      <p className="mb-1 text-[12px] text-(--ink-muted)">
        <Link to={RUTA_DE_PESTANA[deporte]} className="underline-offset-2 hover:underline">{t(`deporte.${deporte}`)}</Link> › {t('partido.titulo')}
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 break-words text-[20px] font-semibold text-(--ink-strong)">{nombre}</h2>
        {clave && <EstrellaSeguir kind="partido" sport={deporte} league={comun?.league ?? null} refId={clave} label={nombre} size={22} />}
        <button onClick={() => void copiar()} className="rounded-lg px-3 py-1.5 text-[13px] text-(--ink-body) ring-1 ring-(--line) hover:bg-(--raised)">
          {copiado ? t('partido.copiado') : t('partido.copiarEnlace')}
        </button>
      </div>

      {res?.resuelto && (
        <section aria-live="polite" className="mb-4 rounded-xl border p-4" style={{ borderColor: res.acerto ? `${PROFIT_COLOR}66` : `${LOSS_COLOR}66` }}>
          <h3 className="text-[15px] font-semibold text-(--ink-strong)">{t('partido.acerto')}</h3>
          <p className="mt-1 text-[14px] text-(--ink-body)">
            {res.marcador && <span className="mr-2 font-semibold tabular-nums">{res.marcador}</span>}
            {res.acerto ? t('partido.si') : t('partido.no')}
            {res.probabilidadDada != null && ` · ${t('partido.lePuso', { p: f.porcentaje(res.probabilidadDada, 1) })}`}
          </p>
        </section>
      )}

      {item === null && <p className="text-[13px] text-(--ink-muted)">{t('comun.cargando')}</p>}
      {item === 'error' && !res && <p className="text-[14px] text-(--ink-soft)">{t('partido.noEncontrado')}</p>}
      {item === 'error' && res && <p className="mb-4 text-[13px] text-(--ink-muted)">{t('partido.yaNoProximo')}</p>}
      {publicada?.difiere && (
        <p className="mb-2 text-[13px] text-(--ink-soft)">
          {t('partido.publicada', { cuando: f.fecha(publicada.en, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }), hoy: publicada.actual.map((p) => f.porcentaje(p, 1)).join(' · ') })}
        </p>
      )}
      {item && item !== 'error' && (
        <div className="mb-4">
          {deporte === 'football' && <FootballCard item={item as never} onOpenTeam={abrirEquipo} />}
          {deporte === 'basketball' && <BasketballCard item={item as never} onOpenTeam={abrirEquipo} />}
          {deporte === 'baseball' && <BaseballCard item={item as never} onOpenTeam={abrirEquipo} />}
          {deporte === 'nfl' && <NflCard item={item as never} onOpenTeam={abrirEquipo} />}
          {deporte === 'nhl' && <NhlCard item={item as never} onOpenTeam={(id: string) => abrirEquipo('nhl', id)} />}
          {deporte === 'ufc' && <UfcCard item={item as never} onOpenFighter={(fid: string) => navigate(rutaLuchador(fid))} />}
          {deporte === 'tennis' && <TennisCard item={item as never} onOpenPlayer={abrirJugador} />}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-(--line) p-4">
          <h3 className="mb-2 text-[15px] font-semibold text-(--ink-strong)">{t('partido.deriva')}</h3>
          {deriva.length > 1 ? (
            <>
              <LineChart series={[{ nombre: (pre && nombreDelPrePartido(pre)) || '1', puntos: deriva }]} unidad=" %" formatoX={(x) => f.fecha(new Date(x).toISOString())} />
              <ul className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-(--ink-soft)">
                {deriva.map((d) => <li key={d.etiqueta}>{d.etiqueta}: <span className="tabular-nums text-(--ink-strong)">{f.numero(d.y, 1)} %</span></li>)}
              </ul>
            </>
          ) : (
            <p className="text-[13px] text-(--ink-muted)">{t(pre ? avisoSinDeriva(pre) : 'partido.sinInstantaneas', { n: pre?.instantaneas ?? 0 })}</p>
          )}
          {pre?.final && <p className="mt-1 text-[12px] text-(--ink-soft)">{t('partido.finalCongelada', { p: f.porcentaje(pre.final.probs[0], 1) })}</p>}
        </section>
        <section className="rounded-xl border border-(--line) p-4">
          <h3 className="mb-2 text-[15px] font-semibold text-(--ink-strong)">{t('partido.cuotasPorCasa')}</h3>
          {seriesCasas.length === 0 ? (
            <p className="text-[13px] text-(--ink-muted)">{t('partido.sinCuotas')}</p>
          ) : (
            <>
              {seleccionesCasas.length > 1 && (
                <div className="mb-2 flex flex-wrap gap-1" role="group" aria-label={t('partido.seleccion')}>
                  {seleccionesCasas.map((s) => (
                    <button key={s} aria-pressed={s === sel} onClick={() => setSeleccion(s)} className={`rounded-full px-2.5 py-0.5 text-[12px] ring-1 ${s === sel ? 'bg-(--raised-2) text-(--ink-strong) ring-(--line-strong)' : 'text-(--ink-soft) ring-(--line)'}`}>{s}</button>
                  ))}
                </div>
              )}
              <LineChart series={seriesCasas} formatoX={(x) => f.fecha(new Date(x).toISOString())} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
