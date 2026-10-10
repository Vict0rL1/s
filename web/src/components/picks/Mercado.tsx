// Inteligencia de mercado en Destacados (aproximación).
import { useEffect, useState } from 'react';
import { PROFIT_COLOR } from '../../lib/theme';
import { StatusMark } from '../icons';
import { type Inteligencia, AMBAR, num } from './tipos';
import { useI18n } from '../../i18n';
import { num as numF } from '../../lib/formato';

export function Mercado() {
  const { t, idioma } = useI18n();
  // Un decimal con la coma en español, como estaba; con punto en inglés.
  const dec = (x: number) => (idioma === 'es' ? numF(x, 1) : numF(x, 1));
  const [d, setD] = useState<Inteligencia | null | 'error'>(null);
  useEffect(() => {
    let vivo = true;
    fetch('/api/odds/intel')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j: Inteligencia) => vivo && setD(j))
      .catch(() => vivo && setD('error'));
    return () => {
      vivo = false;
    };
  }, []);
  if (d === 'error') return null;
  return (
    <div className="mt-3 rounded-xl border border-(--line) p-4 text-[12px] leading-relaxed text-(--ink-muted)">
      <p className="mb-1.5 font-medium text-(--ink-soft)">{t('mi.titulo')}</p>
      {!d && <p>{t('mi.leyendo')}</p>}
      {d && d.eventos === 0 && <p>{t('mi.sinCuotas', { h: d.ventanaHoras })}</p>}
      {d && d.eventos > 0 && (
        <>
          <p>
            {t('mi.resumen', { e: d.eventos, s: d.steam.length, b: d.surebets.length, r: d.referencia.length })}
          </p>
          {d.steam.slice(0, 4).map((s) => (
            <p key={`${s.eventId}|${s.market}|${s.seleccion}`}>
              <StatusMark estado="aviso" color={AMBAR} />
              {t('mi.steam', {
                partido: s.partido,
                sel: s.seleccion,
                desde: num(s.desde),
                hasta: num(s.hasta),
                min: s.minutos,
                casas: s.casas,
                pp: `${s.movimientoPp > 0 ? '+' : '−'}${dec(Math.abs(s.movimientoPp))}`,
              })}
            </p>
          ))}
          {d.surebets.slice(0, 3).map((s) => (
            <p key={`${s.eventId}|${s.market}`}>
              <StatusMark estado="ok" color={PROFIT_COLOR} />
              {t('mi.surebet', {
                partido: s.partido,
                m: dec(s.margenPct),
                patas: s.patas.map((p) => t('mi.pata', { sel: p.seleccion, cuota: num(p.cuota), casa: p.casa })).join(', '),
              })}
            </p>
          ))}
          {d.referencia.slice(0, 3).map((r) => (
            <p key={`${r.eventId}|${r.market}`}>
              {t('mi.referencia', {
                partido: r.partido,
                casa: r.casa,
                lista: r.selecciones.map((s) => `${s.seleccion} ${s.desviacionPp > 0 ? '+' : '−'}${dec(Math.abs(s.desviacionPp))} pp`).join(' · '),
              })}
            </p>
          ))}
          <p className="mt-1 text-(--ink-faint)">{d.etiqueta}</p>
        </>
      )}
    </div>
  );
}
