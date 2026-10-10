// Cómo va el modelo EN VIVO, con la capa común de métricas (server/src/evaluation).
//
// El log loss va delante y el acierto al final, a propósito: el acierto no distingue un
// 51 % de un 90 % y el log loss sí. Y ningún número va solo: al lado, el del mercado sobre
// los MISMOS partidos, que es la referencia que decide si el modelo aporta algo. Son solo
// predicciones reales registradas antes de cada partido: ningún backtest entra aquí.

import { useEffect, useState } from 'react';
import { PROFIT_TEXT, STATUS, LOSS_TEXT } from '../../lib/theme';
import { AlertIcon, DeporteIcono } from '../icons';
import { codigo, conNodos, useI18n, type Clave, type Traducir } from '../../i18n';
import { pct as pctF, num as numF } from '../../lib/formato';

interface Informe {
  origen: 'live';
  deporte: string;
  n: number;
  logLoss: number | null;
  brier: number | null;
  accuracy: number | null;
  ece: number | null;
  mercado: { n: number; logLoss: number; brier: number; modeloLogLoss: number } | null;
  logLossUniforme: number | null;
  aviso?: { nivel: string; texto: string | null };
  porVersion?: { version: string | null; n: number; logLoss: number | null; mercado: { n: number; logLoss: number; modeloLogLoss: number } | null }[];
}

interface Prueba {
  pregunta: string;
  n: number;
  veredicto: 'a favor' | 'en contra' | 'no concluyente' | 'muestra insuficiente';
  lectura: string;
}
interface Validacion {
  modeloVsMercado: Record<string, Prueba>;
  clvSenales: Prueba;
  clvApostadas: Prueba;
  clvRechazadas: Prueba;
  retornoBanco: Prueba;
  promesa?: Prueba;
}

interface Tramo {
  etiqueta: string;
  aviso?: { nivel: string; texto: string | null };
  n: number;
  roi: number | null;
  roiPrometido: number | null;
  clvMedio: number | null;
}
interface GrupoSeleccion {
  nombre: string;
  informe: { n: number; logLoss: number | null; brier: number | null; ece: number | null; accuracy: number | null };
  ganancia?: number | null;
  mezcla?: Record<string, number>;
  aviso: { nivel: string; texto: string | null };
  roiHipotetico: { apuestas: number; roi: number | null; aviso: { nivel: string; texto: string | null } } | null;
}
interface CalidadSeleccion {
  partidos: number;
  grupos: GrupoSeleccion[];
  cobertura: { cobertura: number; n: number; informe: { logLoss: number | null; brier: number | null }; ganancia?: number | null; aviso: { texto: string | null } }[];
  porDeporte?: Record<string, GrupoSeleccion[]>;
  clv: { apostadas: { n: number; media: number | null }; abstenidas: { n: number; media: number | null } };
  lectura: string;
}
interface Rendimiento {
  total: Tramo;
  aciertos: number;
  aciertosEsperados: number | null;
  drawdown: { importe: number; pct: number } | null;
  peorRacha: number;
  porDeporte: Tramo[];
  porCuota: Tramo[];
  porEdge: Tramo[];
  senalesPorEdge: (Prueba & { etiqueta: string })[];
  lecturaEdge: string | null;
}
const COLOR_VEREDICTO: Record<Prueba['veredicto'], string> = {
  'a favor': PROFIT_TEXT,
  'en contra': LOSS_TEXT,
  'no concluyente': STATUS.warning,
  'muestra insuficiente': 'var(--ink-muted)',
};

const DEPORTES = new Set(['tennis', 'football', 'basketball', 'baseball', 'nfl', 'nhl', 'ufc']);
const nombreDe = (t: Traducir, id: string) => (DEPORTES.has(id) ? t(`deporte.${id}` as Clave) : id);
/** El deporte con su icono, para celdas y títulos (`nombreDe` se queda para el texto corrido). */
function Dep({ id }: { id: string }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-center gap-1.5">
      <DeporteIcono nombre={id} size={15} />
      {nombreDe(t, id)}
    </span>
  );
}
const f3 = (x: number | null | undefined) => (x == null ? '—' : numF(x, 3));
const pct = (x: number | null | undefined) => (x == null ? '—' : `${pctF(x, 1)}`);
const signo = (x: number | null | undefined) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${pctF(Math.abs(x), 1)}`);

export default function LiveEvaluation() {
  const [d, setD] = useState<Informe[] | null>(null);
  const [v, setV] = useState<Validacion | null>(null);
  const [rend, setRend] = useState<Rendimiento | null>(null);
  const [sel, setSel] = useState<CalidadSeleccion | null>(null);
  const { t } = useI18n();
  useEffect(() => {
    let vivo = true;
    fetch('/api/evaluation')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j: { deportes: Informe[]; validacion?: Validacion; rendimiento?: Rendimiento; seleccion?: CalidadSeleccion }) => {
        if (!vivo) return;
        setD(j.deportes);
        setV(j.validacion ?? null);
        setRend(j.rendimiento ?? null);
        setSel(j.seleccion ?? null);
      })
      .catch(() => vivo && setD([]));
    return () => {
      vivo = false;
    };
  }, []);
  if (!d) return null;
  const hay = d.filter((x) => x.n > 0);

  return (
    <section className="mb-6 overflow-hidden rounded-xl border border-(--line) bg-(--tint)">
      <div className="px-4 py-3">
        <h3 className="text-[16px] font-semibold text-(--ink-strong)">{t('eval.titulo')}</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-(--ink-muted)">
          {conNodos(t('eval.intro'), { antes: <strong>{t('eval.antes')}</strong>, logloss: <strong>{t('eval.logloss')}</strong> })}
        </p>
      </div>
      {hay.length === 0 ? (
        <p className="border-t border-(--line) px-4 py-3 text-[14px] text-(--ink-soft)">
          {t('eval.vacio')}
        </p>
      ) : (
        <div className="overflow-x-auto border-t border-(--line)" tabIndex={0}>
          <table className="w-full min-w-[620px] border-collapse text-[14px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-(--ink-muted)">
                <th className="px-4 py-2 font-medium">{t('eval.thDeporte')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('eval.thPartidos')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('eval.thLogLoss')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('eval.thMercado')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('eval.thNoSaber')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('eval.thBrier')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('eval.thCalibracion')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('eval.thAcierto')}</th>
              </tr>
            </thead>
            <tbody>
              {hay.map((x) => {
                // Comparado sobre los MISMOS partidos: el del modelo restringido a los que
                // tienen precio, no el global.
                const mejor = x.mercado ? x.mercado.modeloLogLoss < x.mercado.logLoss : null;
                return (
                  <tr key={x.deporte} className="border-t border-(--line)">
                    <td className="px-4 py-2.5 text-(--ink-body)"><Dep id={x.deporte} /></td>
                    <td className="px-4 py-2.5 text-right text-(--ink-soft)" title={x.aviso?.texto ?? undefined}>
                      {x.n}
                      {x.aviso?.nivel === 'insuficiente' && <span className="ml-1 inline-flex align-[-2px]" style={{ color: STATUS.warning }} title={t('eval.muestraInsuficiente')}><AlertIcon size={14} /></span>}
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold text-(--ink-strong)">{f3(x.logLoss)}</td>
                    <td className="px-4 py-2.5 text-right text-(--ink-soft)">
                      {x.mercado ? (
                        <>
                          {f3(x.mercado.logLoss)}
                          <span className="block text-[11px]" style={{ color: mejor ? PROFIT_TEXT : LOSS_TEXT }}>
                            {mejor ? t('eval.modeloMejor') : t('eval.mercadoMejor')} · {t('eval.conPrecio', { n: x.mercado.n })}
                          </span>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right text-(--ink-faint)">{f3(x.logLossUniforme)}</td>
                    <td className="px-4 py-2.5 text-right text-(--ink-soft)">{f3(x.brier)}</td>
                    <td className="px-4 py-2.5 text-right text-(--ink-soft)">±{pct(x.ece)}</td>
                    <td className="px-4 py-2.5 text-right text-(--ink-muted)">{pct(x.accuracy)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {/* POR VERSIÓN. La fila de arriba junta todas las versiones del modelo; en cuanto
              hay más de una, aquí se ve cada una sobre SUS predicciones, para saber si el
              cambio mejoró o empeoró sin que la vieja tape a la nueva. */}
          {hay.some((x) => (x.porVersion?.length ?? 0) > 1) && (
            <div className="border-t border-(--line) px-4 py-2 text-[12px] text-(--ink-soft)">
              <p className="mb-1 text-(--ink-muted)">{t('eval.porVersion')}</p>
              {hay
                .filter((x) => (x.porVersion?.length ?? 0) > 1)
                .map((x) => (
                  <p key={x.deporte}>
                    <Dep id={x.deporte} />:{' '}
                    {x.porVersion!.map((v, i) => (
                      <span key={v.version ?? 'sin'}>
                        {i > 0 && ' · '}
                        <code className="text-(--ink-body)">{v.version ?? t('eval.sinVersion')}</code> {t('eval.versionPartidos', { n: v.n, ll: f3(v.logLoss) })}
                        {v.mercado && t('eval.versionPrecio', { n: v.mercado.n, m: f3(v.mercado.modeloLogLoss), k: f3(v.mercado.logLoss) })}
                      </span>
                    ))}
                  </p>
                ))}
            </div>
          )}
          {hay.some((x) => x.n < 200) && (
            <p className="border-t border-(--line) px-4 py-2 text-[12px] text-(--ink-muted)">
              {t('eval.pocosPartidos')}
            </p>
          )}
        </div>
      )}
      {/* EL DINERO, POR TRAMOS. Lo que el banco prometía (la ventaja con que apostó) al lado
          de lo que dio, y dónde: deporte, cuota y tamaño de la ventaja. */}
      {rend && (rend.total.n > 0 || rend.senalesPorEdge.some((t) => t.n > 0)) && (
        <div className="border-t border-(--line) px-4 py-3">
          <h4 className="text-[14px] font-semibold text-(--ink-body)">{t('eval.dineroTitulo')}</h4>
          {rend.total.n > 0 && (
            <>
              <p className="mt-1 text-[13px] leading-relaxed text-(--ink-soft)">
                {conNodos(t('eval.dineroResumen', { n: rend.total.n, prometido: signo(rend.total.roiPrometido) }), {
                  roi: <strong style={{ color: (rend.total.roi ?? 0) >= 0 ? PROFIT_TEXT : LOSS_TEXT }}>{signo(rend.total.roi)}</strong>,
                })}
                {rend.aciertosEsperados != null && t('eval.aciertosEsperados', { a: rend.aciertos, e: numF(rend.aciertosEsperados, 1) })}
                {rend.drawdown && rend.drawdown.importe > 0 && t('eval.peorCaida', { p: pct(rend.drawdown.pct) })}
                {rend.peorRacha > 0 && t('eval.racha', { n: rend.peorRacha })}
              </p>
              {rend.total.aviso?.texto && (
                <p className="text-[12px]" style={{ color: STATUS.warning }}>
                  {rend.total.aviso.texto}
                </p>
              )}
              <div className="mt-2 overflow-x-auto" tabIndex={0}>
                <table className="w-full border-collapse whitespace-nowrap text-[12px] sm:text-[13px]">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-(--ink-muted)">
                      <th className="py-1.5 pr-2 sm:pr-3 font-medium">{t('eval.thTramo')}</th>
                      <th className="py-1.5 pr-2 sm:pr-3 text-right font-medium">{t('eval.thN')}</th>
                      <th className="py-1.5 pr-2 sm:pr-3 text-right font-medium">{t('eval.thRoi')}</th>
                      <th className="py-1.5 pr-2 sm:pr-3 text-right font-medium">{t('eval.thPrometido')}</th>
                      <th className="py-1.5 text-right font-medium">{t('eval.thClv')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        [t('eval.porDeporte'), rend.porDeporte.map((x) => ({ ...x, etiqueta: nombreDe(t, x.etiqueta) }))],
                        [t('eval.porCuota'), rend.porCuota],
                        [t('eval.porVentaja'), rend.porEdge],
                      ] as [string, Tramo[]][]
                    ).map(([grupo, ts]) => [
                      <tr key={grupo}>
                        <td colSpan={5} className="pt-2 text-[11px] uppercase tracking-wide text-(--ink-faint)">
                          {grupo}
                        </td>
                      </tr>,
                      ...ts.map((x) => (
                        <tr key={grupo + x.etiqueta} className="border-t border-(--line)">
                          <td className="py-1.5 pr-2 sm:pr-3 text-(--ink-body)">{x.etiqueta}</td>
                          <td className="py-1.5 pr-2 sm:pr-3 text-right text-(--ink-soft)" title={x.aviso?.texto ?? undefined}>
                            {x.n}
                            {x.aviso?.nivel === 'insuficiente' && <span className="ml-1 inline-flex align-[-2px]" style={{ color: STATUS.warning }} title={t('eval.muestraInsuficiente')}><AlertIcon size={14} /></span>}
                          </td>
                          <td className="py-1.5 pr-2 sm:pr-3 text-right" style={{ color: (x.roi ?? 0) >= 0 ? PROFIT_TEXT : LOSS_TEXT }}>
                            {signo(x.roi)}
                          </td>
                          <td className="py-1.5 pr-2 sm:pr-3 text-right text-(--ink-muted)">{signo(x.roiPrometido)}</td>
                          <td className="py-1.5 text-right text-(--ink-soft)">{signo(x.clvMedio)}</td>
                        </tr>
                      )),
                    ])}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {rend.senalesPorEdge.some((x) => x.n > 0) && (
            <div className="mt-3 text-[13px] leading-relaxed">
              <p className="text-(--ink-soft)">
                {t('eval.ventajaGrande')}
              </p>
              <ul className="mt-1 space-y-1">
                {rend.senalesPorEdge
                  .filter((x) => x.n > 0)
                  .map((x) => (
                    <li key={x.etiqueta}>
                      <span className="text-(--ink-body)">{x.etiqueta}</span>{' '}
                      <strong style={{ color: COLOR_VEREDICTO[x.veredicto] }}>{codigo(t, x.veredicto)}</strong>
                      <span className="text-(--ink-muted)"> · {x.lectura}</span>
                    </li>
                  ))}
              </ul>
              {rend.lecturaEdge && <p className="mt-1 text-(--ink-soft)">{rend.lecturaEdge}</p>}
            </div>
          )}
        </div>
      )}
      {/* ¿SIRVE ABSTENERSE? Lo que decidió la capa de confianza antes del partido, contra lo
          que pasó: apostables contra abstenidas, y participar solo en lo más fiable. */}
      {sel && (
        <div className="border-t border-(--line) px-4 py-3 text-[13px] leading-relaxed">
          <h4 className="text-[14px] font-semibold text-(--ink-body)">{t('eval.abstenerse')}</h4>
          {sel.partidos === 0 ? (
            <p className="mt-1 text-(--ink-muted)">{sel.lectura}</p>
          ) : (
            <>
              <ul className="mt-1 space-y-1 text-(--ink-soft)">
                {sel.grupos.filter((g) => g.informe.n > 0).map((g) => (
                  <li key={g.nombre}>
                    <span className="text-(--ink-body)">{g.nombre}</span>: {t('eval.grupoLinea', { n: g.informe.n, g: f3(g.ganancia ?? null) })}
                    {g.mezcla && Object.keys(g.mezcla).length > 1 && ` (${Object.entries(g.mezcla).map(([d, n]) => `${nombreDe(t, d)} ${n}`).join(', ')})`}
                    {g.roiHipotetico && t('eval.roiHipotetico', { roi: signo(g.roiHipotetico.roi), n: g.roiHipotetico.apuestas })}
                    {g.aviso.texto && <span className="block text-[12px]" style={{ color: STATUS.warning }}>{g.aviso.texto}</span>}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-(--ink-soft)">
                {t('eval.cobertura', { lista: sel.cobertura.map((c) => t('eval.coberturaItem', { pct: Math.round(c.cobertura * 100), g: f3(c.ganancia ?? null), n: c.n })).join(' · ') })}
              </p>
              {sel.porDeporte &&
                Object.entries(sel.porDeporte).map(([d, gs]) => (
                  <p key={d} className="text-(--ink-soft)">
                    <Dep id={d} />:{' '}
                    {gs
                      .filter((g) => g.informe.n > 0)
                      .map((g) => `${g.nombre.split(' (')[0].toLowerCase()} ${g.informe.n} · log loss ${f3(g.informe.logLoss)} · Brier ${f3(g.informe.brier)}`)
                      .join(' | ')}
                  </p>
                ))}
              <p className="text-[12px] text-(--ink-faint)">
                {t('eval.ganancia')}
              </p>
              <p className="text-(--ink-soft)">
                {t('eval.clvSenales', { a: signo(sel.clv.apostadas.media), na: sel.clv.apostadas.n, b: signo(sel.clv.abstenidas.media), nb: sel.clv.abstenidas.n })}
              </p>
              <p className="text-[12px] text-(--ink-muted)">{sel.lectura}</p>
            </>
          )}
        </div>
      )}
      {/* ¿ES REAL? Cada cifra con su intervalo. El veredicto no promete más de lo que la
          muestra sostiene: con pocos datos dice cuántos harían falta. */}
      {v && (
        <div className="border-t border-(--line) px-4 py-3">
          <h4 className="text-[14px] font-semibold text-(--ink-body)">{t('eval.esReal')}</h4>
          <ul className="mt-2 space-y-1.5 text-[13px] leading-relaxed">
            {[
              ...Object.entries(v.modeloVsMercado)
                .filter(([, p]) => p.n > 0)
                .map(([dep, p]) => ({ ...p, pregunta: t('eval.qModelo', { deporte: nombreDe(t, dep) }) })),
              { ...v.clvSenales, pregunta: t('eval.qSenales') },
              { ...v.clvApostadas, pregunta: t('eval.qApostadas') },
              { ...v.clvRechazadas, pregunta: t('eval.qRechazadas') },
              { ...v.retornoBanco, pregunta: t('eval.qBanco') },
              ...(v.promesa ? [{ ...v.promesa, pregunta: t('eval.qPromesa') }] : []),
            ].map((p) => (
              <li key={p.pregunta}>
                <span className="text-(--ink-soft)">{p.pregunta}</span>{' '}
                <strong style={{ color: COLOR_VEREDICTO[p.veredicto] }}>{codigo(t, p.veredicto)}</strong>
                <span className="text-(--ink-muted)"> · {p.lectura}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
