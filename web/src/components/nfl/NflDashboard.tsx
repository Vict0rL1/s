import { useEffect, useMemo, useState } from 'react';
import {
  pillClass, SkeletonList, TeamCrest, DayFilter, DayHeading, StaleHistoryWarning, PicksPanel,
} from '../ui';
import { staleness } from '../../lib/staleness';
import { CAVEATS, rankPicks, nflPicks } from '../../lib/picks';
import { useStake } from '../../lib/useStake';
import { countryFlag, dayChipLabel, groupByDay } from '../../lib/format';
import {
  nflApi,
  type NflGameWithPrediction,
  type NflLeague,
  type NflMeta,
  type NflTrackRecord,
} from '../../lib/nfl';
import GameCard from './GameCard';
import TeamProfile from './TeamProfile';

/**
 * The whole American football tab. Holds its own state and talks only to
 * /api/nfl/*, so switching sports never mixes anything.
 *
 * The header carries something no other tab has: the two league-wide numbers the
 * model TRACKS rather than assumes — what home field is worth right now, and how
 * many points a game is producing. Both moved a lot over the archive (home field
 * from +3.5 points to under +2, and briefly to zero in the empty stadiums of
 * 2020), so showing today's value is showing something the model actually
 * learned rather than a constant somebody typed in.
 */
export default function NflDashboard() {
  const [meta, setMeta] = useState<NflMeta | null>(null);
  const [leagues, setLeagues] = useState<NflLeague[]>([]);
  const [league, setLeague] = useState<string | null>(null);
  const [games, setGames] = useState<NflGameWithPrediction[]>([]);
  const [power, setPower] = useState<
    { id: string; name: string; elo: number; games: number; pf: number | null; pa: number | null }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [team, setTeam] = useState<{ league: string; id: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // null = every day, which is the default: someone who has not asked to filter
  // should see the whole schedule.
  const [day, setDay] = useState<string | null>(null);
  const [showTeams, setShowTeams] = useState(false);

  useEffect(() => {
    Promise.all([nflApi.meta(), nflApi.leagues()])
      .then(([m, l]) => {
        setMeta(m);
        setLeagues(l);
      })
      .catch((e) =>
        setError(`No se pudo cargar el fútbol americano. ¿Ejecutaste "npm run update-data:naf"? (${e})`),
      );
  }, []);

  const selectable = useMemo(() => leagues.filter((l) => l.hasUpcoming || l.games > 0), [leagues]);
  useEffect(() => {
    if (league && selectable.some((l) => l.id === league)) return;
    setLeague((selectable.find((l) => l.hasUpcoming) ?? selectable[0])?.id ?? null);
  }, [selectable, league]);

  useEffect(() => {
    if (!league) {
      setGames([]);
      setPower([]);
      return;
    }
    setLoading(true);
    Promise.all([nflApi.upcoming(league), nflApi.power(league)])
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
      await nflApi.refresh();
      const [m, l, g] = await Promise.all([
        nflApi.meta(),
        nflApi.leagues(),
        league ? nflApi.upcoming(league) : Promise.resolve([]),
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
  const picks = useMemo(() => rankPicks(nflPicks(games)), [games]);
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

  return (
    <div>
      <header className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-prose text-[15px] leading-relaxed text-[#9aa1ac]">
            Hándicap, total y ganador con Elo por equipo y una distribución de margen que conoce los
            números clave del deporte. Es el único deporte de la app cuyo modelo se puede medir
            contra la línea de cierre real.
          </p>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            title="Vuelve a consultar los partidos próximos y sus cuotas"
            className="shrink-0 rounded-lg bg-white/[0.06] px-3 py-1.5 text-[14px] font-medium text-[#d5d9df] ring-1 ring-inset ring-white/10 transition hover:bg-white/[0.1] disabled:opacity-50"
          >
            {refreshing ? 'Actualizando…' : '↻ Actualizar'}
          </button>
        </div>
        {meta && <DataLine meta={meta} />}
        <StaleHistoryWarning
          info={staleness('nfl', leagueMeta?.historyThrough)}
          what="Los Elo, el hándicap y el total"
          fix="npm run update-data:naf"
        />
        {league && <NflTrackRecordPanel league={league} />}
      </header>

      {/* The ranked-markets panel. Built from the SAME rows the cards below
          render, so the two can never disagree about a number. */}
      <PicksPanel {...picks} caveat={CAVEATS.nfl} demoOdds={demoOdds} stake={stake} onStakeChange={setStake} />

      {error && (
        <div className="mb-4 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] p-3 text-[15px] text-rose-200">
          {error}
        </div>
      )}

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
              {!l.hasModel && (
                <span className="ml-1.5 text-amber-400" title="Sin modelo Elo">
                  ◦
                </span>
              )}
            </button>
          ))}
        </div>
      ) : (
        <div className="mb-6 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] p-5 text-[15px] text-rose-200">
          <p className="font-medium">No hay datos de fútbol americano todavía.</p>
          <p className="mt-1 text-rose-300/90">
            Ejecuta <code className="rounded bg-rose-900/40 px-1">npm run update-data:naf</code> para
            descargar equipos, resultados y el calendario.
          </p>
        </div>
      )}

      {activeLeague && !activeLeague.hasModel && (
        <div className="mb-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3 text-[15px] leading-relaxed text-amber-200/90">
          <strong>{activeLeague.name} sin modelo Elo.</strong> No hay una fuente abierta de
          resultados partido a partido para esta competición, así que se muestran los partidos y las
          probabilidades <em>implícitas del mercado</em>, no una predicción propia.
        </div>
      )}

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
                      <td className="py-1 pr-2">{t.pf?.toFixed(1) ?? '—'}</td>
                      <td className="py-1 pr-2">{t.pa?.toFixed(1) ?? '—'}</td>
                      <td className="py-1">
                        {t.pf != null && t.pa != null
                          ? `${t.pf - t.pa > 0 ? '+' : ''}${(t.pf - t.pa).toFixed(1)}`
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

      {team && <TeamProfile league={team.league} id={team.id} onClose={() => setTeam(null)} />}
    </div>
  );
}

function DataLine({ meta }: { meta: NflMeta }) {
  return (
    <p className="mt-2 text-[13px] leading-relaxed text-[#7b828d]">
      <span className="mr-1 rounded-full px-2 py-0.5 text-emerald-300 ring-1 ring-inset ring-emerald-500/30">
        datos reales (nflverse)
      </span>
      {meta.counts.games.toLocaleString('es')} partidos · {meta.counts.teams} equipos ·{' '}
      {/* The two tracked league quantities. Worth a line of chrome: they are the
          model's own reading of how the sport is being played this year. */}
      <span className="text-[#9aa1ac]">
        ventaja de campo {meta.league.homeAdvantagePoints} pts · {meta.league.pointsPerGame} puntos
        por partido
      </span>
      {!meta.hasOddsKey && ' · configura ODDS_API_KEY para cuotas reales'}
    </p>
  );
}

/**
 * The staleness warning, counted in SEASONS.
 *
 * The other tabs warn in months. Here that would fire every summer on a
 * perfectly current archive: the NFL simply does not play between February and
 * September, so "the history ends five months ago" in July means nothing is
 * missing at all.
 */

/**
 * The track record.
 *
 * The one panel in the app that can put the model and the market side by side on
 * the SAME games the app actually showed you, because this is the only sport
 * where the market's number is recorded at the moment of the call.
 */
function NflTrackRecordPanel({ league }: { league: string }) {
  const [data, setData] = useState<NflTrackRecord | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    nflApi
      .trackRecord(league)
      .then((d) => alive && setData(d))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [league]);

  if (!data || (data.resolved === 0 && data.pending === 0)) return null;

  return (
    <div className="mt-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
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
              acierto en <strong className="tabular-nums">{data.resolved}</strong> partidos
              {data.marginMae != null && (
                <span className="text-[#9aa1ac]"> · error del margen {data.marginMae} pts</span>
              )}
            </span>
          )}
        </span>
        <span className="shrink-0 text-[14px] text-[#5c636c]">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="mt-3 space-y-3 border-t border-white/[0.07] pt-3 text-[14px] text-[#c3c9d1]">
          {data.vsMarket && (
            <p>
              <strong>Contra el mercado</strong>, en los {data.vsMarket.n} partidos donde había
              cuotas cuando se hizo la predicción: el modelo acertó el{' '}
              {((data.vsMarket.modelAccuracy ?? 0) * 100).toFixed(1)}% y el mercado el{' '}
              {((data.vsMarket.marketAccuracy ?? 0) * 100).toFixed(1)}% (Brier{' '}
              {data.vsMarket.modelBrier} frente a {data.vsMarket.marketBrier}; menor es mejor).
            </p>
          )}
          <p className="text-[#9aa1ac]">
            La línea de cierre de la NFL es el precio más afinado del deporte. En 27 temporadas de
            histórico el modelo no la bate — acierta el 50.9% contra el hándicap, por debajo del
            52.4% que hace falta solo para cubrir la comisión. Esto se dice aquí, y no en letra
            pequeña, porque es lo que hay.
          </p>
          {data.calibration.length > 0 && (
            <div>
              <div className="mb-1 text-[#7b828d]">Calibración del favorito:</div>
              <ul className="space-y-0.5">
                {data.calibration.map((c) => (
                  <li key={c.label} className="tabular-nums">
                    {c.label}: dijo {(c.predicted * 100).toFixed(0)}%, salió{' '}
                    {(c.observed * 100).toFixed(0)}% ({c.n} partidos)
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
