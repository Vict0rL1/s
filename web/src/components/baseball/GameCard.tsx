import { useEffect, useState } from 'react';
import {
  bsbApi,
  type BsbGameWithPrediction,
  type BsbPitcher,
  type BsbPrediction,
  type BsbReliability,
  type BsbSide,
} from '../../lib/baseball';
import { formatDateTime, formatDate } from '../../lib/format';
import RunMatrix from './RunMatrix';

export const HOME_COLOR = '#fbbf24'; // amber — baseball gets its own palette
export const AWAY_COLOR = '#38bdf8'; // sky

const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

export default function GameCard({
  item,
  onOpenTeam,
}: {
  item: BsbGameWithPrediction;
  onOpenTeam: (league: string, id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // The starting pitchers the user has chosen, and the prediction the server
  // returns for them. Held here because EVERYTHING on the card comes out of the
  // same run distribution: change a starter and the winner, the total, the run
  // line and the whole matrix have to move together.
  const [homeSp, setHomeSp] = useState<string | null | undefined>(undefined);
  const [awaySp, setAwaySp] = useState<string | null | undefined>(undefined);
  const [adjusted, setAdjusted] = useState<BsbPrediction | null>(null);
  const [adjusting, setAdjusting] = useState(false);

  const { game, marketOnly, teams, startersAnnounced } = item;
  const dirty = homeSp !== undefined || awaySp !== undefined;

  useEffect(() => {
    if (!dirty) {
      setAdjusted(null);
      return;
    }
    let live = true;
    setAdjusting(true);
    bsbApi
      .game(game.id, { home: homeSp, away: awaySp })
      .then((r) => live && setAdjusted(r.prediction))
      // Falling back to the unadjusted call is right: a failed re-predict must
      // never leave the card showing numbers for a matchup nobody asked for.
      .catch(() => live && setAdjusted(null))
      .finally(() => live && setAdjusting(false));
    return () => {
      live = false;
    };
  }, [game.id, homeSp, awaySp, dirty]);

  const prediction = adjusted ?? item.prediction;
  const probs = prediction?.model ?? marketOnly ?? null;
  const fromModel = !!prediction;

  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-800/40 p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between text-xs text-slate-400">
        <span>{formatDateTime(game.commence_time)}</span>
        <div className="flex items-center gap-2">
          {!startersAnnounced && prediction && (
            <span
              className="rounded bg-slate-700/60 px-2 py-0.5 text-slate-300"
              title="Ningún feed ha anunciado los abridores; se usa el número uno de cada rotación"
            >
              abridores estimados
            </span>
          )}
          {game.source === 'fixture' && (
            <span className="rounded bg-amber-900/40 px-2 py-0.5 text-amber-300">partido demo</span>
          )}
        </div>
      </div>

      {/* Away @ Home — baseball is written away-first, unlike the other three */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <TeamName
          name={prediction?.teams.away.name ?? game.away_name}
          color={AWAY_COLOR}
          elo={prediction?.teams.away.elo ?? teams.away?.elo ?? null}
          eloRank={prediction?.teams.away.eloRank ?? teams.away?.eloRank ?? null}
          odds={game.odds_away}
          onClick={game.away_id ? () => onOpenTeam(game.league, game.away_id!) : undefined}
        />
        <span className="px-2 pt-1 text-xs text-slate-500">@</span>
        <TeamName
          name={prediction?.teams.home.name ?? game.home_name}
          color={HOME_COLOR}
          elo={prediction?.teams.home.elo ?? teams.home?.elo ?? null}
          eloRank={prediction?.teams.home.eloRank ?? teams.home?.eloRank ?? null}
          odds={game.odds_home}
          homeBadge
          alignRight
          onClick={game.home_id ? () => onOpenTeam(game.league, game.home_id!) : undefined}
        />
      </div>

      {probs ? (
        <>
          <div className="grid grid-cols-2 gap-2 text-center">
            <Outcome
              label="Visitante"
              value={probs.away}
              color={AWAY_COLOR}
              odds={game.odds_away}
              runs={prediction?.runs.expectedAway}
            />
            <Outcome
              label="Local"
              value={probs.home}
              color={HOME_COLOR}
              odds={game.odds_home}
              runs={prediction?.runs.expectedHome}
            />
          </div>
          {!fromModel && (
            <p className="mt-2 text-center text-[11px] text-amber-400">
              Probabilidades implícitas del mercado, no del modelo.
            </p>
          )}
          <Bar home={probs.home} />

          {prediction && (
            <>
              {/* The starting pitchers get top billing: in baseball nothing else
                  a single player does moves the number this much. */}
              <div className="mt-3 grid grid-cols-2 gap-2">
                <StarterChip side={prediction.teams.away} color={AWAY_COLOR} />
                <StarterChip side={prediction.teams.home} color={HOME_COLOR} />
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <Figure
                  label="Carreras"
                  value={`${prediction.runs.expectedAway} – ${prediction.runs.expectedHome}`}
                  hint={`total ${prediction.runs.expectedTotal}`}
                />
                <Figure
                  label={`+${prediction.runs.totalLine}`}
                  value={pct(prediction.runs.over)}
                  hint={`−${prediction.runs.totalLine}: ${pct(prediction.runs.under)}`}
                />
                <Figure
                  label="Línea −1.5"
                  value={pct(prediction.runs.runLine.homeCovers)}
                  hint={`local por 2+`}
                />
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm">
                  {prediction.verdict.close ? (
                    <span className="text-slate-300">
                      Muy igualado —{' '}
                      <strong className="text-slate-100">{prediction.verdict.label}</strong> solo por
                      poco ({pct(prediction.verdict.probability)})
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
                        : prediction.teams.away.name}
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
                {open ? '▲ Ocultar desglose' : '▼ Ver desglose (abridores · carreras · mercado)'}
              </button>
              {open && (
                <Detail
                  prediction={prediction}
                  league={game.league}
                  homeSp={homeSp}
                  awaySp={awaySp}
                  onHomeSp={setHomeSp}
                  onAwaySp={setAwaySp}
                  adjusting={adjusting}
                  adjusted={dirty}
                />
              )}
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
  label, value, color, odds, runs,
}: { label: string; value: number; color: string; odds: number | null; runs?: number }) {
  return (
    <div className="rounded-lg bg-slate-900/50 p-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-2xl font-bold tabular-nums" style={{ color }}>
        {(value * 100).toFixed(1)}
        <span className="text-sm">%</span>
      </div>
      {runs != null && <div className="text-[10px] tabular-nums text-slate-400">{runs} carreras esp.</div>}
      {odds != null && <div className="text-[10px] text-slate-500">cuota {odds}</div>}
    </div>
  );
}

function Bar({ home }: { home: number }) {
  return (
    <div className="mt-2 flex h-4 overflow-hidden rounded">
      <div style={{ width: `${(1 - home) * 100}%`, backgroundColor: AWAY_COLOR }} />
      <div style={{ width: `${home * 100}%`, backgroundColor: HOME_COLOR }} />
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

function StarterChip({ side, color }: { side: BsbSide; color: string }) {
  const s = side.starter;
  return (
    <div className="min-w-0 rounded-lg bg-slate-900/50 p-2" title={s.label}>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">Abridor</div>
      <div className="truncate text-sm font-semibold" style={{ color }}>
        {s.name ?? 'sin anunciar'}
      </div>
      <div className="truncate text-[10px] text-slate-500">{s.label}</div>
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

function ReliabilityBadge({ reliability }: { reliability: BsbReliability }) {
  const styles: Record<BsbReliability['level'], string> = {
    high: 'bg-emerald-900/40 text-emerald-300 ring-emerald-500/40',
    medium: 'bg-amber-900/40 text-amber-300 ring-amber-500/40',
    low: 'bg-rose-900/40 text-rose-300 ring-rose-500/40',
  };
  const title = [
    `Margen de incertidumbre: ±${reliability.marginPp} puntos porcentuales.`,
    `Partidos tras cada Elo: ${reliability.gamesBehind.home} (local) y ${reliability.gamesBehind.away} (visitante).`,
    ...reliability.reasons,
  ].join('\n');
  return (
    <span title={title} className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ${styles[reliability.level]}`}>
      {reliability.label} · ±{reliability.marginPp} pp
    </span>
  );
}

function MissingModel({ item }: { item: BsbGameWithPrediction }) {
  const { game } = item;
  const missing = [
    !game.away_id ? game.away_name : null,
    !game.home_id ? game.home_name : null,
  ].filter(Boolean) as string[];
  return (
    <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 p-3 text-xs text-amber-200">
      <p className="font-medium">Sin modelo ni cuotas para este partido.</p>
      {missing.length > 0 && (
        <p className="mt-1">
          No encuentro en el historial a: <strong>{missing.join(', ')}</strong>. Ocurre en ligas sin
          archivo abierto de resultados (NPB, KBO, universitario), donde solo se muestran las
          probabilidades del mercado.
        </p>
      )}
    </div>
  );
}

/** Pick a starter by hand — the one input that beats the model's guess. */
function StarterPicker({
  league, teamId, teamName, color, value, announced, onChange,
}: {
  league: string;
  teamId: string;
  teamName: string;
  color: string;
  value: string | null | undefined;
  announced: string | null;
  onChange: (id: string | null) => void;
}) {
  const [rotation, setRotation] = useState<BsbPitcher[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    bsbApi
      .rotation(league, teamId)
      .then((r) => live && setRotation(r.pitchers))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [league, teamId]);

  if (error) return <p className="text-[11px] text-slate-500">Sin datos de lanzadores.</p>;
  const current = value !== undefined ? value : announced;

  return (
    <div className="min-w-0 flex-1">
      <label className="mb-1 block truncate text-xs font-semibold" style={{ color }}>
        {teamName}
      </label>
      <select
        value={current ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="w-full rounded border border-slate-600 bg-slate-900 px-2 py-1 text-xs text-slate-200"
        aria-label={`Abridor de ${teamName}`}
      >
        <option value="">— sin abridor conocido —</option>
        {(rotation ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} · {p.starts} ap · {p.rating != null ? `${p.rating < 1 ? '−' : '+'}${Math.abs(Math.round((p.rating - 1) * 100))}%` : 's/d'}
          </option>
        ))}
      </select>
    </div>
  );
}

function Detail({
  prediction, league, homeSp, awaySp, onHomeSp, onAwaySp, adjusting, adjusted,
}: {
  prediction: BsbPrediction;
  league: string;
  homeSp: string | null | undefined;
  awaySp: string | null | undefined;
  onHomeSp: (id: string | null) => void;
  onAwaySp: (id: string | null) => void;
  adjusting: boolean;
  adjusted: boolean;
}) {
  const { teams, runs, h2h, market, reasoning, reliability } = prediction;
  const home = teams.home;
  const away = teams.away;
  return (
    <div className="mt-4 space-y-4 border-t border-slate-700/60 pt-4 text-sm">
      <div className="rounded-lg bg-slate-800/50 p-3">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-xs uppercase tracking-wide text-slate-500">Quién abre</span>
          <span className="text-[10px] text-slate-500">
            {adjusting ? 'recalculando…' : adjusted ? 'ajustado a tu elección' : ''}
          </span>
        </div>
        <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
          El abridor es lo que más mueve un partido de béisbol y se anuncia con un día de
          antelación. Si sabes quién lanza —o si lo han cambiado— elígelo aquí y se recalcula todo:
          el ganador, las carreras y la matriz de marcadores.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <StarterPicker
            league={league} teamId={away.id} teamName={away.name} color={AWAY_COLOR}
            value={awaySp} announced={away.starter.id} onChange={onAwaySp}
          />
          <StarterPicker
            league={league} teamId={home.id} teamName={home.name} color={HOME_COLOR}
            value={homeSp} announced={home.starter.id} onChange={onHomeSp}
          />
        </div>
      </div>

      <RunMatrix prediction={prediction} />

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
          Partidos tras cada Elo: {reliability.gamesBehind.away} y {reliability.gamesBehind.home}.
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
                {f.pointsForHome === 0
                  ? '0 (neutral)'
                  : `+${Math.abs(f.pointsForHome)} para ${f.pointsForHome > 0 ? home.name : away.name}`}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg bg-slate-800/50 p-3 text-xs">
        <div className="mb-2 uppercase tracking-wide text-slate-500">Equipos</div>
        <div className="grid grid-cols-[1fr_auto_auto] gap-2">
          <div />
          <div className="w-20 text-right" style={{ color: AWAY_COLOR }}>{away.name}</div>
          <div className="w-20 text-right" style={{ color: HOME_COLOR }}>{home.name}</div>
          <div className="text-slate-400">Elo</div>
          <div className="w-20 text-right tabular-nums">{Math.round(away.elo)}</div>
          <div className="w-20 text-right tabular-nums">{Math.round(home.elo)}</div>
          <div className="text-slate-400">Carreras a favor / partido</div>
          <div className="w-20 text-right tabular-nums">{away.rs ?? '—'}</div>
          <div className="w-20 text-right tabular-nums">{home.rs ?? '—'}</div>
          <div className="text-slate-400">Carreras en contra / partido</div>
          <div className="w-20 text-right tabular-nums">{away.ra ?? '—'}</div>
          <div className="w-20 text-right tabular-nums">{home.ra ?? '—'}</div>
          <div className="text-slate-400" title="Lo que dicen sus carreras que debería ser su balance">
            Pitagórico
          </div>
          <div className="w-20 text-right tabular-nums">
            {away.pythagorean != null ? pct(away.pythagorean) : '—'}
          </div>
          <div className="w-20 text-right tabular-nums">
            {home.pythagorean != null ? pct(home.pythagorean) : '—'}
          </div>
          <div className="text-slate-400">Balance (G-P)</div>
          <div className="w-20 text-right tabular-nums">{away.record.wins}-{away.record.losses}</div>
          <div className="w-20 text-right tabular-nums">{home.record.wins}-{home.record.losses}</div>
          <div className="text-slate-400">Últimos 10</div>
          <div className="w-20 break-all text-right tracking-tight">{away.last10.join('') || '—'}</div>
          <div className="w-20 break-all text-right tracking-tight">{home.last10.join('') || '—'}</div>
        </div>
      </div>

      <div className="rounded-lg bg-slate-800/50 p-3 text-xs">
        <div className="mb-2 uppercase tracking-wide text-slate-500">
          Marcadores más probables
        </div>
        <div className="space-y-1">
          {runs.scorelines.map((s) => (
            <div key={s.label} className="flex items-center gap-2">
              <span className="w-10 tabular-nums text-slate-200">{s.away}-{s.home}</span>
              <div className="h-2 flex-1 rounded bg-slate-700/50">
                <div
                  className="h-full rounded"
                  style={{
                    width: `${(s.probability / runs.scorelines[0].probability) * 100}%`,
                    backgroundColor: s.home > s.away ? HOME_COLOR : AWAY_COLOR,
                  }}
                />
              </div>
              <span className="w-12 text-right tabular-nums text-slate-400">{pct(s.probability)}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-slate-500">
          Fíjate en lo bajas que son: en béisbol el marcador más probable ronda el 3%, contra el 12%
          de un partido de fútbol. Hay muchísimos resultados plausibles, y por eso el ganador es
          casi una moneda.
        </p>
      </div>

      <div className="rounded-lg bg-slate-800/50 p-3 text-xs">
        <div className="mb-2 flex items-center justify-between">
          <span className="uppercase tracking-wide text-slate-500">Historial directo</span>
          <span>
            <span style={{ color: AWAY_COLOR }}>{h2h.awayWins}</span>
            <span className="text-slate-500"> - </span>
            <span style={{ color: HOME_COLOR }}>{h2h.homeWins}</span>
            <span className="ml-2 text-slate-500">({h2h.total})</span>
          </span>
        </div>
        {h2h.recent.length === 0 ? (
          <p className="text-slate-400">Sin enfrentamientos previos en el historial.</p>
        ) : (
          <ul className="space-y-1">
            {h2h.recent.map((m, i) => (
              <li key={i} className="flex justify-between text-slate-300">
                <span className="text-slate-500">{formatDate(m.date)}</span>
                <span>
                  {m.awayId === away.id ? away.name : home.name} {m.awayRuns}–{m.homeRuns}{' '}
                  {m.homeId === home.id ? home.name : away.name}
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
            Cuotas {market.market.odds.away} / {market.market.odds.home} · implícitas sin vig{' '}
            {pct(market.market.away)} / {pct(market.market.home)} · margen{' '}
            {((market.market.overround - 1) * 100).toFixed(1)}%
          </p>
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-slate-500">{prediction.disclaimer}</p>
    </div>
  );
}
