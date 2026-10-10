// La píldora de estado global (Fase 5.4): modo de cuotas, frescura de datos por deporte,
// última actualización de resultados y cuota restante. Una por app, no un aviso por pestaña:
// la misma información repetida cinco veces parecía cinco problemas distintos.

import { useEffect, useRef, useState } from 'react';
import { STATUS, tenido } from '../../lib/theme';
import { StatusMark } from '../icons';
import { useI18n, type Clave, type Traducir } from '../../i18n';
import { useDialogo } from '../ui/useDialogo';

interface Estado {
  generado: string;
  cuotas: { modo: 'real' | 'demo'; clave: boolean; restantes: number | null; plan: number | null; ultimaConsulta: string | null; error: string | null };
  deportes: { sport: string; datosHasta: string | null; proximos: number; ultimaCuota: string | null }[];
  resultados: { ultima: string | null; estado: string | null };
  copia: { ultima: string | null };
  errores24h: number;
  trabajosConError: number;
}

const DEPORTES = new Set(['tennis', 'football', 'basketball', 'baseball', 'nfl', 'nhl', 'ufc']);
const nombreDe = (t: Traducir, sport: string) => (DEPORTES.has(sport) ? t(`deporte.${sport}` as Clave) : sport);

function hace(t: Traducir, iso: string | null): string {
  if (!iso) return t('estado.nunca');
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(min)) return t('estado.desconocido');
  if (min < 1) return t('estado.ahoraMismo');
  if (min < 60) return t('estado.haceMin', { n: min });
  const h = Math.round(min / 60);
  if (h < 48) return t('estado.haceH', { n: h });
  return t('estado.haceDias', { n: Math.round(h / 24) });
}

function diasDesde(iso: string | null): number | null {
  if (!iso) return null;
  const d = (Date.now() - Date.parse(iso)) / 86_400_000;
  return Number.isFinite(d) ? Math.floor(d) : null;
}

export function useEstadoGlobal(): Estado | null {
  const [e, setE] = useState<Estado | null>(null);
  useEffect(() => {
    let vivo = true;
    const leer = () =>
      fetch('/api/estado')
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((j: Estado) => vivo && setE(j))
        .catch(() => undefined);
    void leer();
    const t = setInterval(leer, 5 * 60_000);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, []);
  return e;
}

/** El resumen de una palabra y su color: lo peor que haya manda. */
export function resumenEstado(e: Estado, t: Traducir): { texto: string; color: string; nivel: 'ok' | 'aviso' | 'error' } {
  const viejo = e.deportes.some((d) => (diasDesde(d.datosHasta) ?? 0) > 7 && d.proximos > 0);
  if (e.trabajosConError > 0 || e.cuotas.error) return { texto: e.cuotas.modo === 'demo' ? t('estado.demoErrores') : t('estado.conErrores'), color: STATUS.critical, nivel: 'error' };
  if (e.cuotas.modo === 'demo') return { texto: t('estado.demo'), color: STATUS.warning, nivel: 'aviso' };
  if (viejo || (e.cuotas.restantes != null && e.cuotas.restantes < 50)) return { texto: t('estado.realAtencion'), color: STATUS.warning, nivel: 'aviso' };
  return { texto: t('estado.real'), color: STATUS.good, nivel: 'ok' };
}

export default function StatusPill({ compacto = false }: { compacto?: boolean }) {
  const e = useEstadoGlobal();
  const [abierto, setAbierto] = useState(false);
  const { t, idioma } = useI18n();
  const dialogo = useRef<HTMLDivElement>(null);
  useDialogo(abierto, () => setAbierto(false), dialogo, { bloquear: false });
  if (!e) return null;
  const r = resumenEstado(e, t);
  const loc = idioma === 'en' ? 'en-GB' : 'es';
  return (
    <div className="relative">
      <button
        onClick={() => setAbierto((o) => !o)}
        aria-expanded={abierto}
        aria-label={t('estado.aria', { texto: r.texto })}
        data-testid="status-pill"
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium text-(--ink-body) transition hover:bg-(--raised)"
        style={{ borderColor: tenido(r.color, 40) }}
      >
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: r.color }} />
        <span className={compacto ? 'sr-only sm:not-sr-only' : ''}>{r.texto}</span>
        {!compacto && e.cuotas.restantes != null && <span className="text-(--ink-muted)">{t('estado.peticiones', { n: e.cuotas.restantes })}</span>}
      </button>
      {abierto && (
        <div ref={dialogo} role="dialog" aria-modal="true" aria-label={t('estado.dialogo')} className="absolute left-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-(--line) bg-(--surface-card) p-3 text-[12px] leading-relaxed text-(--ink-soft) shadow-xl">
          <p className="mb-1 font-semibold text-(--ink-strong)">
            <StatusMark estado={r.nivel === 'ok' ? 'ok' : r.nivel === 'aviso' ? 'aviso' : 'error'} color={r.color} />
            {r.texto}
          </p>
          <p>
            {e.cuotas.modo === 'demo'
              ? t('estado.demoTexto')
              : t('estado.realTexto', {
                  restantes:
                    e.cuotas.restantes == null
                      ? ''
                      : e.cuotas.plan
                        ? t('estado.restantesDe', { n: e.cuotas.restantes, plan: e.cuotas.plan.toLocaleString(loc) })
                        : t('estado.restantes', { n: e.cuotas.restantes }),
                  consultadas: e.cuotas.ultimaConsulta ? t('estado.consultadas', { hace: hace(t, e.cuotas.ultimaConsulta) }) : '',
                })}
            {e.cuotas.error && <span style={{ color: STATUS.critical }}> {e.cuotas.error}</span>}
          </p>
          <ul className="mt-2 space-y-0.5">
            {e.deportes.map((d) => {
              const dias = diasDesde(d.datosHasta);
              return (
                <li key={d.sport} className="flex justify-between gap-2">
                  <span className="text-(--ink-body)">{nombreDe(t, d.sport)}</span>
                  <span className="text-right">
                    {d.datosHasta ? `${t('estado.datosHasta', { fecha: new Date(d.datosHasta).toLocaleDateString(loc) })}${dias != null && dias > 7 ? t('estado.dias', { n: dias }) : ''}` : t('estado.sinArchivo')} · {t('estado.proximos', { n: d.proximos })}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2">
            {t('estado.resultados', { cuando: e.resultados.ultima ? `${hace(t, e.resultados.ultima)}${e.resultados.estado && e.resultados.estado !== 'ok' ? ` (${e.resultados.estado})` : ''}` : t('estado.sinPasada') })} ·{' '}
            {t('estado.copia', { cuando: hace(t, e.copia.ultima) })}
            {e.errores24h > 0 && t('estado.errores24h', { n: e.errores24h })}
            {e.trabajosConError > 0 && t('estado.trabajosError', { n: e.trabajosConError })}
          </p>
          <a href="/confianza/diagnostico" className="mt-2 inline-block text-(--ink-body) underline-offset-2 hover:underline">
            {t('estado.verDiagnostico')}
          </a>
        </div>
      )}
    </div>
  );
}
