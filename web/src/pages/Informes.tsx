// El archivo de informes (Fase 6.9): resúmenes diarios e informes semanales, cada uno como se
// escribió el día que se generó.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useI18n, formato } from '../i18n';
import { useJson, enviarJson } from '../lib/usarJson';
import { pillClass } from '../components/ui';

interface ResumenInforme { id: number; tipo: 'diario' | 'semanal'; periodo: string; created_at: string; titulo: string; resumen: string }
interface Respuesta { informes: ResumenInforme[]; zona: string; pdf: boolean; diario: boolean; semanal: boolean }

export default function Informes() {
  const { t, idioma } = useI18n();
  const f = formato(idioma);
  const navigate = useNavigate();
  const [tipo, setTipo] = useState<'' | 'diario' | 'semanal'>('');
  const { datos, error } = useJson<Respuesta>(`/api/informes${tipo ? `?tipo=${tipo}` : ''}`);
  const [generando, setGenerando] = useState(false);
  const [fallo, setFallo] = useState<string | null>(null);
  const generar = async (que: 'diario' | 'semanal') => {
    setGenerando(true);
    setFallo(null);
    try {
      const r = await enviarJson<{ id: number }>('/api/informes/generar', 'POST', { tipo: que });
      navigate(`/informes/${r.id}`);
    } catch (e) {
      setFallo((e as Error).message);
    } finally {
      setGenerando(false);
    }
  };
  return (
    <div>
      <h2 className="mb-1 text-[20px] font-semibold text-(--ink-strong)">{t('nav.informes')}</h2>
      <p className="mb-4 max-w-3xl text-[14px] leading-relaxed text-(--ink-soft)">{t('informes.intro', { zona: datos?.zona ?? '—' })}</p>
      {error && <p role="alert" className="text-[14px] text-(--ink-soft)">{error}</p>}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <button className={pillClass(tipo === '')} onClick={() => setTipo('')}>{t('informes.todos')}</button>
        <button className={pillClass(tipo === 'diario')} onClick={() => setTipo('diario')}>{t('informes.diarios')}</button>
        <button className={pillClass(tipo === 'semanal')} onClick={() => setTipo('semanal')}>{t('informes.semanales')}</button>
        <span className="ml-auto flex flex-wrap gap-1.5">
          {datos?.diario && (
            <button disabled={generando} onClick={() => void generar('diario')} className="rounded-lg px-3 py-1.5 text-[13px] text-(--ink-body) ring-1 ring-(--line) hover:bg-(--raised) disabled:opacity-60">{t('informes.generarDiario')}</button>
          )}
          {datos?.semanal && (
            <button disabled={generando} onClick={() => void generar('semanal')} className="rounded-lg px-3 py-1.5 text-[13px] text-(--ink-body) ring-1 ring-(--line) hover:bg-(--raised) disabled:opacity-60">{t('informes.generarSemanal')}</button>
          )}
        </span>
      </div>
      {fallo && <p className="mb-3 text-[13px] text-(--ink-soft)">{fallo}</p>}
      {datos && datos.informes.length === 0 && <p className="text-[14px] text-(--ink-muted)">{t('informes.vacio')}</p>}
      <ul className="space-y-2" data-testid="lista-informes">
        {(datos?.informes ?? []).map((i) => (
          <li key={i.id}>
            <Link to={`/informes/${i.id}`} className="block rounded-xl border border-(--line) p-3 hover:bg-(--raised)">
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="text-[15px] font-semibold text-(--ink-strong)">{i.titulo}</span>
                <span className="rounded-full px-2 py-0.5 text-[11px] text-(--ink-muted) ring-1 ring-(--line)">{i.tipo === 'diario' ? t('informes.diario') : t('informes.semanal')}</span>
              </span>
              <span className="mt-0.5 block text-[13px] text-(--ink-body)">{i.resumen}</span>
              <span className="mt-0.5 block text-[12px] text-(--ink-muted)">{t('informes.generado', { cuando: f.fecha(i.created_at) })}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
