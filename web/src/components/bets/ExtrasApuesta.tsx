// Lo que la fila de una apuesta propia añade al abrirla (Fase 5.16): el CLV cuando hay
// snapshot que casar, «¿la habría apostado el modelo?» con la ventaja mínima de la política,
// y las etiquetas.
import { useEffect, useState } from 'react';
import { PROFIT_TEXT, LOSS_TEXT } from '../../lib/theme';
import type { Bet } from '../../lib/bets';
import { conNodos, useI18n } from '../../i18n';
import { pct as pctF, num as numF } from '../../lib/formato';

interface Clv { clv: number | null; cierre: number | null; casas: number | null; motivo: string | null }

const pct = (x: number) => `${x >= 0 ? '+' : '−'}${pctF(Math.abs(x), 1)}`;

export function Etiquetas({ tags }: { tags: string[] }) {
  if (!tags?.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <span key={t} className="rounded-full px-2 py-0.5 text-[11px] text-(--ink-soft) ring-1 ring-(--line)">{t}</span>
      ))}
    </span>
  );
}

export function LoHabriaApostado({ bet, minEdge }: { bet: Bet; minEdge: number | null }) {
  const { t } = useI18n();
  if (bet.model_prob == null || minEdge == null) return null;
  const ventaja = bet.model_prob * bet.odds - 1;
  const si = ventaja >= minEdge;
  return (
    <span className="text-(--ink-soft)" title={t('extras.lohabriaNota')}>
      {conNodos(t('extras.lohabria', { ventaja: pct(ventaja), minimo: pct(minEdge) }), {
        respuesta: <strong style={{ color: si ? PROFIT_TEXT : LOSS_TEXT }}>{si ? t('extras.si') : t('extras.no')}</strong>,
      })}
    </span>
  );
}

export function ClvPropio({ id }: { id: number }) {
  const [c, setC] = useState<Clv | null>(null);
  const { t } = useI18n();
  useEffect(() => {
    let vivo = true;
    fetch(`/api/bets/${id}/clv`).then((r) => (r.ok ? r.json() : null)).then((j) => vivo && setC(j)).catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, [id]);
  if (!c) return null;
  if (c.clv == null) return <span className="text-(--ink-muted)" title={c.motivo ?? undefined}>{t('extras.clvSinCierre', { motivo: c.motivo ?? '—' })}</span>;
  return (
    <span className="text-(--ink-soft)">
      {conNodos(t('extras.clv', { cierre: (c.cierre == null ? undefined : numF(c.cierre, 2)) ?? '—', casas: c.casas ?? '—' }), {
        clv: <strong style={{ color: c.clv >= 0 ? PROFIT_TEXT : LOSS_TEXT }}>{pct(c.clv)}</strong>,
      })}
    </span>
  );
}

export function Sugerencia({ odds, prob }: { odds: number; prob: number | null }) {
  const [s, setS] = useState<{ fraccion: number; importe: number | null; nota: string; bancoPersonal: number | null } | null>(null);
  const { t } = useI18n();
  useEffect(() => {
    if (!(odds > 1) || prob == null || !(prob > 0 && prob < 1)) {
      setS(null);
      return;
    }
    let vivo = true;
    fetch(`/api/bets/sugerencia?odds=${odds}&prob=${prob}`).then((r) => (r.ok ? r.json() : null)).then((j) => vivo && setS(j)).catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, [odds, prob]);
  if (!s) return null;
  return (
    <p className="text-[13px] text-(--ink-soft)" role="status">
      {conNodos(
        t('extras.sugerencia', {
          importe: s.importe != null ? t('extras.importeDe', { importe: numF(s.importe, 2), banco: s.bancoPersonal ?? '—' }) : t('extras.fijaBanco'),
          nota: s.nota,
        }),
        { fraccion: <strong className="text-(--ink-strong)">{t('extras.delBanco', { p: numF(s.fraccion * 100, 2) })}</strong> },
      )}
    </p>
  );
}
