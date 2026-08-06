import { useEffect, useMemo, useState } from 'react';
import {
  pillClass, SkeletonList, TeamCrest, DayFilter, DayHeading, StaleHistoryWarning,
} from '../ui';
import { staleness } from '../../lib/staleness';
import {
  fbApi,
  type FbFixtureWithPrediction,
  type FbLeague,
  type FbMeta,
  type FbPowerTeam,
  type FbTeamInfo,
} from '../../lib/football';
import MatchCard from './MatchCard';
import { formatDate, countryFlag, dayChipLabel, groupByDay } from '../../lib/format';

/**
 * The ⚽ tab.
 *
 * Leagues are SUB-TABS inside this tab rather than one long list, because a
 * combined feed of the Premier League, LaLiga, MLS and the Brasileirão is not
 * something anyone reads top to bottom — you come here for one competition. The
 * chosen league is remembered, so reopening lands where you left off.
 */
const STORAGE_KEY = 'predictor.football.league';

export default function FootballDashboard() {
  const [meta, setMeta] = useState<FbMeta | null>(null);
  const [leagues, setLeagues] = useState<FbLeague[]>([]);
  const [league, setLeague] = useState<string | null>(null);
  const [fixtures, setFixtures] = useState<FbFixtureWithPrediction[]>([]);
  const [power, setPower] = useState<FbPowerTeam[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [team, setTeam] = useState<{ league: string; id: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // null = every day, which is the default: someone who has not asked to filter
  // should see the whole schedule.
  const [day, setDay] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    Promise.all([fbApi.meta(), fbApi.leagues()])
      .then(([m, l]) => {
        setMeta(m);
        setLeagues(l);
      })
      .catch((e) =>
        setError(`No se pudo cargar el fútbol. ¿Ejecutaste "npm run update-data:fb"? (${e})`),
      );
  }, []);

  // Only offer leagues that have something to show.
  const selectable = useMemo(
    () => leagues.filter((l) => l.hasUpcoming || l.matches > 0),
    [leagues],
  );

  useEffect(() => {
    if (league && selectable.some((l) => l.id === league)) return;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {
      // storage disabled — fall through to the default
    }
    // `saved &&` would yield the empty string when nothing is stored, so the
    // lookup is written as an explicit null to keep the type a league or null.
    const remembered = saved ? selectable.find((l) => l.id === saved) : undefined;
    const pick = remembered ?? selectable.find((l) => l.hasUpcoming) ?? selectable[0];
    setLeague(pick?.id ?? null);
  }, [selectable, league]);

  useEffect(() => {
    if (!league) return;
    try {
      localStorage.setItem(STORAGE_KEY, league);
    } catch {
      // Only affects which sub-tab opens next time.
    }
    setLoading(true);
    Promise.all([fbApi.upcoming(league), fbApi.power(league, 40)])
      .then(([f, p]) => {
        setFixtures(f);
        setPower(p.teams);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [league]);

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      await fbApi.refresh();
      const [m, l, f] = await Promise.all([
        fbApi.meta(),
        fbApi.leagues(),
        league ? fbApi.upcoming(league) : Promise.resolve([]),
      ]);
      setMeta(m);
      setLeagues(l);
      setFixtures(f);
    } catch (e) {
      setError(`No se pudo actualizar: ${e}`);
    } finally {
      setRefreshing(false);
    }
  }

  // Grouped by the reader's own local day, and filtered to one of them if asked.
  const dayGroups = useMemo(
    () => groupByDay(fixtures, (f) => f.fixture.commence_time),
    [fixtures],
  );
  const dayChips = useMemo(
    () => dayGroups.map((d) => ({ key: d.key, label: dayChipLabel(d.key), count: d.items.length })),
    [dayGroups],
  );
  const shownGroups = day ? dayGroups.filter((d) => d.key === day) : dayGroups;
  // A day that no longer exists after switching league would filter everything
  // away and look like "no fixtures", so the choice is dropped rather than kept.
  useEffect(() => {
    if (day && !dayGroups.some((d) => d.key === day)) setDay(null);
  }, [dayGroups, day]);

  const active = leagues.find((l) => l.id === league) ?? null;
  const activeMeta = meta?.leagues.find((l) => l.id === league) ?? null;

  return (
    <div>
      <header className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-prose text-[15px] leading-relaxed text-[#9aa1ac]">
            Predicción 1X2, goles y marcadores con Elo por equipo, ventaja de campo y odds del
            mercado.
          </p>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="shrink-0 rounded-lg bg-white/[0.06] px-3 py-1.5 text-[14px] font-medium text-[#d5d9df] ring-1 ring-inset ring-white/10 transition hover:bg-white/[0.1] disabled:opacity-50"
          >
            {refreshing ? 'Actualizando…' : '↻ Actualizar'}
          </button>
        </div>
        {meta && (
          <p className="mt-1 text-[14px] text-[#7b828d]">
            {meta.counts.matches} partidos · {meta.counts.teams} equipos
            {!meta.hasOddsKey && ' · configura ODDS_API_KEY para partidos y cuotas reales'}
          </p>
        )}
      </header>

      {error && (
        <div className="mb-4 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] p-3 text-[15px] text-rose-200">
          {error}
        </div>
      )}

      {/* ---- LEAGUE SUB-TABS ---- */}
      {selectable.length > 0 ? (
        <nav className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Ligas">
          {selectable.map((l) => {
            const on = league === l.id;
            return (
              <button
                key={l.id}
                role="tab"
                aria-selected={on}
                onClick={() => setLeague(l.id)}
                title={l.label}
                className={pillClass(on)}
              >
                {countryFlag(l.country) && (
                <span aria-hidden className="mr-1.5">{countryFlag(l.country)}</span>
              )}
              {l.name}
                {l.upcomingCount > 0 && <span className="ml-1.5 opacity-60">{l.upcomingCount}</span>}
                {!l.hasModel && (
                  <span className="ml-1.5 text-amber-400" title="Sin modelo Elo: solo mercado">
                    ◦
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      ) : (
        <div className="mb-6 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] p-5 text-[15px] text-rose-200">
          <p className="font-medium">No hay datos de fútbol todavía.</p>
          <p className="mt-1 text-rose-300/90">
            Ejecuta <code className="rounded bg-rose-900/40 px-1">npm run update-data:fb</code> para
            descargar equipos, resultados y partidos próximos.
          </p>
        </div>
      )}

      {active && !active.hasModel && (
        <div className="mb-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3 text-[15px] leading-relaxed text-amber-200/90">
          <strong>{active.name} sin modelo Elo.</strong> Sus equipos vienen de ligas distintas y sus
          ratings viven en cada tabla doméstica, así que un Elo compartido necesitaría una
          calibración entre ligas que esta app no hace. Se muestran los partidos y las
          probabilidades <em>del mercado</em>.
        </div>
      )}

      <StaleHistoryWarning
        info={staleness('football', activeMeta?.historyThrough, meta?.dataSource === 'seed')}
        what="Los Elo y los goles esperados"
        fix="npm run update-data:fb"
      />
      {league && <TrackRecordPanel league={league} />}

      {loading ? (
        <SkeletonList />
      ) : fixtures.length === 0 ? (
        <p className="mb-6 text-[16px] text-[#7b828d]">
          No hay partidos próximos para {active?.name ?? 'esta liga'}.
        </p>
      ) : (
        <>
          <DayFilter days={dayChips} selected={day} onSelect={setDay} />
          {shownGroups.map((group) => (
            <section key={group.key} className="mb-6">
              <DayHeading label={group.label} count={group.items.length} />
              <div className="space-y-4">
                {group.items.map((f) => (
                  <MatchCard
                    key={f.fixture.id}
                    item={f}
                    onOpenTeam={(lg, id) => setTeam({ league: lg, id })}
                  />
                ))}
              </div>
            </section>
          ))}
        </>
      )}

      {/* All teams in the league, ranked by Elo */}
      {power.length > 0 && (
        <div className="mt-8 rounded-xl border border-white/[0.07] bg-[#14161b] p-4">
          <button
            onClick={() => setShowTable((s) => !s)}
            className="flex w-full items-center justify-between text-left"
          >
            <span>
              <span className="text-[14px] uppercase tracking-wide text-[#7b828d]">
                Todos los equipos · {active?.name}
              </span>
              <br />
              <span className="text-[16px] text-[#d5d9df]">{power.length} equipos por Elo</span>
            </span>
            <span className="text-[14px] text-[#5c636c]">{showTable ? '▲' : '▼'}</span>
          </button>
          {showTable && (
            <div className="mt-3 overflow-x-auto border-t border-white/[0.07] pt-3">
              <table className="w-full text-left text-[14px] tabular-nums">
                <thead className="text-[#7b828d]">
                  <tr>
                    <th className="py-1 pr-2 font-normal">#</th>
                    <th className="py-1 pr-2 font-normal">Equipo</th>
                    <th className="py-1 pr-2 font-normal">Elo</th>
                    <th className="py-1 pr-2 font-normal">GF</th>
                    <th className="py-1 pr-2 font-normal">GC</th>
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
                      <td className="py-1 pr-2">{t.gf ?? '—'}</td>
                      <td className="py-1 pr-2">{t.ga ?? '—'}</td>
                      <td className="py-1">
                        {t.gf != null && t.ga != null
                          ? `${t.gf - t.ga > 0 ? '+' : ''}${(t.gf - t.ga).toFixed(2)}`
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

function TrackRecordPanel({ league }: { league: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof fbApi.trackRecord>> | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    fbApi
      .trackRecord(league)
      .then((d) => alive && setData(d))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [league]);

  if (!data || (data.resolved === 0 && data.pending === 0)) return null;

  return (
    <div className="mb-4 rounded-lg border border-white/[0.07] bg-white/[0.04] p-3">
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
              RPS <strong className="tabular-nums">{data.rps}</strong> en{' '}
              <strong className="tabular-nums">{data.resolved}</strong> partidos
              <span className="text-[#9aa1ac]">
                {' '}
                · acertó el resultado en {((data.accuracy ?? 0) * 100).toFixed(1)}%
              </span>
            </span>
          )}
        </span>
        <span className="shrink-0 text-[14px] text-[#5c636c]">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="mt-3 space-y-3 border-t border-white/[0.07] pt-3 text-[14px] text-[#c3c9d1]">
          <p className="text-[#9aa1ac]">
            El <strong>RPS</strong> (Ranked Probability Score) es la medida correcta para un 1X2:
            penaliza menos equivocarse por un escalón (decir «local» y salir empate) que por dos.
            Menor es mejor.
          </p>
          {data.draws && (
            <p>
              Empates: el modelo los eligió como resultado más probable en{' '}
              <strong>{data.draws.predicted}</strong> partidos y hubo{' '}
              <strong>{data.draws.actual}</strong>; probabilidad media asignada al empate{' '}
              <strong>{((data.draws.meanProbability ?? 0) * 100).toFixed(1)}%</strong>.
            </p>
          )}
          {data.vsMarket && (
            <p>
              Contra el mercado en {data.vsMarket.n} partidos: modelo RPS{' '}
              <strong>{data.vsMarket.modelRps}</strong> vs mercado{' '}
              <strong>{data.vsMarket.marketRps}</strong>.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function TeamProfile({
  league,
  id,
  onClose,
}: {
  league: string;
  id: string;
  onClose: () => void;
}) {
  const [team, setTeam] = useState<FbTeamInfo | null>(null);
  useEffect(() => {
    let alive = true;
    setTeam(null);
    fbApi.team(league, id).then((t) => alive && setTeam(t)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [league, id]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="mt-8 w-full max-w-lg rounded-xl border border-white/[0.07] bg-[#14161b] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-[20px] font-bold text-[#e8eaed]">{team?.name ?? id}</h2>
            {team && (
              <p className="text-[14px] text-[#9aa1ac]">
                Elo {Math.round(team.elo)} · #{team.eloRank} · {team.matchesInDb} partidos ·{' '}
                {team.points} puntos acumulados
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-[#9aa1ac] hover:text-[#d5d9df]">
            ✕
          </button>
        </div>
        {!team ? (
          <p className="text-[16px] text-[#7b828d]">Cargando…</p>
        ) : (
          <div className="space-y-4 text-[16px]">
            <div className="grid grid-cols-3 gap-x-4 gap-y-3 border-y border-white/[0.07] py-3 text-[14px]">
              <Stat label="Global" value={`${team.record.wins}-${team.record.draws}-${team.record.losses}`} />
              <Stat label="Casa" value={`${team.homeRecord.wins}-${team.homeRecord.draws}-${team.homeRecord.losses}`} />
              <Stat label="Fuera" value={`${team.awayRecord.wins}-${team.awayRecord.draws}-${team.awayRecord.losses}`} />
              <Stat label="Goles a favor" value={team.gf != null ? `${team.gf}/partido` : '—'} />
              <Stat label="Goles en contra" value={team.ga != null ? `${team.ga}/partido` : '—'} />
              <Stat
                label="Diferencia"
                value={
                  team.gf != null && team.ga != null
                    ? `${team.gf - team.ga > 0 ? '+' : ''}${(team.gf - team.ga).toFixed(2)}`
                    : '—'
                }
              />
            </div>
            <div>
              <div className="mb-1 text-[14px] uppercase tracking-wide text-[#7b828d]">
                Últimos partidos
              </div>
              <ul className="space-y-1 text-[14px]">
                {team.form.map((m, i) => (
                  <li key={i} className="flex items-center justify-between gap-2">
                    <span
                      className={
                        m.result === 'W'
                          ? 'text-emerald-400'
                          : m.result === 'D'
                            ? 'text-[#9aa1ac]'
                            : 'text-rose-400'
                      }
                    >
                      {m.result}
                    </span>
                    <span className="flex-1 truncate text-[#c3c9d1]">
                      {m.home ? 'vs' : '@'} {m.opponentName ?? m.opponentId}
                    </span>
                    <span className="tabular-nums text-[#9aa1ac]">
                      {m.goalsFor}–{m.goalsAgainst}
                    </span>
                    <span className="w-20 text-right text-[#5c636c]">{formatDate(m.date)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-[#7b828d]">{label}</div>
      <div className="tabular-nums text-[#e8eaed]">{value}</div>
    </div>
  );
}
