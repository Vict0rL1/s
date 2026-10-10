// Comparador de líneas (Fase 6.5): la mejor cuota de cada selección y en qué casa, el consenso, la
// dispersión entre casas y si hay surebet. Solo lectura: el banco de papel apuesta al consenso.
import { useState } from 'react';
import { Link } from 'react-router';
import { useI18n, formato } from '../i18n';
import { useJson } from '../lib/usarJson';
import { SubNav } from '../components/nav/SubNav';
import { pillClass } from '../components/ui';
import { COLOR_BENEFICIO } from '../components/charts';
import { useSubnavApuestas } from './subnav';

interface Linea { seleccion: string; linea: number | null; mejor: { cuota: number; casa: string }; peor: { cuota: number; casa: string }; consenso: number; casas: number; dispersionPp: number; mejorSobreConsenso: number }
interface Mercado { eventId: string; sport: string; league: string; market: string; partido: string; cuando: string | null; eventoId: string | null; selecciones: Linea[]; margenMejor: number | null; margenConsenso: number | null; surebet: boolean; observado: string | null }
interface Respuesta { generado: string; ventanaHoras: number; mercados: Mercado[]; eventos: number; nota: string }

const DEPORTES = ['football', 'basketball', 'baseball', 'nfl', 'nhl', 'ufc', 'tennis'];
const MERCADOS = ['h2h', 'spreads', 'totals'];

export default function Lineas() {
  const { t, idioma } = useI18n();
  const f = formato(idioma);
  const subnav = useSubnavApuestas();
  const [sport, setSport] = useState('');
  const [market, setMarket] = useState('');
  const [soloSurebets, setSoloSurebets] = useState(false);
  const q = new URLSearchParams();
  if (sport) q.set('sport', sport);
  if (market) q.set('market', market);
  const { datos, error } = useJson<Respuesta>(`/api/odds/lineas${q.toString() ? `?${q}` : ''}`);
  const mercados = (datos?.mercados ?? []).filter((m) => !soloSurebets || m.surebet);
  const cuota = (x: number) => f.numero(x, 2);
  return (
    <div>
      <p className="mb-1 text-[12px] text-(--ink-muted)">
        <Link to="/apuestas" className="underline-offset-2 hover:underline">{t('nav.apuestas')}</Link> › {t('nav.lineas')}
      </p>
      <SubNav etiqueta={t('nav.subApuestas')} enlaces={subnav} />
      <h2 className="mb-1 text-[20px] font-semibold text-(--ink-strong)">{t('lineas.titulo')}</h2>
      <p className="mb-2 max-w-3xl text-[14px] leading-relaxed text-(--ink-soft)">{t('lineas.intro')}</p>
      {datos && <p className="mb-4 max-w-3xl text-[12px] text-(--ink-muted)">{datos.nota}</p>}
      <div className="mb-4 flex flex-wrap gap-1.5">
        <button className={pillClass(sport === '')} onClick={() => setSport('')}>{t('bandeja.todosDeportes')}</button>
        {DEPORTES.map((d) => (
          <button key={d} className={pillClass(sport === d)} onClick={() => setSport(d)}>{t(`deporte.${d}` as never)}</button>
        ))}
        <select aria-label={t('lineas.mercado')} value={market} onChange={(e) => setMarket(e.target.value)} className="rounded-full bg-(--raised) px-3 py-1.5 text-[14px] text-(--ink-body) ring-1 ring-(--line)">
          <option value="">{t('lineas.todosMercados')}</option>
          {MERCADOS.map((m) => (
            <option key={m} value={m}>{t(`lineas.mercado.${m}` as never)}</option>
          ))}
        </select>
        <button className={pillClass(soloSurebets)} aria-pressed={soloSurebets} onClick={() => setSoloSurebets((x) => !x)}>{t('lineas.soloSurebets')}</button>
      </div>
      {error && <p role="alert" className="text-[14px] text-(--ink-soft)">{error}</p>}
      {datos && mercados.length === 0 && <p className="text-[14px] text-(--ink-muted)">{t('lineas.vacio', { horas: datos.ventanaHoras })}</p>}
      <div className="grid gap-3 lg:grid-cols-2" data-testid="lista-lineas">
        {mercados.map((m) => (
          <article key={`${m.eventId}|${m.market}`} className="rounded-xl border border-(--line) bg-(--surface-card) p-4">
            <div className="mb-2 flex flex-wrap items-baseline gap-2">
              <h3 className="min-w-0 flex-1 break-words text-[15px] font-semibold text-(--ink-strong)">
                {m.eventoId ? <Link to={`/partido/${m.sport}/${encodeURIComponent(m.eventoId)}`} className="hover:underline">{m.partido}</Link> : m.partido}
              </h3>
              {m.surebet && <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1" style={{ color: COLOR_BENEFICIO, borderColor: COLOR_BENEFICIO }}>surebet</span>}
            </div>
            <p className="mb-2 text-[12px] text-(--ink-muted)">
              {t(`deporte.${m.sport}` as never)} · {t(`lineas.mercado.${m.market}` as never)}
              {m.cuando ? ` · ${f.fecha(m.cuando)}` : ''}
              {m.margenConsenso != null ? ` · ${t('lineas.margenConsenso', { v: f.porcentaje(m.margenConsenso, 1) })}` : ''}
              {m.margenMejor != null ? ` · ${t('lineas.margenMejor', { v: f.porcentaje(m.margenMejor, 1) })}` : ''}
            </p>
            <div className="overflow-x-auto" tabIndex={0}>
              <table className="w-full min-w-[20rem] text-[13px] tabular-nums">
                <thead>
                  <tr className="text-left text-(--ink-muted)">
                    <th className="py-1 pr-2 font-medium">{t('lineas.seleccion')}</th>
                    <th className="py-1 pr-2 font-medium">{t('lineas.mejor')}</th>
                    <th className="py-1 pr-2 font-medium">{t('lineas.consenso')}</th>
                    <th className="py-1 pr-2 font-medium">{t('lineas.peor')}</th>
                    <th className="py-1 font-medium">{t('lineas.dispersion')}</th>
                  </tr>
                </thead>
                <tbody>
                  {m.selecciones.map((s) => (
                    <tr key={s.seleccion} className="border-t border-(--line) align-top">
                      <td className="py-1 pr-2 text-(--ink-body)">
                        {s.seleccion}
                        {s.linea != null && <span className="text-(--ink-muted)"> {s.linea > 0 ? `+${s.linea}` : s.linea}</span>}
                      </td>
                      <td className="py-1 pr-2">
                        <span className="font-semibold text-(--ink-strong)">{cuota(s.mejor.cuota)}</span>
                        <span className="block text-[11px] text-(--ink-muted)">{s.mejor.casa} · +{f.porcentaje(s.mejorSobreConsenso, 1)}</span>
                      </td>
                      <td className="py-1 pr-2 text-(--ink-body)">{cuota(s.consenso)}<span className="block text-[11px] text-(--ink-muted)">{t('lineas.casas', { n: s.casas })}</span></td>
                      <td className="py-1 pr-2 text-(--ink-soft)">{cuota(s.peor.cuota)}<span className="block text-[11px] text-(--ink-muted)">{s.peor.casa}</span></td>
                      <td className="py-1 text-(--ink-body)">{f.numero(s.dispersionPp, 1)} pp</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
