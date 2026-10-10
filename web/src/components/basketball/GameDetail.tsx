import type { BbPrediction, BbTeamSide } from '../../lib/basketball';
import { formatDate } from '../../lib/format';
import { AWAY_COLOR, HOME_COLOR } from '../../lib/theme';
import { conNodos, useI18n, type Traducir } from '../../i18n';
import { pct as pctF, num as numF } from '../../lib/formato';

function Num({ value, plus = false }: { value: number; plus?: boolean }) {
  const sign = plus && value > 0 ? '+' : '';
  const color = value > 0 ? 'text-emerald-400' : value < 0 ? 'text-rose-400' : 'text-(--ink-soft)';
  return (
    <span className={color}>
      {sign}
      {value}
    </span>
  );
}

/** Diverging bar: right = favours the home team, left = the away team. */
function FactorBar({ points, max }: { points: number; max: number }) {
  const frac = Math.max(-1, Math.min(1, points / max));
  const width = Math.abs(frac) * 50;
  return (
    <div className="relative h-3 w-full rounded bg-(--raised)">
      <div className="absolute left-1/2 top-0 h-full w-px bg-white/20" />
      <div
        className="absolute top-0 h-full rounded"
        style={
          frac >= 0
            ? { left: '50%', width: `${width}%`, backgroundColor: HOME_COLOR }
            : { right: '50%', width: `${width}%`, backgroundColor: AWAY_COLOR }
        }
      />
    </div>
  );
}

/**
 * Days of rest in words. Past a week it stops meaning "rested" and starts meaning
 * the results simply end there, so it is phrased as a gap rather than an
 * advantage — "4109 día(s)" is true and useless.
 */
function describeRest(side: BbTeamSide, t: Traducir): string {
  const d = side.daysRest;
  if (d == null) return '—';
  if (side.backToBack) return t('bkd.b2b');
  if (d < 7) return t('bkd.dias', { n: d });
  if (d < 60) return t('bkd.diasSin', { n: d });
  const months = Math.round(d / 30);
  if (months < 24) return t('bkd.mesesSin', { n: months });
  const years = Math.round(d / 365);
  return years === 1 ? t('bkd.unAnio') : t('bkd.aniosSin', { n: years });
}

function LastGames({ side, color }: { side: BbTeamSide; color: string }) {
  const { t } = useI18n();
  if (side.last10.length === 0) return <span className="text-(--ink-muted)">—</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {side.last10.slice(0, 10).map((g, i) => (
        <span
          key={i}
          title={`${g.won ? t('bkd.victoria') : t('bkd.derrota')} ${g.pts}-${g.oppPts} ${g.home ? t('bkd.casa') : t('bkd.fuera')}`}
          className="inline-flex h-4 w-4 items-center justify-center rounded text-[11px] font-bold"
          style={{
            backgroundColor: g.won ? color : 'transparent',
            color: g.won ? '#0a0f1e' : 'var(--status-critical)',
            border: g.won ? 'none' : '1px solid var(--status-critical)',
          }}
        >
          {g.won ? t('bkd.v') : t('bkd.d')}
        </span>
      ))}
    </span>
  );
}

/** Signal-by-signal breakdown, all in Elo points so the arithmetic is visible. */
export default function GameDetail({ prediction }: { prediction: BbPrediction }) {
  const { t } = useI18n();
  const { teams, reasoning, projection, h2h, market } = prediction;
  const home = teams.home;
  const away = teams.away;
  const maxFactor = Math.max(60, ...reasoning.factors.map((f) => Math.abs(f.pointsForHome)));

  // The rows must add up to the rating actually used, or the "auditable" claim is
  // empty: Elo + rest + home court = the number behind the probability.
  const homeAdj = Math.round((home.elo + home.restAdjustment) * 10) / 10;
  const awayAdj = Math.round((away.elo + away.restAdjustment) * 10) / 10;
  const homeCourt = prediction.neutral ? 0 : 100;

  const rows: { label: string; home: React.ReactNode; away: React.ReactNode }[] = [
    { label: t('bkd.eloEquipo'), home: Math.round(home.elo), away: Math.round(away.elo) },
    {
      label: t('bkd.ajusteDescanso'),
      home: <Num value={home.restAdjustment} plus />,
      away: <Num value={away.restAdjustment} plus />,
    },
    { label: t('det.ratingAjustado'), home: <strong>{homeAdj}</strong>, away: <strong>{awayAdj}</strong> },
    {
      label: prediction.neutral ? t('bkd.ventajaCampoNeutral') : t('bkd.ventajaCampo'),
      home: <Num value={homeCourt} plus />,
      away: 0,
    },
    {
      label: t('det.probModelo'),
      home: <strong>{pctF(prediction.model.probHome, 1)}</strong>,
      away: <strong>{pctF(prediction.model.probAway, 1)}</strong>,
    },
  ];

  return (
    <div className="mt-4 space-y-5 border-t border-(--line) pt-4 text-[16px]">
      {/* HOW SOLID — qualifies everything below, so it goes first */}
      <ReliabilityBlock prediction={prediction} />

      {/* WHY */}
      <div className="rounded-lg bg-(--raised) p-3">
        <div className="mb-2 text-[14px] uppercase tracking-wide text-(--ink-muted)">{t('det.porQue')}</div>
        <p className="mb-3 text-(--ink-body)">{reasoning.text}</p>
        <div className="space-y-2">
          {reasoning.factors.map((f) => (
            <div key={f.key} className="grid grid-cols-[8rem_1fr_3rem] items-center gap-2">
              <span className="text-[14px] text-(--ink-soft)">{f.label}</span>
              <FactorBar points={f.pointsForHome} max={maxFactor} />
              <span className="text-right text-[14px] tabular-nums text-(--ink-body)">
                {f.pointsForHome > 0 ? '+' : ''}
                {f.pointsForHome}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between text-[11px] text-(--ink-muted)">
          <span>{t('bkd.ventajaIzq', { equipo: away.name })}</span>
          <span>{t('bkd.ventajaDer', { equipo: home.name })}</span>
        </div>
      </div>

      {/* Numbers table */}
      <div className="grid grid-cols-[1fr_auto_auto] gap-2">
        <div className="text-(--ink-soft)">{t('det.senal')}</div>
        <div className="w-24 text-right font-semibold" style={{ color: AWAY_COLOR }}>
          {away.name}
          <span className="ml-1 text-[14px] font-normal text-(--ink-muted)">#{away.eloRank}</span>
        </div>
        <div className="w-24 text-right font-semibold" style={{ color: HOME_COLOR }}>
          {home.name}
          <span className="ml-1 text-[14px] font-normal text-(--ink-muted)">#{home.eloRank}</span>
        </div>
      </div>
      {rows.map((r) => (
        <div key={r.label} className="-my-2 grid grid-cols-[1fr_auto_auto] gap-2">
          <div className="text-(--ink-soft)">{r.label}</div>
          <div className="w-24 text-right tabular-nums">{r.away}</div>
          <div className="w-24 text-right tabular-nums">{r.home}</div>
        </div>
      ))}

      {/* Score projection */}
      <div className="rounded-lg bg-(--raised) p-3">
        <div className="mb-2 text-[14px] uppercase tracking-wide text-(--ink-muted)">
          {t('bkd.marcadorEstimado')}
        </div>
        {projection.home != null && projection.away != null ? (
          <p className="text-(--ink-body)">
            <span style={{ color: AWAY_COLOR }}>{away.name}</span>{' '}
            <strong className="tabular-nums">{Math.round(projection.away)}</strong>
            {' – '}
            <strong className="tabular-nums">{Math.round(projection.home)}</strong>{' '}
            <span style={{ color: HOME_COLOR }}>{home.name}</span>
            <span className="text-(--ink-soft)">
              {' '}
              {t('bkd.totalSpread', { n: Math.round(projection.total ?? 0), spread: projection.spreadLabel })}
            </span>
          </p>
        ) : (
          <p className="text-(--ink-soft)">
            {t('bkd.sinMedias', { spread: projection.spreadLabel })}
          </p>
        )}
        <p className="mt-2 text-[14px] text-(--ink-muted)">
          {conNodos(t('bkd.brecha'), { mae: <strong>{t('bkd.mae')}</strong> })}
        </p>
      </div>

      {/* Scoring rates */}
      <div className="rounded-lg bg-(--raised) p-3">
        <div className="mb-2 text-[14px] uppercase tracking-wide text-(--ink-muted)">
          {t('bkd.anotacion')}
        </div>
        <div className="grid grid-cols-[1fr_auto_auto] gap-2 text-[14px]">
          <div />
          <div className="w-20 text-right" style={{ color: AWAY_COLOR }}>
            {away.abbreviation ?? away.name}
          </div>
          <div className="w-20 text-right" style={{ color: HOME_COLOR }}>
            {home.abbreviation ?? home.name}
          </div>
          <div className="text-(--ink-soft)">{t('bkd.puntosPartido')}</div>
          <div className="w-20 text-right tabular-nums">{away.ppg ?? '—'}</div>
          <div className="w-20 text-right tabular-nums">{home.ppg ?? '—'}</div>
          <div className="text-(--ink-soft)">{t('bkd.puntosRecibidos')}</div>
          <div className="w-20 text-right tabular-nums">{away.papg ?? '—'}</div>
          <div className="w-20 text-right tabular-nums">{home.papg ?? '—'}</div>
        </div>
      </div>

      {/* Form + venue records */}
      <div className="rounded-lg bg-(--raised) p-3">
        <div className="mb-2 text-[14px] uppercase tracking-wide text-(--ink-muted)">
          {t('bkd.formaBalance')}
        </div>
        <div className="grid grid-cols-2 gap-4">
          {[
            { side: away, color: AWAY_COLOR, venue: t('bkd.venueFuera') },
            { side: home, color: HOME_COLOR, venue: t('bkd.venueCasa') },
          ].map(({ side, color, venue }) => (
            <div key={side.id}>
              <div className="break-words font-semibold" style={{ color }} title={side.name}>
                {side.name}
              </div>
              <div className="mt-1">
                <LastGames side={side} color={color} />
              </div>
              <div className="mt-1 text-[14px] text-(--ink-soft)">
                {t('bkd.global', { w: side.record.wins, l: side.record.losses, venue, vw: side.venueRecord.wins, vl: side.venueRecord.losses })}
              </div>
              <div className="text-[14px] text-(--ink-soft)">
                {t('bkd.descanso', { d: describeRest(side, t) })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Head to head */}
      <div className="rounded-lg bg-(--raised) p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[14px] uppercase tracking-wide text-(--ink-muted)">{t('eq.historialDirecto')}</span>
          <span className="text-[16px]">
            <span style={{ color: HOME_COLOR }}>{h2h.homeWins}</span>
            <span className="text-(--ink-muted)"> – </span>
            <span style={{ color: AWAY_COLOR }}>{h2h.awayWins}</span>
            <span className="ml-2 text-(--ink-muted)">{t('bkd.nPartidos', { n: h2h.total })}</span>
          </span>
        </div>
        {h2h.recentSeasons && (
          <p className="mb-2 text-[14px] text-(--ink-soft)">
            {t('bkd.ultimasTemporadas', {
              n: h2h.recentSeasons.seasons,
              local: home.name,
              a: h2h.recentSeasons.homeWins,
              b: h2h.recentSeasons.awayWins,
              visitante: away.name,
            })}
          </p>
        )}
        {h2h.recent.length === 0 ? (
          <p className="text-(--ink-soft)">{t('det.sinEnfrentamientos')}</p>
        ) : (
          <ul className="space-y-1 text-[14px]">
            {h2h.recent.map((m, i) => (
              <li key={i} className="flex items-center justify-between gap-2 text-(--ink-body)">
                <span className="text-(--ink-muted)">{formatDate(m.date)}</span>
                <span className="break-words">
                  {m.awayId === away.id ? away.name : home.name} {m.awayPts} @{' '}
                  {m.homeId === home.id ? home.name : away.name} {m.homePts}
                  {m.isPlayoff && <span className="ml-1 text-amber-400">playoff</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Market */}
      <div className="rounded-lg bg-(--raised) p-3 text-[14px]">
        <div className="mb-2 uppercase tracking-wide text-(--ink-muted)">{t('eq.mercado')}</div>
        {market.market ? (
          <>
            <p className="text-(--ink-body)">
              {t('bkd.cuotas', {
                o2: market.market.odds2,
                visitante: away.name,
                o1: market.market.odds1,
                local: home.name,
                p2: numF(market.market.implied2 * 100, 1),
                p1: numF(market.market.implied1 * 100, 1),
                m: numF((market.market.overround - 1) * 100, 1),
              })}
            </p>
            {market.edge1 != null && (
              <p className="mt-1 text-(--ink-soft)">
                {conNodos(t('bkd.diferenciaModelo'), { n: <Num value={Math.round(market.edge1 * 1000) / 10} plus /> })}
              </p>
            )}
          </>
        ) : (
          <p className="text-(--ink-soft)">{t('bkd.sinCuotas')}</p>
        )}
      </div>

      <p className="text-[13px] leading-relaxed text-(--ink-muted)">{prediction.disclaimer}</p>
    </div>
  );
}

/**
 * How much evidence sits behind the probability. First in the breakdown because it
 * qualifies every figure below it.
 */
function ReliabilityBlock({ prediction }: { prediction: BbPrediction }) {
  const { t } = useI18n();
  const rel = prediction.reliability;
  const favIsHome = prediction.model.probHome >= 0.5;
  const favProb = favIsHome ? prediction.model.probHome : prediction.model.probAway;
  const favName = favIsHome ? prediction.teams.home.name : prediction.teams.away.name;
  const lo = Math.max(0, favProb - rel.marginPp / 100);
  const hi = Math.min(1, favProb + rel.marginPp / 100);

  const tone =
    rel.level === 'high'
      ? 'border-emerald-700/50 bg-emerald-950/30'
      : rel.level === 'medium'
        ? 'border-amber-700/50 bg-amber-950/30'
        : 'border-rose-700/50 bg-rose-950/30';

  return (
    <div className={`rounded-lg border p-3 ${tone}`}>
      <div className="mb-2 text-[14px] uppercase tracking-wide text-(--ink-muted)">
        {t('bkd.cuantaConfianza')}
      </div>
      <p className="text-(--ink-body)">
        <strong className="capitalize">{rel.label}</strong>{' '}
        {conNodos(t('bkd.entre', { equipo: favName }), {
          lo: <strong className="tabular-nums">{pctF(lo, 1)}</strong>,
          hi: <strong className="tabular-nums">{pctF(hi, 1)}</strong>,
        })}{' '}
        <span className="text-(--ink-soft)">(±{numF(rel.marginPp, 1)} pp)</span>
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[14px]">
        <div className="min-w-0">
          <div className="break-words text-(--ink-soft)">{prediction.teams.away.name}</div>
          <div className="tabular-nums text-(--ink-body)">{t('bkd.partidosN', { n: rel.gamesBehind.away })}</div>
        </div>
        <div className="min-w-0">
          <div className="break-words text-(--ink-soft)">{prediction.teams.home.name}</div>
          <div className="tabular-nums text-(--ink-body)">{t('bkd.partidosN', { n: rel.gamesBehind.home })}</div>
        </div>
      </div>
      {rel.reasons.length > 0 && (
        <ul className="mt-2 space-y-1">
          {rel.reasons.map((r, i) => (
            <li key={i} className="flex gap-2 text-[14px] text-(--ink-body)">
              <span className="text-(--ink-faint)">•</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
