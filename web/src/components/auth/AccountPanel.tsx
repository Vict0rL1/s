// «Cuenta»: las sesiones abiertas, cerrar otra y salir. Solo cuando la puerta está activa.

import { useEffect, useState } from 'react';
import { revocar, salir, sesiones, type SesionVista } from '../../lib/auth';
import { CrossIcon, LogoutIcon, UserIcon } from '../icons';
import NotificacionesPanel from './NotificacionesPanel';
import { useI18n, type Traducir } from '../../i18n';
import { STATUS, tenido } from '../../lib/theme';

const cuando = (iso: string, loc: string) => new Date(iso).toLocaleString(loc, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Un nombre legible del navegador, sin librería: lo justo para reconocer «el móvil». */
function dispositivo(t: Traducir, ua: string | null): string {
  if (!ua) return t('cuenta.dispositivoDesconocido');
  const so = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : t('cuenta.otro');
  const nav = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl/.test(ua) ? 'curl' : t('cuenta.navegador');
  return `${nav} · ${so}`;
}

export default function AccountPanel({ usuario, onSalir, compacto = false }: { usuario?: string; onSalir: () => void; compacto?: boolean }) {
  const [abierto, setAbierto] = useState(false);
  const [lista, setLista] = useState<SesionVista[] | null>(null);
  const [error, setError] = useState(false);
  const { t, idioma } = useI18n();
  const loc = idioma === 'en' ? 'en-GB' : 'es';

  async function cargar() {
    try {
      setLista((await sesiones()).sesiones);
      setError(false);
    } catch {
      setError(true);
    }
  }
  useEffect(() => {
    if (abierto) void cargar();
  }, [abierto]);

  async function cerrar(s: SesionVista) {
    const r = await revocar(s.id);
    if (r.eraLaActual) onSalir();
    else void cargar();
  }

  return (
    <div className={compacto ? '' : 'mt-auto border-t border-(--line) px-2 py-2'}>
      <button
        onClick={() => setAbierto((v) => !v)}
        aria-expanded={abierto}
        className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[14px] text-(--ink-soft) transition hover:bg-(--raised) hover:text-(--ink-strong)"
      >
        <UserIcon size={17} />
        <span className="min-w-0 flex-1 break-words">{t('cuenta.titulo')}{usuario ? ` · ${usuario}` : ''}</span>
        <span className="text-[11px] text-(--ink-faint)">{abierto ? '▲' : '▼'}</span>
      </button>
      {abierto && (
        <div className="mx-1 mb-1 rounded-lg bg-(--tint) p-2 text-[12.5px] ring-1 ring-(--line)">
          <p className="mb-1.5 px-1 text-[11px] uppercase tracking-wide text-(--ink-muted)">{t('cuenta.sesiones')}</p>
          {error && <p role="alert" className="px-1" style={{ color: STATUS.critical }}>{t('cuenta.errorSesiones')}</p>}
          {lista && (
            <ul className="divide-y divide-(--line)">
              {lista.map((s) => (
                <li key={s.id} className="flex items-center gap-2 px-1 py-1.5">
                  <div className="min-w-0 flex-1 leading-tight">
                    <div className="break-words text-(--ink-body)">
                      {dispositivo(t, s.user_agent)}
                      {s.actual && (
                        <span className="ml-1.5 rounded px-1.5 py-px text-[10.5px]" style={{ color: STATUS.good, background: tenido(STATUS.good, 15) }}>
                          {t('cuenta.esta')}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-(--ink-muted)">
                      {t('cuenta.vista', { cuando: cuando(s.last_seen_at, loc) })}
                      {s.ip ? ` · ${s.ip}` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => void cerrar(s)}
                    title={s.actual ? t('cuenta.salir') : t('cuenta.cerrarEsta')}
                    aria-label={s.actual ? t('cuenta.salir') : t('cuenta.cerrarDe', { dispositivo: dispositivo(t, s.user_agent) })}
                    className="grid h-7 w-7 place-items-center rounded text-(--ink-muted) hover:bg-(--raised) hover:text-(--ink-strong)"
                  >
                    {s.actual ? <LogoutIcon size={15} /> : <CrossIcon size={14} />}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            onClick={async () => {
              await salir();
              onSalir();
            }}
            className="mt-1.5 inline-flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-(--ink-body) ring-1 ring-(--line) hover:bg-(--raised)"
          >
            <LogoutIcon size={15} />
            {t('cuenta.salir')}
          </button>
          <NotificacionesPanel />
        </div>
      )}
    </div>
  );
}
