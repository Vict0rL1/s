import type { ClimaFicha } from '../lib/clima';
import { TECHO } from '../lib/clima';
import { Panel, SectionTitle } from './ui';
import { useI18n, type Clave } from '../i18n';
import { num as numF } from '../lib/formato';

/**
 * El clima del partido, como información: la previsión más reciente (T-24h → T-1h) o lo
 * observado después. Nunca mueve la probabilidad publicada; cuando no hay dato, lo dice y por
 * qué, en vez de enseñar una casilla vacía que parece un cero.
 */
export function ClimaPanel({ clima }: { clima: ClimaFicha | null | undefined }) {
  const { t } = useI18n();
  if (!clima) return null;
  // TECHO (lib/clima) sigue siendo la referencia en español; la etiqueta sale del catálogo.
  const techo = clima.estadio && clima.estadio.techo in TECHO ? t(`clima.techo.${clima.estadio.techo}` as Clave) : null;
  const derecha =
    clima.estado === 'DESCONOCIDO'
      ? t('clima.sinDato')
      : clima.estado === 'observado'
        ? t('clima.observado')
        : t('clima.prevision', { h: clima.horizonte ?? '' });
  return (
    <Panel>
      <SectionTitle right={derecha}>{t('clima.titulo')}</SectionTitle>
      {clima.estado === 'DESCONOCIDO' ? (
        <p className="text-[13px] text-(--ink-muted)">
          DESCONOCIDO{clima.motivo ? ` · ${clima.motivo}` : ''}
          {clima.estadio ? ` · ${clima.estadio.nombre} (${techo})` : ''}
        </p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-4">
          <div>
            <dt className="text-(--ink-muted)">{t('clima.temperatura')}</dt>
            <dd className="text-(--ink-strong)">{clima.tempC == null ? '—' : `${Math.round(clima.tempC)} °C`}</dd>
          </div>
          <div>
            <dt className="text-(--ink-muted)">{t('clima.viento')}</dt>
            <dd className="text-(--ink-strong)">{clima.vientoMph == null ? '—' : `${Math.round(clima.vientoMph)} mph`}</dd>
          </div>
          <div>
            <dt className="text-(--ink-muted)">{t('clima.lluvia')}</dt>
            <dd className="text-(--ink-strong)">
              {clima.probLluvia != null ? `${Math.round(clima.probLluvia)} %` : clima.lluviaMm != null ? `${numF(clima.lluviaMm, 1)} mm` : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-(--ink-muted)">{t('clima.cielo')}</dt>
            <dd className="text-(--ink-strong)">{clima.descripcion ?? '—'}</dd>
          </div>
        </dl>
      )}
      {clima.estadio && clima.estado !== 'DESCONOCIDO' && (
        <p className="mt-1.5 text-[12px] text-(--ink-faint)">
          {clima.estadio.nombre}, {clima.estadio.ciudad} · {techo}
          {clima.estadio.techo !== 'outdoors' ? t('clima.techoCerrado') : ''}
          {t('clima.informativo')}
        </p>
      )}
    </Panel>
  );
}
