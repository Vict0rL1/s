import type { BbPrediction, BbTeamSide } from '../../lib/basketball';
import { formatDate } from '../../lib/format';
import { AWAY_COLOR, HOME_COLOR } from './GameCard';

function Num({ value, plus = false }: { value: number; plus?: boolean }) {
  const sign = plus && value > 0 ? '+' : '';
  const color = value > 0 ? 'text-lime-400' : value < 0 ? 'text-rose-400' : 'text-slate-400';
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
    <div className="relative h-3 w-full rounded bg-slate-700/50">
      <div className="absolute left-1/2 top-0 h-full w-px bg-slate-500" />
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
function describeRest(side: BbTeamSide): string {
  const d = side.daysRest;
  if (d == null) return '—';
  if (side.backToBack) return 'back-to-back (jugó ayer)';
  if (d < 7) return `${d} día(s)`;
  if (d < 60) return `${d} días sin jugar`;
  const months = Math.round(d / 30);
  if (months < 24) return `~${months} meses sin jugar`;
  const years = Math.round(d / 365);
  return years === 1 ? '~1 año sin jugar' : `~${years} años sin jugar`;
}

function LastGames({ side, color }: { side: BbTeamSide; color: string }) {
  if (side.last10.length === 0) return <span className="text-slate-500">—</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {side.last10.slice(0, 10).map((g, i) => (
        <span
          key={i}
          title={`${g.won ? 'Victoria' : 'Derrota'} ${g.pts}-${g.oppPts} ${g.home ? '(casa)' : '(fuera)'}`}
          className="inline-flex h-4 w-4 items-center justify-center rounded text-[10px] font-bold"
          style={{
            backgroundColor: g.won ? color : 'transparent',
            color: g.won ? '#0a0f1e' : '#f87171',
            border: g.won ? 'none' : '1px solid #f87171',
          }}
        >
          {g.won ? 'V' : 'D'}
        </span>
      ))}
    </span>
  );
}

/** Signal-by-signal breakdown, all in Elo points so the arithmetic is visible. */
export default function GameDetail({ prediction }: { prediction: BbPrediction }) {
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
    { label: 'Elo del equipo', home: Math.round(home.elo), away: Math.round(away.elo) },
    {
      label: 'Ajuste descanso',
      home: <Num value={home.restAdjustment} plus />,
      away: <Num value={away.restAdjustment} plus />,
    },
    { label: 'Rating ajustado', home: <strong>{homeAdj}</strong>, away: <strong>{awayAdj}</strong> },
    {
      label: prediction.neutral ? 'Ventaja de campo (neutral)' : 'Ventaja de campo',
      home: <Num value={homeCourt} plus />,
      away: 0,
    },
    {
      label: 'Prob. del modelo',
      home: <strong>{(prediction.model.probHome * 100).toFixed(1)}%</strong>,
      away: <strong>{(prediction.model.probAway * 100).toFixed(1)}%</strong>,
    },
  ];

  return (
    <div className="mt-4 space-y-5 border-t border-slate-700/60 pt-4 text-sm">
      {/* HOW SOLID — qualifies everything below, so it goes first */}
      <ReliabilityBlock prediction={prediction} />

      {/* WHY */}
      <div className="rounded-lg bg-slate-800/50 p-3">
        <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">Por qué</div>
        <p className="mb-3 text-slate-300">{reasoning.text}</p>
        <div className="space-y-2">
          {reasoning.factors.map((f) => (
            <div key={f.key} className="grid grid-cols-[8rem_1fr_3rem] items-center gap-2">
              <span className="text-xs text-slate-400">{f.label}</span>
              <FactorBar points={f.pointsForHome} max={maxFactor} />
              <span
                className="text-right text-xs tabular-nums"
                style={{ color: f.pointsForHome >= 0 ? HOME_COLOR : AWAY_COLOR }}
              >
                {f.pointsForHome > 0 ? '+' : ''}
                {f.pointsForHome}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between text-[10px] text-slate-500">
          <span>◀ ventaja {away.name}</span>
          <span>ventaja {home.name} ▶</span>
        </div>
      </div>

      {/* Numbers table */}
      <div className="grid grid-cols-[1fr_auto_auto] gap-2">
        <div className="text-slate-400">Señal</div>
        <div className="w-24 text-right font-semibold" style={{ color: AWAY_COLOR }}>
          {away.name}
          <span className="ml-1 text-xs font-normal text-slate-500">#{away.eloRank}</span>
        </div>
        <div className="w-24 text-right font-semibold" style={{ color: HOME_COLOR }}>
          {home.name}
          <span className="ml-1 text-xs font-normal text-slate-500">#{home.eloRank}</span>
        </div>
      </div>
      {rows.map((r) => (
        <div key={r.label} className="-my-2 grid grid-cols-[1fr_auto_auto] gap-2">
          <div className="text-slate-400">{r.label}</div>
          <div className="w-24 text-right tabular-nums">{r.away}</div>
          <div className="w-24 text-right tabular-nums">{r.home}</div>
        </div>
      ))}

      {/* Score projection */}
      <div className="rounded-lg bg-slate-800/50 p-3">
        <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">
          Marcador y diferencia estimados
        </div>
        {projection.home != null && projection.away != null ? (
          <p className="text-slate-200">
            <span style={{ color: AWAY_COLOR }}>{away.name}</span>{' '}
            <strong className="tabular-nums">{Math.round(projection.away)}</strong>
            {' – '}
            <strong className="tabular-nums">{Math.round(projection.home)}</strong>{' '}
            <span style={{ color: HOME_COLOR }}>{home.name}</span>
            <span className="text-slate-400">
              {' '}
              · total {Math.round(projection.total ?? 0)} · {projection.spreadLabel}
            </span>
          </p>
        ) : (
          <p className="text-slate-400">
            Sin medias de puntos suficientes para estimar el marcador; la diferencia esperada es{' '}
            {projection.spreadLabel}.
          </p>
        )}
        <p className="mt-2 text-xs text-slate-500">
          La diferencia sale de la brecha de Elo (~28 puntos de Elo = 1 punto de margen). En el
          backtest sobre 37.000 partidos reales el error absoluto medio fue de <strong>9,2
          puntos</strong> con sesgo cero: es un centro fiable, pero el rango es ancho. El total se
          estima con las medias de anotar y recibir de ambos equipos, y no es un modelo de ritmo.
        </p>
      </div>

      {/* Scoring rates */}
      <div className="rounded-lg bg-slate-800/50 p-3">
        <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">
          Anotación (medias recientes)
        </div>
        <div className="grid grid-cols-[1fr_auto_auto] gap-2 text-xs">
          <div />
          <div className="w-20 text-right" style={{ color: AWAY_COLOR }}>
            {away.abbreviation ?? away.name}
          </div>
          <div className="w-20 text-right" style={{ color: HOME_COLOR }}>
            {home.abbreviation ?? home.name}
          </div>
          <div className="text-slate-400">Puntos por partido</div>
          <div className="w-20 text-right tabular-nums">{away.ppg ?? '—'}</div>
          <div className="w-20 text-right tabular-nums">{home.ppg ?? '—'}</div>
          <div className="text-slate-400">Puntos recibidos</div>
          <div className="w-20 text-right tabular-nums">{away.papg ?? '—'}</div>
          <div className="w-20 text-right tabular-nums">{home.papg ?? '—'}</div>
        </div>
      </div>

      {/* Form + venue records */}
      <div className="rounded-lg bg-slate-800/50 p-3">
        <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">
          Forma y balance por cancha
        </div>
        <div className="grid grid-cols-2 gap-4">
          {[
            { side: away, color: AWAY_COLOR, venue: 'fuera' },
            { side: home, color: HOME_COLOR, venue: 'en casa' },
          ].map(({ side, color, venue }) => (
            <div key={side.id}>
              <div className="truncate font-semibold" style={{ color }} title={side.name}>
                {side.name}
              </div>
              <div className="mt-1">
                <LastGames side={side} color={color} />
              </div>
              <div className="mt-1 text-xs text-slate-400">
                Global {side.record.wins}–{side.record.losses} · {venue}{' '}
                {side.venueRecord.wins}–{side.venueRecord.losses}
              </div>
              <div className="text-xs text-slate-400">
                Descanso: {describeRest(side)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Head to head */}
      <div className="rounded-lg bg-slate-800/50 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs uppercase tracking-wide text-slate-500">Historial directo</span>
          <span className="text-sm">
            <span style={{ color: HOME_COLOR }}>{h2h.homeWins}</span>
            <span className="text-slate-500"> – </span>
            <span style={{ color: AWAY_COLOR }}>{h2h.awayWins}</span>
            <span className="ml-2 text-slate-500">({h2h.total} partidos)</span>
          </span>
        </div>
        {h2h.recentSeasons && (
          <p className="mb-2 text-xs text-slate-400">
            Últimas {h2h.recentSeasons.seasons} temporadas: {home.name}{' '}
            {h2h.recentSeasons.homeWins}–{h2h.recentSeasons.awayWins} {away.name}. Es la ventana
            informativa: un historial de décadas describe a otros jugadores.
          </p>
        )}
        {h2h.recent.length === 0 ? (
          <p className="text-slate-400">Sin enfrentamientos previos.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {h2h.recent.map((m, i) => (
              <li key={i} className="flex items-center justify-between gap-2 text-slate-300">
                <span className="text-slate-500">{formatDate(m.date)}</span>
                <span className="truncate">
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
      <div className="rounded-lg bg-slate-800/50 p-3 text-xs">
        <div className="mb-2 uppercase tracking-wide text-slate-500">Mercado</div>
        {market.market ? (
          <>
            <p className="text-slate-300">
              Cuotas: {market.market.odds2} ({away.name}) / {market.market.odds1} ({home.name}) ·
              implícitas sin vig: {(market.market.implied2 * 100).toFixed(1)}% /{' '}
              {(market.market.implied1 * 100).toFixed(1)}% · margen de la casa{' '}
              {((market.market.overround - 1) * 100).toFixed(1)}%
            </p>
            {market.edge1 != null && (
              <p className="mt-1 text-slate-400">
                Diferencia del modelo respecto al mercado (local):{' '}
                <Num value={Math.round(market.edge1 * 1000) / 10} plus /> pp
              </p>
            )}
          </>
        ) : (
          <p className="text-slate-400">Sin cuotas para este partido.</p>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-slate-500">{prediction.disclaimer}</p>
    </div>
  );
}

/**
 * How much evidence sits behind the probability. First in the breakdown because it
 * qualifies every figure below it.
 */
function ReliabilityBlock({ prediction }: { prediction: BbPrediction }) {
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
      <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">
        Cuánta confianza merece este número
      </div>
      <p className="text-slate-200">
        <strong className="capitalize">{rel.label}</strong> — {favName} entre{' '}
        <strong className="tabular-nums">{(lo * 100).toFixed(1)}%</strong> y{' '}
        <strong className="tabular-nums">{(hi * 100).toFixed(1)}%</strong>{' '}
        <span className="text-slate-400">(±{rel.marginPp} pp)</span>
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded bg-slate-900/50 p-2">
          <div className="truncate text-slate-400">{prediction.teams.away.name}</div>
          <div className="tabular-nums text-slate-200">{rel.gamesBehind.away} partidos</div>
        </div>
        <div className="rounded bg-slate-900/50 p-2">
          <div className="truncate text-slate-400">{prediction.teams.home.name}</div>
          <div className="tabular-nums text-slate-200">{rel.gamesBehind.home} partidos</div>
        </div>
      </div>
      {rel.reasons.length > 0 && (
        <ul className="mt-2 space-y-1">
          {rel.reasons.map((r, i) => (
            <li key={i} className="flex gap-2 text-xs text-slate-300">
              <span className="text-slate-600">•</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
