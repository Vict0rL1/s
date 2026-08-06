import { useEffect, useMemo, useState } from 'react';
import {
  pillClass, SkeletonList, TeamCrest, DayFilter, DayHeading, StaleHistoryWarning, PicksPanel, DashboardHeader,
} from '../ui';
import { staleLabel, staleness } from '../../lib/staleness';
import { CAVEATS, rankPicks, basketballPicks } from '../../lib/picks';
import { useStake } from '../../lib/useStake';
import { countryFlag, dayChipLabel, groupByDay } from '../../lib/format';
import {
  bbApi,
  type BbGameWithPrediction,
  type BbLeague,
  type BbMeta,
  type BbPowerTeam,
  type BbTrackRecord,
} from '../../lib/basketball';
import GameCard from './GameCard';
import TeamProfile from './TeamProfile';

/**
 * The whole basketball tab. Holds its own state and talks only to
 * /api/basketball/*, so switching sports never mixes the two — the tennis view is
 * untouched while this one is mounted, and vice versa.
 */
export default function BasketballDashboard() {
  const [meta, setMeta] = useState<BbMeta | null>(null);
  const [leagues, setLeagues] = useState<BbLeague[]>([]);
  const [league, setLeague] = useState<string | null>(null);
  const [games, setGames] = useState<BbGameWithPrediction[]>([]);
  const [power, setPower] = useState<BbPowerTeam[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [team, setTeam] = useState<{ league: string; id: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // null = every day, which is the default: someone who has not asked to filter
  // should see the whole schedule.
  const [day, setDay] = useState<string | null>(null);
  const [showTeams, setShowTeams] = useState(false);

  useEffect(() => {
    Promise.all([bbApi.meta(), bbApi.leagues()])
      .then(([m, l]) => {
        setMeta(m);
        setLeagues(l);
      })
      .catch((e) =>
        setError(
          `No se pudo cargar el baloncesto. ¿Ejecutaste "npm run update-data:bb"? (${e})`,
        ),
      );
  }, []);

  // Prefer a league that actually has games to show; fall back to one with data.
  const selectable = useMemo(
    () => leagues.filter((l) => l.hasUpcoming || l.games > 0),
    [leagues],
  );
  useEffect(() => {
    if (league && selectable.some((l) => l.id === league)) return;
    const withGames = selectable.find((l) => l.hasUpcoming) ?? selectable[0];
    setLeague(withGames?.id ?? null);
  }, [selectable, league]);

  useEffect(() => {
    if (!league) {
      setGames([]);
      setPower([]);
      return;
    }
    setLoading(true);
    Promise.all([bbApi.upcoming(league), bbApi.power(league, 40)])
      .then(([g, p]) => {
        setGames(g);
        setPower(p.teams);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [league]);

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      await bbApi.refresh();
      const [m, l, g] = await Promise.all([
        bbApi.meta(),
        bbApi.leagues(),
        league ? bbApi.upcoming(league) : Promise.resolve([]),
      ]);
      setMeta(m);
      setLeagues(l);
      setGames(g);
    } catch (e) {
      setError(`No se pudo actualizar: ${e}`);
    } finally {
      setRefreshing(false);
    }
  }

  // Grouped by the reader's own local day, and filtered to one of them if asked.
  const dayGroups = useMemo(() => groupByDay(games, (g) => g.game.commence_time), [games]);
  const dayChips = useMemo(
    () => dayGroups.map((d) => ({ key: d.key, label: dayChipLabel(d.key), count: d.items.length })),
    [dayGroups],
  );
  const shownGroups = day ? dayGroups.filter((d) => d.key === day) : dayGroups;

  // Ranked markets, from the rows already fetched. Recomputed only when those
  // change: it is pure arithmetic over what is on screen, no extra request.
  const picks = useMemo(() => rankPicks(basketballPicks(games)), [games]);
  const [stake, setStake] = useStake();
  // Every price on screen invented by this app rather than fetched — see picks.ts.
  const demoOdds = games.length > 0 && games.every((r) => r.game.source === 'fixture');
  // A day that no longer exists after switching league would filter everything
  // away and look like "no games", so the choice is dropped rather than kept.
  useEffect(() => {
    if (day && !dayGroups.some((d) => d.key === day)) setDay(null);
  }, [dayGroups, day]);

  const activeLeague = leagues.find((l) => l.id === league) ?? null;
  const leagueMeta = meta?.leagues.find((l) => l.id === league) ?? null;

  // Computed once: the collapsed header needs the short version and the
  // expanded one the full paragraph, and they must be the same judgement.
  const stale = staleness('basketball', leagueMeta?.historyThrough, meta?.dataSource === 'seed');

  return (
    <div>
      <DashboardHeader
        onRefresh={handleRefresh}
        refreshing={refreshing}
        refreshTitle="Vuelve a consultar los partidos próximos y sus cuotas"
        chips={meta && (<>{meta.counts.games.toLocaleString('es')} partidos · {meta.counts.teams} equipos</>)}
        alert={staleLabel(stale)}
      >
          <p className="max-w-prose text-[15px] leading-relaxed text-[#9aa1ac]">
            Predicción de partidos con Elo por equipo, ventaja de campo, margen de puntos, descanso
            y odds del mercado.
          </p>
        {meta && <DataLine meta={meta} />}
        <StaleHistoryWarning
          info={stale}
          what="Los Elo, el margen y el total"
          fix="npm run update-data:bb"
        />
        {league && <BbTrackRecordPanel league={league} />}
      </DashboardHeader>

      {/* The ranked-markets panel. Built from the SAME rows the cards below
          render, so the two can never disagree about a number. */}
      <PicksPanel {...picks} caveat={CAVEATS.basketball} demoOdds={demoOdds} stake={stake} onStakeChange={setStake} />

      {error && (
        <div className="mb-4 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] p-3 text-[15px] text-rose-200">
          {error}
        </div>
      )}

      {/* League selector */}
      {selectable.length > 0 ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {selectable.map((l) => (
            <button
              key={l.id}
              onClick={() => setLeague(l.id)}
              title={l.label}
              className={pillClass(league === l.id)}
            >
              {countryFlag(l.country) && (
                <span aria-hidden className="mr-1.5">{countryFlag(l.country)}</span>
              )}
              {l.name}
              {l.upcomingCount > 0 && <span className="ml-1.5 opacity-60">{l.upcomingCount}</span>}
              {!l.hasModel && <span className="ml-1.5 text-amber-400" title="Sin modelo Elo">◦</span>}
            </button>
          ))}
        </div>
      ) : (
        <div className="mb-6 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] p-5 text-[15px] text-rose-200">
          <p className="font-medium">No hay datos de baloncesto todavía.</p>
          <p className="mt-1 text-rose-300/90">
            Ejecuta <code className="rounded bg-rose-900/40 px-1">npm run update-data:bb</code> para
            descargar equipos, resultados y partidos próximos.
          </p>
        </div>
      )}

      {activeLeague && !activeLeague.hasModel && (
        <div className="mb-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3 text-[15px] leading-relaxed text-amber-200/90">
          <strong>{activeLeague.name} sin modelo Elo.</strong> No hay una fuente abierta de
          resultados para esta liga, así que se muestran los partidos y las probabilidades{' '}
          <em>implícitas del mercado</em>, no una predicción propia. Se indica en cada tarjeta.
        </div>
      )}

      {/* Games */}
      {loading ? (
        <SkeletonList />
      ) : games.length === 0 ? (
        <p className="mb-6 text-[16px] text-[#7b828d]">
          No hay partidos próximos para {activeLeague?.name ?? 'esta liga'}.
        </p>
      ) : (
        <>
          <DayFilter days={dayChips} selected={day} onSelect={setDay} />
          {shownGroups.map((group) => (
            <section key={group.key} className="mb-6">
              <DayHeading label={group.label} count={group.items.length} />
              {/* Two-up from 1280px. The shell got wider (see SHELL_WIDTH in
                  App.tsx) and a card does not want to BE wider — it wants a
                  neighbour. `items-start` so a card with its breakdown open does
                  not stretch the one beside it.

                  minmax(0,1fr) and NOT grid-cols-1/2: a grid track is `minmax(auto,
                  1fr)` by default, and `auto` means "at least the widest thing that
                  cannot shrink". One nowrap badge inside a card was enough to push
                  the track past the viewport — 5px of horizontal page scroll on a
                  390px phone. Block flow (the `space-y-4` this replaced) clamped the
                  card and let the content overflow internally instead, so the bug
                  arrived with the grid. */}
              <div className="grid gap-4 grid-cols-[minmax(0,1fr)] xl:grid-cols-[repeat(2,minmax(0,1fr))] xl:items-start">
                {group.items.map((g) => (
                  <GameCard key={g.game.id} item={g} onOpenTeam={(lg, id) => setTeam({ league: lg, id })} />
                ))}
              </div>
            </section>
          ))}
        </>
      )}

      {/* All teams, by Elo — "la información de todos los equipos" */}
      {power.length > 0 && (
        <div className="mt-8 rounded-xl border border-white/[0.07] bg-[#14161b] p-4">
          <button
            onClick={() => setShowTeams((s) => !s)}
            className="flex w-full items-center justify-between text-left"
          >
            <span>
              <span className="text-[14px] uppercase tracking-wide text-[#7b828d]">
                Todos los equipos · {activeLeague?.name}
              </span>
              <br />
              <span className="text-[16px] text-[#d5d9df]">
                {power.length} equipos ordenados por Elo
              </span>
            </span>
            <span className="text-[14px] text-[#5c636c]">{showTeams ? '▲' : '▼'}</span>
          </button>
          {showTeams && (
            <div className="mt-3 overflow-x-auto border-t border-white/[0.07] pt-3">
              <table className="w-full text-left text-[14px] tabular-nums">
                <thead className="text-[#7b828d]">
                  <tr>
                    <th className="py-1 pr-2 font-normal">#</th>
                    <th className="py-1 pr-2 font-normal">Equipo</th>
                    <th className="py-1 pr-2 font-normal">Elo</th>
                    <th className="py-1 pr-2 font-normal">Anota</th>
                    <th className="py-1 pr-2 font-normal">Recibe</th>
                    <th className="py-1 font-normal">Dif.</th>
                  </tr>
                </thead>
                <tbody className="text-[#d5d9df]">
                  {power.map((t, i) => (
                    <tr key={t.id} className="border-t border-white/[0.07]">
                      <td className="py-1 pr-2 text-[#7b828d]">{i + 1}</td>
                      <td className="py-1 pr-2">
                        <span className="flex min-w-0 items-center gap-2">
                          <TeamCrest league={league!} name={t.name} code={t.id} size={16} />
                          <button
                            onClick={() => setTeam({ league: league!, id: t.id })}
                            className="truncate text-[#c3c9d1] hover:underline"
                          >
                            {t.name}
                          </button>
                        </span>
                      </td>
                      <td className="py-1 pr-2">{Math.round(t.elo)}</td>
                      <td className="py-1 pr-2">{t.ppg ?? '—'}</td>
                      <td className="py-1 pr-2">{t.papg ?? '—'}</td>
                      <td className="py-1">
                        {t.ppg != null && t.papg != null
                          ? `${t.ppg - t.papg > 0 ? '+' : ''}${(t.ppg - t.papg).toFixed(1)}`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {team && (
        <TeamProfile league={team.league} id={team.id} onClose={() => setTeam(null)} />
      )}
    </div>
  );
}

function DataLine({ meta }: { meta: BbMeta }) {
  const when = meta.oddsRefreshedAt ?? meta.updatedAt;
  const whenTxt = when
    ? new Date(when).toLocaleString('es', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
  return (
    <p className="mt-1 text-[14px] text-[#7b828d]">
      {meta.counts.games} partidos · {meta.counts.teams} equipos · actualizado {whenTxt}
      {meta.hasOddsKey
        ? meta.autoRefreshMinutes > 0
          ? ` · auto cada ${Math.round(meta.autoRefreshMinutes / 60)}h`
          : ''
        : ' · configura ODDS_API_KEY para partidos y cuotas reales'}
    </p>
  );
}

/**
 * Ratings are only as current as the results behind them. In basketball this
 * matters even more than in tennis: a roster can change completely over one
 * summer, so a rating from a past season describes a team that no longer exists.
 */

/**
 * The app's own scorecard for basketball. Unlike tennis it can also report how far
 * off the predicted MARGIN was, which is the figure a handicap bet depends on.
 */
function BbTrackRecordPanel({ league }: { league: string }) {
  const [data, setData] = useState<BbTrackRecord | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    bbApi
      .trackRecord(league)
      .then((d) => alive && setData(d))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [league]);

  if (!data || (data.resolved === 0 && data.pending === 0)) return null;
  const thin = data.resolved > 0 && data.resolved < 30;

  return (
    <div className="mt-3 rounded-lg border border-white/[0.07] bg-white/[0.04] p-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="text-[16px]">
          <span className="text-[14px] uppercase tracking-wide text-[#7b828d]">
            Aciertos reales de la app
          </span>
          <br />
          {data.resolved === 0 ? (
            <span className="text-[#c3c9d1]">
              {data.pending} predicción(es) registradas, esperando resultado.
            </span>
          ) : (
            <span className="text-[#e8eaed]">
              <strong className="tabular-nums">{((data.accuracy ?? 0) * 100).toFixed(1)}%</strong> de
              acierto en <strong className="tabular-nums">{data.resolved}</strong> partidos jugados
              {data.marginMae != null && (
                <span className="text-[#9aa1ac]"> · error de margen {data.marginMae} pts</span>
              )}
              {thin && <span className="text-amber-400"> · muestra pequeña</span>}
            </span>
          )}
        </span>
        <span className="shrink-0 text-[14px] text-[#5c636c]">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-4 border-t border-white/[0.07] pt-3 text-[14px]">
          <p className="text-[#9aa1ac]">
            Cada predicción se guarda <strong>antes</strong> del partido y se puntúa cuando llega el
            resultado real (al ejecutar{' '}
            <code className="rounded bg-white/[0.03] px-1">npm run update-data:bb</code>). No es el
            backtest histórico: son los partidos que viste aquí.
          </p>
          {data.resolved > 0 && (
            <div className="grid grid-cols-4 gap-x-4 gap-y-3 border-y border-white/[0.07] py-3">
              <Cell label="Acierto" value={`${((data.accuracy ?? 0) * 100).toFixed(1)}%`} />
              <Cell label="Brier" value={data.brier?.toFixed(4) ?? '—'} />
              <Cell label="Error margen" value={data.marginMae != null ? `${data.marginMae} pts` : '—'} />
              <Cell
                label="Sesgo margen"
                value={
                  data.marginBias != null
                    ? `${data.marginBias > 0 ? '+' : ''}${data.marginBias}`
                    : '—'
                }
                hint="+ = sobreestima al local"
              />
            </div>
          )}
          {data.vsMarket && (
            <div>
              <div className="mb-1 uppercase tracking-wide text-[#7b828d]">
                Modelo vs mercado ({data.vsMarket.n} partidos con cuotas)
              </div>
              <table className="w-full text-left tabular-nums">
                <thead className="text-[#7b828d]">
                  <tr>
                    <th className="py-1 font-normal">&nbsp;</th>
                    <th className="py-1 font-normal">Acierto</th>
                    <th className="py-1 font-normal">Brier</th>
                  </tr>
                </thead>
                <tbody className="text-[#d5d9df]">
                  <tr>
                    <td className="py-1 text-[#9aa1ac]">Modelo</td>
                    <td>{fmtPct(data.vsMarket.modelAccuracy)}</td>
                    <td>{data.vsMarket.modelBrier?.toFixed(4) ?? '—'}</td>
                  </tr>
                  <tr>
                    <td className="py-1 text-[#9aa1ac]">Mercado</td>
                    <td>{fmtPct(data.vsMarket.marketAccuracy)}</td>
                    <td>{data.vsMarket.marketBrier?.toFixed(4) ?? '—'}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          {data.recent.length > 0 && (
            <div>
              <div className="mb-1 uppercase tracking-wide text-[#7b828d]">Últimas resueltas</div>
              <ul className="space-y-1">
                {data.recent.map((r, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className={r.hit ? 'text-emerald-400' : 'text-rose-400'}>
                      {r.hit ? '✓' : '✗'}
                    </span>
                    <span className="text-[#c3c9d1]">
                      {r.away} @ {r.home}
                      <span className="text-[#7b828d]">
                        {' '}
                        — dijo {fmtPct(Math.max(r.probHome, 1 - r.probHome))} para{' '}
                        {r.probHome >= 0.5 ? r.home : r.away}; acabó {r.awayPts}–{r.homePts}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Cell({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[#7b828d]">{label}</div>
      <div className="tabular-nums text-[#e8eaed]">{value}</div>
      {hint && <div className="text-[11px] text-[#5c636c]">{hint}</div>}
    </div>
  );
}

function fmtPct(v: number | null): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
}
