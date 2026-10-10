// Piezas compartidas de la interfaz: rows. Partido de ui/index.tsx en la Fase 5 (ningún import cambia: index.tsx reexporta).
import type { ReactNode } from 'react';
import { SeriesDot } from './marks';
import { useI18n } from '../../i18n';
import { pct as pctF, num as numF } from '../../lib/formato';
/**
 * One factor's contribution in a "why" list.
 *
 * The figure is ink and the dot says which side it favours — the same split as
 * HeroStat. The line already ends in the team's name, so painting the whole
 * string blue or orange was colouring text that had already said who it meant.
 */
export function FactorValue({
  color,
  neutral = false,
  children,
}: {
  color: string;
  neutral?: boolean;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 tabular-nums text-(--ink-body)">
      {!neutral && <SeriesDot color={color} />}
      {children}
    </span>
  );
}

/** Label / value row, for the dense comparison tables in a breakdown. */
export function CompareRow({
  label,
  left,
  right,
  title,
}: {
  label: string;
  left: ReactNode;
  right: ReactNode;
  title?: string;
}) {
  return (
    <>
      <dt className="min-w-0 break-words py-1 text-(--ink-soft)" title={title}>
        {label}
      </dt>
      <dd className="py-1 text-right tabular-nums text-(--ink-body)">{left}</dd>
      <dd className="py-1 text-right tabular-nums text-(--ink-body)">{right}</dd>
    </>
  );
}

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------
/**
 * A stacked probability bar.
 *
 * 2px surface gaps between segments (the spacer rule) so adjacent fills read as
 * separate marks rather than one continuous ribbon, and rounded outer ends.
 */
export function ProbabilityBar({
  segments,
  height = 10,
  marker,
}: {
  segments: { value: number; color: string; label: string }[];
  height?: number;
  /**
   * Dónde cortaría la MISMA barra según el mercado, dibujado encima.
   *
   * ===========================================================================
   * LA COMPARACIÓN ERA LO IMPORTANTE Y ERA LO ÚNICO QUE NO SE VEÍA
   * ===========================================================================
   * Las tarjetas enseñaban dos barras apiladas —modelo arriba, «mercado sin vig» debajo,
   * más fina— y la de abajo NO llevaba ni un número. Para saber si el modelo se apartaba
   * del precio había que comparar a ojo dos rectángulos de anchuras parecidas, y eso no
   * se puede hacer: una diferencia de tres puntos porcentuales son once píxeles.
   *
   * Con la marca encima, LA DISTANCIA ES LA DISCREPANCIA. Y quien la pinta añade al lado
   * cuántos puntos son, que es el número que se acaba queriendo.
   *
   * La fracción es respecto del MISMO total que los segmentos, para que las dos cosas
   * midan lo mismo: dibujarla sobre 100 cuando los segmentos suman 0,98 la desplazaría
   * un punto entero.
   */
  marker?: number | null;
}) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  const markerPct = marker != null ? (marker / total) * 100 : null;
  return (
    <div className="relative flex w-full gap-[2px] overflow-hidden rounded-full" style={{ height }}>
      {segments.map((s, i) => (
        <div
          key={i}
          className="first:rounded-l-full last:rounded-r-full"
          style={{ width: `${(s.value / total) * 100}%`, backgroundColor: s.color }}
          title={`${s.label}: ${pctF(s.value, 1)}`}
        />
      ))}
      {markerPct != null && (
        // Blanca con un halo oscuro para que se lea igual sobre los dos colores de la
        // barra, que es la razón de no usar ninguno de los dos.
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-[2px] bg-white/85"
          style={{ left: `calc(${markerPct}% - 1px)`, boxShadow: '0 0 0 1px rgba(0,0,0,0.5)' }}
        />
      )}
    </div>
  );
}

/**
 * La leyenda de esa marca: cuánto se aparta el modelo del mercado, en puntos.
 *
 * Separada del componente de la barra porque el texto va en la fila del título, que cada
 * deporte monta a su manera. Por debajo de medio punto no se anuncia una diferencia:
 * «+0,0 pp» ocupa sitio para decir que no hay ninguna.
 */
export function MarketGap({ model, market }: { model: number; market: number | null | undefined }) {
  const { t } = useI18n();
  if (market == null) return null;
  const pp = (model - market) * 100;
  if (Math.abs(pp) < 0.5) {
    return <span className="text-[12px] text-(--ink-muted)">{t('pb.coincide')}</span>;
  }
  return (
    <span className="text-[12px] tabular-nums text-(--ink-muted)">
      <span className="mr-1 inline-block h-[9px] w-[2px] translate-y-[1px] bg-white/85" />
      mercado, a {numF(Math.abs(pp), 1)} pp
    </span>
  );
}

/**
 * A horizontal bar in a ranked list.
 *
 * Scaled to the largest bar rather than to 100%, because these distributions peak
 * in the single digits and an absolute scale would leave every bar invisible.
 */
export function BarRow({
  label,
  value,
  max,
  color,
  valueLabel,
  title,
}: {
  label: ReactNode;
  value: number;
  max: number;
  color: string;
  valueLabel: string;
  title?: string;
}) {
  return (
    <div className="flex items-center gap-2 text-[13px]" title={title}>
      <span className="w-[3.75rem] shrink-0 text-right tabular-nums text-(--ink-body)">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-(--raised)">
        <div
          className="h-full rounded-full"
          style={{ width: `${max > 0 ? (value / max) * 100 : 0}%`, backgroundColor: color }}
        />
      </div>
      <span className="w-12 shrink-0 text-right tabular-nums text-(--ink-soft)">{valueLabel}</span>
    </div>
  );
}

/**
 * Recent form as dots.
 *
 * "WWLWDLWWLW" is a string the eye has to parse letter by letter. Dots are read
 * at a glance, and the letter stays in the tooltip for anyone who wants it.
 */
export function FormDots({
  results,
  colors,
}: {
  /** 'NC': el «sin resultado» de la UFC; se pinta como el empate y se dice como lo que es. */
  results: ('W' | 'D' | 'L' | 'NC')[];
  colors: { W: string; D: string; L: string };
}) {
  const { t } = useI18n();
  if (results.length === 0) return <span className="text-(--ink-faint)">—</span>;
  return (
    <span className="inline-flex gap-[3px] align-middle">
      {results.map((r, i) => (
        <span
          key={i}
          title={r === 'W' ? t('forma.ganado') : r === 'D' ? t('forma.empatado') : r === 'NC' ? t('forma.sinResultado') : t('forma.perdido')}
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: colors[r === 'NC' ? 'D' : r] }}
        />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------
/**
 * A small annotation on a card: "cancha neutral", "partido demo".
 *
 * The neutral tone has no fill at all — it is a word with a hairline round it.
 * Most badges on a card are neutral, and a filled pill for every one of them put
 * a row of grey lozenges above the teams competing with the teams. The coloured
 * tones keep their tint, because those are the ones that need to be noticed.
 */
export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'warning' | 'critical' | 'accent';
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'text-(--ink-soft) ring-(--line)',
    good: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30',
    warning: 'bg-amber-500/10 text-amber-300 ring-amber-500/30',
    critical: 'bg-rose-500/10 text-rose-300 ring-rose-500/30',
    // "accent" marks a card the reader has changed (a lineup edit, a swapped
    // starter). A strong neutral says "this one is not the default" without
    // spending a fifth hue on it.
    accent: 'bg-(--raised-3) text-(--ink-strong) ring-(--line-strong)',
  };
  return (
    <span
      title={title}
      // `max-w-full` + truncate rather than bare `whitespace-nowrap`: a badge that
      // says "Value: Arizona Cardinals" is as long as the team name, and without a
      // cap it widened the page instead of itself.
      className={`inline-flex min-w-0 max-w-full shrink-0 items-center gap-1 break-words rounded-full px-2 py-0.5 text-[13px] font-medium ring-1 ring-inset ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------
