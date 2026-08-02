import { useEffect, useState } from 'react';
import {
  bsbApi,
  type BsbGameWithPrediction,
  type BsbPitcher,
  type BsbPrediction,
  type BsbSide,
} from '../../lib/baseball';
import { formatDateTime, formatDate } from '../../lib/format';
import { AWAY_COLOR, HOME_COLOR, pct } from '../../lib/theme';
import {
  Badge,
  BarRow,
  Card,
  CompareRow,
  Disclosure,
  EmptyState,
  FactorValue,
  FormDots,
  HeroStat,
  Panel,
  ProbabilityBar,
  ReliabilityChip,
  SectionTitle,
  SeriesDot,
  TeamCrest,
  StatRow,
  StatTile,
} from '../ui';
import RunMatrix from './RunMatrix';

export default function GameCard({
  item,
  onOpenTeam,
}: {
  item: BsbGameWithPrediction;
  onOpenTeam: (league: string, id: string) => void;
}) {
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
    <Card as="article" className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2 text-[11px] text-[#7b828d]">
        <time>{formatDateTime(game.commence_time)}</time>
        <div className="flex items-center gap-1.5">
          {dirty && <Badge tone="accent">{adjusting ? 'recalculando…' : 'con tu abridor'}</Badge>}
          {!startersAnnounced && prediction && (
            <Badge title="Ningún feed ha anunciado los abridores; se usa el número uno de cada rotación">
              abridores estimados
            </Badge>
          )}
          {game.source === 'fixture' && <Badge tone="warning">partido demo</Badge>}
        </div>
      </div>

      {/* Away @ Home — baseball is written away-first, unlike the other three */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <TeamName
          league={game.league}
          id={game.away_id}
          name={prediction?.teams.away.name ?? game.away_name}
          elo={prediction?.teams.away.elo ?? teams.away?.elo ?? null}
          eloRank={prediction?.teams.away.eloRank ?? teams.away?.eloRank ?? null}
          odds={game.odds_away}
          onClick={game.away_id ? () => onOpenTeam(game.league, game.away_id!) : undefined}
        />
        <span className="shrink-0 pt-1 text-[11px] font-medium text-[#5c636c]">@</span>
        <TeamName
          league={game.league}
          id={game.home_id}
          name={prediction?.teams.home.name ?? game.home_name}
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
          <div className="flex items-end justify-between gap-3">
            <HeroStat
              value={pct(probs.away)}
              label="Visitante"
              sub={[
                prediction ? `${prediction.runs.expectedAway} carreras esp.` : null,
                game.odds_away ? `cuota ${game.odds_away}` : null,
              ].filter(Boolean).join(' · ') || undefined}
              color={AWAY_COLOR}
            />
            <HeroStat
              value={pct(probs.home)}
              label="Local"
              sub={[
                prediction ? `${prediction.runs.expectedHome} carreras esp.` : null,
                game.odds_home ? `cuota ${game.odds_home}` : null,
              ].filter(Boolean).join(' · ') || undefined}
              color={HOME_COLOR}
              align="right"
            />
          </div>
          <div className="mt-2.5">
            <ProbabilityBar
              segments={[
                { value: probs.away, color: AWAY_COLOR, label: game.away_name },
                { value: probs.home, color: HOME_COLOR, label: game.home_name },
              ]}
            />
          </div>
          {!fromModel && (
            <p className="mt-2 text-center text-[11px] text-amber-300/90">
              Probabilidades implícitas del mercado, no del modelo.
            </p>
          )}

          {prediction && (
            <>
              {/* The starting pitchers get top billing: in baseball nothing else
                  a single player does moves the number this much. */}
              <div className="mt-3 grid grid-cols-2 gap-x-4 border-t border-white/[0.07] pt-3">
                <StarterChip side={prediction.teams.away} color={AWAY_COLOR} />
                <StarterChip side={prediction.teams.home} color={HOME_COLOR} />
              </div>

              <StatRow className="mt-3">
                <StatTile
                  label="Carreras esp."
                  value={`${prediction.runs.expectedAway} – ${prediction.runs.expectedHome}`}
                  hint={`total ${prediction.runs.expectedTotal}`}
                />
                <StatTile
                  label="Marcador"
                  value={`${prediction.runs.scorelines[0].away}-${prediction.runs.scorelines[0].home}`}
                  hint={`más probable · ${pct(prediction.runs.scorelines[0].probability)}`}
                />
                <StatTile
                  label={`+${prediction.runs.totalLine} carreras`}
                  value={pct(prediction.runs.over)}
                  hint={`−${prediction.runs.totalLine}: ${pct(prediction.runs.under)}`}
                />
                <StatTile
                  label="Línea −1.5"
                  value={pct(prediction.runs.runLine.homeCovers)}
                  hint="local por 2+"
                />
              </StatRow>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 text-[13px] leading-snug text-[#c3c9d1]">
                  {prediction.verdict.close ? (
                    <>
                      Muy igualado —{' '}
                      <strong className="font-semibold text-[#e8eaed]">
                        {prediction.verdict.label}
                      </strong>{' '}
                      solo por poco
                    </>
                  ) : (
                    <>
                      Lo más probable:{' '}
                      <strong className="font-semibold text-[#e8eaed]">
                        {prediction.verdict.label}
                      </strong>
                    </>
                  )}
                </p>
                <div className="flex shrink-0 items-center gap-1.5">
                  {prediction.market.verdict.startsWith('value_') && (
                    <Badge tone="good" title="El modelo da más probabilidad que el mercado">
                      Value:{' '}
                      {prediction.market.verdict === 'value_home'
                        ? prediction.teams.home.name
                        : prediction.teams.away.name}
                    </Badge>
                  )}
                  <ReliabilityChip
                    level={prediction.reliability.level}
                    label={prediction.reliability.label}
                    marginPp={prediction.reliability.marginPp}
                    title={[
                      `Margen de incertidumbre: ±${prediction.reliability.marginPp} pp.`,
                      `Partidos tras cada Elo: ${prediction.reliability.gamesBehind.home} y ${prediction.reliability.gamesBehind.away}.`,
                      ...prediction.reliability.reasons,
                    ].join('\n')}
                  />
                </div>
              </div>

              <div className="mt-1">
                <Disclosure summary="Ver desglose · abridores, carreras, marcadores y mercado">
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
                </Disclosure>
              </div>
            </>
          )}
        </>
      ) : (
        <MissingModel item={item} />
      )}
    </Card>
  );
}




/**
 * The starter, given its own tile rather than a line of text.
 *
 * It is the single most important input on a baseball card, and the run-
 * suppression figure next to the name is what the model actually uses — so it is
 * shown, not hidden in a tooltip.
 */
function StarterChip({ side, color }: { side: BsbSide; color: string }) {
  const s = side.starter;
  const delta = s.rating != null ? Math.round((1 - s.rating) * 100) : null;
  return (
    <div className="min-w-0" title={s.label}>
      {/* The delta sits NEXT to the label, not pushed to the column's far edge:
          spread across half a card it landed beside the OTHER starter's label and
          read as belonging to them. */}
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.06em] text-[#7b828d]">
          Abridor
        </span>
        {delta != null && Math.abs(delta) >= 4 && (
          <span
            className="shrink-0 text-[10px] font-semibold tabular-nums"
            style={{ color: delta > 0 ? '#199e70' : '#e66767' }}
            title="Carreras que permite frente a lo esperado de un abridor medio"
          >
            {delta > 0 ? '−' : '+'}
            {Math.abs(delta)}% carreras
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <SeriesDot color={color} />
        <span className="truncate text-[13px] font-semibold text-[#e8eaed]">
          {s.name ?? 'sin anunciar'}
        </span>
      </div>
      <div className="truncate text-[10px] text-[#7b828d]">
        {s.starts > 0 ? `${s.starts} aperturas` : 'sin datos'}
      </div>
    </div>
  );
}

function TeamName({
  league, id, name, elo, eloRank, odds, alignRight = false, homeBadge = false, onClick,
}: {
  league: string; id: string | null;
  name: string; elo: number | null; eloRank: number | null;
  odds: number | null; alignRight?: boolean; homeBadge?: boolean; onClick?: () => void;
}) {
  return (
    <div className={`min-w-0 flex-1 ${alignRight ? 'text-right' : ''}`}>
      <span className={`flex items-center gap-1.5 ${alignRight ? 'justify-end' : ''}`}>
        {/* The crest, not the series dot: the dot's job is done one line below
            by the hero label, and two identity marks on one line is one too many. */}
        {!alignRight && <TeamCrest league={league} name={name} code={id} />}
        <button
          onClick={onClick}
          disabled={!onClick}
          className={`max-w-full truncate text-base font-semibold text-[#e8eaed] ${onClick ? 'hover:underline' : 'cursor-default'}`}
          title={onClick ? 'Ver ficha del equipo' : undefined}
        >
          {name}
          {homeBadge && <span className="ml-1.5 text-[10px] text-[#7b828d]">(local)</span>}
        </button>
        {alignRight && <TeamCrest league={league} name={name} code={id} />}
      </span>
      <div className="text-[11px] text-[#7b828d]">
        {elo != null && <>Elo {Math.round(elo)}{eloRank != null && ` (#${eloRank})`}</>}
        {odds != null && <> · cuota {odds}</>}
      </div>
    </div>
  );
}


function MissingModel({ item }: { item: BsbGameWithPrediction }) {
  const { game } = item;
  const missing = [
    !game.away_id ? game.away_name : null,
    !game.home_id ? game.home_name : null,
  ].filter(Boolean) as string[];
  return (
    <EmptyState title="Sin modelo ni cuotas para este partido" tone="warning">
      {missing.length > 0 && (
        <>
          No encuentro en el historial a <strong>{missing.join(', ')}</strong>. Ocurre en ligas sin
          archivo abierto de resultados (NPB, KBO, universitario), donde solo se muestran las
          probabilidades del mercado.
        </>
      )}
    </EmptyState>
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

  if (error) return <p className="text-[11px] text-[#7b828d]">Sin datos de lanzadores.</p>;
  const current = value !== undefined ? value : announced;

  return (
    <div className="min-w-0 flex-1">
      <label className="mb-1 block truncate text-xs font-semibold" style={{ color }}>
        {teamName}
      </label>
      <select
        value={current ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="w-full rounded border border-white/[0.12] bg-[#14161b] px-2 py-1 text-xs text-[#d5d9df]"
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
  const formColors = { W: HOME_COLOR, D: '#64748b', L: AWAY_COLOR };
  return (
    <div className="space-y-3">
      <Panel>
        <SectionTitle right={adjusting ? 'recalculando…' : adjusted ? 'ajustado a tu elección' : undefined}>
          Quién abre
        </SectionTitle>
        <p className="mb-2.5 text-[11px] leading-relaxed text-[#9aa1ac]">
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
      </Panel>

      <RunMatrix prediction={prediction} />

      <div
        className={`rounded-xl border p-3 text-[12px] ${
          reliability.level === 'high'
            ? 'border-emerald-500/25 bg-emerald-500/[0.06]'
            : reliability.level === 'medium'
              ? 'border-amber-500/25 bg-amber-500/[0.06]'
              : 'border-rose-500/25 bg-rose-500/[0.06]'
        }`}
      >
        <p className="text-[#d5d9df]">
          <strong className="capitalize">{reliability.label}</strong> — margen ±{reliability.marginPp} pp.
          Partidos tras cada Elo: {reliability.gamesBehind.away} y {reliability.gamesBehind.home}.
        </p>
        {reliability.reasons.length > 0 && (
          <ul className="mt-1.5 space-y-1">
            {reliability.reasons.map((r, i) => (
              <li key={i} className="flex gap-2 text-[11px] text-[#9aa1ac]">
                <span aria-hidden className="text-[#5c636c]">•</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Panel>
        <SectionTitle>Por qué</SectionTitle>
        <p className="mb-2 text-[13px] leading-relaxed text-[#c3c9d1]">{reasoning.text}</p>
        <dl className="space-y-1 text-[11px]">
          {reasoning.factors.map((f) => (
            <div key={f.key} className="flex justify-between gap-3">
              <dt className="text-[#9aa1ac]">{f.label}</dt>
              <dd>
                <FactorValue
                  color={f.pointsForHome >= 0 ? HOME_COLOR : AWAY_COLOR}
                  neutral={f.pointsForHome === 0}
                >
                  {f.pointsForHome === 0
                    ? '0 (neutral)'
                    : `+${Math.abs(f.pointsForHome)} para ${f.pointsForHome > 0 ? home.name : away.name}`}
                </FactorValue>
              </dd>
            </div>
          ))}
        </dl>
      </Panel>

      <Panel>
        <SectionTitle>Los dos equipos</SectionTitle>
        <dl className="grid grid-cols-[1fr_auto_auto] gap-x-3 text-[11px]">
          <div />
          <div className="w-20 truncate text-right font-medium" style={{ color: AWAY_COLOR }}>
            {away.name}
          </div>
          <div className="w-20 truncate text-right font-medium" style={{ color: HOME_COLOR }}>
            {home.name}
          </div>
          <CompareRow label="Elo" left={Math.round(away.elo)} right={Math.round(home.elo)} />
          <CompareRow label="Carreras a favor / partido" left={away.rs ?? '—'} right={home.rs ?? '—'} />
          <CompareRow label="Carreras en contra / partido" left={away.ra ?? '—'} right={home.ra ?? '—'} />
          <CompareRow
            label="Pitagórico"
            title="Lo que dicen sus carreras que debería ser su balance. La diferencia con el real es la parte de suerte."
            left={away.pythagorean != null ? pct(away.pythagorean) : '—'}
            right={home.pythagorean != null ? pct(home.pythagorean) : '—'}
          />
          <CompareRow
            label="Balance (G-P)"
            left={`${away.record.wins}-${away.record.losses}`}
            right={`${home.record.wins}-${home.record.losses}`}
          />
          <CompareRow
            label="Últimos 10"
            title="Azul = ganado · naranja = perdido"
            left={<FormDots results={away.last10} colors={formColors} />}
            right={<FormDots results={home.last10} colors={formColors} />}
          />
        </dl>
      </Panel>

      <Panel>
        <SectionTitle>Marcadores más probables</SectionTitle>
        <div className="space-y-1">
          {runs.scorelines.map((s) => (
            <BarRow
              key={s.label}
              label={`${s.away}-${s.home}`}
              value={s.probability}
              max={runs.scorelines[0].probability}
              color={s.home > s.away ? HOME_COLOR : AWAY_COLOR}
              valueLabel={pct(s.probability)}
            />
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-[#7b828d]">
          Fíjate en lo bajas que son: en béisbol el marcador más probable ronda el 3%, contra el 12%
          de un partido de fútbol. Hay muchísimos resultados plausibles, y por eso el ganador es casi
          una moneda.
        </p>
      </Panel>

      <Panel>
        <SectionTitle
          right={
            <>
              <span style={{ color: AWAY_COLOR }}>{h2h.awayWins}</span>
              <span className="text-[#5c636c]"> · </span>
              <span style={{ color: HOME_COLOR }}>{h2h.homeWins}</span>
              <span className="ml-1.5 text-[#5c636c]">({h2h.total})</span>
            </>
          }
        >
          Historial directo
        </SectionTitle>
        {h2h.recent.length === 0 ? (
          <p className="text-[11px] text-[#7b828d]">Sin enfrentamientos previos en el historial.</p>
        ) : (
          <ul className="space-y-1 text-[11px]">
            {h2h.recent.map((m, i) => (
              <li key={i} className="flex justify-between gap-3 text-[#c3c9d1]">
                <span className="shrink-0 text-[#7b828d]">{formatDate(m.date)}</span>
                <span className="truncate text-right">
                  {m.awayId === away.id ? away.name : home.name} {m.awayRuns}–{m.homeRuns}{' '}
                  {m.homeId === home.id ? home.name : away.name}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {market.market && (
        <Panel>
          <SectionTitle right={`margen ${((market.market.overround - 1) * 100).toFixed(1)}%`}>
            Mercado
          </SectionTitle>
          <p className="text-[11px] leading-relaxed text-[#c3c9d1]">
            Cuotas {market.market.odds.away} / {market.market.odds.home} · implícitas sin vig{' '}
            {pct(market.market.away)} / {pct(market.market.home)}
          </p>
        </Panel>
      )}

      <Panel>
        <SectionTitle>Lectura completa</SectionTitle>
        <ul className="space-y-1.5">
          {prediction.summary.bullets.map((b, i) => (
            <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-[#9aa1ac]">
              <span aria-hidden className="text-[#5c636c]">•</span>
              <span>{b}</span>
            </li>
          ))}
        </ul>
      </Panel>

      <p className="text-[11px] leading-relaxed text-[#7b828d]">{prediction.disclaimer}</p>
    </div>
  );
}
