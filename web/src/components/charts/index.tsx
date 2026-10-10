// Gráficos propios en SVG (Fase 5.22): una sola «biblioteca», los colores de datos de
// theme.ts y un resumen en texto por gráfico para lectores de pantalla. Sin dependencias.

import { useId, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { HOME_COLOR, AWAY_COLOR, DRAW_COLOR, NEUTRAL_COLOR, PROFIT_COLOR, LOSS_COLOR } from '../../lib/theme';
import { num as numF } from '../../lib/formato';

export const SERIES = [HOME_COLOR, AWAY_COLOR, DRAW_COLOR, '#a78bfa', '#f5b544', NEUTRAL_COLOR];

export interface Serie {
  nombre: string;
  puntos: { x: number; y: number }[];
  color?: string;
}

const fmt = (v: number, d = 2) => (Number.isInteger(v) ? String(v) : numF(v, d));
/** Las etiquetas del eje: sin decimales a partir de 100, que con el margen izquierdo no caben. */
const fmtEje = (v: number) => (Math.abs(v) >= 100 ? String(Math.round(v)) : fmt(v));

/** Marco común: título, resumen accesible y el SVG. */
function Marco({ titulo, resumen, children, alto = 180 }: { titulo?: string; resumen: string; children: ReactNode; alto?: number }) {
  const id = useId();
  return (
    <figure className="m-0" aria-describedby={id}>
      {titulo && <figcaption className="mb-1 text-[12px] font-medium text-(--ink-soft)">{titulo}</figcaption>}
      <div style={{ height: alto }}>{children}</div>
      <p id={id} className="sr-only">{resumen}</p>
    </figure>
  );
}

function escalas(series: Serie[], ancho: number, alto: number, m: { l: number; r: number; t: number; b: number }, yMin?: number, yMax?: number) {
  const xs = series.flatMap((s) => s.puntos.map((p) => p.x));
  const ys = series.flatMap((s) => s.puntos.map((p) => p.y));
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = yMin ?? Math.min(...ys);
  const y1 = yMax ?? Math.max(...ys);
  const sx = (x: number) => m.l + ((x - x0) / Math.max(1e-9, x1 - x0)) * (ancho - m.l - m.r);
  const sy = (y: number) => alto - m.b - ((y - y0) / Math.max(1e-9, y1 - y0)) * (alto - m.t - m.b);
  return { sx, sy, x0, x1, y0, y1 };
}

/** Líneas: una o varias series sobre el mismo eje. `formatoX` convierte la x (p. ej. una fecha). */
export function LineChart({ series, titulo, unidad = '', formatoX = (x) => String(x), yMin, yMax, alto = 180, referencia }: { series: Serie[]; titulo?: string; unidad?: string; formatoX?: (x: number) => string; yMin?: number; yMax?: number; alto?: number; referencia?: { y: number; etiqueta: string } }) {
  const { t: tr } = useI18n();
  const ancho = 640;
  const m = { l: 44, r: 12, t: 10, b: 24 };
  const con = series.filter((s) => s.puntos.length > 0);
  if (!con.length) return <p className="text-[12px] text-(--ink-muted)">{tr('ch.sinDatos')}</p>;
  const { sx, sy, x0, x1, y0, y1 } = escalas(con, ancho, alto, m, yMin, yMax);
  const ticks = [y0, (y0 + y1) / 2, y1];
  const resumen = con
    .map((s) => {
      const u = s.puntos[s.puntos.length - 1];
      const p = s.puntos[0];
      return tr('ch.resumenLinea', { nombre: s.nombre, a: `${fmt(p.y)}${unidad}`, xa: formatoX(p.x), b: `${fmt(u.y)}${unidad}`, xb: formatoX(u.x), n: s.puntos.length });
    })
    .join('; ');
  return (
    <Marco titulo={titulo} resumen={resumen} alto={alto}>
      <svg viewBox={`0 0 ${ancho} ${alto}`} width="100%" height="100%" role="img" aria-label={titulo ?? tr('ch.lineas')} preserveAspectRatio="none">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={ancho - m.r} y1={sy(t)} y2={sy(t)} stroke="var(--line)" />
            <text x={m.l - 6} y={sy(t) + 4} textAnchor="end" fontSize="11" fill="var(--ink-muted)">{fmtEje(t)}{unidad}</text>
          </g>
        ))}
        {referencia && (
          <g>
            <line x1={m.l} x2={ancho - m.r} y1={sy(referencia.y)} y2={sy(referencia.y)} stroke="var(--ink-faint)" strokeDasharray="4 4" />
            <text x={ancho - m.r} y={sy(referencia.y) - 4} textAnchor="end" fontSize="11" fill="var(--ink-muted)">{referencia.etiqueta}</text>
          </g>
        )}
        <text x={m.l} y={alto - 6} fontSize="11" fill="var(--ink-muted)">{formatoX(x0)}</text>
        <text x={ancho - m.r} y={alto - 6} textAnchor="end" fontSize="11" fill="var(--ink-muted)">{formatoX(x1)}</text>
        {con.map((s, i) => (
          <polyline key={s.nombre} fill="none" stroke={s.color ?? SERIES[i % SERIES.length]} strokeWidth={2} strokeLinejoin="round" points={s.puntos.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' ')}>
            <title>{s.nombre}</title>
          </polyline>
        ))}
      </svg>
      {con.length > 1 && (
        <ul className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-(--ink-muted)">
          {con.map((s, i) => (
            <li key={s.nombre} className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: s.color ?? SERIES[i % SERIES.length] }} />{s.nombre}</li>
          ))}
        </ul>
      )}
    </Marco>
  );
}

/** Una línea diminuta, sin ejes: la tendencia y nada más. */
export function Sparkline({ puntos, color = HOME_COLOR, ancho = 120, alto = 28, etiqueta }: { puntos: number[]; color?: string; ancho?: number; alto?: number; etiqueta: string }) {
  const { t: tr } = useI18n();
  if (puntos.length < 2) return <span className="text-[11px] text-(--ink-muted)">—</span>;
  const y0 = Math.min(...puntos);
  const y1 = Math.max(...puntos);
  const sx = (i: number) => (i / (puntos.length - 1)) * (ancho - 2) + 1;
  const sy = (v: number) => alto - 2 - ((v - y0) / Math.max(1e-9, y1 - y0)) * (alto - 4);
  return (
    <svg width={ancho} height={alto} role="img" aria-label={tr('ch.sparkline', { etiqueta, a: fmt(puntos[0]), b: fmt(puntos[puntos.length - 1]) })}>
      <polyline fill="none" stroke={color} strokeWidth={1.5} points={puntos.map((v, i) => `${sx(i)},${sy(v)}`).join(' ')} />
    </svg>
  );
}

/** Barras horizontales con etiqueta y valor; `max` fija la escala (1 para probabilidades). */
export function BarChart({ filas, titulo, max, formato = (v) => fmt(v), color = HOME_COLOR }: { filas: { etiqueta: string; valor: number; color?: string; n?: number }[]; titulo?: string; max?: number; formato?: (v: number) => string; color?: string }) {
  const { t: tr } = useI18n();
  if (!filas.length) return <p className="text-[12px] text-(--ink-muted)">{tr('ch.sinDatos')}</p>;
  const tope = max ?? Math.max(...filas.map((f) => f.valor), 1e-9);
  const resumen = filas.map((f) => `${f.etiqueta}: ${formato(f.valor)}${f.n != null ? ` (n ${f.n})` : ''}`).join('; ');
  return (
    <Marco titulo={titulo} resumen={resumen} alto={filas.length * 22 + 4}>
      <ul className="m-0 list-none p-0 text-[12px]" aria-label={titulo}>
        {filas.map((f) => (
          <li key={f.etiqueta} className="flex items-center gap-2 py-0.5">
            <span className="w-32 shrink-0 break-words text-(--ink-soft)">{f.etiqueta}</span>
            <span className="h-3 flex-1 overflow-hidden rounded bg-(--raised)">
              <span className="block h-full rounded" style={{ width: `${Math.min(100, (f.valor / tope) * 100)}%`, backgroundColor: f.color ?? color }} />
            </span>
            <span className="w-16 shrink-0 text-right tabular-nums text-(--ink-strong)">{formato(f.valor)}</span>
            {f.n != null && <span className="w-14 shrink-0 text-right text-(--ink-muted)">n {f.n}</span>}
          </li>
        ))}
      </ul>
    </Marco>
  );
}

/** Diagrama de fiabilidad: predicha contra observada, con la diagonal y el tamaño de cada cubeta. */
export function ReliabilityDiagram({ cubetas, titulo }: { cubetas: { desde: number; hasta: number; n: number; predicha: number | null; observada: number | null }[]; titulo?: string }) {
  const { t: tr } = useI18n();
  const ancho = 320;
  const alto = 320;
  const m = { l: 40, r: 12, t: 10, b: 32 };
  const s = (v: number) => m.l + v * (ancho - m.l - m.r);
  const t = (v: number) => alto - m.b - v * (alto - m.t - m.b);
  const con = cubetas.filter((c) => c.n > 0 && c.predicha != null && c.observada != null);
  const total = cubetas.reduce((a, c) => a + c.n, 0);
  const resumen = con.length ? con.map((c) => tr('ch.resumenFiab', { p: Math.round((c.predicha as number) * 100), o: Math.round((c.observada as number) * 100), n: c.n })).join('; ') : tr('ch.sinCubetas');
  return (
    <Marco titulo={titulo} resumen={resumen} alto={alto}>
      <svg viewBox={`0 0 ${ancho} ${alto}`} width="100%" height="100%" role="img" aria-label={titulo ?? tr('ch.fiabilidad')}>
        <line x1={s(0)} y1={t(0)} x2={s(1)} y2={t(1)} stroke="var(--ink-faint)" strokeDasharray="4 4" />
        {[0, 0.5, 1].map((v) => (
          <g key={v}>
            <text x={s(v)} y={alto - 10} textAnchor="middle" fontSize="11" fill="var(--ink-muted)">{Math.round(v * 100)} %</text>
            <text x={m.l - 6} y={t(v) + 4} textAnchor="end" fontSize="11" fill="var(--ink-muted)">{Math.round(v * 100)} %</text>
          </g>
        ))}
        <text x={(s(0) + s(1)) / 2} y={alto - 0} textAnchor="middle" fontSize="10" fill="var(--ink-faint)">{tr('ch.predicha')}</text>
        {con.map((c) => (
          <circle key={c.desde} cx={s(c.predicha as number)} cy={t(c.observada as number)} r={Math.max(3, Math.min(14, Math.sqrt(c.n / Math.max(1, total)) * 40))} fill={HOME_COLOR} fillOpacity={0.75}>
            <title>{tr('ch.cubetaTitulo', { desde: Math.round(c.desde * 100), hasta: Math.round(c.hasta * 100), p: Math.round((c.predicha as number) * 100), o: Math.round((c.observada as number) * 100), n: c.n })}</title>
          </circle>
        ))}
      </svg>
    </Marco>
  );
}

/** Distribución discreta (posiciones finales, márgenes…): barras verticales. */
export function Histogram({ valores, etiquetas, titulo, color = HOME_COLOR, resaltar }: { valores: number[]; etiquetas: string[]; titulo?: string; color?: string; resaltar?: number }) {
  const { t: tr } = useI18n();
  const ancho = Math.max(240, valores.length * 22);
  const alto = 120;
  const max = Math.max(...valores, 1e-9);
  const w = (ancho - 8) / valores.length;
  const resumen = valores.map((v, i) => `${etiquetas[i]}: ${Math.round(v * 100)} %`).join('; ');
  return (
    <Marco titulo={titulo} resumen={resumen} alto={alto + 18}>
      <svg viewBox={`0 0 ${ancho} ${alto + 18}`} width="100%" height="100%" role="img" aria-label={titulo ?? tr('ch.distribucion')} preserveAspectRatio="none">
        {valores.map((v, i) => (
          <g key={i}>
            <rect x={4 + i * w + 1} y={alto - (v / max) * (alto - 8)} width={Math.max(1, w - 2)} height={(v / max) * (alto - 8)} fill={resaltar === i ? AWAY_COLOR : color} fillOpacity={0.85}>
              <title>{`${etiquetas[i]}: ${Math.round(v * 100)} %`}</title>
            </rect>
            {(valores.length <= 12 || i % Math.ceil(valores.length / 12) === 0) && <text x={4 + i * w + w / 2} y={alto + 13} textAnchor="middle" fontSize="10" fill="var(--ink-muted)">{etiquetas[i]}</text>}
          </g>
        ))}
      </svg>
    </Marco>
  );
}

export const COLOR_BENEFICIO = PROFIT_COLOR;
export const COLOR_PERDIDA = LOSS_COLOR;
