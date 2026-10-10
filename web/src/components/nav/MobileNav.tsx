// La barra inferior del móvil (Fase 5.3): cuatro destinos y nada fuera de pantalla a 390 px.
// «Deportes» abre una hoja con los cinco; los demás llevan directamente.

import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { SPORT_THEMES, type SportId } from '../../lib/theme';
import { DEPORTES, RUTA_DE_PESTANA, pestanaDeRuta, recordarPestana } from '../../rutas';
import { SportIcon } from '../icons';
import { useI18n, type Clave } from '../../i18n';
import { useDialogo } from '../ui/useDialogo';

const DESTINOS: { id: SportId | 'deportes'; etiqueta: Clave }[] = [
  { id: 'picks', etiqueta: 'nav.destacados' },
  { id: 'deportes', etiqueta: 'nav.deportes' },
  { id: 'bets', etiqueta: 'nav.apuestas' },
  { id: 'trust', etiqueta: 'nav.confianza' },
];

export default function MobileNav({ ocultos = [] }: { ocultos?: string[] }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [hoja, setHoja] = useState(false);
  const { t } = useI18n();
  const activa = pestanaDeRuta(pathname);
  const enDeporte = activa != null && DEPORTES.includes(activa);
  useEffect(() => setHoja(false), [pathname]);
  const dialogo = useRef<HTMLDivElement>(null);
  useDialogo(hoja, () => setHoja(false), dialogo);
  const ir = (id: SportId) => {
    recordarPestana(id);
    navigate(RUTA_DE_PESTANA[id]);
  };
  return (
    <>
      {hoja && (
        <div ref={dialogo} className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label={t('nav.deportes')}>
          <button aria-label={t('comun.cerrar')} className="absolute inset-0 bg-black/50" onClick={() => setHoja(false)} />
          <div className="absolute inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] rounded-t-2xl border-t border-(--line) bg-(--surface-card) p-3 pb-4">
            <p className="mb-2 px-1 text-[12px] font-medium uppercase tracking-wide text-(--ink-muted)">{t('nav.deportes')}</p>
            <div className="grid grid-cols-5 gap-1">
              {DEPORTES.filter((d) => !ocultos.includes(d)).map((id) => {
                const s = SPORT_THEMES[id];
                const on = activa === id;
                return (
                  <button key={id} onClick={() => ir(id)} aria-current={on ? 'page' : undefined} className="flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-[11px] text-(--ink-soft) hover:bg-(--raised)">
                    <span className="grid h-9 w-9 place-items-center rounded-lg" style={{ color: on ? s.accent : 'currentColor', backgroundColor: on ? s.accentSoft : 'transparent' }}>
                      <SportIcon sport={id} size={20} />
                    </span>
                    <span className={on ? 'text-(--ink-strong)' : ''}>{t(`deporte.${id}` as Clave)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
      <nav aria-label={t('nav.principal')} data-testid="barra-inferior" className="fixed inset-x-0 bottom-0 z-40 grid h-[calc(3.5rem+env(safe-area-inset-bottom))] grid-cols-4 border-t border-(--line) bg-(--surface-page)/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        {DESTINOS.map((d) => {
          const on = d.id === 'deportes' ? enDeporte || hoja : activa === d.id;
          const tema = d.id === 'deportes' ? (enDeporte && activa ? SPORT_THEMES[activa] : null) : SPORT_THEMES[d.id];
          return (
            <button
              key={d.id}
              onClick={() => (d.id === 'deportes' ? setHoja((h) => !h) : ir(d.id))}
              aria-current={on && d.id !== 'deportes' ? 'page' : undefined}
              aria-expanded={d.id === 'deportes' ? hoja : undefined}
              className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${on ? 'text-(--ink-strong)' : 'text-(--ink-muted)'}`}
            >
              <span aria-hidden style={{ color: on && tema ? tema.accent : 'currentColor' }}>
                {d.id === 'deportes' ? <SportIcon sport={enDeporte && activa ? activa : 'football'} size={20} /> : <SportIcon sport={d.id} size={20} />}
              </span>
              {t(d.etiqueta)}
            </button>
          );
        })}
      </nav>
    </>
  );
}
