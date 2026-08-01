import { useEffect, useMemo, useState } from 'react';
import {
  bsbApi,
  type BsbGameWithPrediction,
  type BsbLeague,
  type BsbMeta,
  type BsbPowerTeam,
  type BsbTeamInfo,
  type BsbTrackRecord,
} from '../../lib/baseball';
import GameCard from './GameCard';
import { formatDate, formatDateTime } from '../../lib/format';

/**
 * The whole baseball tab. Holds its own state and talks only to /api/baseball/*,
 * so switching sports never mixes the four — the other three are untouched while
 * this one is mounted.
 */
export default function BaseballDashboard() {
  const [meta, setMeta] = useState<BsbMeta | null>(null);
  const [leagues, setLeagues] = useState<BsbLeague[]>([]);
  const [league, setLeague] = useState<string | null>(null);
  const [games, setGames] = useState<BsbGameWithPrediction[]>([]);
  const [power, setPower] = useState<BsbPowerTeam[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [team, setTeam] = useState<{ league: string; id: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showTeams, setShowTeams] = useState(false);

  useEffect(() => {
    Promise.all([bsbApi.meta(), bsbApi.leagues()])
      .then(([m, l]) => {
        setMeta(m);
        setLeagues(l);
      })
      .catch((e) =>
        setError(`No se pudo cargar el béisbol. ¿Ejecutaste "npm run update-data:bsb"? (${e})`),
      );
  }, []);

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
    Promise.all([bsbApi.upcoming(league), bsbApi.power(league, 40)])
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
      await bsbApi.refresh();
      const [m, l, g] = await Promise.all([
        bsbApi.meta(),
        bsbApi.leagues(),
        league ? bsbApi.upcoming(league) : Promise.resolve([]),
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
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-slate-400">
            Predicción con Elo por equipo, ventaja de campo, el <strong>lanzador abridor</strong> y
            una distribución de carreras que produce ganador, total y línea de una sola vez.
          </p>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            title="Vuelve a consultar los partidos próximos, sus cuotas y los abridores anunciados"
            className="shrink-0 rounded-lg bg-slate-800 px-3 py-1 text-xs font-medium text-slate-200 ring-1 ring-slate-600 transition hover:bg-slate-700 disabled:opacity-50"
          >
            {refreshing ? 'Actualizando…' : '↻ Actualizar'}
          </button>
        </div>
        {meta && <DataLine meta={meta} />}
        {leagueMeta && <StaleWarning name={leagueMeta.name} through={leagueMeta.historyThrough} />}
        {league && <TrackRecordPanel league={league} />}
      </header>

      {error && (
        <div className="mb-4 rounded-lg border border-rose-800 bg-rose-950/50 p-3 text-sm text-rose-300">
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
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                league === l.id
                  ? 'bg-amber-400 text-slate-900'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {l.name}
              {l.upcomingCount > 0 && <span className="ml-1.5 opacity-60">{l.upcomingCount}</span>}
              {!l.hasModel && <span className="ml-1.5 text-amber-400" title="Sin modelo Elo">◦</span>}
            </button>
          ))}
        </div>
      ) : (
        <div className="mb-6 rounded-lg border border-rose-800/60 bg-rose-950/40 p-4 text-sm text-rose-200">
          <p className="font-medium">No hay datos de béisbol todavía.</p>
          <p className="mt-1 text-rose-300/90">
            Ejecuta <code className="rounded bg-rose-900/40 px-1">npm run update-data:bsb</code> para
            descargar equipos, resultados, lanzadores y partidos próximos.
          </p>
        </div>
      )}

      {activeLeague && !activeLeague.hasModel && (
        <div className="mb-4 rounded-lg border border-amber-700/60 bg-amber-950/40 p-3 text-sm text-amber-200">
          <strong>{activeLeague.name} sin modelo propio.</strong> No existe un archivo abierto,
          partido a partido, para esta liga —y menos aún con el abridor de cada encuentro, que es lo
          que de verdad hace falta en béisbol—, así que se muestran los partidos y las
          probabilidades <em>implícitas del mercado</em>.
        </div>
      )}

      {loading ? (
        <p className="text-slate-500">Cargando partidos…</p>
      ) : games.length === 0 ? (
        <p className="mb-6 text-sm text-slate-500">
          No hay partidos próximos para {activeLeague?.name ?? 'esta liga'}.
        </p>
      ) : (
        <div className="space-y-4">
          {games.map((g) => (
            <GameCard key={g.game.id} item={g} onOpenTeam={(lg, id) => setTeam({ league: lg, id })} />
          ))}
        </div>
      )}

      {power.length > 0 && (
        <div className="mt-8 rounded-xl border border-slate-700/60 bg-slate-800/40 p-4">
          <button
            onClick={() => setShowTeams((s) => !s)}
            className="flex w-full items-center justify-between text-left"
          >
            <span>
              <span className="text-xs uppercase tracking-wide text-slate-500">
                Todos los equipos · {activeLeague?.name}
              </span>
              <br />
              <span className="text-sm text-slate-200">{power.length} equipos ordenados por Elo</span>
            </span>
            <span className="text-xs text-sky-400">{showTeams ? '▲' : '▼'}</span>
          </button>
          {showTeams && (
            <div className="mt-3 overflow-x-auto border-t border-slate-700/60 pt-3">
              <table className="w-full text-left text-xs tabular-nums">
                <thead className="text-slate-500">
                  <tr>
                    <th className="py-1 pr-2">#</th>
                    <th className="py-1 pr-2">Equipo</th>
                    <th className="py-1 pr-2 text-right">Elo</th>
                    <th className="py-1 pr-2 text-right">CF/p</th>
                    <th className="py-1 pr-2 text-right">CC/p</th>
                    <th className="py-1 text-right">Partidos</th>
                  </tr>
                </thead>
                <tbody>
                  {power.map((t, i) => (
                    <tr key={t.id} className="border-t border-slate-700/40">
                      <td className="py-1 pr-2 text-slate-500">{i + 1}</td>
                      <td className="py-1 pr-2">
                        <button
                          className="text-slate-200 hover:underline"
                          onClick={() => setTeam({ league: league!, id: t.id })}
                        >
                          {t.name ?? t.id}
                        </button>
                      </td>
                      <td className="py-1 pr-2 text-right text-slate-200">{Math.round(t.elo)}</td>
                      <td className="py-1 pr-2 text-right text-slate-400">{t.rs ?? '—'}</td>
                      <td className="py-1 pr-2 text-right text-slate-400">{t.ra ?? '—'}</td>
                      <td className="py-1 text-right text-slate-500">{t.games}</td>
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

function DataLine({ meta }: { meta: BsbMeta }) {
  const real = meta.dataSource === 'retrosheet';
  return (
    <div className="mt-2 space-y-1 text-xs text-slate-500">
      <p>
        <span
          className={`rounded px-1.5 py-0.5 ${
            real ? 'bg-emerald-900/40 text-emerald-300' : 'bg-amber-900/40 text-amber-300'
          }`}
        >
          {real ? 'datos reales (Retrosheet)' : 'sin datos'}
        </span>{' '}
        · {meta.counts.games.toLocaleString('es')} partidos · {meta.counts.teams} equipos
        {meta.updatedAt && <> · actualizado {formatDate(meta.updatedAt.slice(0, 10).replace(/-/g, ''))}</>}
      </p>
      <p>
        {meta.oddsRefreshedAt && <>Cuotas: {formatDateTime(meta.oddsRefreshedAt)} · </>}
        {meta.probables > 0 ? (
          <>abridores anunciados para {meta.probables} partidos</>
        ) : (
          <>
            sin feed de abridores: se usa el número uno de cada rotación y la tarjeta lo indica
          </>
        )}
        {!meta.hasOddsKey && <> · configura ODDS_API_KEY para cuotas reales</>}
      </p>
    </div>
  );
}

function StaleWarning({ name, through }: { name: string; through: string | null }) {
  if (!through) return null;
  const y = Number(through.slice(0, 4));
  const m = Number(through.slice(4, 6));
  const months = (new Date().getUTCFullYear() - y) * 12 + (new Date().getUTCMonth() + 1 - m);
  // Baseball's off-season runs November to March, so a five-month gap in February
  // is normal rather than a problem worth shouting about.
  if (months <= 6) return null;
  return (
    <div className="mt-2 rounded-lg border border-amber-700/60 bg-amber-950/40 p-2 text-xs text-amber-200">
      ⚠️ El historial de {name} termina en {m}/{y} (~{Math.round(months / 12 * 10) / 10} años). Los Elo
      no describen a las plantillas actuales. Vuelve a ejecutar{' '}
      <code className="rounded bg-amber-900/40 px-1">npm run update-data:bsb</code>.
    </div>
  );
}

function TrackRecordPanel({ league }: { league: string }) {
  const [rec, setRec] = useState<BsbTrackRecord | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    bsbApi.trackRecord(league).then(setRec).catch(() => setRec(null));
  }, [league]);
  if (!rec || (rec.resolved === 0 && rec.pending === 0)) return null;

  return (
    <div className="mt-3 rounded-lg border border-slate-700/60 bg-slate-800/40 p-3 text-xs">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between">
        <span className="text-slate-300">
          <span className="uppercase tracking-wide text-slate-500">Cómo va acertando</span>{' '}
          {rec.resolved > 0 ? (
            <>
              — {rec.resolved} predicciones resueltas
              {rec.accuracy != null && <>, {(rec.accuracy * 100).toFixed(1)}% de acierto</>}
              {rec.brier != null && <> · Brier {rec.brier.toFixed(4)}</>}
            </>
          ) : (
            <>— {rec.pending} pendientes de jugarse</>
          )}
        </span>
        <span className="text-sky-400">{open ? '▲' : '▼'}</span>
      </button>
      {open && rec.resolved > 0 && (
        <div className="mt-2 space-y-2 border-t border-slate-700/60 pt-2 text-slate-300">
          {rec.totalMae != null && (
            <p>
              Error del total de carreras: {rec.totalMae.toFixed(2)}
              {rec.totalBias != null && (
                <> · sesgo {rec.totalBias >= 0 ? '+' : ''}{rec.totalBias.toFixed(2)}</>
              )}
            </p>
          )}
          {rec.byStarterKnown.length > 0 && (
            <div>
              <div className="text-slate-500">Según se supieran los abridores:</div>
              {rec.byStarterKnown.map((b) => (
                <div key={String(b.known)} className="flex justify-between">
                  <span>{b.known ? 'anunciados' : 'estimados'} ({b.n})</span>
                  <span className="tabular-nums">
                    {b.accuracy != null ? `${(b.accuracy * 100).toFixed(1)}%` : '—'}
                    {b.brier != null && ` · Brier ${b.brier.toFixed(4)}`}
                  </span>
                </div>
              ))}
            </div>
          )}
          {rec.vsMarket && (
            <p>
              Contra el mercado ({rec.vsMarket.n}): modelo Brier{' '}
              {rec.vsMarket.modelBrier?.toFixed(4) ?? '—'} vs mercado{' '}
              {rec.vsMarket.marketBrier?.toFixed(4) ?? '—'}
            </p>
          )}
          <p className="text-slate-500">
            Solo cuenta lo que la app dijo ANTES de cada partido y nunca se reescribe.
          </p>
        </div>
      )}
    </div>
  );
}

function TeamProfile({ league, id, onClose }: { league: string; id: string; onClose: () => void }) {
  const [info, setInfo] = useState<BsbTeamInfo | null>(null);
  useEffect(() => {
    bsbApi.team(league, id).then(setInfo).catch(() => setInfo(null));
  }, [league, id]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/80 p-4"
      onClick={onClose}
    >
      <div
        className="mt-8 w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between">
          <h3 className="text-lg font-semibold text-slate-100">{info?.name ?? 'Cargando…'}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200">✕</button>
        </div>
        {!info ? (
          <p className="text-sm text-slate-500">Cargando ficha…</p>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <Stat label="Elo" value={`${Math.round(info.elo)} (#${info.eloRank})`} />
              <Stat label="Balance" value={`${info.record.wins}-${info.record.losses}`} />
              <Stat label="En casa" value={`${info.homeRecord.wins}-${info.homeRecord.losses}`} />
              <Stat label="Fuera" value={`${info.awayRecord.wins}-${info.awayRecord.losses}`} />
              <Stat label="Carreras a favor / partido" value={info.rs ?? '—'} />
              <Stat label="Carreras en contra / partido" value={info.ra ?? '—'} />
              <Stat
                label="Pitagórico"
                value={info.pythagorean != null ? `${(info.pythagorean * 100).toFixed(1)}%` : '—'}
                hint="Lo que sus carreras dicen que debería ser su balance. La diferencia con el real es la parte de suerte."
              />
              <Stat label="Partidos en el historial" value={info.gamesInDb} />
            </div>

            {info.rotation.length > 0 && (
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-slate-500">Rotación</div>
                <table className="w-full text-left text-xs tabular-nums">
                  <thead className="text-slate-500">
                    <tr>
                      <th className="py-1 pr-2">Lanzador</th>
                      <th className="py-1 pr-2 text-right">Aperturas</th>
                      <th className="py-1 pr-2 text-right">C/apertura</th>
                      <th className="py-1 text-right" title="Carreras permitidas frente a lo esperado; por debajo de 0% es mejor que la media">
                        vs esperado
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {info.rotation.map((p) => (
                      <tr key={p.id} className="border-t border-slate-700/40">
                        <td className="py-1 pr-2 text-slate-200">{p.name}</td>
                        <td className="py-1 pr-2 text-right text-slate-400">{p.starts}</td>
                        <td className="py-1 pr-2 text-right text-slate-400">{p.runsPer9 ?? '—'}</td>
                        <td
                          className="py-1 text-right"
                          style={{ color: (p.rating ?? 1) <= 1 ? '#34d399' : '#fb7185' }}
                        >
                          {p.rating != null
                            ? `${p.rating <= 1 ? '−' : '+'}${Math.abs(Math.round((p.rating - 1) * 100))}%`
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {info.form.length > 0 && (
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-slate-500">
                  Últimos partidos
                </div>
                <ul className="space-y-1 text-xs">
                  {info.form.map((f, i) => (
                    <li key={i} className="flex justify-between text-slate-300">
                      <span className="text-slate-500">{formatDate(f.date)}</span>
                      <span>
                        {f.home ? 'vs' : '@'} {f.opponentName ?? f.opponentId}{' '}
                        <span className={f.result === 'W' ? 'text-emerald-400' : 'text-rose-400'}>
                          {f.result} {f.runsFor}-{f.runsAgainst}
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
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded bg-slate-800/60 p-2" title={hint}>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="font-semibold text-slate-100">{value}</div>
    </div>
  );
}
