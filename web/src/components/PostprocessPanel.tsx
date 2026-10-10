/**
 * Las dos probabilidades: la que sale del modelo y la que la app publica.
 *
 * ===========================================================================
 * POR QUÉ ESTO SE ENSEÑA Y NO SE ESCONDE
 * ===========================================================================
 * Entre el modelo y este número hay una capa que calibra y —donde hay precio y peso
 * ajustado— mezcla con el mercado. Sin este panel, un lector que compare el porcentaje
 * con la cuota no tiene forma de saber si está viendo lo que piensa el modelo o una
 * media entre el modelo y la propia cuota con la que lo está comparando. Eso último,
 * sin decirlo, es circular: parecería que el modelo coincide con el mercado cuando lo
 * que pasa es que se le ha acercado a propósito.
 *
 * Así que se enseñan las dos, con la flecha entre ellas, y se dice en una línea qué se
 * aplicó y por qué. Si la capa no hizo nada, el panel también lo dice — «no se aplicó
 * ninguna» es información, no un hueco.
 */
import type { FbPostprocess } from '../lib/football';
import { useI18n, type Traducir } from '../i18n';
import { pct as pctF, num as numF } from '../lib/formato';

interface Row {
  label: string;
  raw: number;
  final: number;
}

const pct = (x: number): string => `${pctF(x, 1)}`;

function describe(t: Traducir, pp: FbPostprocess): string {
  const parts: string[] = [];
  parts.push(
    pp.calibrator === 'ninguno'
      ? t('postproceso.sinCalibrar')
      : pp.calibrator === 'platt'
        ? t('postproceso.platt')
        : t('postproceso.isotonica'),
  );
  if (pp.weight !== null) {
    parts.push(
      t('postproceso.mezclada', { peso: numF(pp.weight, 2) }) +
        (pp.disagreement !== null && pp.disagreement > 0.05 ? t('postproceso.rebajado', { nats: numF(pp.disagreement, 2) }) : ''),
    );
  } else if (pp.note) {
    parts.push(t('postproceso.sinMezclar', { nota: pp.note }));
  }
  return `${parts.join('; ')}.`;
}

export function PostprocessPanel({
  rows,
  postprocess,
}: {
  rows: Row[];
  postprocess: FbPostprocess;
}): React.ReactElement | null {
  // Si nada cambió, un panel entero comparando dos columnas idénticas es ruido. Se dice
  // en una línea y ya.
  const changed = rows.some((r) => Math.abs(r.raw - r.final) >= 0.001);
  const { t } = useI18n();
  if (!changed) {
    return (
      <p className="mt-3 text-[12px] leading-relaxed text-(--ink-soft)">
        <span className="font-medium text-(--ink-body)">{t('postproceso.igual')}</span>{' '}
        {describe(t, postprocess)}
      </p>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-slate-700/60 bg-slate-900/40 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h4 className="text-[13px] font-semibold text-(--ink-body)">{t('postproceso.titulo')}</h4>
        <span className="text-[11px] text-(--ink-muted)">{t('postproceso.etiqueta')}</span>
      </div>
      <table className="w-full text-[13px] tabular-nums">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-(--ink-muted)">
            <th className="text-left font-medium">{t('postproceso.resultado')}</th>
            <th className="text-right font-medium">{t('postproceso.modelo')}</th>
            <th className="text-right font-medium">{t('postproceso.publicada')}</th>
            <th className="text-right font-medium">{t('postproceso.cambio')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const d = r.final - r.raw;
            return (
              <tr key={r.label}>
                <td className="py-0.5 text-(--ink-body)">{r.label}</td>
                <td className="py-0.5 text-right text-(--ink-soft)">{pct(r.raw)}</td>
                <td className="py-0.5 text-right font-medium text-(--ink-strong)">{pct(r.final)}</td>
                <td
                  className={`py-0.5 text-right ${
                    Math.abs(d) < 0.001
                      ? 'text-(--ink-muted)'
                      : d > 0
                        ? 'text-emerald-400/90'
                        : 'text-rose-400/90'
                  }`}
                >
                  {d >= 0 ? '+' : ''}
                  {numF(d * 100, 1)} pp
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[12px] leading-relaxed text-(--ink-soft)">{describe(t, postprocess)}</p>
    </div>
  );
}
