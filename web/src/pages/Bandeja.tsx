// La bandeja (Fase 6.4): cada notificación y cada alerta de la app, con leída/no leída,
// filtros por tipo y deporte, y enlace al partido o al informe.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useI18n, formato } from '../i18n';
import { useJson, enviarJson } from '../lib/usarJson';
import { pillClass } from '../components/ui';
import { STATUS } from '../lib/theme';
import { EVENTO_BANDEJA } from '../components/bandeja/Campana';

interface Aviso {
  id: number;
  created_at: string;
  origen: 'notificacion' | 'alerta';
  tipo: string;
  severidad: 'info' | 'aviso' | 'importante';
  sport: string | null;
  match_key: string | null;
  titulo: string;
  cuerpo: string;
  url: string | null;
  leida_at: string | null;
}
interface Respuesta { avisos: Aviso[]; noLeidas: number; tipos: { tipo: string; n: number }[]; hayMas: boolean }

const DEPORTES = ['football', 'basketball', 'baseball', 'nfl', 'nhl', 'ufc', 'tennis'];
const COLOR: Record<Aviso['severidad'], string | undefined> = { importante: STATUS.critical, aviso: STATUS.warning, info: undefined };

export default function Bandeja() {
  const { t, idioma } = useI18n();
  const f = formato(idioma);
  const navigate = useNavigate();
  const [soloNoLeidas, setSoloNoLeidas] = useState(false);
  const [tipo, setTipo] = useState('');
  const [sport, setSport] = useState('');
  const [limite, setLimite] = useState(50);
  const url = useMemo(() => {
    const q = new URLSearchParams({ limite: String(limite) });
    if (soloNoLeidas) q.set('leida', '0');
    if (tipo) q.set('tipo', tipo);
    if (sport) q.set('sport', sport);
    return `/api/bandeja?${q}`;
  }, [soloNoLeidas, tipo, sport, limite]);
  const { datos, error, recargar } = useJson<Respuesta>(url);
  const cambiar = async (cuerpo: { ids?: number[]; todas?: boolean; leida: boolean }) => {
    await enviarJson('/api/bandeja/marcar', 'POST', cuerpo).catch(() => undefined);
    window.dispatchEvent(new Event(EVENTO_BANDEJA));
    recargar();
  };
  const abrir = async (a: Aviso) => {
    if (!a.leida_at) await cambiar({ ids: [a.id], leida: true });
    if (a.url) navigate(a.url);
  };
  return (
    <div>
      <h2 className="mb-1 text-[20px] font-semibold text-(--ink-strong)">{t('nav.bandeja')}</h2>
      <p className="mb-4 max-w-3xl text-[14px] leading-relaxed text-(--ink-soft)">{t('bandeja.intro')}</p>
      {error && <p role="alert" className="text-[14px] text-(--ink-soft)">{error}</p>}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <button className={pillClass(!soloNoLeidas)} onClick={() => setSoloNoLeidas(false)}>{t('bandeja.todas')}</button>
        <button className={pillClass(soloNoLeidas)} onClick={() => setSoloNoLeidas(true)}>
          {t('bandeja.noLeidas')}{datos ? ` · ${datos.noLeidas}` : ''}
        </button>
        <select aria-label={t('bandeja.tipo')} value={tipo} onChange={(e) => setTipo(e.target.value)} className="rounded-full bg-(--raised) px-3 py-1.5 text-[14px] text-(--ink-body) ring-1 ring-(--line)">
          <option value="">{t('bandeja.todosTipos')}</option>
          {(datos?.tipos ?? []).map((x) => (
            <option key={x.tipo} value={x.tipo}>{x.tipo.replace(/_/g, ' ')} ({x.n})</option>
          ))}
        </select>
        <select aria-label={t('lab.deporte')} value={sport} onChange={(e) => setSport(e.target.value)} className="rounded-full bg-(--raised) px-3 py-1.5 text-[14px] text-(--ink-body) ring-1 ring-(--line)">
          <option value="">{t('bandeja.todosDeportes')}</option>
          {DEPORTES.map((d) => (
            <option key={d} value={d}>{t(`deporte.${d}` as never)}</option>
          ))}
        </select>
        {datos && datos.noLeidas > 0 && (
          <button onClick={() => void cambiar({ todas: true, leida: true })} className="ml-auto rounded-lg px-3 py-1.5 text-[13px] text-(--ink-body) ring-1 ring-(--line) hover:bg-(--raised)">
            {t('bandeja.marcarTodo')}
          </button>
        )}
      </div>
      {datos && datos.avisos.length === 0 && <p className="text-[14px] text-(--ink-muted)">{t('bandeja.vacia')}</p>}
      <ul className="space-y-2" data-testid="lista-bandeja">
        {(datos?.avisos ?? []).map((a) => (
          <li key={a.id} className={`rounded-xl border border-(--line) p-3 ${a.leida_at ? 'bg-transparent' : 'bg-(--surface-card)'}`}>
            <div className="flex flex-wrap items-start gap-2">
              {!a.leida_at && <span className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: COLOR[a.severidad] ?? 'var(--ink-soft)' }} aria-label={t('bandeja.sinLeer')} />}
              <div className="min-w-0 flex-1">
                <p className={`break-words text-[14px] ${a.leida_at ? 'text-(--ink-soft)' : 'font-semibold text-(--ink-strong)'}`}>{a.titulo}</p>
                <p className="break-words text-[13px] text-(--ink-body)">{a.cuerpo}</p>
                <p className="mt-1 text-[12px] text-(--ink-muted)">
                  {f.fecha(a.created_at)} · {a.tipo.replace(/_/g, ' ')}
                  {a.severidad !== 'info' && <span style={{ color: COLOR[a.severidad] }}> · {a.severidad}</span>}
                  {a.sport && ` · ${t(`deporte.${a.sport}` as never)}`}
                </p>
              </div>
              <span className="flex shrink-0 gap-1.5">
                {a.url && (
                  <button onClick={() => void abrir(a)} className="rounded-lg px-2.5 py-1 text-[12px] text-(--ink-body) ring-1 ring-(--line) hover:bg-(--raised)">{t('bandeja.abrir')}</button>
                )}
                <button onClick={() => void cambiar({ ids: [a.id], leida: !a.leida_at })} className="rounded-lg px-2.5 py-1 text-[12px] text-(--ink-soft) ring-1 ring-(--line) hover:bg-(--raised)">
                  {a.leida_at ? t('bandeja.marcarNoLeida') : t('bandeja.marcarLeida')}
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>
      {datos?.hayMas && (
        <button onClick={() => setLimite((x) => x + 50)} className="mt-3 rounded-lg px-3 py-1.5 text-[13px] text-(--ink-body) ring-1 ring-(--line) hover:bg-(--raised)">{t('bandeja.mas')}</button>
      )}
    </div>
  );
}
