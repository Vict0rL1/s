// Piezas compartidas de la interfaz: dashboard. Partido de ui/index.tsx en la Fase 5 (ningún import cambia: index.tsx reexporta).
import { useState, type ReactNode } from 'react';
import { StatusMark } from '../icons';
import { conNodos, useI18n } from '../../i18n';

const CODIGOS = {
  doctor: <code>npm run doctor</code>,
  odds: <code>npm run odds</code>,
  clave: <code>ODDS_API_KEY</code>,
  env: <code>.env</code>,
};
/**
 * The per-sport header, collapsed by default.
 *
 * WHAT IT REPLACES. Every tab opened with a wall of prose before a single
 * prediction: a paragraph explaining the model, a data-origin line, an odds-refresh
 * line, a stale-history warning of two sentences, and a track-record panel. All of
 * it true, all of it read once, and all of it standing between the reader and the
 * thing they opened the app for. On a laptop it was most of the first screen.
 *
 * So it collapses, and it opens with the CONTROLS and the FACTS instead: the refresh
 * button, a few counts as chips, and — this is the part that must not be lost — a
 * short warning chip when the data is stale.
 *
 * WHY THE WARNING SURVIVES THE COLLAPSE. The full stale-history paragraph is the one
 * piece of that block that changes what a reader should DO: it says these numbers
 * describe last season's teams. Hiding that silently would make the app quietly
 * misleading, which is exactly the failure the warning exists to prevent. So the
 * paragraph collapses and a four-word version of it does not. Nothing important
 * disappears; it just stops being a paragraph.
 *
 * The open/closed choice is remembered, and remembered ONCE for all sports: it is a
 * preference about how much chrome the reader wants, not a fact about baseball.
 */
const HEADER_OPEN_KEY = 'predictor.header.open';

export function DashboardHeader({
  chips,
  alert,
  onRefresh,
  refreshing = false,
  refreshTitle,
  children,
}: {
  /** Short facts, always visible: "37.262 partidos", "32 equipos". */
  chips?: ReactNode;
  /** Compact stale-data note. Stays visible when collapsed — see above. */
  alert?: string | null;
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshTitle?: string;
  /** The full block. Hidden until asked for. */
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(HEADER_OPEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(HEADER_OPEN_KEY, next ? '1' : '0');
    } catch {
      // Only affects whether it opens collapsed next time.
    }
  };

  return (
    <header className="mb-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {onRefresh && (
          <button
            onClick={onRefresh}
            disabled={refreshing}
            title={refreshTitle}
            className="shrink-0 rounded-lg bg-(--raised) px-3 py-1.5 text-[14px] font-medium text-(--ink-body) ring-1 ring-inset ring-(--line) transition hover:bg-(--raised-2) disabled:opacity-50"
          >
            {refreshing ? t('cabecera.actualizando') : t('cabecera.actualizar')}
          </button>
        )}
        {chips && <span className="min-w-0 text-[13px] text-(--ink-muted)">{chips}</span>}
        {alert && (
          <span
            className="shrink-0 rounded-full bg-amber-500/[0.12] px-2.5 py-1 text-[13px] font-medium text-amber-200/90"
            title={t('cabecera.alertaNota')}
          >
            <StatusMark estado="aviso" color="#fcd34d" size={13} />{alert}
          </span>
        )}
        <button
          onClick={toggle}
          aria-expanded={open}
          className="ml-auto shrink-0 rounded-lg px-2 py-1 text-[13px] font-medium text-(--ink-muted) transition hover:bg-(--raised) hover:text-(--ink-body)"
        >
          {open ? t('cabecera.ocultar') : t('cabecera.detalles')}
        </button>
      </div>
      {open && <div className="mt-3">{children}</div>}
    </header>
  );
}

/**
 * What a tab shows when it has nothing to show.
 *
 * There were five copies of a single line — "No hay partidos próximos para X." —
 * and it is a dead end: it does not say whether that is normal, temporary, a
 * missing download or a permanent limitation, and it offers nothing to do. The WTA
 * tab is the case that made it obvious: zero players, zero matches, zero fixtures,
 * and the reader is told only that there are no upcoming matches, under a header
 * boasting 61,682 matches and 2,218 players.
 *
 * Two situations, and they deserve different words:
 *
 *   'sin-fuente'  — this competition has NO history in the database, so there is no
 *                   model and there never will be until a source is found. The
 *                   reason belongs on screen; it is not the reader's fault and not
 *                   something retrying fixes.
 *   'sin-partidos'— there IS a model, nothing is scheduled inside the window. Normal
 *                   between seasons, and it resolves itself.
 */
export function EmptySlate({
  what,
  reason,
  detail,
}: {
  what: string;
  reason: 'sin-fuente' | 'sin-partidos';
  detail?: ReactNode;
}) {
  const noSource = reason === 'sin-fuente';
  const { t } = useI18n();
  return (
    <div className="mb-6 rounded-xl border border-(--line) bg-(--tint) px-4 py-4">
      <p className="text-[15px] font-semibold text-(--ink-body)">
        {noSource ? t('vacioDeporte.sinModelo', { que: what }) : t('vacioDeporte.sinPartidos', { que: what })}
      </p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-(--ink-soft)">
        {noSource ? t('vacioDeporte.sinFuente', { que: what }) : t('vacioDeporte.listo')}
      </p>
      {detail && <div className="mt-2 text-[13px] leading-relaxed text-(--ink-muted)">{detail}</div>}
    </div>
  );
}

/**
 * POR QUÉ LAS CUOTAS SON DE DEMOSTRACIÓN, EN LA PANTALLA Y NO SOLO EN LA TERMINAL
 * ===========================================================================
 * La pestaña de tenis explicaba la causa desde hace tiempo; las otras cuatro solo
 * enseñaban la palabra «demostración». Y las cuatro causas piden cosas distintas:
 *
 *   sin_clave      falta ODDS_API_KEY. Se arregla poniéndola.
 *   fuente_falla   la clave está, pero el proveedor no contestó: cuota agotada, clave
 *                  inválida o sin red. Volver a poner la clave no arregla nada.
 *   sin_ligas      el proveedor contestó y no ofrece ninguna de las ligas configuradas.
 *                  Fuera de temporada es lo esperado; en temporada es que le cambió la
 *                  clave de deporte al proveedor.
 *   sin_eventos    se reconoció la liga y no había ni un partido con precio. Entre
 *                  jornadas es lo normal.
 *
 * Sin distinguirlas, el consejo por defecto —«pon tu clave»— es FALSO tres de cada
 * cuatro veces, y mandar a revisar una clave que ya está puesta gasta el tiempo donde
 * no está el problema. Esto ya pasó de verdad: con la clave puesta y funcionando, la
 * app seguía diciendo demo porque lo guardado se había descargado antes de ponerla, y
 * lo único que faltaba era volver a pedirlas.
 */
export function DemoOddsNote({
  reason,
  detail,
  hasKey,
  comando,
}: {
  reason: string | null | undefined;
  detail?: string | null;
  hasKey: boolean;
  /** El comando que refresca ESTE deporte, para no mandar a uno que no toca. */
  comando: string;
}) {
  const { t } = useI18n();
  const fuerte = (texto: string) => <strong className="text-(--ink-soft)">{texto}</strong>;
  const cuerpo =
    reason === 'sin_eventos' ? (
      conNodos(t('demo.sinEventos'), { noFalta: fuerte(t('demo.noFalta')) })
    ) : reason === 'sin_ligas' ? (
      conNodos(t('demo.sinLigas'), { si: <em>{t('demo.si')}</em>, ...CODIGOS })
    ) : reason === 'presupuesto' ? (
      <>
        {conNodos(t('demo.presupuesto'), { noEsperando: fuerte(t('demo.noEsperando')), ...CODIGOS })}
        {detail ? <span className="block opacity-70">{detail}</span> : null}
      </>
    ) : reason === 'fuente_falla' ? (
      <>
        {conNodos(t('demo.fuenteFalla'), { clavePuesta: fuerte(t('demo.clavePuesta')), ...CODIGOS })}
        {detail ? <span className="block opacity-70">{t('demo.ultimoError', { e: detail })}</span> : null}
      </>
    ) : reason === 'sin_clave' || !hasKey ? (
      conNodos(t('demo.sinClave'), CODIGOS)
    ) : (
      conNodos(t('demo.sinCausa'), { comando: <code>{comando}</code>, ...CODIGOS })
    );

  return (
    <p className="mb-4 text-[13px] leading-relaxed text-(--ink-muted)">
      {conNodos(t('demo.intro'), { demostracion: fuerte(t('demo.demostracion')), cuerpo: <>{cuerpo}</> })}
    </p>
  );
}

/**
 * La NFL no es un caso de esta nota y por eso NO la usa.
 *
 * Los otros cuatro deportes inventan cuotas cuando no las consiguen, así que «demo»
 * significa «estos precios no son de nadie». La NFL nunca inventa: si no hay línea, la
 * tarjeta sale sin precio y el partido SIGUE SIENDO REAL. Meterla en la misma nota diría
 * que sus partidos son inventados, que es peor que no decir nada.
 */
export function NflNoLineNote({
  reason,
  detail,
  hasKey,
}: {
  reason: string | null | undefined;
  detail?: string | null;
  /** null mientras no se sabe (D14: no se culpa a la clave sin saberlo). */
  hasKey: boolean | null;
}) {
  const { t } = useI18n();
  if (reason == null && hasKey !== false) return null;
  const cuerpo =
    reason === 'sin_ligas' ? (
      t('nflLinea.sinLigas')
    ) : reason === 'presupuesto' ? (
      conNodos(t('nflLinea.presupuesto'), CODIGOS)
    ) : reason === 'fuente_falla' ? (
      <>
        {conNodos(t('nflLinea.fuenteFalla'), CODIGOS)}
        {detail ? <span className="block opacity-70">{t('demo.ultimoError', { e: detail })}</span> : null}
      </>
    ) : reason === 'sin_clave' || hasKey === false ? (
      conNodos(t('nflLinea.sinClave'), CODIGOS)
    ) : (
      t('nflLinea.sinPublicar')
    );
  return <p className="mb-4 text-[13px] leading-relaxed text-(--ink-muted)">{conNodos(t('nflLinea.intro'), { cuerpo: <>{cuerpo}</> })}</p>;
}
