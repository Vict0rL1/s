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

interface Row {
  label: string;
  raw: number;
  final: number;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

function describe(pp: FbPostprocess): string {
  const parts: string[] = [];
  parts.push(
    pp.calibrator === 'ninguno'
      ? 'Sin calibrar: se probaron Platt e isotónica y ninguna mejoró fuera de muestra'
      : pp.calibrator === 'platt'
        ? 'Calibrada con Platt, ajustado sobre predicciones históricas fuera de muestra'
        : 'Calibrada con regresión isotónica, ajustada sobre predicciones históricas fuera de muestra',
  );
  if (pp.weight !== null) {
    parts.push(
      `mezclada con el mercado dándole al modelo un peso de ${pp.weight.toFixed(2)}` +
        (pp.disagreement !== null && pp.disagreement > 0.05
          ? ` (rebajado por discrepar ${pp.disagreement.toFixed(2)} nats del precio)`
          : ''),
    );
  } else if (pp.note) {
    parts.push(`sin mezclar con el mercado — ${pp.note}`);
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
  if (!changed) {
    return (
      <p className="mt-3 text-[12px] leading-relaxed text-slate-400">
        <span className="font-medium text-slate-300">Probabilidad publicada = cruda.</span>{' '}
        {describe(postprocess)}
      </p>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-slate-700/60 bg-slate-900/40 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h4 className="text-[13px] font-semibold text-slate-200">Cruda → publicada</h4>
        <span className="text-[11px] text-slate-500">post-proceso</span>
      </div>
      <table className="w-full text-[13px] tabular-nums">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-slate-500">
            <th className="text-left font-medium">resultado</th>
            <th className="text-right font-medium">modelo</th>
            <th className="text-right font-medium">publicada</th>
            <th className="text-right font-medium">cambio</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const d = r.final - r.raw;
            return (
              <tr key={r.label}>
                <td className="py-0.5 text-slate-300">{r.label}</td>
                <td className="py-0.5 text-right text-slate-400">{pct(r.raw)}</td>
                <td className="py-0.5 text-right font-medium text-slate-100">{pct(r.final)}</td>
                <td
                  className={`py-0.5 text-right ${
                    Math.abs(d) < 0.001
                      ? 'text-slate-500'
                      : d > 0
                        ? 'text-emerald-400/90'
                        : 'text-rose-400/90'
                  }`}
                >
                  {d >= 0 ? '+' : ''}
                  {(d * 100).toFixed(1)} pp
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[12px] leading-relaxed text-slate-400">{describe(postprocess)}</p>
    </div>
  );
}
