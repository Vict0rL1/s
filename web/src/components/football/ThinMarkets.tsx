/**
 * Los mercados de menos liquidez: mitades, córners, tarjetas y props de jugador.
 *
 * ===========================================================================
 * POR QUÉ ESTÁN EN SU PROPIO PANEL Y NO MEZCLADOS CON LOS DEMÁS
 * ===========================================================================
 * Porque no son igual de buenos y presentarlos igual sería mentir por omisión.
 *
 *   · El 1X2 del partido está calibrado dentro de 1,5 pp. Las mitades andan por 2-3 pp,
 *     medido sobre 3.634 partidos que el ajuste no vio. Es mucho mejor que el modelo de
 *     mitades anterior (que llegaba a 8,35 pp y por eso no se publicaba) y sigue siendo
 *     peor que el del partido. Cada mercado lleva su error medido al lado.
 *
 *   · Y varios los cotizan dos o tres casas con un margen del 15 %. Ahí una ventaja
 *     aparente sale más veces del precio malo que del acierto, así que el umbral que hay
 *     que exigirles es mayor — y el panel lo dice en puntos, no en adjetivos.
 *
 * La tentación con estos mercados es la contraria: «aquí las casas se equivocan más».
 * Puede ser verdad y esta app no lo ha medido, así que no lo afirma.
 */
import type { FbPrediction } from '../../lib/football';
import { Panel, SectionTitle } from '../ui';
import { pct } from '../../lib/theme';
import { conNodos, localeDe, useI18n, type Clave } from '../../i18n';
import { num as numF } from '../../lib/formato';

const DEPTH_STYLE: Record<string, string> = {
  profundo: 'text-emerald-300/90',
  medio: 'text-sky-300/90',
  fino: 'text-amber-300/90',
  'muy-fino': 'text-rose-300/90',
};

const DEPTH_LABEL: Record<string, Clave> = {
  profundo: 'tm.muchas',
  medio: 'tm.bastantes',
  fino: 'tm.pocas',
  'muy-fino': 'tm.muyPocas',
};

/** «+2,7 pp» significa que en realidad pasa más de lo que dice el número. */
function Calibration({ pp }: { pp: number | undefined }): React.ReactElement | null {
  const { t } = useI18n();
  if (pp === undefined) return null;
  const strong = Math.abs(pp) >= 2;
  return (
    <span className={`ml-1.5 text-[11px] ${strong ? 'text-amber-300/80' : 'text-(--ink-muted)'}`}>
      {t('tm.medido', { pp: `${pp >= 0 ? '+' : ''}${numF(pp, 1)}` })}
    </span>
  );
}

function Row({
  label,
  value,
  calibration,
  sub,
}: {
  label: string;
  value: string;
  calibration?: number;
  sub?: string;
}): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="text-[13px] text-(--ink-body)">
        {label}
        <Calibration pp={calibration} />
        {sub && <span className="ml-1.5 text-[11px] text-(--ink-muted)">{sub}</span>}
      </span>
      <span className="text-[13px] font-medium tabular-nums text-(--ink-strong)">{value}</span>
    </div>
  );
}

export default function ThinMarkets({
  prediction,
}: {
  prediction: FbPrediction;
}): React.ReactElement | null {
  const { t, idioma } = useI18n();
  const thin = prediction.thin;
  if (!thin) return null;
  const { halves, corners, cards, players, liquidity } = thin;
  const nothing = !halves && !corners && !cards && players.length === 0;
  if (nothing) return null;

  const home = prediction.teams.home.name;
  const away = prediction.teams.away.name;

  return (
    <Panel>
      <SectionTitle right={t('tm.nMercados', { n: liquidity.length })}>{t('tm.titulo')}</SectionTitle>
      <p className="mb-3 text-[13px] leading-relaxed text-(--ink-soft)">
        {conNodos(
          t('tm.intro', {
            n: halves ? halves.calibrationMatches.toLocaleString(localeDe(idioma)) : idioma === 'es' ? '3.634' : '3,634',
          }),
          { ejemplo: <span className="text-amber-300/90">{t('tm.ejemplo')}</span> },
        )}
      </p>

      {halves && (
        <div className="mb-3">
          <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-(--ink-soft)">
            {t('tm.mitades')}
          </h4>
          <Row
            label={t('tm.htLocal')}
            value={pct(halves.htHome)}
            calibration={halves.calibration['descanso-1']}
          />
          <Row
            label={t('tm.htEmpate')}
            value={pct(halves.htDraw)}
            calibration={halves.calibration['descanso-X']}
          />
          <Row
            label={t('tm.htVisitante')}
            value={pct(halves.htAway)}
            calibration={halves.calibration['descanso-2']}
          />
          <Row
            label={t('tm.htMas05')}
            value={pct(halves.htOver05)}
            calibration={halves.calibration['descanso-over-0.5']}
          />
          <Row
            label={t('tm.htMas15')}
            value={pct(halves.htOver15)}
            calibration={halves.calibration['descanso-over-1.5']}
          />
          <Row
            label={t('tm.ganaMitad', { equipo: home })}
            value={pct(halves.homeWinsAHalf)}
            calibration={halves.calibration['local-gana-una-mitad']}
          />
          <Row
            label={t('tm.ganaMitad', { equipo: away })}
            value={pct(halves.awayWinsAHalf)}
            calibration={halves.calibration['visitante-gana-una-mitad']}
          />
          <p className="mt-1 text-[12px] text-(--ink-muted)">
            {t('tm.golesMitades', { a: numF(halves.expected.first, 2), b: numF(halves.expected.second, 2) })}
          </p>
        </div>
      )}

      {(corners || cards) && (
        <div className="mb-3">
          <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-(--ink-soft)">
            {t('tm.cornersTarjetas')}
          </h4>
          {[corners, cards].map(
            (c) =>
              c && (
                <div key={c.market} className="mb-1.5">
                  <Row
                    label={c.market === 'corners' ? t('tm.cornersEsp') : t('tm.tarjetasEsp')}
                    value={numF(c.total, 1)}
                    sub={t('tm.varMedia', { dist: c.distribution === 'negbin' ? t('tm.binNeg') : 'Poisson', d: numF(c.dispersion, 2) })}
                  />
                  {c.lines.map((l) => (
                    <Row key={l.line} label={t('pm.masDe', { linea: l.line })} value={pct(l.over)} />
                  ))}
                </div>
              ),
          )}
        </div>
      )}

      {!corners && !cards && (
        <p className="mb-3 text-[12px] leading-relaxed text-(--ink-muted)">
          <span className="font-medium text-(--ink-soft)">{t('tm.sinDatosTitulo')}</span>{' '}
          {t('tm.sinDatosCuerpo')}
        </p>
      )}

      {players.length > 0 && (
        <div className="mb-3">
          <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-(--ink-soft)">
            {t('tm.props')}
          </h4>
          <div className="overflow-x-auto" tabIndex={0}>
            <table className="w-full text-[12px] tabular-nums">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-(--ink-muted)">
                  <th className="text-left font-medium">{t('tm.jugador')}</th>
                  <th className="text-right font-medium">{t('tm.min')}</th>
                  <th className="text-right font-medium">{t('tm.noJuega')}</th>
                  <th className="text-right font-medium">{t('tm.marca')}</th>
                  <th className="text-right font-medium">{t('tm.golAsist')}</th>
                  <th className="text-right font-medium">{t('tm.tarjeta')}</th>
                </tr>
              </thead>
              <tbody>
                {players.map((p) => (
                  <tr key={p.playerId}>
                    <td className="py-0.5 text-(--ink-body)">
                      {p.name}
                      <span className="ml-1 text-[10px] text-(--ink-muted)">{p.position}</span>
                    </td>
                    <td className="py-0.5 text-right text-(--ink-soft)">
                      {numF(p.minutes.expected, 0)}
                    </td>
                    <td className="py-0.5 text-right text-(--ink-soft)">
                      {pct(p.minutes.pDidNotPlay)}
                    </td>
                    <td className="py-0.5 text-right text-(--ink-strong)">{pct(p.goals.atLeastOne)}</td>
                    <td className="py-0.5 text-right font-medium text-(--ink-strong)">
                      {pct(p.goalOrAssist)}
                    </td>
                    <td className="py-0.5 text-right text-(--ink-soft)">{pct(p.cards.atLeastOne)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-(--ink-muted)">
            {conNodos(t('tm.propsExplica'), { distribucion: <span className="text-(--ink-soft)">{t('tm.distribucion')}</span> })}
            {players[0] && players[0].teamMatches < 5 && (
              <>
                {' '}
                {t(players[0].teamMatches === 1 ? 'tm.titularidad1' : 'tm.titularidadN', { n: players[0].teamMatches })}
              </>
            )}
          </p>
        </div>
      )}

      <div className="mt-3 border-t border-slate-700/50 pt-2">
        <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-(--ink-soft)">
          {t('tm.ventaja')}
        </h4>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5">
          {liquidity.map((l) => (
            <span key={l.key} className="text-[12px] text-(--ink-soft)">
              {l.label}{' '}
              <span className={DEPTH_STYLE[l.depth] ?? 'text-(--ink-soft)'}>
                {DEPTH_LABEL[l.depth] ? t(DEPTH_LABEL[l.depth]) : undefined}
              </span>{' '}
              <span className="tabular-nums text-(--ink-body)">
                ≥{numF(l.minEdge * 100, 0)} pp
              </span>
            </span>
          ))}
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-(--ink-muted)">
          {t('tm.umbral')}
        </p>
      </div>
    </Panel>
  );
}
