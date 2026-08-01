import { useEffect, useMemo, useState } from 'react';
import {
  fbApi,
  type FbFixtureWithPrediction,
  type FbLeague,
  type FbMeta,
  type FbPowerTeam,
  type FbTeamInfo,
} from '../../lib/football';
import MatchCard from './MatchCard';
import { formatDate } from '../../lib/format';

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

  const active = leagues.find((l) => l.id === league) ?? null;
  const activeMeta = meta?.leagues.find((l) => l.id === league) ?? null;

  return (
    <div>
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-slate-400">
            Predicción 1X2, goles y marcadores con Elo por equipo, ventaja de campo y odds del
            mercado.
          </p>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="shrink-0 rounded-lg bg-slate-800 px-3 py-1 text-xs font-medium text-slate-200 ring-1 ring-slate-600 transition hover:bg-slate-700 disabled:opacity-50"
          >
            {refreshing ? 'Actualizando…' : '↻ Actualizar'}
          </button>
        </div>
        {meta && (
          <p className="mt-1 text-xs text-slate-500">
            {meta.counts.matches} partidos · {meta.counts.teams} equipos
            {!meta.hasOddsKey && ' · configura ODDS_API_KEY para partidos y cuotas reales'}
          </p>
        )}
      </header>

      {error && (
        <div className="mb-4 rounded-lg border border-rose-800 bg-rose-950/50 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {/* ---- LEAGUE SUB-TABS ---- */}
      {selectable.length > 0 ? (
        <nav
          className="mb-4 flex flex-wrap gap-1 border-b border-slate-700 pb-px"
          role="tablist"
          aria-label="Ligas"
        >
          {selectable.map((l) => {
            const on = league === l.id;
            return (
              <button
                key={l.id}
                role="tab"
                aria-selected={on}
                onClick={() => setLeague(l.id)}
                title={l.label}
                className={`-mb-px rounded-t-lg border-b-2 px-3 py-1.5 text-xs font-medium transition ${
                  on
                    ? 'border-emerald-400 bg-slate-800/60 text-slate-100'
                    : 'border-transparent text-slate-400 hover:bg-slate-800/30 hover:text-slate-200'
                }`}
              >
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
        <div className="mb-6 rounded-lg border border-rose-800/60 bg-rose-950/40 p-4 text-sm text-rose-200">
          <p className="font-medium">No hay datos de fútbol todavía.</p>
          <p className="mt-1 text-rose-300/90">
            Ejecuta <code className="rounded bg-rose-900/40 px-1">npm run update-data:fb</code> para
            descargar equipos, resultados y partidos próximos.
          </p>
        </div>
      )}

      {active && !active.hasModel && (
        <div className="mb-4 rounded-lg border border-amber-700/60 bg-amber-950/40 p-3 text-sm text-amber-200">
          <strong>{active.name} sin modelo Elo.</strong> Sus equipos vienen de ligas distintas y sus
          ratings viven en cada tabla doméstica, así que un Elo compartido necesitaría una
          calibración entre ligas que esta app no hace. Se muestran los partidos y las
          probabilidades <em>del mercado</em>.
        </div>
      )}

      {activeMeta && <StaleWarning name={activeMeta.name} through={activeMeta.historyThrough} />}
      {league && <TrackRecordPanel league={league} />}

      {loading ? (
        <p className="text-slate-500">Cargando partidos…</p>
      ) : fixtures.length === 0 ? (
        <p className="mb-6 text-sm text-slate-500">
          No hay partidos próximos para {active?.name ?? 'esta liga'}.
        </p>
      ) : (
        <div className="space-y-4">
          {fixtures.map((f) => (
            <MatchCard
              key={f.fixture.id}
              item={f}
              onOpenTeam={(lg, id) => setTeam({ league: lg, id })}
            />
          ))}
        </div>
      )}

      {/* All teams in the league, ranked by Elo */}
      {power.length > 0 && (
        <div className="mt-8 rounded-xl border border-slate-700/60 bg-slate-800/40 p-4">
          <button
            onClick={() => setShowTable((s) => !s)}
            className="flex w-full items-center justify-between text-left"
          >
            <span>
              <span className="text-xs uppercase tracking-wide text-slate-500">
                Todos los equipos · {active?.name}
              </span>
              <br />
              <span className="text-sm text-slate-200">{power.length} equipos por Elo</span>
            </span>
            <span className="text-xs text-sky-400">{showTable ? '▲' : '▼'}</span>
          </button>
          {showTable && (
            <div className="mt-3 overflow-x-auto border-t border-slate-700/60 pt-3">
              <table className="w-full text-left text-xs tabular-nums">
                <thead className="text-slate-500">
                  <tr>
                    <th className="py-1 pr-2 font-normal">#</th>
                    <th className="py-1 pr-2 font-normal">Equipo</th>
                    <th className="py-1 pr-2 font-normal">Elo</th>
                    <th className="py-1 pr-2 font-normal">GF</th>
                    <th className="py-1 pr-2 font-normal">GC</th>
                    <th className="py-1 font-normal">Dif.</th>
                  </tr>
                </thead>
                <tbody className="text-slate-200">
                  {power.map((t, i) => (
                    <tr key={t.id} className="border-t border-slate-800">
                      <td className="py-1 pr-2 text-slate-500">{i + 1}</td>
                      <td className="py-1 pr-2">
                        <button
                          onClick={() => setTeam({ league: league!, id: t.id })}
                          className="text-sky-300 hover:underline"
                        >
                          {t.name}
                        </button>
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

function StaleWarning({ name, through }: { name: string; through: string | null }) {
  if (!through) return null;
  const y = Number(through.slice(0, 4));
  const m = Number(through.slice(4, 6));
  if (!y || !m) return null;
  const monthsOld = (new Date().getFullYear() - y) * 12 + (new Date().getMonth() + 1 - m);
  // Football has a real summer break, so a few stale months is normal.
  if (monthsOld <= 5) return null;
  return (
    <div className="mb-4 rounded-lg border border-amber-700/60 bg-amber-950/40 p-3 text-sm text-amber-200">
      ⚠️ Los resultados de {name} terminan en {m}/{y} (~{Math.round(monthsOld)} meses). Los Elo{' '}
      <strong>no describen a las plantillas actuales</strong>. Vuelve a ejecutar{' '}
      <code className="rounded bg-amber-900/40 px-1">npm run update-data:fb</code> para datos al día.
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
    <div className="mb-4 rounded-lg border border-slate-700/60 bg-slate-800/40 p-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">
            Aciertos reales de la app
          </span>
          <br />
          {data.resolved === 0 ? (
            <span className="text-slate-300">
              {data.pending} predicción(es) registradas, esperando resultado.
            </span>
          ) : (
            <span className="text-slate-100">
              RPS <strong className="tabular-nums">{data.rps}</strong> en{' '}
              <strong className="tabular-nums">{data.resolved}</strong> partidos
              <span className="text-slate-400">
                {' '}
                · acertó el resultado en {((data.accuracy ?? 0) * 100).toFixed(1)}%
              </span>
            </span>
          )}
        </span>
        <span className="shrink-0 text-xs text-sky-400">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="mt-3 space-y-3 border-t border-slate-700/60 pt-3 text-xs text-slate-300">
          <p className="text-slate-400">
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
        className="mt-8 w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-100">{team?.name ?? id}</h2>
            {team && (
              <p className="text-xs text-slate-400">
                Elo {Math.round(team.elo)} · #{team.eloRank} · {team.matchesInDb} partidos ·{' '}
                {team.points} puntos acumulados
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200">
            ✕
          </button>
        </div>
        {!team ? (
          <p className="text-sm text-slate-500">Cargando…</p>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-3 gap-2 text-xs">
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
              <div className="mb-1 text-xs uppercase tracking-wide text-slate-500">
                Últimos partidos
              </div>
              <ul className="space-y-1 text-xs">
                {team.form.map((m, i) => (
                  <li key={i} className="flex items-center justify-between gap-2">
                    <span
                      className={
                        m.result === 'W'
                          ? 'text-emerald-400'
                          : m.result === 'D'
                            ? 'text-slate-400'
                            : 'text-rose-400'
                      }
                    >
                      {m.result}
                    </span>
                    <span className="flex-1 truncate text-slate-300">
                      {m.home ? 'vs' : '@'} {m.opponentName ?? m.opponentId}
                    </span>
                    <span className="tabular-nums text-slate-400">
                      {m.goalsFor}–{m.goalsAgainst}
                    </span>
                    <span className="w-20 text-right text-slate-600">{formatDate(m.date)}</span>
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
    <div className="rounded bg-slate-800/60 p-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="tabular-nums text-slate-100">{value}</div>
    </div>
  );
}
