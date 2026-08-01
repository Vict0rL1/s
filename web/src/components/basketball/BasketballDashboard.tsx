import { useEffect, useMemo, useState } from 'react';
import { SkeletonList } from '../ui';
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

  const activeLeague = leagues.find((l) => l.id === league) ?? null;
  const leagueMeta = meta?.leagues.find((l) => l.id === league) ?? null;

  return (
    <div>
      <header className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-prose text-[13px] leading-relaxed text-slate-400">
            Predicción de partidos con Elo por equipo, ventaja de campo, margen de puntos, descanso
            y odds del mercado.
          </p>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            title="Vuelve a consultar los partidos próximos y sus cuotas"
            className="shrink-0 rounded-lg bg-white/[0.06] px-3 py-1.5 text-[12px] font-medium text-slate-200 ring-1 ring-inset ring-white/10 transition hover:bg-white/[0.1] disabled:opacity-50"
          >
            {refreshing ? 'Actualizando…' : '↻ Actualizar'}
          </button>
        </div>
        {meta && <DataLine meta={meta} />}
        {leagueMeta && <StaleWarning name={leagueMeta.name} through={leagueMeta.historyThrough} />}
        {league && <BbTrackRecordPanel league={league} />}
      </header>

      {error && (
        <div className="mb-4 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] p-3 text-[13px] text-rose-200">
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
              className={`rounded-full px-3 py-1.5 text-[12px] font-medium transition ${
                league === l.id
                  ? 'bg-white/[0.14] text-slate-100 ring-1 ring-inset ring-white/20'
                  : 'bg-white/[0.04] text-slate-400 ring-1 ring-inset ring-white/[0.06] hover:bg-white/[0.08] hover:text-slate-200'
              }`}
            >
              {l.name}
              {l.upcomingCount > 0 && <span className="ml-1.5 opacity-60">{l.upcomingCount}</span>}
              {!l.hasModel && <span className="ml-1.5 text-amber-400" title="Sin modelo Elo">◦</span>}
            </button>
          ))}
        </div>
      ) : (
        <div className="mb-6 rounded-2xl border border-rose-500/25 bg-rose-500/[0.06] p-5 text-[13px] text-rose-200">
          <p className="font-medium">No hay datos de baloncesto todavía.</p>
          <p className="mt-1 text-rose-300/90">
            Ejecuta <code className="rounded bg-rose-900/40 px-1">npm run update-data:bb</code> para
            descargar equipos, resultados y partidos próximos.
          </p>
        </div>
      )}

      {activeLeague && !activeLeague.hasModel && (
        <div className="mb-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3 text-[13px] leading-relaxed text-amber-200/90">
          <strong>{activeLeague.name} sin modelo Elo.</strong> No hay una fuente abierta de
          resultados para esta liga, así que se muestran los partidos y las probabilidades{' '}
          <em>implícitas del mercado</em>, no una predicción propia. Se indica en cada tarjeta.
        </div>
      )}

      {/* Games */}
      {loading ? (
        <SkeletonList />
      ) : games.length === 0 ? (
        <p className="mb-6 text-sm text-slate-500">
          No hay partidos próximos para {activeLeague?.name ?? 'esta liga'}.
        </p>
      ) : (
        <div className="space-y-4">
          {games.map((g) => (
            <GameCard
              key={g.game.id}
              item={g}
              onOpenTeam={(lg, id) => setTeam({ league: lg, id })}
            />
          ))}
        </div>
      )}

      {/* All teams, by Elo — "la información de todos los equipos" */}
      {power.length > 0 && (
        <div className="mt-8 rounded-2xl border border-white/[0.07] bg-slate-900/70 p-4">
          <button
            onClick={() => setShowTeams((s) => !s)}
            className="flex w-full items-center justify-between text-left"
          >
            <span>
              <span className="text-xs uppercase tracking-wide text-slate-500">
                Todos los equipos · {activeLeague?.name}
              </span>
              <br />
              <span className="text-sm text-slate-200">
                {power.length} equipos ordenados por Elo
              </span>
            </span>
            <span className="text-xs text-sky-400">{showTeams ? '▲' : '▼'}</span>
          </button>
          {showTeams && (
            <div className="mt-3 overflow-x-auto border-t border-slate-700/60 pt-3">
              <table className="w-full text-left text-xs tabular-nums">
                <thead className="text-slate-500">
                  <tr>
                    <th className="py-1 pr-2 font-normal">#</th>
                    <th className="py-1 pr-2 font-normal">Equipo</th>
                    <th className="py-1 pr-2 font-normal">Elo</th>
                    <th className="py-1 pr-2 font-normal">Anota</th>
                    <th className="py-1 pr-2 font-normal">Recibe</th>
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
    <p className="mt-1 text-xs text-slate-500">
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
function StaleWarning({ name, through }: { name: string; through: string | null }) {
  if (!through) return null;
  const y = Number(through.slice(0, 4));
  const m = Number(through.slice(4, 6));
  if (!y || !m) return null;
  const monthsOld = (new Date().getFullYear() - y) * 12 + (new Date().getMonth() + 1 - m);
  if (monthsOld <= 4) return null;
  return (
    <div className="mt-3 rounded-lg border border-amber-700/60 bg-amber-950/40 p-3 text-sm text-amber-200">
      ⚠️ Los resultados de {name} terminan en {m}/{y} (~{Math.round(monthsOld)} meses). Los Elo{' '}
      <strong>no describen a las plantillas actuales</strong>, así que estas predicciones son poco
      fiables. Vuelve a ejecutar{' '}
      <code className="rounded bg-amber-900/40 px-1">npm run update-data:bb</code> con acceso a
      ESPN para datos al día.
    </div>
  );
}

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
    <div className="mt-3 rounded-lg border border-slate-700/60 bg-slate-800/40 p-3">
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
              <strong className="tabular-nums">{((data.accuracy ?? 0) * 100).toFixed(1)}%</strong> de
              acierto en <strong className="tabular-nums">{data.resolved}</strong> partidos jugados
              {data.marginMae != null && (
                <span className="text-slate-400"> · error de margen {data.marginMae} pts</span>
              )}
              {thin && <span className="text-amber-400"> · muestra pequeña</span>}
            </span>
          )}
        </span>
        <span className="shrink-0 text-xs text-sky-400">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-4 border-t border-slate-700/60 pt-3 text-xs">
          <p className="text-slate-400">
            Cada predicción se guarda <strong>antes</strong> del partido y se puntúa cuando llega el
            resultado real (al ejecutar{' '}
            <code className="rounded bg-slate-900/60 px-1">npm run update-data:bb</code>). No es el
            backtest histórico: son los partidos que viste aquí.
          </p>
          {data.resolved > 0 && (
            <div className="grid grid-cols-4 gap-2">
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
              <div className="mb-1 uppercase tracking-wide text-slate-500">
                Modelo vs mercado ({data.vsMarket.n} partidos con cuotas)
              </div>
              <table className="w-full text-left tabular-nums">
                <thead className="text-slate-500">
                  <tr>
                    <th className="py-1 font-normal">&nbsp;</th>
                    <th className="py-1 font-normal">Acierto</th>
                    <th className="py-1 font-normal">Brier</th>
                  </tr>
                </thead>
                <tbody className="text-slate-200">
                  <tr>
                    <td className="py-1 text-slate-400">Modelo</td>
                    <td>{fmtPct(data.vsMarket.modelAccuracy)}</td>
                    <td>{data.vsMarket.modelBrier?.toFixed(4) ?? '—'}</td>
                  </tr>
                  <tr>
                    <td className="py-1 text-slate-400">Mercado</td>
                    <td>{fmtPct(data.vsMarket.marketAccuracy)}</td>
                    <td>{data.vsMarket.marketBrier?.toFixed(4) ?? '—'}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          {data.recent.length > 0 && (
            <div>
              <div className="mb-1 uppercase tracking-wide text-slate-500">Últimas resueltas</div>
              <ul className="space-y-1">
                {data.recent.map((r, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className={r.hit ? 'text-emerald-400' : 'text-rose-400'}>
                      {r.hit ? '✓' : '✗'}
                    </span>
                    <span className="text-slate-300">
                      {r.away} @ {r.home}
                      <span className="text-slate-500">
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
    <div className="rounded bg-slate-900/50 p-2">
      <div className="text-slate-500">{label}</div>
      <div className="tabular-nums text-slate-100">{value}</div>
      {hint && <div className="text-[10px] text-slate-600">{hint}</div>}
    </div>
  );
}

function fmtPct(v: number | null): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
}
