// El recorrido de primer uso (Fase 5.19): tres cosas, descartable y recordado (en el
// navegador y en Ajustes para no repetirlo en otro dispositivo).
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { useDialogo } from './ui/useDialogo';

const CLAVE = 'predictor.recorrido';

export default function Recorrido({ vistoEnServidor, onVisto }: { vistoEnServidor: boolean | null; onVisto: () => void }) {
  const { t } = useI18n();
  const [abierto, setAbierto] = useState(false);
  const [paso, setPaso] = useState(0);
  useEffect(() => {
    if (vistoEnServidor == null) return;
    let local = false;
    try {
      local = localStorage.getItem(CLAVE) === '1';
    } catch {
      local = false;
    }
    setAbierto(!vistoEnServidor && !local);
  }, [vistoEnServidor]);
  const cerrar = () => {
    try {
      localStorage.setItem(CLAVE, '1');
    } catch {
      // Vale para esta visita.
    }
    setAbierto(false);
    onVisto();
  };
  const dialogo = useRef<HTMLDivElement>(null);
  useDialogo(abierto, cerrar, dialogo);
  if (!abierto) return null;
  const pasos = [t('recorrido.pildora'), t('recorrido.confianza'), t('recorrido.demo')];
  return (
    <div ref={dialogo} role="dialog" aria-modal="true" aria-label={t('recorrido.titulo')} className="fixed inset-0 z-[60] grid place-items-end bg-black/40 p-4 sm:place-items-center">
      <div className="w-full max-w-md rounded-xl border border-(--line) bg-(--surface-card) p-4 text-[14px] text-(--ink-soft) shadow-xl">
        <p className="text-[16px] font-semibold text-(--ink-strong)">{t('recorrido.titulo')}</p>
        <p className="mt-2 min-h-[4.5rem] leading-relaxed">{pasos[paso]}</p>
        <div className="mt-3 flex items-center justify-between">
          <span className="flex gap-1" role="img" aria-label={t('recorrido.paso', { n: paso + 1, total: pasos.length })}>
            {pasos.map((_, i) => (
              <span key={i} className="h-1.5 w-5 rounded-full" style={{ backgroundColor: i === paso ? 'var(--ink-body)' : 'var(--raised-2)' }} />
            ))}
          </span>
          <span className="flex gap-2">
            <button onClick={cerrar} className="rounded-lg px-3 py-1.5 text-(--ink-muted) hover:bg-(--raised)">{t('comun.cerrar')}</button>
            {paso < pasos.length - 1 ? (
              <button onClick={() => setPaso((p) => p + 1)} className="rounded-lg bg-(--raised-2) px-3 py-1.5 font-medium text-(--ink-strong)">→</button>
            ) : (
              <button onClick={cerrar} className="rounded-lg bg-(--raised-2) px-3 py-1.5 font-medium text-(--ink-strong)">{t('recorrido.entendido')}</button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
