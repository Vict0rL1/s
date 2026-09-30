import type { ReactNode } from 'react';
import type { Prediction } from '../lib/api';
import { pct } from '../lib/format';

// The shared, validated categorical pair — see lib/theme.ts. Player 1 wears the
// same blue as every home side in the app and player 2 the same orange, so the
// colour means one thing across all four tabs.
export { HOME_COLOR as P1_COLOR, AWAY_COLOR as P2_COLOR } from '../lib/theme';
import { AWAY_COLOR as P2, HOME_COLOR as P1 } from '../lib/theme';

function SplitBar({
  leftFrac,
  leftLabel,
  rightLabel,
  title,
  marker,
  right,
}: {
  leftFrac: number | null;
  leftLabel: string;
  rightLabel: string;
  title: string;
  /**
   * Dónde parte la OTRA barra, dibujado sobre esta.
   *
   * ===========================================================================
   * LA COMPARACIÓN ERA LA GRACIA Y HABÍA QUE LEERLA
   * ===========================================================================
   * Dos barras apiladas con el mismo aspecto: para saber si el modelo se aparta del
   * mercado había que leer «72,7 %» arriba, «75,8 %» abajo y restar. El dato que la
   * tarjeta existe para dar —¿discrepan?— era el único que no se veía.
   *
   * Con la marca del mercado encima de la barra del modelo, la distancia ES la
   * discrepancia. Un partido donde coinciden enseña la marca pegada al corte; uno donde
   * el modelo se aparta seis puntos la enseña a seis puntos. Sin leer nada.
   */
  marker?: number | null;
  /** Texto a la derecha del título, para la diferencia. */
  right?: ReactNode;
}) {
  const hasData = leftFrac != null;
  const left = hasData ? Math.round(leftFrac * 1000) / 10 : 50;
  const markerPct = marker != null ? Math.round(marker * 1000) / 10 : null;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-[14px] text-[#9aa1ac]">
        <span>{title}</span>
        {right}
      </div>
      <div className="relative flex h-6 w-full overflow-hidden rounded-md ring-1 ring-white/[0.07]">
        <div
          className="flex items-center justify-start pl-2 text-[14px] font-semibold text-slate-900"
          style={{
            width: `${left}%`,
            backgroundColor: hasData ? P1 : '#475569',
          }}
          aria-label={`${title} ${leftLabel}`}
        >
          {hasData && left >= 18 ? leftLabel : ''}
        </div>
        <div
          className="flex items-center justify-end pr-2 text-[14px] font-semibold text-slate-900"
          style={{
            width: `${100 - left}%`,
            backgroundColor: hasData ? P2 : '#334155',
          }}
          aria-label={`${title} ${rightLabel}`}
        >
          {hasData && 100 - left >= 18 ? rightLabel : ''}
        </div>
        {markerPct != null && (
          // Blanco sobre los dos colores de la barra, con una sombra fina para que se
          // vea igual sobre el azul que sobre el naranja.
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-[2px] bg-white/80"
            style={{ left: `calc(${markerPct}% - 1px)`, boxShadow: '0 0 0 1px rgba(0,0,0,0.45)' }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Two "tug of war" bars, stacked: MODEL vs MARKET. The divider position shows
 * each player's win probability. Comparing where the two bars split shows
 * whether the model agrees with the bookmakers.
 */
export default function ProbabilityBars({ prediction }: { prediction: Prediction }) {
  const modelLeft = prediction.model.prob1;
  const market = prediction.market.market;
  const marketLeft = market ? market.implied1 : null;

  // La diferencia, en puntos porcentuales y con su signo. Por debajo de medio punto no
  // se anuncia nada: «+0,0 pp» ocupa sitio para decir que no hay diferencia.
  const gap = marketLeft != null ? (modelLeft - marketLeft) * 100 : null;

  return (
    <div className="space-y-3">
      <SplitBar
        title="Modelo"
        leftFrac={modelLeft}
        leftLabel={pct(prediction.model.prob1, 1)}
        rightLabel={pct(prediction.model.prob2, 1)}
        marker={marketLeft}
        right={
          gap != null && Math.abs(gap) >= 0.5 ? (
            <span className="tabular-nums text-[13px] text-[#7b828d]">
              <span className="mr-1 inline-block h-[9px] w-[2px] translate-y-[1px] bg-white/80" />
              mercado, a {Math.abs(gap).toFixed(1)} pp
            </span>
          ) : gap != null ? (
            <span className="text-[13px] text-[#7b828d]">coincide con el mercado</span>
          ) : undefined
        }
      />
      <SplitBar
        title="Mercado (odds sin vig)"
        leftFrac={marketLeft}
        leftLabel={market ? pct(market.implied1, 1) : 'sin odds'}
        rightLabel={market ? pct(market.implied2, 1) : ''}
      />
    </div>
  );
}
