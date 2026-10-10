// Los iconos de la app: SVG propios, un solo trazo, en el color del texto que los rodea.
//
// Sustituyen a los emojis. Un emoji lo dibuja el sistema operativo, no la app: el mismo
// ⚽ es un balón brillante en un iPhone, otro distinto en Android y un contorno plano en
// Windows, y ninguno se parece a la tipografía ni a la paleta de alrededor. Un icono de
// línea en `currentColor` hereda el color del texto (o el acento del deporte), se ve igual
// en todos los sistemas y pesa unos cientos de bytes sin descargar nada.
//
// Todos en una rejilla de 24×24, trazo 1,75 con extremos redondeados: la misma familia,
// para que la barra de deportes se lea como un conjunto.

import type { ReactNode, SVGProps } from 'react';
import { SPORT_THEMES, STATUS, tenido, type SportId } from '../../lib/theme';
import { useI18n } from '../../i18n';

type Props = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number; title?: string };

function Svg({ size = 20, title, children, ...rest }: Props & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      {...rest}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Deportes
// ---------------------------------------------------------------------------

/** Balón de fútbol: el pentágono central relleno y cinco costuras hasta el borde. */
export function FootballIcon(p: Props) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9.25" />
      <path d="M12 7.6 16.18 10.64 14.59 15.56H9.41L7.82 10.64Z" fill="currentColor" fillOpacity={0.3} />
      <path d="M12 7.6V2.9M16.18 10.64l4.5-1.5M14.59 15.56l2.8 3.8M9.41 15.56l-2.8 3.8M7.82 10.64l-4.5-1.5" />
    </Svg>
  );
}

/** Balón de baloncesto: las dos líneas rectas y las dos curvas laterales. */
export function BasketballIcon(p: Props) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9.25" />
      <path d="M12 2.75v18.5M2.75 12h18.5" />
      <path d="M5.6 5.2c3.2 3.4 3.2 10.2 0 13.6M18.4 5.2c-3.2 3.4-3.2 10.2 0 13.6" />
    </Svg>
  );
}

/** Pelota de béisbol: dos costuras curvas con sus puntadas. */
export function BaseballIcon(p: Props) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9.25" />
      <path d="M6.2 4.8c2.6 3.6 2.6 10.8 0 14.4M17.8 4.8c-2.6 3.6-2.6 10.8 0 14.4" />
      <path
        d="M7.9 6.4l1.3-.6M8.6 9.2l1.4-.3M8.8 12h1.4M8.6 14.8l1.4.3M7.9 17.6l1.3.6M16.1 6.4l-1.3-.6M15.4 9.2l-1.4-.3M15.2 12h-1.4M15.4 14.8l-1.4.3M16.1 17.6l-1.3.6"
        strokeWidth={1.25}
      />
    </Svg>
  );
}

/** Balón de fútbol americano: el óvalo en diagonal, los cordones y las franjas. */
export function NflIcon(p: Props) {
  return (
    <Svg {...p}>
      <path d="M4.3 19.7C3.2 12.2 12.2 3.2 19.7 4.3 20.8 11.8 11.8 20.8 4.3 19.7Z" />
      <path d="M9.6 14.4l4.8-4.8" />
      <path d="M10 12.4l1.6 1.6M11.2 11.2l1.6 1.6M12.4 10l1.6 1.6" strokeWidth={1.4} />
      <path d="M6.2 15.4l2.4 2.4M15.4 6.2l2.4 2.4" strokeWidth={1.4} />
    </Svg>
  );
}

/** Hockey: el stick en diagonal, con su pala, y el disco. */
export function NhlIcon(p: Props) {
  return (
    <Svg {...p}>
      <path d="M17.5 3.5 9.2 15.8a2 2 0 0 1-1.66.89H4" />
      <path d="M4 16.7v2.3h3.9a3 3 0 0 0 2.5-1.34l.7-1.06" />
      <ellipse cx="17" cy="18" rx="3.5" ry="1.6" />
      <path d="M13.5 18v.9c0 .9 1.57 1.6 3.5 1.6s3.5-.7 3.5-1.6V18" />
    </Svg>
  );
}

/** UFC: el octógono visto desde arriba, con la lona por dentro. */
export function UfcIcon(p: Props) {
  return (
    <Svg {...p}>
      <path d="M20.87 15.67 L15.67 20.87 L8.33 20.87 L3.13 15.67 L3.13 8.33 L8.33 3.13 L15.67 3.13 L20.87 8.33Z" />
      <path d="M16.99 14.07 L14.07 16.99 L9.93 16.99 L7.01 14.07 L7.01 9.93 L9.93 7.01 L14.07 7.01 L16.99 9.93Z" strokeOpacity={0.55} />
    </Svg>
  );
}

/** Pelota de tenis: las dos curvas de la costura, una en cada esquina. */
export function TennisIcon(p: Props) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9.25" />
      <path d="M3.1 9.4c4.9.9 8.3-2.6 7-6.5M20.9 14.6c-4.9-.9-8.3 2.6-7 6.5" />
    </Svg>
  );
}

/** Boleto: las apuestas. Muescas a los lados y la línea de corte. */
export function TicketIcon(p: Props) {
  return (
    <Svg {...p}>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h15A1.5 1.5 0 0 1 21 7.5v2a2.5 2.5 0 0 0 0 5v2a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5v-2a2.5 2.5 0 0 0 0-5Z" />
      <path d="M15 7.5v1.2M15 11.4v1.2M15 15.3v1.2" />
      <path d="M7 10.5h4.5M7 13.5h3" strokeWidth={1.4} />
    </Svg>
  );
}

/** Escudo con un visto: la confianza. */
export function ShieldCheckIcon(p: Props) {
  return (
    <Svg {...p}>
      <path d="M12 2.8 19.5 5.8v5.7c0 4.5-3.2 8.1-7.5 9.7-4.3-1.6-7.5-5.2-7.5-9.7V5.8Z" />
      <path d="m8.8 12.1 2.2 2.2 4.3-4.5" />
    </Svg>
  );
}

/** Estrella: los destacados. */
export function StarIcon({ filled = false, ...p }: Props & { filled?: boolean }) {
  return (
    <Svg {...p}>
      <path
        d="M12 3.2l2.62 5.3 5.85.85-4.23 4.12 1 5.83L12 16.55l-5.24 2.75 1-5.83L3.53 9.35l5.85-.85Z"
        fill={filled ? 'currentColor' : 'none'}
      />
    </Svg>
  );
}

const POR_DEPORTE: Record<SportId, (p: Props) => ReactNode> = {
  picks: StarIcon,
  football: FootballIcon,
  basketball: BasketballIcon,
  baseball: BaseballIcon,
  nfl: NflIcon,
  nhl: NhlIcon,
  ufc: UfcIcon,
  tennis: TennisIcon,
  bets: TicketIcon,
  trust: ShieldCheckIcon,
};

export function SportIcon({ sport, ...p }: Props & { sport: SportId }) {
  const I = POR_DEPORTE[sport];
  return <I {...p} />;
}

/** Los nombres en español que usan las respuestas del servidor (`deporte`). */
const POR_NOMBRE: Record<string, SportId> = {
  'Fútbol': 'football',
  'Baloncesto': 'basketball',
  'Béisbol': 'baseball',
  NFL: 'nfl',
  NHL: 'nhl',
  UFC: 'ufc',
  'Tenis': 'tennis',
  tennis: 'tennis',
  football: 'football',
  basketball: 'basketball',
  baseball: 'baseball',
  nfl: 'nfl',
  nhl: 'nhl',
  ufc: 'ufc',
};
export const sportIdDe = (nombre: string): SportId | null => POR_NOMBRE[nombre] ?? null;

/** El icono de un deporte por su nombre en español, en el acento del deporte. */
/** Acepta el nombre en español (`Fútbol`) o el id (`football`). */
export function DeporteIcono({ nombre, size = 16, tile = false }: { nombre: string; size?: number; tile?: boolean }) {
  const id = sportIdDe(nombre);
  if (!id) return null;
  if (tile) return <SportTile sport={id} size={size} />;
  return (
    <span aria-hidden className="inline-flex align-[-3px]" style={{ color: SPORT_THEMES[id].accent }}>
      <SportIcon sport={id} size={size} />
    </span>
  );
}

/**
 * El icono de un deporte dentro de una baldosa redondeada en su color de acento: lo que
 * va al lado de una fila de partido. El acento es identidad del deporte, nunca un dato.
 */
export function SportTile({ sport, size = 28, className = '' }: { sport: SportId; size?: number; className?: string }) {
  const t = TILE[sport];
  return (
    <span
      aria-hidden
      className={`inline-grid shrink-0 place-items-center rounded-lg ${className}`}
      style={{ width: size, height: size, color: t.accent, backgroundColor: t.soft, boxShadow: `inset 0 0 0 1px ${t.ring}` }}
    >
      <SportIcon sport={sport} size={Math.round(size * 0.62)} />
    </span>
  );
}
// Los acentos salen de SPORT_THEMES: un deporte tiene un solo color en toda la app.
const TILE = Object.fromEntries(
  Object.entries(SPORT_THEMES).map(([k, v]) => [k, { accent: v.accent, soft: v.accentSoft, ring: `${v.accent}33` }]),
) as Record<SportId, { accent: string; soft: string; ring: string }>;

// ---------------------------------------------------------------------------
// Interfaz
// ---------------------------------------------------------------------------

export function CheckIcon(p: Props) {
  return (
    <Svg {...p}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Svg>
  );
}

export function CrossIcon(p: Props) {
  return (
    <Svg {...p}>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </Svg>
  );
}

/** Triángulo de aviso. */
export function AlertIcon(p: Props) {
  return (
    <Svg {...p}>
      <path d="M10.3 4.2 2.9 17.1A2 2 0 0 0 4.6 20h14.8a2 2 0 0 0 1.7-2.9L13.7 4.2a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4.2" />
      <path d="M12 16.9h.01" strokeWidth={2.4} />
    </Svg>
  );
}

/** Círculo con interrogación: lo desconocido. */
export function UnknownIcon(p: Props) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.7" />
      <path d="M12 17h.01" strokeWidth={2.4} />
    </Svg>
  );
}

/** Señal de prohibido: un jugador de baja. */
export function BanIcon(p: Props) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.7 5.7l12.6 12.6" />
    </Svg>
  );
}

/** Persona: la cuenta y sus sesiones. */
export function UserIcon(p: Props) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="8.5" r="3.6" />
      <path d="M4.8 19.5c1.3-3.3 4-5 7.2-5s5.9 1.7 7.2 5" />
    </Svg>
  );
}

/** Candado: la entrada. */
export function LockIcon(p: Props) {
  return (
    <Svg {...p}>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
      <path d="M12 14.5v2.5" />
    </Svg>
  );
}

/** Salir. */
export function LogoutIcon(p: Props) {
  return (
    <Svg {...p}>
      <path d="M10 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H10" />
      <path d="M14.5 15.5 18 12l-3.5-3.5M18 12H9.5" />
    </Svg>
  );
}

/** Estadio. */
export function StadiumIcon(p: Props) {
  return (
    <Svg {...p}>
      <ellipse cx="12" cy="8" rx="9" ry="3.2" />
      <path d="M3 8v7.5c0 1.8 4 3.2 9 3.2s9-1.4 9-3.2V8" />
      <path d="M8 11v7.4M16 11v7.4" />
    </Svg>
  );
}

/**
 * La marca de la app: una barra de probabilidad en los tres colores de datos (local,
 * empate, visitante). La misma que el favicon (web/public/favicon.svg), para que la
 * pestaña del navegador y la cabecera digan lo mismo.
 */
export function AppMark({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={className}>
      <rect width="32" height="32" rx="8" fill="#14161b" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="none" stroke="#ffffff" strokeOpacity="0.08" />
      <rect x="3.5" y="12.5" width="11.5" height="7" rx="3.5" fill="#3987e5" />
      <rect x="16.5" y="12.5" width="5" height="7" fill="#199e70" />
      <rect x="23" y="12.5" width="5.5" height="7" rx="2.75" fill="#d95926" />
    </svg>
  );
}

/** El veredicto de un partido como pastilla: icono + palabra, nunca solo color. */
export function Verdict({ ok, okText, koText }: { ok: boolean; okText?: string; koText?: string }) {
  const { t } = useI18n();
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[12px] font-semibold"
      style={{ color: ok ? STATUS.good : STATUS.critical, background: tenido(ok ? STATUS.good : STATUS.critical, 12) }}
    >
      {ok ? <CheckIcon size={13} strokeWidth={2.4} /> : <CrossIcon size={13} strokeWidth={2.4} />}
      {ok ? (okText ?? t('bkt.acerto')) : (koText ?? t('bkt.fallo'))}
    </span>
  );
}

/** Marca pequeña de estado en línea con el texto (✓ / ⚠ / ?). */
export function StatusMark({ estado, color, size = 14 }: { estado: 'ok' | 'aviso' | 'desconocido' | 'error'; color?: string; size?: number }) {
  const c = color ?? (estado === 'ok' ? 'var(--status-good)' : estado === 'aviso' ? 'var(--status-warning)' : estado === 'error' ? 'var(--status-critical)' : 'var(--ink-muted)');
  const I = estado === 'ok' ? CheckIcon : estado === 'aviso' ? AlertIcon : estado === 'error' ? CrossIcon : UnknownIcon;
  return (
    <span className="relative top-[2px] mr-1 inline-flex" style={{ color: c }}>
      <I size={size} strokeWidth={estado === 'ok' || estado === 'error' ? 2.4 : 2} />
    </span>
  );
}
