// ¿Cuánto fiarse de ESTA predicción? La respuesta de la capa de confianza
// (server/src/trust), con sus razones, y lo que el modelo decía antes del partido.
//
// No es «una nota»: cada pieza dice qué mide y con qué criterio, y lo que la app no sabe
// aparece como desconocido. La decisión BET / NO BET es la misma que aplica el banco de
// papel.

import { useEffect, useState } from 'react';
import { LOSS_COLOR, PROFIT_COLOR, PROFIT_TEXT, LOSS_TEXT } from '../../lib/theme';
import { StatusMark } from '../icons';
import { etiquetaHorizonte, nombreDelPrePartido, type EvaluacionConfianza, type PrePartido, type PrePartidoRef } from '../../lib/trust';
import { ConfianzaBadge } from './ConfianzaBadge';
import { codigo, useI18n } from '../../i18n';
import { pct as pctF, num as numF } from '../../lib/formato';

const pct = (p: number) => `${pctF(p, 1)}`;
const pp = (x: number) => `${x >= 0 ? '+' : '−'}${numF(Math.abs(x), 1)} pp`;
const AMBAR = 'var(--status-warning)';
const GRIS = 'var(--ink-muted)';

const COLOR: Record<string, string> = {
  ALTA: PROFIT_TEXT, BAJO: PROFIT_TEXT, BET: PROFIT_TEXT,
  MEDIA: AMBAR, MEDIO: AMBAR,
  BAJA: LOSS_TEXT, ALTO: LOSS_TEXT, 'NO BET': LOSS_TEXT,
  'SIN MERCADO': GRIS, 'SIN DATOS': GRIS, 'SIN COMPONENTES': GRIS,
};

function Etiqueta({ texto }: { texto: string }) {
  const { t } = useI18n();
  return (
    <span className="rounded px-1.5 py-0.5 text-[11px] font-semibold tracking-wide" style={{ color: COLOR[texto] ?? GRIS, border: `1px solid ${COLOR[texto] ?? GRIS}55` }}>
      {codigo(t, texto)}
    </span>
  );
}

function Fila({ titulo, valor, children }: { titulo: string; valor: React.ReactNode; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-(--line) py-2">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-3 text-left text-[13px]" aria-expanded={open}>
        <span className="text-(--ink-soft)">{titulo}</span>
        <span className="flex items-center gap-2 text-(--ink-body)">
          {valor}
          {children && <span className="text-(--ink-faint)">{open ? '▲' : '▼'}</span>}
        </span>
      </button>
      {open && children && <div className="mt-2 space-y-1 text-[12px] leading-relaxed text-(--ink-soft)">{children}</div>}
    </div>
  );
}

const COLOR_ICONO = { ok: PROFIT_COLOR, aviso: AMBAR, desconocido: GRIS } as const;

const logit = (p: number) => Math.log(Math.max(p, 1e-9) / Math.max(1 - p, 1e-9));
const sigm = (x: number) => 1 / (1 + Math.exp(-x));
/** El mismo desplazamiento logístico que usa la capa de confianza (server/src/trust/perturbation.ts: mover). */
export function moverProbs(probs: number[], pendiente: number, delta: number): number[] {
  if (probs.length === 2) {
    const q = sigm(logit(probs[0]) + pendiente * delta);
    return [q, 1 - q];
  }
  const [h, d, a] = probs;
  const resto = h + a;
  const q = sigm(logit(h / resto) + pendiente * delta);
  return [resto * q, d, resto * (1 - q)];
}

/** Deslizadores «qué pasaría si»: cada factor dentro de su rango plausible; se recalcula aquí, nunca se registra. */
function QueSi({ c }: { c: EvaluacionConfianza }) {
  const q = c.queSi;
  const [mult, setMult] = useState<Record<string, number>>({});
  const { t } = useI18n();
  if (!q || q.factores.length === 0) return <p>{t('fiarse.sinFactores')}</p>;
  const delta = q.factores.reduce((s, f) => s + f.puntos * ((mult[f.clave] ?? 1) - 1), 0);
  const probs = moverProbs(c.probs, q.pendiente, delta);
  const tocado = Object.values(mult).some((m) => m !== 1);
  return (
    <>
      {q.factores.map((f) => {
        const m = mult[f.clave] ?? 1;
        const [lo, hi] = f.rango;
        return (
          <label key={f.clave} className="block">
            <span className="flex items-center justify-between gap-2">
              <span className="text-(--ink-body)">{f.etiqueta}</span>
              <span className="tabular-nums">{numF((f.puntos * m), 1)} <span className="text-(--ink-faint)">(×{numF(m, 2)})</span></span>
            </span>
            <input type="range" min={lo} max={hi} step={0.05} value={m} onChange={(e) => setMult((s) => ({ ...s, [f.clave]: Number(e.target.value) }))} className="mt-1 w-full accent-[#c3c9d1]" aria-label={t('fiarse.queSiAria', { factor: f.etiqueta })} />
            <span className="text-(--ink-faint)">{f.porQue}</span>
          </label>
        );
      })}
      <p className="mt-1 text-(--ink-body)">
        {c.outcomes.map((o, i) => (
          <span key={o} className="mr-3 tabular-nums">{o}: {pct(probs[i])}{tocado ? ` (${pp((probs[i] - c.probs[i]) * 100)})` : ''}</span>
        ))}
      </p>
      {tocado && <button onClick={() => setMult({})} className="text-(--ink-muted) underline-offset-2 hover:underline">{t('fiarse.volver')}</button>}
      <p className="text-(--ink-faint)">{q.etiqueta}{q.exacta ? '' : t('fiarse.curvaAprox')}</p>
    </>
  );
}

function HistorialPrePartido({ refP }: { refP: PrePartidoRef }) {
  const [d, setD] = useState<PrePartido | null>(null);
  const [error, setError] = useState(false);
  const { t } = useI18n();
  useEffect(() => {
    let vivo = true;
    fetch(`/api/prematch/${refP.sport}/${encodeURIComponent(refP.matchKey)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j: PrePartido) => vivo && setD(j))
      .catch(() => vivo && setError(true));
    return () => {
      vivo = false;
    };
  }, [refP.sport, refP.matchKey]);
  if (error) return <p>{t('fiarse.errorHistorial')}</p>;
  if (!d) return <p>{t('comun.cargando')}</p>;
  if (!d.instantaneas) return <p>{t('fiarse.sinInstantaneas')}</p>;
  const nombre = nombreDelPrePartido(d);
  return (
    <>
      <p>{t('fiarse.probabilidadDe', { nombre })}</p>
      <ul>
        {d.horizontes.map((h) => (
          <li key={h.etiqueta}>
            <span className="text-(--ink-body)">{h.etiqueta}:</span>{' '}
            {h.fila ? `${pct(h.fila.probs[0])}${h.minutosAntesDeLaMarca && h.minutosAntesDeLaMarca > 90 ? t('fiarse.capturada', { h: Math.round(h.minutosAntesDeLaMarca / 60) }) : ''}` : t(etiquetaHorizonte(h) ?? 'fiarse.sinObservacion')}
          </li>
        ))}
      </ul>
      {d.final && <p>{t('fiarse.finalCongelada', { fuente: d.final.source === 'snapshot' ? t('fiarse.ultimaInstantanea') : t('fiarse.registroPredicciones'), p: pct(d.final.probs[0]) })}</p>}
      {d.cambios.length > 0 && (
        <>
          <p className="mt-1">{t('fiarse.cambios')}</p>
          <ul>
            {d.cambios.map((c, i) => (
              <li key={i}>
                {pp(c.deltaPp[0])} · {c.causas.length ? c.causas.join('; ') : ''} <span className="text-(--ink-faint)">({c.atribucion})</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function LineaTemporal({ refP }: { refP: PrePartidoRef }) {
  const [d, setD] = useState<{ hitos: { at: string; tipo: string; texto: string }[]; nota: string } | null>(null);
  const { t, idioma } = useI18n();
  useEffect(() => {
    let vivo = true;
    fetch(`/api/timeline/${refP.sport}/${encodeURIComponent(refP.matchKey)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => vivo && setD(j))
      .catch(() => vivo && setD({ hitos: [], nota: t('fiarse.errorLinea') }));
    return () => {
      vivo = false;
    };
  }, [refP.sport, refP.matchKey, t]);
  if (!d) return <p>{t('comun.cargando')}</p>;
  return (
    <>
      {d.hitos.map((h, i) => (
        <p key={i}>
          <span className="text-(--ink-faint)">{new Date(h.at).toLocaleString(idioma === 'en' ? 'en-GB' : 'es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span> {h.texto}
        </p>
      ))}
      <p className="text-(--ink-faint)">{d.nota}</p>
    </>
  );
}

export default function EventTrustPanel({ confianza, prePartido }: { confianza?: EvaluacionConfianza | null; prePartido?: PrePartidoRef | null }) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  if (!confianza) return null;
  const c = confianza;
  const top = c.probs.indexOf(Math.max(...c.probs));
  return (
    <div className="mt-2 rounded-lg border border-(--line) bg-(--tint) px-3 py-2">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-2 text-left" aria-expanded={open}>
        <span className="text-[14px] font-medium text-(--ink-body)">{t('fiarse.titulo')}</span>
        <span className="flex flex-wrap items-center justify-end gap-1.5 text-[12px] text-(--ink-soft)">
          <ConfianzaBadge nivel={c.confianza.nivel} decision={c.decision.decision} compacta />
          {c.decision.decision !== 'SIN MERCADO' && <Etiqueta texto={c.decision.decision} />}
          <span className="text-(--ink-faint)">{open ? '▲' : '▼'}</span>
        </span>
      </button>
      {open && (
        <div className="mt-2">
          <p className="text-[13px] text-(--ink-body)">
            {t('fiarse.rango', { resultado: c.outcomes[top], p: pct(c.probs[top]), bajo: pct(c.incertidumbre.rango.bajo), alto: pct(c.incertidumbre.rango.alto) })}
          </p>
          {c.decision.seleccion && (
            <p className="text-[12px] text-(--ink-soft)">
              {t('fiarse.mejorSeleccion', { nombre: c.decision.seleccion.nombre, cuota: numF(c.decision.seleccion.cuota, 2), ventaja: pct(c.decision.seleccion.edge) })}
              {c.decision.desaparece != null && t('fiarse.desaparece', { n: Math.round(c.decision.desaparece * 100) })}
            </p>
          )}
          <div className="mt-1 text-[12px] leading-relaxed">
            {c.decision.decision === 'NO BET' && (
              <>
                <p style={{ color: LOSS_TEXT }}>{t('fiarse.noBetRazones')}</p>
                <ul className="text-(--ink-soft)">{c.decision.razones.map((r) => <li key={r}>– {r}</li>)}</ul>
                <p className="mt-1 text-(--ink-soft)">{t('fiarse.haceFalta', { cosas: c.decision.contrafactual.join('; ') })}</p>
              </>
            )}
            {c.decision.decision === 'BET' && (
              <>
                {c.decision.razones.length > 0 && <ul className="text-(--ink-soft)">{c.decision.razones.map((r) => <li key={r}>– {r}</li>)}</ul>}
                <p className="text-(--ink-soft)">{t('fiarse.dejaDeCumplir', { cosas: c.decision.contrafactual.join(t('fiarse.o')) })}</p>
              </>
            )}
            {c.decision.decision === 'SIN MERCADO' && <p className="text-(--ink-soft)">{c.decision.razones.join(' · ')}</p>}
          </div>

          <div className="mt-2">
            <Fila titulo={t('fiarse.confianza')} valor={<Etiqueta texto={c.confianza.nivel} />}>
              {c.confianza.porQue.map((s) => (
                <p key={s.texto}><StatusMark estado={s.ok ? 'ok' : 'aviso'} color={s.ok ? PROFIT_COLOR : AMBAR} />{s.texto}</p>
              ))}
              <p className="text-(--ink-faint)">{c.confianza.criterio}</p>
            </Fila>
            <Fila titulo={t('fiarse.calidadDatos')} valor={`${c.calidadDatos.puntuacion} / 100`}>
              {c.calidadDatos.items.map((i) => (
                <p key={i.texto}>
                  <StatusMark estado={i.estado} color={COLOR_ICONO[i.estado]} />{i.texto}
                  {i.estado === 'desconocido' ? <span className="text-(--ink-faint)">{t('fiarse.desconocido')}</span> : <span className="text-(--ink-faint)"> ({i.puntos}/{i.max})</span>}
                </p>
              ))}
              <p className="text-(--ink-faint)">{c.calidadDatos.explicacion}</p>
            </Fila>
            <Fila titulo={t('fiarse.incertidumbre')} valor={`±${numF(c.incertidumbre.totalPp, 1)} pp`}>
              <p>{t('fiarse.ruido', { pp: c.incertidumbre.ruidoRatingPp })}</p>
              <p>{c.incertidumbre.sesgoCalibracionPp == null ? t('fiarse.sinCalibracion') : t('fiarse.sesgo', { pp: pp(c.incertidumbre.sesgoCalibracionPp), n: c.incertidumbre.nTramo ?? '—' })}</p>
              <p className="text-(--ink-faint)">{c.incertidumbre.significado}</p>
            </Fila>
            <Fila titulo={t('fiarse.estabilidad')} valor={<Etiqueta texto={c.estabilidad.nivel} />}>
              <p>{t('fiarse.escenarios', { lista: c.estabilidad.escenarios.map((e) => pct(e.p)).join(' · ') })}</p>
              <ul>{c.estabilidad.escenarios.map((e) => <li key={e.texto}>{pct(e.p)} — {e.texto}</li>)}</ul>
              <p>{t('fiarse.percentiles', { p10: pct(c.estabilidad.p10), p90: pct(c.estabilidad.p90) })}</p>
              {c.estabilidad.supuestos.map((s) => <p key={s}>· {s}</p>)}
              <p className="text-(--ink-faint)">{c.estabilidad.criterio}</p>
            </Fila>
            <Fila titulo={t('fiarse.desacuerdo')} valor={<Etiqueta texto={c.desacuerdo.nivel} />}>
              {c.desacuerdo.componentes.map((k) => <p key={k.nombre}>{k.nombre}: {pct(k.p)}</p>)}
              <p className="text-(--ink-faint)">{c.desacuerdo.criterio}</p>
            </Fila>
            <Fila titulo={t('fiarse.queMueve')} valor={c.sensibilidad.exacta ? t('fiarse.exacto') : t('fiarse.aproximado')}>
              <p>{t('fiarse.sinFactor', { p: pct(c.sensibilidad.base), resultado: c.outcomes[0] })}</p>
              {c.sensibilidad.contribuciones.map((k) => <p key={k.etiqueta}>{k.etiqueta}: {pp(k.pp)}</p>)}
              <p>{t('fiarse.final', { p: pct(c.sensibilidad.final) })}</p>
              <p className="text-(--ink-faint)">{c.sensibilidad.metodo}</p>
            </Fila>
            {c.queSi && (
              <Fila titulo={t('fiarse.queSi')} valor={t('fiarse.simulacion')}>
                <QueSi c={c} />
              </Fila>
            )}
            <Fila titulo={t('fiarse.calidadMercado')} valor={<Etiqueta texto={c.mercado.calidad} />}>
              {c.mercado.lineas.map((l, i) => {
                // La ventaja con cada cuota, con la probabilidad del modelo para esa selección.
                const p = c.probs[i];
                const ev = (o: number) => pp((p * o - 1) * 100);
                return (
                  <p key={l.seleccion}>
                    {t('fiarse.linea', {
                      seleccion: l.seleccion,
                      mejor: numF(l.mejor, 2),
                      casa: l.mejorCasa,
                      evMejor: ev(l.mejor),
                      mediana: numF(l.mediana, 2),
                      evMediana: ev(l.mediana),
                      peor: numF(l.peor, 2),
                      evPeor: ev(l.peor),
                      casas: l.casas,
                      disp: l.dispersionPp,
                    })}
                  </p>
                );
              })}
              {c.mercado.lineas.length > 0 && <p className="text-(--ink-faint)">{t('fiarse.cotaSuperior')}</p>}
              {c.mercado.ultimaActualizacionMin != null && <p>{t('fiarse.ultimaObs', { min: c.mercado.ultimaActualizacionMin, n: c.mercado.observaciones24h })}</p>}
              {c.mercado.motivos.map((m) => <p key={m}><StatusMark estado="aviso" color={AMBAR} />{m}</p>)}
              <p className="text-(--ink-faint)">{c.mercado.etiqueta}.</p>
            </Fila>
            <Fila titulo={t('fiarse.ood')} valor={c.ood.length ? t('fiarse.avisos', { n: c.ood.length }) : t('fiarse.no')}>
              {c.ood.length ? c.ood.map((o) => <p key={o.texto}><StatusMark estado={o.grave ? 'error' : 'aviso'} color={o.grave ? LOSS_COLOR : AMBAR} />{o.texto}{o.grave ? t('fiarse.grave') : ''}</p>) : <p>{t('fiarse.nadaFuera')}</p>}
            </Fila>
            <Fila titulo={t('fiarse.regimen')} valor={c.regimen.etiqueta}>
              {c.regimen.nota && <p>{c.regimen.nota}</p>}
              <p>{t('fiarse.deriva', { d: c.deriva })}</p>
            </Fila>
            {prePartido && (
              <Fila titulo={t('fiarse.historial')} valor={t('fiarse.historialValor')}>
                <HistorialPrePartido refP={prePartido} />
              </Fila>
            )}
            {prePartido && (
              <Fila titulo={t('fiarse.lineaTemporal')} valor={t('fiarse.hechos')}>
                <LineaTemporal refP={prePartido} />
              </Fila>
            )}
            <p className="mt-1 text-[11px] text-(--ink-faint)">{c.nota}</p>
          </div>
        </div>
      )}
    </div>
  );
}
