// Analítica del modelo en Confianza (Fase 5.22): fiabilidad (backtest y vivo, sin mezclar),
// la ventana móvil de 4 semanas con el PSI, y el acierto por segmento. Todo de las rutas de la
// Fase 4; lo que no tiene muestra lo dice en vez de pintar barras.

import { useEffect, useState } from 'react';
import { BarChart, LineChart, ReliabilityDiagram } from '../charts';
import { STATUS } from '../../lib/theme';
import { conNodos, useI18n, type Clave } from '../../i18n';
import { DeporteIcono } from '../icons';
import { Termino } from '../ui';
import { num as numF } from '../../lib/formato';
import { pct as pctF } from '../../lib/formato';

type Deporte = 'football' | 'basketball' | 'baseball' | 'nfl' | 'nhl' | 'ufc' | 'tennis';
interface Cubeta { desde: number; hasta: number; n: number; predicha: number | null; observada: number | null }
interface Diagrama { partidos: number; cubetas: Cubeta[]; ece: number | null; aviso: { nivel: string; texto: string | null } }
interface Fiabilidad { backtest: Diagrama | null; live: Diagrama }
interface Monitorizacion { serie: { dia: string; n: number; logLoss: number | null; brier: number | null; psi: number | null }[]; actual: { n: number; logLoss: number | null; brier: number | null; psi: number | null } | null; referencia: { logLoss: number | null; brier: number | null } | null; deriva: { hay: boolean; motivos: string[]; aviso: { texto: string | null } } }
interface Segmentos { predicciones: { n: number; dimensiones: Record<string, Record<string, { n: number; acierto: number | null; publicada: boolean }>> }; apuestas: { n: number; dimensiones: Record<string, Record<string, { n: number; conCierre: number; clvMedio: number | null; publicada: boolean }>> }; umbrales: { predicciones: number; apuestas: number } }

const DEPORTES: Deporte[] = ['football', 'basketball', 'baseball', 'nfl', 'nhl', 'ufc', 'tennis'];
const pct = (x: number, d = 1) => pctF(x, d);

function usar<T>(url: string): T | null | 'error' {
  const [d, setD] = useState<T | null | 'error'>(null);
  useEffect(() => {
    let vivo = true;
    setD(null);
    fetch(url).then((r) => (r.ok ? r.json() : Promise.reject())).then((j: T) => vivo && setD(j)).catch(() => vivo && setD('error'));
    return () => {
      vivo = false;
    };
  }, [url]);
  return d;
}

export default function Analitica() {
  const [sport, setSport] = useState<Deporte>('football');
  const { t, idioma } = useI18n();
  const loc = idioma === 'en' ? 'en-GB' : 'es';
  const fia = usar<Fiabilidad>(`/api/evaluation/reliability?sport=${sport}`);
  const mon = usar<Monitorizacion>(`/api/monitoring?sport=${sport}`);
  const seg = usar<Segmentos>(`/api/evaluation/segmentos?sport=${sport}`);
  const serieLL = mon && mon !== 'error' ? mon.serie.filter((p) => p.logLoss != null && p.n >= 1).map((p) => ({ x: Date.parse(p.dia), y: p.logLoss as number })) : [];
  const serieBr = mon && mon !== 'error' ? mon.serie.filter((p) => p.brier != null && p.n >= 1).map((p) => ({ x: Date.parse(p.dia), y: p.brier as number })) : [];
  return (
    <section className="mb-4 rounded-xl border border-(--line) p-4" aria-label={t('analitica.titulo')}>
      <h3 className="mb-2 text-[15px] font-semibold text-(--ink-strong)">{t('analitica.titulo')}</h3>
      <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label={t('analitica.deporte')}>
        {DEPORTES.map((d) => (
          <button key={d} aria-pressed={sport === d} onClick={() => setSport(d)} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px] ring-1 ${sport === d ? 'bg-(--raised-2) text-(--ink-strong) ring-(--line-strong)' : 'text-(--ink-soft) ring-(--line) hover:bg-(--raised)'}`}>
            <DeporteIcono nombre={d} size={15} />
            {t(`deporte.${d}` as Clave)}
          </button>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h4 className="mb-1 text-[13px] font-medium text-(--ink-body)">{conNodos(t('analitica.fiabilidad'), { ece: <Termino clave="ece">ECE</Termino> })}</h4>
          {fia === null && <p className="text-[12px] text-(--ink-muted)">{t('comun.cargando')}</p>}
          {fia === 'error' && <p className="text-[12px] text-(--ink-muted)">{t('analitica.sinFiabilidad')}</p>}
          {fia && fia !== 'error' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <ReliabilityDiagram titulo={t('analitica.backtest')} cubetas={fia.backtest?.cubetas ?? []} />
                <p className="text-[11px] text-(--ink-muted)">{fia.backtest ? t('analitica.partidosEce', { n: fia.backtest.partidos.toLocaleString(loc), ece: fia.backtest.ece == null ? '—' : pct(fia.backtest.ece) }) : t('analitica.sinBacktest')}</p>
              </div>
              <div>
                <ReliabilityDiagram titulo={t('analitica.enVivo')} cubetas={fia.live.cubetas} />
                <p className="text-[11px] text-(--ink-muted)">{t('analitica.partidosEce', { n: fia.live.partidos, ece: fia.live.ece == null ? '—' : pct(fia.live.ece) })}{fia.live.aviso.texto ? ` · ${fia.live.aviso.texto}` : ''}</p>
              </div>
            </div>
          )}
        </div>
        <div>
          <h4 className="mb-1 text-[13px] font-medium text-(--ink-body)">
            {conNodos(t('analitica.ventana'), {
              brier: <Termino clave="brier">Brier</Termino>,
              logloss: <Termino clave="logloss">log loss</Termino>,
              psi: <Termino clave="psi">PSI</Termino>,
            })}
          </h4>
          {mon === null && <p className="text-[12px] text-(--ink-muted)">{t('comun.cargando')}</p>}
          {mon === 'error' && <p className="text-[12px] text-(--ink-muted)">{t('analitica.sinMonitorizacion')}</p>}
          {mon && mon !== 'error' && (
            <>
              {serieLL.length > 1 ? (
                <LineChart series={[{ nombre: 'log loss', puntos: serieLL }, { nombre: 'Brier', puntos: serieBr }]} formatoX={(x) => new Date(x).toLocaleDateString(loc, { day: '2-digit', month: 'short' })} referencia={mon.referencia?.logLoss != null ? { y: mon.referencia.logLoss, etiqueta: t('analitica.referencia', { v: numF(mon.referencia.logLoss, 3) }) } : undefined} />
              ) : (
                <p className="text-[12px] text-(--ink-muted)">{t('analitica.sinSerie')}</p>
              )}
              <p className="mt-1 text-[12px] text-(--ink-soft)">
                {mon.actual ? t('analitica.ahora', { n: mon.actual.n, ll: (mon.actual.logLoss == null ? undefined : numF(mon.actual.logLoss, 3)) ?? '—', psi: (mon.actual.psi == null ? undefined : numF(mon.actual.psi, 3)) ?? '—' }) : t('analitica.sinVentana')}
                {mon.deriva.hay ? <span className="block" style={{ color: STATUS.critical }} role="alert">{t('analitica.deriva', { motivos: mon.deriva.motivos.join('; ') })}</span> : mon.deriva.aviso.texto ? <span className="block text-(--ink-muted)">{mon.deriva.aviso.texto}</span> : null}
              </p>
            </>
          )}
        </div>
      </div>
      <div className="mt-4">
        <h4 className="mb-1 text-[13px] font-medium text-(--ink-body)">{t('analitica.segmentos')}</h4>
        {seg === null && <p className="text-[12px] text-(--ink-muted)">{t('comun.cargando')}</p>}
        {seg === 'error' && <p className="text-[12px] text-(--ink-muted)">{t('analitica.sinSegmentos')}</p>}
        {seg && seg !== 'error' && (
          seg.predicciones.n === 0 ? (
            <p className="text-[12px] text-(--ink-muted)">{t('analitica.sinPredicciones')}</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {Object.entries(seg.predicciones.dimensiones).map(([dim, celdas]) => {
                const pub = Object.entries(celdas).filter(([, c]) => c.publicada && c.acierto != null);
                const sin = Object.entries(celdas).filter(([, c]) => !c.publicada);
                return (
                  <div key={dim}>
                    {pub.length > 0 ? (
                      <BarChart titulo={dim} max={1} formato={(v) => pct(v, 0)} filas={pub.map(([k, c]) => ({ etiqueta: k, valor: c.acierto as number, n: c.n }))} />
                    ) : (
                      <p className="text-[12px] font-medium text-(--ink-soft)">{dim}</p>
                    )}
                    {sin.length > 0 && <p className="text-[11px] text-(--ink-muted)">{t('analitica.sinPublicar', { n: seg.umbrales.predicciones, lista: sin.map(([k, c]) => `${k} ${c.n}`).join(' · ') })}</p>}
                  </div>
                );
              })}
            </div>
          )
        )}
      </div>
    </section>
  );
}
