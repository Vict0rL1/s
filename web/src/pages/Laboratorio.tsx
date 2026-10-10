// El laboratorio de estrategias (Fase 6.1): bancos de papel con nombre, lado a lado con el banco
// principal, y «¿qué habría pasado?» sobre el histórico con cuotas.
import { useState } from 'react';
import { Link } from 'react-router';
import { useI18n, formato } from '../i18n';
import { useJson, enviarJson } from '../lib/usarJson';
import type { FilaComparacion, RespuestaLab } from '../lib/estrategias';
import { SubNav } from '../components/nav/SubNav';
import { Sparkline, COLOR_BENEFICIO, COLOR_PERDIDA } from '../components/charts';
import { NuevaEstrategia, QueHabriaPasado, resumenConfig } from './LaboratorioPartes';
import { useSubnavApuestas } from './subnav';

export default function Laboratorio() {
  const { t } = useI18n();
  const { datos, error, recargar } = useJson<RespuestaLab>('/api/estrategias');
  const subnav = useSubnavApuestas();
  return (
    <div>
      <p className="mb-1 text-[12px] text-(--ink-muted)">
        <Link to="/apuestas" className="underline-offset-2 hover:underline">{t('nav.apuestas')}</Link> › {t('nav.laboratorio')}
      </p>
      <SubNav etiqueta={t('nav.subApuestas')} enlaces={subnav} />
      <h2 className="mb-1 text-[20px] font-semibold text-(--ink-strong)">{t('lab.titulo')}</h2>
      <p className="mb-4 max-w-3xl text-[14px] leading-relaxed text-(--ink-soft)">{t('lab.intro')}</p>
      {error && <p role="alert" className="text-[14px] text-(--ink-soft)">{error}</p>}
      {!datos && !error && <p className="text-[13px] text-(--ink-muted)">{t('comun.cargando')}</p>}
      {datos && (
        <>
          <section className="mb-6">
            <h3 className="mb-2 text-[16px] font-semibold text-(--ink-strong)">{t('lab.comparacion')}</h3>
            <div className="grid gap-3 lg:grid-cols-2">
              {datos.comparacion.filas.map((f) => (
                <TarjetaFila key={f.id ?? 'principal'} fila={f} onArchivada={recargar} />
              ))}
            </div>
            {datos.estrategias.length === 0 && <p className="mt-2 text-[13px] text-(--ink-muted)">{t('lab.sinEstrategias')}</p>}
            <p className="mt-2 text-[12px] text-(--ink-muted)">{datos.comparacion.nota}</p>
          </section>
          <NuevaEstrategia datos={datos} onCreada={recargar} />
          <QueHabriaPasado datos={datos} />
        </>
      )}
    </div>
  );
}

function TarjetaFila({ fila, onArchivada }: { fila: FilaComparacion; onArchivada: () => void }) {
  const { t, idioma } = useI18n();
  const f = formato(idioma);
  const [error, setError] = useState<string | null>(null);
  const signo = (x: number | null) => (x == null ? undefined : x > 0 ? COLOR_BENEFICIO : x < 0 ? COLOR_PERDIDA : undefined);
  const archivar = async () => {
    if (fila.id == null || !confirm(t('lab.archivarConfirmar', { nombre: fila.nombre }))) return;
    try {
      await enviarJson(`/api/estrategias/${fila.id}/archivar`, 'POST');
      onArchivada();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const datosFila: [string, string, string | undefined][] = [
    [t('lab.banco'), f.numero(fila.banco, 2), signo(fila.beneficio)],
    [t('lab.roi'), fila.roi == null ? '—' : f.porcentaje(fila.roi, 1), signo(fila.roi)],
    [t('lab.clv'), fila.clvMedio == null ? '—' : f.porcentaje(fila.clvMedio, 1), signo(fila.clvMedio)],
    [t('lab.drawdown'), fila.drawdown ? f.porcentaje(fila.drawdown.pct, 1) : '—', undefined],
    [t('lab.acierto'), fila.acierto == null ? '—' : f.porcentaje(fila.acierto, 0), undefined],
    [t('lab.apuestas'), String(fila.apuestas), undefined],
  ];
  return (
    <article className={`rounded-xl border border-(--line) bg-(--surface-card) p-4 ${fila.archivada ? 'opacity-70' : ''}`} data-testid="fila-estrategia">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h4 className="min-w-0 flex-1 break-words text-[15px] font-semibold text-(--ink-strong)">{fila.nombre}</h4>
        {fila.id == null && <span className="rounded-full px-2 py-0.5 text-[11px] text-(--ink-muted) ring-1 ring-(--line)">{t('lab.principal')}</span>}
        {fila.archivada && <span className="rounded-full px-2 py-0.5 text-[11px] text-(--ink-muted) ring-1 ring-(--line)">{t('lab.archivada')}</span>}
        {fila.id != null && !fila.archivada && (
          <button onClick={() => void archivar()} className="rounded-lg px-2.5 py-1 text-[12px] text-(--ink-soft) ring-1 ring-(--line) hover:bg-(--raised)">
            {t('lab.archivar')}
          </button>
        )}
      </div>
      {fila.config && <p className="mb-2 text-[12px] text-(--ink-muted)">{resumenConfig(fila.config, t, idioma)}</p>}
      <dl className="grid grid-cols-3 gap-x-3 gap-y-2">
        {datosFila.map(([k, v, color]) => (
          <div key={k} className="min-w-0">
            <dt className="text-[11px] uppercase tracking-wide text-(--ink-muted)">{k}</dt>
            <dd className="text-[15px] font-semibold tabular-nums text-(--ink-strong)" style={color ? { color } : undefined}>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-1 text-[12px] text-(--ink-muted)">{t('lab.apuestasDetalle', { liquidadas: fila.liquidadas, pendientes: fila.pendientes })}</p>
      {fila.curva.length > 1 && (
        <div className="mt-2">
          <Sparkline puntos={fila.curva.map((p) => p.banco)} ancho={260} alto={36} etiqueta={`${t('lab.curva')}: ${fila.nombre}`} color={fila.beneficio >= 0 ? COLOR_BENEFICIO : COLOR_PERDIDA} />
        </div>
      )}
      {!fila.comparable && <p className="mt-2 text-[12px] text-(--ink-soft)">{t('lab.noComparable')}</p>}
      {error && <p role="alert" className="mt-2 text-[12px]" style={{ color: COLOR_PERDIDA }}>{error}</p>}
    </article>
  );
}
