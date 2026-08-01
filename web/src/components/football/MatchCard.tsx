import { useState } from 'react';
import type { FbFixtureWithPrediction, FbPrediction, FbReliability } from '../../lib/football';
import { formatDateTime, formatDate } from '../../lib/format';

export const HOME_COLOR = '#a3e635'; // lime
export const DRAW_COLOR = '#94a3b8'; // slate — the draw needs a colour of its own
export const AWAY_COLOR = '#38bdf8'; // sky

const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

export default function MatchCard({
  item,
  onOpenTeam,
}: {
  item: FbFixtureWithPrediction;
  onOpenTeam: (league: string, id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { fixture, prediction, marketOnly, teams } = item;

  const probs = prediction?.model ?? marketOnly ?? null;
  const fromModel = !!prediction;

  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-800/40 p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between text-xs text-slate-400">
        <span>{formatDateTime(fixture.commence_time)}</span>
        {fixture.source === 'fixture' && (
          <span className="rounded bg-amber-900/40 px-2 py-0.5 text-amber-300">partido demo</span>
        )}
      </div>

      {/* Home vs Away — football is written home-first */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <TeamName
          name={prediction?.teams.home.name ?? fixture.home_name}
          color={HOME_COLOR}
          elo={prediction?.teams.home.elo ?? teams.home?.elo ?? null}
          eloRank={prediction?.teams.home.eloRank ?? teams.home?.eloRank ?? null}
          odds={fixture.odds_home}
          homeBadge
          onClick={fixture.home_id ? () => onOpenTeam(fixture.league, fixture.home_id!) : undefined}
        />
        <span className="px-2 pt-1 text-xs text-slate-500">vs</span>
        <TeamName
          name={prediction?.teams.away.name ?? fixture.away_name}
          color={AWAY_COLOR}
          elo={prediction?.teams.away.elo ?? teams.away?.elo ?? null}
          eloRank={prediction?.teams.away.eloRank ?? teams.away?.eloRank ?? null}
          odds={fixture.odds_away}
          alignRight
          onClick={fixture.away_id ? () => onOpenTeam(fixture.league, fixture.away_id!) : undefined}
        />
      </div>

      {probs ? (
        <>
          {/* 1X2 — three outcomes, so the draw gets equal billing */}
          <div className="grid grid-cols-3 gap-2 text-center">
            <Outcome label="1" sub="Local" value={probs.home} color={HOME_COLOR} odds={fixture.odds_home} />
            <Outcome label="X" sub="Empate" value={probs.draw} color={DRAW_COLOR} odds={fixture.odds_draw} />
            <Outcome label="2" sub="Visitante" value={probs.away} color={AWAY_COLOR} odds={fixture.odds_away} />
          </div>
          {!fromModel && (
            <p className="mt-2 text-center text-[11px] text-amber-400">
              Probabilidades implícitas del mercado, no del modelo.
            </p>
          )}
          <Bar probs={probs} />

          {prediction && (
            <>
              {/* Goals markets, all derived from the same distribution */}
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <Figure
                  label="Goles"
                  value={`${prediction.goals.expectedHome} – ${prediction.goals.expectedAway}`}
                  hint={`total ${prediction.goals.expectedTotal}`}
                />
                <Figure
                  label="+2.5 goles"
                  value={pct(prediction.goals.over25)}
                  hint={`−2.5: ${pct(prediction.goals.under25)}`}
                />
                <Figure
                  label="Ambos marcan"
                  value={pct(prediction.goals.bothScore)}
                  hint={`no: ${pct(1 - prediction.goals.bothScore)}`}
                />
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm">
                  {prediction.verdict.open ? (
                    <span className="text-slate-300">
                      Partido abierto —{' '}
                      <strong className="text-slate-100">{prediction.verdict.label}</strong> es solo
                      el más probable ({pct(prediction.verdict.probability)})
                    </span>
                  ) : (
                    <span>
                      Más probable:{' '}
                      <strong className="text-slate-100">{prediction.verdict.label}</strong>{' '}
                      <span className="text-slate-400">({pct(prediction.verdict.probability)})</span>
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <ReliabilityBadge reliability={prediction.reliability} />
                  {prediction.market.verdict.startsWith('value_') && (
                    <span className="rounded-full bg-emerald-900/50 px-3 py-1 text-xs font-medium text-emerald-300 ring-1 ring-emerald-500/40">
                      Posible value:{' '}
                      {prediction.market.verdict === 'value_home'
                        ? prediction.teams.home.name
                        : prediction.market.verdict === 'value_away'
                          ? prediction.teams.away.name
                          : 'empate'}
                    </span>
                  )}
                </div>
              </div>

              <div className="mt-3 rounded-lg bg-slate-900/60 p-3 ring-1 ring-slate-700/50">
                <div className="mb-1.5 text-xs uppercase tracking-wide text-slate-500">
                  Qué es lo más probable
                </div>
                <p className="text-sm font-medium text-slate-100">{prediction.summary.headline}</p>
                <ul className="mt-2 space-y-1">
                  {prediction.summary.bullets.map((b, i) => (
                    <li key={i} className="flex gap-2 text-xs text-slate-300">
                      <span className="text-slate-600">•</span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <button
                onClick={() => setOpen((o) => !o)}
                className="mt-3 text-xs text-sky-400 hover:text-sky-300"
              >
                {open ? '▲ Ocultar desglose' : '▼ Ver desglose (Elo · goles · marcadores · mercado)'}
              </button>
              {open && <Detail prediction={prediction} />}
            </>
          )}
        </>
      ) : (
        <MissingModel item={item} />
      )}
    </div>
  );
}

function Outcome({
  label, sub, value, color, odds,
}: { label: string; sub: string; value: number; color: string; odds: number | null }) {
  return (
    <div className="rounded-lg bg-slate-900/50 p-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">
        {label} · {sub}
      </div>
      <div className="text-2xl font-bold tabular-nums" style={{ color }}>
        {(value * 100).toFixed(1)}
        <span className="text-sm">%</span>
      </div>
      {odds != null && <div className="text-[10px] text-slate-500">cuota {odds}</div>}
    </div>
  );
}

function Bar({ probs }: { probs: { home: number; draw: number; away: number } }) {
  return (
    <div className="mt-2 flex h-4 overflow-hidden rounded">
      <div style={{ width: `${probs.home * 100}%`, backgroundColor: HOME_COLOR }} />
      <div style={{ width: `${probs.draw * 100}%`, backgroundColor: DRAW_COLOR }} />
      <div style={{ width: `${probs.away * 100}%`, backgroundColor: AWAY_COLOR }} />
    </div>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg bg-slate-900/50 p-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="truncate text-sm font-semibold tabular-nums text-slate-100">{value}</div>
      <div className="truncate text-[10px] text-slate-500">{hint}</div>
    </div>
  );
}

function TeamName({
  name, color, elo, eloRank, odds, alignRight = false, homeBadge = false, onClick,
}: {
  name: string; color: string; elo: number | null; eloRank: number | null;
  odds: number | null; alignRight?: boolean; homeBadge?: boolean; onClick?: () => void;
}) {
  return (
    <div className={`min-w-0 flex-1 ${alignRight ? 'text-right' : ''}`}>
      <button
        onClick={onClick}
        disabled={!onClick}
        className={`max-w-full truncate text-base font-semibold ${onClick ? 'hover:underline' : 'cursor-default'}`}
        style={{ color }}
        title={onClick ? 'Ver ficha del equipo' : undefined}
      >
        {name}
        {homeBadge && <span className="ml-1.5 text-[10px] text-slate-500">(local)</span>}
      </button>
      <div className="text-[11px] text-slate-500">
        {elo != null && <>Elo {Math.round(elo)}{eloRank != null && ` (#${eloRank})`}</>}
        {odds != null && <> · cuota {odds}</>}
      </div>
    </div>
  );
}

function ReliabilityBadge({ reliability }: { reliability: FbReliability }) {
  const styles: Record<FbReliability['level'], string> = {
    high: 'bg-emerald-900/40 text-emerald-300 ring-emerald-500/40',
    medium: 'bg-amber-900/40 text-amber-300 ring-amber-500/40',
    low: 'bg-rose-900/40 text-rose-300 ring-rose-500/40',
  };
  const title = [
    `Margen de incertidumbre: ±${reliability.marginPp} puntos porcentuales.`,
    `Partidos tras cada Elo: ${reliability.matchesBehind.home} (local) y ${reliability.matchesBehind.away} (visitante).`,
    ...reliability.reasons,
  ].join('\n');
  return (
    <span title={title} className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ${styles[reliability.level]}`}>
      {reliability.label} · ±{reliability.marginPp} pp
    </span>
  );
}

function MissingModel({ item }: { item: FbFixtureWithPrediction }) {
  const { fixture } = item;
  const missing = [
    !fixture.home_id ? fixture.home_name : null,
    !fixture.away_id ? fixture.away_name : null,
  ].filter(Boolean) as string[];
  return (
    <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 p-3 text-xs text-amber-200">
      <p className="font-medium">Sin modelo ni cuotas para este partido.</p>
      {missing.length > 0 && (
        <p className="mt-1">
          No encuentro en el historial a: <strong>{missing.join(', ')}</strong>. Ocurre en
          competiciones sin fuente de resultados (Champions) o cuando la casa escribe el nombre del
          club de otra forma.
        </p>
      )}
    </div>
  );
}

/** Full breakdown, all figures drawn from the same score distribution. */
function Detail({ prediction }: { prediction: FbPrediction }) {
  const { teams, goals, h2h, market, reasoning, reliability } = prediction;
  const home = teams.home;
  const away = teams.away;
  return (
    <div className="mt-4 space-y-4 border-t border-slate-700/60 pt-4 text-sm">
      <div
        className={`rounded-lg border p-3 ${
          reliability.level === 'high'
            ? 'border-emerald-700/50 bg-emerald-950/30'
            : reliability.level === 'medium'
              ? 'border-amber-700/50 bg-amber-950/30'
              : 'border-rose-700/50 bg-rose-950/30'
        }`}
      >
        <div className="mb-1 text-xs uppercase tracking-wide text-slate-500">
          Cuánta confianza merece
        </div>
        <p className="text-slate-200">
          <strong className="capitalize">{reliability.label}</strong> — margen ±{reliability.marginPp} pp.
          Partidos tras cada Elo: {reliability.matchesBehind.home} y {reliability.matchesBehind.away}.
        </p>
        {reliability.reasons.length > 0 && (
          <ul className="mt-2 space-y-1">
            {reliability.reasons.map((r, i) => (
              <li key={i} className="flex gap-2 text-xs text-slate-300">
                <span className="text-slate-600">•</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-lg bg-slate-800/50 p-3">
        <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">Por qué</div>
        <p className="mb-2 text-slate-300">{reasoning.text}</p>
        <div className="space-y-1 text-xs">
          {reasoning.factors.map((f) => (
            <div key={f.key} className="flex justify-between">
              <span className="text-slate-400">{f.label}</span>
              <span
                className="tabular-nums"
                style={{ color: f.pointsForHome >= 0 ? HOME_COLOR : AWAY_COLOR }}
              >
                {f.pointsForHome > 0 ? '+' : ''}
                {f.pointsForHome} para {f.pointsForHome >= 0 ? home.name : away.name}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg bg-slate-800/50 p-3">
        <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">
          Marcadores más probables
        </div>
        <div className="space-y-1">
          {goals.scorelines.map((s) => (
            <div key={s.label} className="flex items-center gap-2 text-xs">
              <span className="w-10 tabular-nums text-slate-200">{s.label}</span>
              <div className="h-2 flex-1 rounded bg-slate-700/50">
                <div
                  className="h-full rounded"
                  style={{
                    width: `${(s.probability / goals.scorelines[0].probability) * 100}%`,
                    backgroundColor: s.home > s.away ? HOME_COLOR : s.home === s.away ? DRAW_COLOR : AWAY_COLOR,
                  }}
                />
              </div>
              <span className="w-12 text-right tabular-nums text-slate-400">{pct(s.probability)}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500">
          El 1X2, el over/under y «ambos marcan» salen de esta misma distribución, así que nunca
          pueden contradecirse entre sí.
        </p>
      </div>

      <div className="rounded-lg bg-slate-800/50 p-3 text-xs">
        <div className="mb-2 uppercase tracking-wide text-slate-500">Equipos</div>
        <div className="grid grid-cols-[1fr_auto_auto] gap-2">
          <div />
          <div className="w-20 text-right" style={{ color: HOME_COLOR }}>{home.name}</div>
          <div className="w-20 text-right" style={{ color: AWAY_COLOR }}>{away.name}</div>
          <div className="text-slate-400">Elo</div>
          <div className="w-20 text-right tabular-nums">{Math.round(home.elo)}</div>
          <div className="w-20 text-right tabular-nums">{Math.round(away.elo)}</div>
          <div className="text-slate-400">Goles a favor / partido</div>
          <div className="w-20 text-right tabular-nums">{home.gf ?? '—'}</div>
          <div className="w-20 text-right tabular-nums">{away.gf ?? '—'}</div>
          <div className="text-slate-400">Goles en contra / partido</div>
          <div className="w-20 text-right tabular-nums">{home.ga ?? '—'}</div>
          <div className="w-20 text-right tabular-nums">{away.ga ?? '—'}</div>
          <div className="text-slate-400">Balance (G-E-P)</div>
          <div className="w-20 text-right tabular-nums">
            {home.record.wins}-{home.record.draws}-{home.record.losses}
          </div>
          <div className="w-20 text-right tabular-nums">
            {away.record.wins}-{away.record.draws}-{away.record.losses}
          </div>
          <div className="text-slate-400">Últimos 5</div>
          <div className="w-20 text-right">{home.last5.join('') || '—'}</div>
          <div className="w-20 text-right">{away.last5.join('') || '—'}</div>
        </div>
      </div>

      <div className="rounded-lg bg-slate-800/50 p-3 text-xs">
        <div className="mb-2 flex items-center justify-between">
          <span className="uppercase tracking-wide text-slate-500">Historial directo</span>
          <span>
            <span style={{ color: HOME_COLOR }}>{h2h.homeWins}</span>
            <span className="text-slate-500"> - {h2h.draws} - </span>
            <span style={{ color: AWAY_COLOR }}>{h2h.awayWins}</span>
            <span className="ml-2 text-slate-500">({h2h.total})</span>
          </span>
        </div>
        {h2h.recent.length === 0 ? (
          <p className="text-slate-400">Sin enfrentamientos previos.</p>
        ) : (
          <ul className="space-y-1">
            {h2h.recent.map((m, i) => (
              <li key={i} className="flex justify-between text-slate-300">
                <span className="text-slate-500">{formatDate(m.date)}</span>
                <span>
                  {m.homeId === home.id ? home.name : away.name} {m.homeGoals}–{m.awayGoals}{' '}
                  {m.awayId === away.id ? away.name : home.name}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {market.market && (
        <div className="rounded-lg bg-slate-800/50 p-3 text-xs">
          <div className="mb-2 uppercase tracking-wide text-slate-500">Mercado</div>
          <p className="text-slate-300">
            Cuotas {market.market.odds.home} / {market.market.odds.draw} / {market.market.odds.away} ·
            implícitas sin vig {pct(market.market.home)} / {pct(market.market.draw)} /{' '}
            {pct(market.market.away)} · margen {((market.market.overround - 1) * 100).toFixed(1)}%
          </p>
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-slate-500">{prediction.disclaimer}</p>
    </div>
  );
}
