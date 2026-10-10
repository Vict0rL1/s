// El banco de papel del modelo, en pantalla.
//
// Va en la pestaña de Apuestas pero SEPARADO del registro de la persona, y eso importa:
// mezclar «lo que apostaste tú» con «lo que apostaría el modelo» en una sola cuenta
// haría imposible responder a ninguna de las dos preguntas.

import ProfitCurve from './ProfitCurve';
import { useEffect, useState } from 'react';
import { NEUTRAL_TEXT, PROFIT_TEXT, STATUS, LOSS_TEXT } from '../../lib/theme';
import { StatusMark } from '../icons';
import { conNodos, useI18n, type Clave } from '../../i18n';
import { pct as pctF, num as numF, dinero as dineroF } from '../../lib/formato';

interface Apuesta {
  /** Grupos de correlación (server/src/staking/risk.ts), en JSON: el primero es el evento. */
  correlation_groups?: string | null;
  id: number;
  placed_at: string;
  sport: string;
  label: string;
  selection: string;
  p_model: number;
  p_market: number;
  odds: number;
  stake: number;
  status: string;
  profit: number | null;
  settled_at?: string | null;
  // Auditoría: nulos en las apuestas anteriores a que existiera, y no se inventan.
  opening_odds?: number | null;
  closing_odds?: number | null;
  closing_observed_at?: string | null;
  commence_time?: string | null;
  clv?: number | null;
  event_result?: string | null;
  model_version?: string | null;
  git_commit?: string | null;
}

interface Resumen {
  bancoInicial: number;
  banco: number;
  beneficio: number;
  expuesto: number;
  liquidadas: number;
  ganadas: number;
  perdidas: number;
  pendientes: number;
  roi: number | null;
  arriesgado: number;
  empezado: string | null;
  ultima: { cuando: string; candidatas: number; colocadas: number; rechazos: Record<string, number> } | null;
  apuestas: Apuesta[];
  motivo: string | null;
  clvMedio?: number | null;
  conCierre?: number;
}

/** Los seis estados, del catálogo (`apuesta.*`). `push`: empate que devuelve el importe (NFL). */
const ESTADOS = new Set(['pending', 'won', 'lost', 'push', 'void', 'cancelled']);

// Sin símbolo de moneda (D5): el proyecto no inventa una (ver lib/bets.ts).
const dinero = (n: number) => dineroF(n);

export default function PaperBankroll() {
  const [r, setR] = useState<Resumen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { t, idioma } = useI18n();
  const loc = idioma === 'en' ? 'en-GB' : 'es';
  const plural = (n: number, uno: Clave, varios: Clave) => t(n === 1 ? uno : varios, { n });
  const estado = (s: string) => (ESTADOS.has(s) ? t(`apuesta.${s}` as Clave) : s);

  useEffect(() => {
    let vivo = true;
    fetch('/api/paper')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((j) => vivo && setR(j as Resumen))
      .catch((e) => vivo && setError((e as Error).message));
    return () => {
      vivo = false;
    };
  }, []);

  if (error) {
    return (
      <section className="mb-6 rounded-xl border border-(--line) bg-(--tint) px-4 py-3 text-[14px] text-(--ink-soft)">
        {t('papel.error', { error })}
      </section>
    );
  }
  if (!r) return null;

  const color = r.beneficio > 0 ? PROFIT_TEXT : r.beneficio < 0 ? LOSS_TEXT : NEUTRAL_TEXT;

  return (
    <section className="mb-6 overflow-hidden rounded-xl border border-(--line) bg-(--tint)">
      <div className="px-4 py-3">
        <h2 className="text-[16px] font-semibold text-(--ink-strong)">{t('papel.titulo')}</h2>
        <p className="mt-0.5 text-[13px] leading-relaxed text-(--ink-muted)">
          {conNodos(t('papel.intro', { inicial: r.bancoInicial }), { noReal: <strong className="text-(--ink-soft)">{t('papel.noReal')}</strong> })}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-px border-t border-(--line) bg-(--raised) sm:grid-cols-4">
        {[
          { k: t('papel.banco'), v: dinero(r.banco), c: color },
          { k: t('papel.beneficio'), v: dinero(r.beneficio), c: color },
          // El ROI no existe sin apuestas liquidadas, y enseñar «0 %» se leería como
          // «no gana nada» cuando lo que pasa es que aún no ha jugado.
          { k: t('papel.roi'), v: r.roi === null ? '—' : `${pctF(r.roi, 1)}`, c: r.roi === null ? undefined : color },
          { k: t('papel.comprometido'), v: dinero(r.expuesto) },
        ].map((x) => (
          <div key={x.k} className="bg-(--surface-page) px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-(--ink-muted)">{x.k}</div>
            <div className="mt-0.5 text-[18px] font-semibold" style={{ color: x.c ?? 'var(--ink-strong)' }}>
              {x.v}
            </div>
          </div>
        ))}
      </div>

      {/* La curva de capital del banco de papel (Fase 5.22): beneficio acumulado por día de liquidación. */}
      {(() => {
        const porDia = new Map<string, number>();
        for (const x of [...r.apuestas].filter((x) => x.profit != null && x.settled_at).sort((a, b) => String(a.settled_at).localeCompare(String(b.settled_at)))) {
          const d = String(x.settled_at).slice(0, 10);
          porDia.set(d, (porDia.get(d) ?? 0) + (x.profit as number));
        }
        let acc = 0;
        const puntos = [...porDia.entries()].map(([day, v]) => ({ day, profit: (acc += v) }));
        return puntos.length >= 3 ? (
          <div className="border-t border-(--line) px-4 py-3">
            <p className="mb-1 text-[12px] font-medium uppercase tracking-wide text-(--ink-muted)">{t('papel.curva')}</p>
            <ProfitCurve points={puntos} />
          </div>
        ) : null;
      })()}

      {/* EL CLV: si se consiguió mejor precio que el de cierre. Es la medida que no
          depende de la suerte del resultado: una apuesta perdida a 2,10 que cerró a
          1,94 fue una buena apuesta. */}
      {r.conCierre != null && r.conCierre > 0 && r.clvMedio != null && (
        <p className="border-t border-(--line) px-4 py-2.5 text-[13px] text-(--ink-soft)">
          <strong style={{ color: r.clvMedio >= 0 ? PROFIT_TEXT : LOSS_TEXT }}>
            {t('papel.clvMedio', { v: `${r.clvMedio >= 0 ? '+' : '−'}${pctF(Math.abs(r.clvMedio), 1)}` })}
          </strong>{' '}
          {plural(r.conCierre, 'papel.clvSobre1', 'papel.clvSobreN')}{' '}
          {r.clvMedio >= 0 ? t('papel.clvBueno') : t('papel.clvMalo')}
        </p>
      )}

      <p className="border-t border-(--line) px-4 py-2.5 text-[13px] text-(--ink-muted)">
        {plural(r.liquidadas, 'papel.liquidada1', 'papel.liquidadaN')} ({plural(r.ganadas, 'papel.ganada1', 'papel.ganadaN')},{' '}
        {plural(r.perdidas, 'papel.perdida1', 'papel.perdidaN')}) · {t('papel.sinResolver', { n: r.pendientes })}
        {r.arriesgado > 0 && t('papel.arriesgados', { d: dinero(r.arriesgado) })}
        {r.empezado && t('papel.desde', { fecha: new Date(r.empezado).toLocaleDateString(loc) })}
        {/* Mismos umbrales que server/src/evaluation/sample.ts (apuestas: 30 y 300). Un aviso,
            no una prueba: el veredicto con intervalo está en «¿Es real?». */}
        {r.roi !== null && r.liquidadas < 300 && (
          <span className="block" style={{ color: STATUS.warning }}>
            <StatusMark estado="aviso" color={STATUS.warning} />
            {r.liquidadas < 30 ? t('papel.avisoPequena', { n: r.liquidadas }) : t('papel.avisoOrientativo', { n: r.liquidadas })}
          </span>
        )}
      </p>

      {/* Sin apuestas y con un motivo: se dice el motivo. Un banco a 1.000 y una tabla
          vacía, sin explicación, se lee como que el experimento no funciona. */}
      {r.apuestas.length === 0 && r.motivo && (
        <div className="border-t border-(--line) px-4 py-3 text-[14px] leading-relaxed text-(--ink-soft)">
          <strong className="text-(--ink-body)">{t('papel.nadaTodavia')}</strong> {r.motivo}
        </div>
      )}

      {/* La última pasada, con los RECHAZOS. Sin esto, un banco quieto se lee igual
          esté esperando partidos, esperando cuotas, o decidiendo no apostar — y la
          tercera es el experimento funcionando, no una avería. */}
      {r.ultima && (r.ultima.candidatas > 0 || Object.keys(r.ultima.rechazos).length > 0) && (
        <div className="border-t border-(--line) px-4 py-2.5 text-[13px] leading-relaxed text-(--ink-muted)">
          {t('papel.ultimaRevision', {
            cuando: new Date(r.ultima.cuando).toLocaleString(loc, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
            partidos: plural(r.ultima.candidatas, 'papel.partidosReales1', 'papel.partidosRealesN'),
            apostados: plural(r.ultima.colocadas, 'papel.apostado1', 'papel.apostadoN'),
          })}
          {Object.entries(r.ultima.rechazos).map(([motivo, n]) => (
            <span key={motivo} className="block">
              {t(n === 1 ? 'papel.descartado1' : 'papel.descartadoN', { n, motivo })}
            </span>
          ))}
        </div>
      )}

      {r.apuestas.length > 0 && (
        <div className="overflow-x-auto border-t border-(--line)" tabIndex={0}>
          <table className="w-full min-w-[560px] border-collapse text-[14px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-(--ink-muted)">
                <th className="px-4 py-2 font-medium">{t('papel.thPartido')}</th>
                <th className="px-4 py-2 font-medium">{t('papel.thApuesta')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('papel.thModeloMercado')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('papel.thCuotas')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('papel.thImporte')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('papel.thResultado')}</th>
              </tr>
            </thead>
            <tbody>
              {r.apuestas.map((a) => (
                <tr key={a.id} className="border-t border-(--line)">
                  <td className="px-4 py-2.5 text-(--ink-body)">
                    {a.label}
                    {a.correlation_groups && (
                      <span className="block text-[11px] text-(--ink-faint)" title={(JSON.parse(a.correlation_groups) as string[]).join(' · ')}>
                        {t('papel.grupo', { g: (JSON.parse(a.correlation_groups) as string[])[0] })}
                      </span>
                    )}
                    {/* Qué versión exacta del modelo tomó la decisión. */}
                    {a.model_version && (
                      <span className="block text-[11px] text-(--ink-faint)" title={a.git_commit ? `commit ${a.git_commit}` : undefined}>
                        {a.model_version}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-(--ink-strong)">{a.selection}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right text-(--ink-soft)">
                    {pctF(a.p_model, 1)} / {pctF(a.p_market, 1)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right text-(--ink-soft)">
                    <span className="text-(--ink-faint)">{a.opening_odds != null ? numF(a.opening_odds, 2) : '—'}</span>
                    {' · '}
                    <span className="font-semibold text-(--ink-strong)">{numF(a.odds, 2)}</span>
                    {' · '}
                    <span className="text-(--ink-faint)">{a.closing_odds != null ? numF(a.closing_odds, 2) : '—'}</span>
                    {a.clv != null && (
                      <span className="block text-[11px]" style={{ color: a.clv >= 0 ? PROFIT_TEXT : LOSS_TEXT }}>
                        CLV {a.clv >= 0 ? '+' : '−'}
                        {pctF(Math.abs(a.clv), 1)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right text-(--ink-soft)">{numF(a.stake, 2)}</td>
                  <td
                    className="whitespace-nowrap px-4 py-2.5 text-right font-medium"
                    style={{
                      color:
                        a.status === 'pending'
                          ? 'var(--ink-muted)'
                          : (a.profit ?? 0) > 0
                            ? PROFIT_TEXT
                            : (a.profit ?? 0) < 0
                              ? LOSS_TEXT
                              : NEUTRAL_TEXT,
                    }}
                  >
                    {a.status === 'pending' || a.status === 'won' || a.status === 'lost'
                      ? a.status === 'pending'
                        ? estado('pending')
                        : dinero(a.profit ?? 0)
                      : estado(a.status)}
                    {a.event_result && <span className="block text-[11px] font-normal text-(--ink-muted)">{a.event_result}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
