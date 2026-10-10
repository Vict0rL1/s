// 📊 Confianza del sistema: ¿podemos fiarnos del modelo? Lo que sabemos, lo que todavía
// no, y las cifras que lo sostienen. Todo sale del servidor (evaluation/system.ts y
// compañía); las dos listas se generan con reglas a partir de las muestras reales.

import { useEffect, useState } from 'react';
import LiveEvaluation from '../bets/LiveEvaluation';
import Analitica from './Analitica';
import { SubNav } from '../nav/SubNav';
import { useSubnavConfianza } from '../../pages/subnav';
import { conNodos, localeDe, useI18n, type Clave, type Traducir } from '../../i18n';
import { PROFIT_COLOR, LOSS_TEXT } from '../../lib/theme';
import { DeporteIcono, ShieldCheckIcon, StatusMark } from '../icons';
import { num as numF, pct as pctF } from '../../lib/formato';

interface Sistema {
  prediccionesEnVivo: number;
  resueltas: number;
  apuestasEnVivo: number;
  liquidadas: number;
  diasRegistrados: number | null;
  clvMedio: number | null;
  roi: number | null;
  brier: { deporte: string; n: number; brier: number | null; ece: number | null }[];
  maxDrawdownPct: number | null;
  benchmark: { deporte: string; partidos: number; modelo: number | null; mejorBaseline: { nombre: string; logLoss: number } | null; mercado: number | null }[];
  sabemos: string[];
  noSabemos: string[];
  cuotasReales: boolean;
}
interface Alerta {
  id: number;
  created_at: string;
  severity: string;
  title: string;
  body: string;
}
interface Riesgo {
  total: { importe: number; pct: number; limite: number };
  porDeporte: { deporte: string; importe: number; pct: number }[];
  grupos: { grupo: string; apuestas: number; pct: number; limite: number; excede: boolean }[];
  nota: string;
}

// Tenis y fútbol salen del catálogo; NBA, MLB, NFL y NHL se dicen igual en los dos idiomas.
const NOMBRE_TXT: Record<string, string> = { tennis: 'deporte.tennis', football: 'deporte.football', basketball: 'NBA', baseball: 'MLB', nfl: 'NFL', nhl: 'NHL', ufc: 'UFC' };
const nombreTxt = (t: Traducir, k: string) => {
  const v = NOMBRE_TXT[k];
  return v == null ? k : v.startsWith('deporte.') ? t(v as Clave) : v;
};
/** El deporte con su icono (nada si no es uno de los cinco, como antes). */
function Nombre({ sport }: { sport: string }) {
  const { t } = useI18n();
  if (!(sport in NOMBRE_TXT)) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <DeporteIcono nombre={sport} size={15} />
      {nombreTxt(t, sport)}
    </span>
  );
}
/** Las cifras con Intl en el idioma activo (lib/formato.ts). */
function useCifras() {
  useI18n();
  return {
    f3: (x: number | null | undefined) => (x == null ? '—' : numF(x, 3)),
    pct: (x: number | null | undefined) => (x == null ? '—' : `${x >= 0 ? '' : '−'}${pctF(Math.abs(x), 1)}`),
  };
}
const AMBAR = 'var(--status-warning)';

function Bloque({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="mb-4 rounded-xl border border-(--line) bg-(--tint) px-4 py-3">
      <h3 className="mb-2 text-[15px] font-semibold text-(--ink-strong)">{titulo}</h3>
      <div className="text-[13px] leading-relaxed text-(--ink-soft)">{children}</div>
    </section>
  );
}

function Reproducir() {
  const { t } = useI18n();
  const [id, setId] = useState('');
  const [r, setR] = useState<{ encontrado: boolean; campos: [string, string][]; avisos: string[] } | null>(null);
  return (
    <div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (id.trim()) fetch(`/api/reproduce/${encodeURIComponent(id.trim())}`).then((x) => x.json()).then(setR).catch(() => setR(null));
        }}
      >
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="apuesta:12 · senal:5 · evaluacion:3 · nfl:<clave>"
          className="min-w-0 flex-1 rounded border border-(--line) bg-transparent px-2 py-1 text-[13px] text-(--ink-strong)"
        />
        <button className="rounded border border-(--line-strong) px-3 py-1 text-[13px] text-(--ink-body)">{t('st.reproducir')}</button>
      </form>
      {r && (
        <div className="mt-2">
          {r.campos.map(([k, v]) => (
            <p key={k}><span className="text-(--ink-body)">{k}:</span> {v}</p>
          ))}
          {r.avisos.map((a) => <p key={a} style={{ color: AMBAR }}><StatusMark estado="aviso" color={AMBAR} />{a}</p>)}
        </div>
      )}
      <p className="mt-1 text-[12px] text-(--ink-faint)">{t('st.reproducirNota')}</p>
    </div>
  );
}

interface Sombras {
  sombras: { sport: string; nombre: string; n: number; sombra: { logLoss: number | null; brier: number | null }; campeon: { logLoss: number | null; brier: number | null }; diferencia: { veredicto: string; lectura: string }; aviso: { texto: string | null } }[];
  ensembles: Record<string, { componentes: string[]; mejor: string; metodos: Record<string, { validacion: { n: number; logLoss: number; logLossCampeon: number; ic?: [number, number] } }> } | undefined>;
}
interface Version {
  version: string;
  activada: string;
  desactivada: string | null;
  motivo: string;
  git_commit: string;
  metricas: string;
}
interface Experimentos {
  total: number;
  aceptados: number;
  noConcluyentes: number;
  rechazados: { id: string; date: string; sport: string; hypothesis: string; motivo: string }[];
}

function ModelosSombra() {
  const { t } = useI18n();
  const { f3 } = useCifras();
  const [d, setD] = useState<Sombras | null>(null);
  useEffect(() => {
    fetch('/api/shadows').then((r) => r.json()).then(setD).catch(() => {});
  }, []);
  if (!d) return <p>{t('comun.cargando')}</p>;
  return (
    <>
      {d.sombras.length === 0 ? (
        <p>{t('st.sinSombras')}</p>
      ) : (
        d.sombras.map((x) => (
          <p key={x.sport + x.nombre}>
            <Nombre sport={x.sport} /> · {t('st.sombraLinea', { nombre: x.nombre, n: x.n, s: f3(x.sombra.logLoss), c: f3(x.campeon.logLoss), veredicto: x.diferencia.veredicto })}
            {x.aviso.texto && <span style={{ color: AMBAR }}> · <StatusMark estado="aviso" color={AMBAR} size={13} />{t('st.muestraPequena')}</span>}
          </p>
        ))
      )}
      {Object.entries(d.ensembles).map(([sport, e]) =>
        e ? (
          <p key={sport}>
            {conNodos(
              t('st.ensemble', {
                componentes: e.componentes.join(' + '),
                mejor: e.mejor,
                ll: f3(e.metodos[e.mejor].validacion.logLoss),
                llc: f3(e.metodos[e.mejor].validacion.logLossCampeon),
                n: e.metodos[e.mejor].validacion.n,
              }),
              { deporte: <Nombre sport={sport} /> },
            )}
          </p>
        ) : null,
      )}
      <p className="text-[12px] text-(--ink-faint)">{t('st.ningunaSombra')}</p>
    </>
  );
}

function HistoriaVersiones() {
  const { t } = useI18n();
  const [d, setD] = useState<{ historial: Record<string, Version[]>; nota: string | null } | null>(null);
  useEffect(() => {
    fetch('/api/model-history').then((r) => r.json()).then(setD).catch(() => {});
  }, []);
  if (!d) return <p>{t('comun.cargando')}</p>;
  if (d.nota) return <p>{d.nota}</p>;
  return (
    <>
      {Object.entries(d.historial).map(([sport, vs]) => (
        <details key={sport} className="mb-1">
          <summary className="cursor-pointer text-(--ink-body)">
            <Nombre sport={sport} />: {t('st.versiones', { n: vs.length, v: vs[vs.length - 1]?.version ?? '' })}
          </summary>
          <ul className="ml-3 mt-1">
            {[...vs].reverse().map((v, i) => (
              <li key={v.version}>
                v{vs.length - i} <span className="text-(--ink-body)">{v.version}</span> · {v.activada.slice(0, 10)} → {v.desactivada ? v.desactivada.slice(0, 10) : t('st.activa')} · {v.git_commit} — {v.motivo}
                <span className="text-(--ink-faint)"> ({v.metricas})</span>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </>
  );
}

function Rechazados() {
  const { t } = useI18n();
  const [d, setD] = useState<Experimentos | null>(null);
  useEffect(() => {
    fetch('/api/experiments').then((r) => r.json()).then(setD).catch(() => {});
  }, []);
  if (!d) return <p>{t('comun.cargando')}</p>;
  return (
    <>
      <p>{t('st.experimentos', { total: d.total, a: d.aceptados, r: d.rechazados.length, nc: d.noConcluyentes })}</p>
      <ul className="mt-1 space-y-1">
        {d.rechazados.slice(0, 12).map((x) => (
          <li key={x.id}>
            <span className="text-(--ink-faint)">{x.date.slice(0, 10)}</span> <span className="text-(--ink-body)">{x.hypothesis}</span>
            <span className="block text-[12px]">{t('st.rechazado', { motivo: x.motivo })}</span>
          </li>
        ))}
      </ul>
      {d.rechazados.length > 12 && <p className="text-[12px] text-(--ink-faint)">{t('st.yMas', { n: d.rechazados.length - 12 })}</p>}
    </>
  );
}

export default function SystemTrust() {
  const { t, idioma } = useI18n();
  const { f3, pct } = useCifras();
  const subnav = useSubnavConfianza();
  const [s, setS] = useState<Sistema | null>(null);
  const [alertas, setAlertas] = useState<Alerta[]>([]);
  const [riesgo, setRiesgo] = useState<Riesgo | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let vivo = true;
    fetch('/api/system-trust').then((r) => (r.ok ? r.json() : Promise.reject())).then((j) => vivo && setS(j)).catch(() => vivo && setError(true));
    fetch('/api/alerts?limit=30').then((r) => r.json()).then((j) => vivo && setAlertas(j)).catch(() => {});
    fetch('/api/risk').then((r) => r.json()).then((j) => vivo && setRiesgo(j)).catch(() => {});
    return () => {
      vivo = false;
    };
  }, []);
  const nav = <SubNav etiqueta={t('nav.subConfianza')} enlaces={subnav} />;
  if (error) return <>{nav}<p className="text-[14px] text-(--ink-soft)">{t('st.errorLeer')}</p></>;
  if (!s) return <>{nav}<p className="text-[14px] text-(--ink-muted)">{t('comun.cargando')}</p></>;
  const tiles: [string, string][] = [
    [t('st.tile.predicciones'), t('st.tile.prediccionesValor', { n: s.prediccionesEnVivo, r: s.resueltas })],
    [t('st.tile.apuestas'), t('st.tile.apuestasValor', { n: s.apuestasEnVivo, l: s.liquidadas })],
    [t('st.tile.dias'), s.diasRegistrados == null ? '—' : String(s.diasRegistrados)],
    [t('st.tile.clv'), pct(s.clvMedio)],
    ['ROI', pct(s.roi)],
    [t('st.tile.caida'), s.maxDrawdownPct == null ? '—' : `−${pct(s.maxDrawdownPct)}`],
  ];
  return (
    <div>
      {nav}
      <h2 className="mb-1 flex items-center gap-2.5 text-[20px] font-semibold text-(--ink-strong)">
          <span className="grid h-9 w-9 place-items-center rounded-xl" style={{ color: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.12)' }}>
            <ShieldCheckIcon size={21} />
          </span>
          {t('st.titulo')}
        </h2>
      <p className="mb-4 text-[13px] text-(--ink-muted)">
        {t('st.intro')}
      </p>
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {tiles.map(([k, v]) => (
          <div key={k} className="rounded-lg border border-(--line) px-3 py-2">
            <p className="text-[11px] uppercase tracking-wide text-(--ink-muted)">{k}</p>
            <p className="text-[16px] font-semibold text-(--ink-strong)">{v}</p>
          </div>
        ))}
      </div>
      <Bloque titulo={t('st.sabemos')}>
        <ul className="space-y-1">{s.sabemos.map((x) => <li key={x}><StatusMark estado="ok" color={PROFIT_COLOR} />{x}</li>)}</ul>
      </Bloque>
      <Bloque titulo={t('st.noSabemos')}>
        <ul className="space-y-1">{s.noSabemos.map((x) => <li key={x}><StatusMark estado="aviso" color={AMBAR} />{x}</li>)}</ul>
      </Bloque>
      <Bloque titulo={t('st.historico')}>
        <div className="overflow-x-auto" tabIndex={0}>
          <table className="w-full whitespace-nowrap text-[12px] sm:text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-(--ink-muted)">
                <th className="py-1 pr-2">{t('st.th.deporte')}</th><th className="py-1 pr-2 text-right">{t('st.th.partidos')}</th><th className="py-1 pr-2 text-right">{t('st.th.modelo')}</th><th className="py-1 pr-2">{t('st.th.baseline')}</th><th className="py-1 text-right">{t('st.th.mercado')}</th>
              </tr>
            </thead>
            <tbody>
              {s.benchmark.map((b) => (
                <tr key={b.deporte} className="border-t border-(--line)">
                  <td className="py-1 pr-2 text-(--ink-body)"><Nombre sport={b.deporte} /></td>
                  <td className="py-1 pr-2 text-right">{b.partidos || '—'}</td>
                  <td className="py-1 pr-2 text-right text-(--ink-strong)">{f3(b.modelo)}</td>
                  <td className="py-1 pr-2">{b.mejorBaseline ? `${b.mejorBaseline.nombre} ${f3(b.mejorBaseline.logLoss)}` : '—'}</td>
                  <td className="py-1 text-right" style={{ color: b.mercado != null && b.modelo != null && b.mercado < b.modelo ? LOSS_TEXT : undefined }}>
                    {b.mercado == null ? t('st.sinCuotas') : `${f3(b.mercado)}${b.modelo != null && b.mercado < b.modelo ? t('st.mejor') : ''}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-[12px] text-(--ink-faint)">{t('st.logLossNota')}</p>
      </Bloque>
      {/* El modelo en vivo (antes en Apuestas, Fase 5.6): es evaluación del modelo, no dinero. */}
      <div className="mb-4">
        <LiveEvaluation />
      </div>
      <Analitica />
      <Bloque titulo={t('st.enVivo')}>
        {s.brier.map((b) => (
          <p key={b.deporte}>
            <Nombre sport={b.deporte} />: {t('st.brierLinea', { n: b.n, b: f3(b.brier), e: pct(b.ece) })}
            {b.n < 100 && <span style={{ color: AMBAR }}> · <StatusMark estado="aviso" color={AMBAR} size={13} />{t('st.muestraPequena')}</span>}
          </p>
        ))}
      </Bloque>
      {riesgo && (
        <Bloque titulo={t('st.riesgo')}>
          <p>
            {t('st.riesgoTotal', {
              p: pct(riesgo.total.pct),
              l: pct(riesgo.total.limite),
              resto: riesgo.porDeporte.length ? ` · ${riesgo.porDeporte.map((d) => `${nombreTxt(t, d.deporte)} ${pct(d.pct)}`).join(' · ')}` : '',
            })}
          </p>
          {riesgo.grupos.map((g) => (
            <p key={g.grupo} style={{ color: g.excede ? LOSS_TEXT : undefined }}>{t('st.grupo', { grupo: g.grupo, n: g.apuestas, p: pct(g.pct), l: pct(g.limite) })}</p>
          ))}
          <p className="text-[12px] text-(--ink-faint)">{riesgo.nota}</p>
        </Bloque>
      )}
      <Bloque titulo={t('st.alertas')}>
        {alertas.length === 0 ? <p>{t('st.ninguna')}</p> : alertas.map((a) => (
          <p key={a.id}>
            <span className="text-(--ink-faint)">{new Date(a.created_at).toLocaleString(localeDe(idioma))}</span>{' '}
            <span style={{ color: a.severity === 'importante' ? LOSS_TEXT : a.severity === 'aviso' ? AMBAR : undefined }}>{a.title}</span> — {a.body}
          </p>
        ))}
      </Bloque>
      <Bloque titulo={t('st.sombras')}>
        <ModelosSombra />
      </Bloque>
      <Bloque titulo={t('st.evolucion')}>
        <HistoriaVersiones />
      </Bloque>
      <Bloque titulo={t('st.rechazados')}>
        <Rechazados />
      </Bloque>
      <Bloque titulo={t('st.reproducirTitulo')}>
        <Reproducir />
      </Bloque>
    </div>
  );
}
