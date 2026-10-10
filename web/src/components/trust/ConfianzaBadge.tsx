// La insignia de confianza (Fase 5.9): nivel (ALTA / MEDIA / BAJA) y, aparte, «Sin mercado» en
// gris cuando no hay cuotas. No tener mercado no es tener confianza baja: son dos estados.
import { STATUS, tenido } from '../../lib/theme';
import { useI18n, type Clave } from '../../i18n';

const NIVEL: Record<'ALTA' | 'MEDIA' | 'BAJA', { color: string; fondo: string; texto: Clave; corta: Clave }> = {
  ALTA: { color: STATUS.good, fondo: tenido(STATUS.good, 14), texto: 'insignia.alta', corta: 'insignia.altaCorta' },
  MEDIA: { color: STATUS.warning, fondo: tenido(STATUS.warning, 14), texto: 'insignia.media', corta: 'insignia.mediaCorta' },
  BAJA: { color: STATUS.critical, fondo: tenido(STATUS.critical, 12), texto: 'insignia.baja', corta: 'insignia.bajaCorta' },
};

export function ConfianzaBadge({ nivel, decision, motivo, compacta = false }: { nivel: 'ALTA' | 'MEDIA' | 'BAJA' | null; decision?: 'BET' | 'NO BET' | 'SIN MERCADO' | null; motivo?: string | null; compacta?: boolean }) {
  const n = nivel ? NIVEL[nivel] : null;
  const { t } = useI18n();
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-testid="insignia-confianza">
      {n ? (
        <span className="rounded-md px-2 py-0.5 text-[12px] font-semibold" style={{ color: n.color, background: n.fondo }} title={motivo ?? undefined}>
          {compacta ? t(n.corta) : t(n.texto)}
        </span>
      ) : (
        <span className="rounded-md px-2 py-0.5 text-[12px] text-(--ink-muted) ring-1 ring-(--line)" title={t('insignia.sinEvaluarNota')}>
          {t('insignia.sinEvaluar')}
        </span>
      )}
      {decision === 'SIN MERCADO' && (
        <span className="rounded-md px-2 py-0.5 text-[12px] text-(--ink-soft) ring-1 ring-(--line-strong)" title={t('insignia.sinMercadoNota')}>
          {t('insignia.sinMercado')}
        </span>
      )}
    </span>
  );
}
