import { useEffect, useState } from 'react';
import { fbApi, type FbFixtureWithPrediction, type FbPrediction } from '../../lib/football';
import { formatDate } from '../../lib/format';
import { AWAY_COLOR, DRAW_COLOR, HOME_COLOR, pct } from '../../lib/theme';
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
  MatchTime,
  Panel,
  ProbabilityBar,
  ReliabilityChip,
  ResultBanner,
  SectionTitle,
  StatRow,
  StatTile,
  TeamCrest,
} from '../ui';
import ScoreMatrix from './ScoreMatrix';
import SquadPanel from './SquadPanel';
import { realMarket } from '../../lib/picks';

/**
 * One fixture.
 *
 * The card used to open with a nine-bullet paragraph: every number the model knew,
 * written out in prose, above the fold. That is the least scannable way to present
 * numbers, and it made every card look identical from a distance. Now the top of
 * the card carries the three probabilities and four figures, the one-line verdict
 * sits under them, and the prose moved into the breakdown for anyone who wants the
 * reasoning rather than the answer.
 */
export default function MatchCard({
  item,
  onOpenTeam,
}: {
  item: FbFixtureWithPrediction;
  onOpenTeam: (league: string, id: string) => void;
}) {
  // Players the user has marked unavailable, and the prediction the server
  // returns for that lineup. Held here rather than inside the squad panel because
  // EVERY figure on the card comes from the same distribution — mark a striker out
  // and the 1X2, the goals markets and the whole matrix have to move together.
  const [outHome, setOutHome] = useState<string[]>([]);
  const [outAway, setOutAway] = useState<string[]>([]);
  const [adjusted, setAdjusted] = useState<FbPrediction | null>(null);
  const [adjusting, setAdjusting] = useState(false);

  const { fixture, marketOnly, teams } = item;
  const dirty = outHome.length > 0 || outAway.length > 0;

  useEffect(() => {
    if (!dirty) {
      setAdjusted(null);
      return;
    }
    let live = true;
    setAdjusting(true);
    fbApi
      .fixture(fixture.id, { home: outHome, away: outAway })
      .then((r) => live && setAdjusted(r.prediction))
      // Falling back to the unadjusted prediction is right: a failed re-predict
      // must never leave the card showing numbers for a lineup nobody asked for.
      .catch(() => live && setAdjusted(null))
      .finally(() => live && setAdjusting(false));
    return () => {
      live = false;
    };
  }, [fixture.id, outHome, outAway, dirty]);

  const prediction = adjusted ?? item.prediction;
  const probs = prediction?.model ?? marketOnly ?? null;
  const fromModel = !!prediction;

  const homeName = prediction?.teams.home.name ?? fixture.home_name;
  const awayName = prediction?.teams.away.name ?? fixture.away_name;

  return (
    <Card as="article" className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2 text-[13px] text-[#7b828d]">
        <MatchTime iso={fixture.commence_time} />
        <div className="flex items-center gap-1.5">
          {dirty && <Badge tone="accent">{adjusting ? 'recalculando…' : 'con tus bajas'}</Badge>}
          {fixture.source === 'fixture' && <Badge tone="warning">partido demo</Badge>}
        </div>
      </div>

      {/* The result, when there is one. Above the forecast because once a match
          has been played the score is the headline and the prediction is history.
          Football is the one sport where a DRAW is a real third outcome, so
          "did the model call it" compares the winning side against whichever of
          the three the model rated highest — not just home against away. */}
      <ResultBanner
        started={item.outcome.started}
        score={
          item.outcome.result
            ? `${item.outcome.result.homeScore}-${item.outcome.result.awayScore}`
            : null
        }
        detail={
          item.outcome.result
            ? `${homeName} ${item.outcome.result.homeScore} · ${awayName} ${item.outcome.result.awayScore}`
            : null
        }
        modelCalledIt={
          prediction && item.outcome.result
            ? topOutcome(prediction.model) === actualOutcome(item.outcome.result)
            : null
        }
      />

      <div className="mb-3 flex items-start justify-between gap-3">
        <TeamName
          league={fixture.league}
          id={fixture.home_id}
          name={homeName}
          elo={prediction?.teams.home.elo ?? teams.home?.elo ?? null}
          eloRank={prediction?.teams.home.eloRank ?? teams.home?.eloRank ?? null}
          seededFrom={prediction?.teams.home.seededFrom ?? null}
          homeBadge
          onClick={fixture.home_id ? () => onOpenTeam(fixture.league, fixture.home_id!) : undefined}
        />
        <span className="shrink-0 pt-1 text-[13px] font-medium text-[#5c636c]">vs</span>
        <TeamName
          league={fixture.league}
          id={fixture.away_id}
          name={awayName}
          elo={prediction?.teams.away.elo ?? teams.away?.elo ?? null}
          eloRank={prediction?.teams.away.eloRank ?? teams.away?.eloRank ?? null}
          seededFrom={prediction?.teams.away.seededFrom ?? null}
          alignRight
          onClick={fixture.away_id ? () => onOpenTeam(fixture.league, fixture.away_id!) : undefined}
        />
      </div>

      {probs ? (
        <>
          {/* 1X2 — three outcomes, so the draw gets equal billing */}
          <div className="flex items-end justify-between gap-3">
            <HeroStat
              value={pct(probs.home)}
              label="1 · Local"
              sub={fixture.odds_home ? `cuota ${fixture.odds_home}` : undefined}
              color={HOME_COLOR}
            />
            <div className="pb-0.5">
              <HeroStat
                value={pct(probs.draw)}
                label="X · Empate"
                sub={fixture.odds_draw ? `cuota ${fixture.odds_draw}` : undefined}
                color={DRAW_COLOR}
                align="center"
                size="sm"
              />
            </div>
            <HeroStat
              value={pct(probs.away)}
              label="2 · Visitante"
              sub={fixture.odds_away ? `cuota ${fixture.odds_away}` : undefined}
              color={AWAY_COLOR}
              align="right"
            />
          </div>

          <div className="mt-2.5">
            <ProbabilityBar
              segments={[
                { value: probs.home, color: HOME_COLOR, label: homeName },
                { value: probs.draw, color: DRAW_COLOR, label: 'Empate' },
                { value: probs.away, color: AWAY_COLOR, label: awayName },
              ]}
            />
          </div>

          {!fromModel && (
            <p className="mt-2 text-center text-[13px] text-amber-300/90">
              Probabilidades implícitas del mercado, no del modelo.
            </p>
          )}

          {prediction && (
            <>
              <StatRow className="mt-3">
                <StatTile
                  label="Goles esp."
                  value={`${prediction.goals.expectedHome} – ${prediction.goals.expectedAway}`}
                  hint={`total ${prediction.goals.expectedTotal}`}
                />
                <StatTile
                  label="Marcador"
                  value={prediction.goals.scorelines[0].label}
                  hint={`más probable · ${pct(prediction.goals.scorelines[0].probability)}`}
                />
                <StatTile
                  label="+2.5 goles"
                  value={pct(prediction.goals.over25)}
                  hint={`−2.5: ${pct(prediction.goals.under25)}`}
                />
                <StatTile
                  label="Ambos marcan"
                  value={pct(prediction.goals.bothScore)}
                  hint={`no: ${pct(1 - prediction.goals.bothScore)}`}
                />
              </StatRow>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 text-[15px] leading-snug text-[#c3c9d1]">
                  {/* En un partido abierto la frase útil NO es cuál de tres treintaipicos
                      es el mayor: es la doble oportunidad, que en el 82,2 % de los
                      partidos abiertos del archivo pasa del 65 %. Antes la tarjeta
                      decía «X es solo el más probable» y se callaba el 70 %. */}
                  {prediction.verdict.open ? (
                    <>
                      Partido abierto —{' '}
                      <strong className="font-semibold text-[#e8eaed]">
                        {prediction.verdict.doubleChance.label}
                      </strong>{' '}
                      {pct(prediction.verdict.doubleChance.probability)}
                      <span className="text-[#8b93a1]">
                        {' '}
                        · suelto, {prediction.verdict.label.toLowerCase()}{' '}
                        {pct(prediction.verdict.probability)}
                      </span>
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
                {/* WRAPS, and must: this group holds a "Value: <team name>" badge, and
                      with `shrink-0` it could neither shrink nor wrap, so a long name
                      pushed the whole page 10px wide. */}
                <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                                    {/* Gated on the odds being REAL. Without a key the app prices the
                      slate from its own model, so a green "Value" badge here was the
                      card claiming to have found an edge against its own output —
                      while the panel above it said, in words, that those odds come
                      from the model and comparing them says nothing. */}
                  {realMarket(fixture.source) && prediction.market.verdict.startsWith('value_') && (
                    <Badge tone="good" title="El modelo da más probabilidad que el mercado">
                      Value:{' '}
                      {prediction.market.verdict === 'value_home'
                        ? homeName
                        : prediction.market.verdict === 'value_away'
                          ? awayName
                          : 'empate'}
                    </Badge>
                  )}
                  <ReliabilityChip
                    level={prediction.reliability.level}
                    label={prediction.reliability.label}
                    marginPp={prediction.reliability.marginPp}
                    title={[
                      `Margen de incertidumbre: ±${prediction.reliability.marginPp} pp.`,
                      `Partidos tras cada Elo: ${prediction.reliability.matchesBehind.home} y ${prediction.reliability.matchesBehind.away}.`,
                      ...prediction.reliability.reasons,
                    ].join('\n')}
                  />
                </div>
              </div>

              <div className="mt-1">
                <Disclosure summary="Ver desglose · alineaciones, marcadores, Elo y mercado">
                  <Detail
                    prediction={prediction}
                    league={fixture.league}
                    outHome={outHome}
                    outAway={outAway}
                    onOutHome={setOutHome}
                    onOutAway={setOutAway}
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

function TeamName({
  league, id, name, elo, eloRank, seededFrom = null, alignRight = false, homeBadge = false, onClick,
}: {
  league: string; id: string | null; logo?: string | null;
  name: string; elo: number | null; eloRank: number | null; seededFrom?: string | null;
  alignRight?: boolean; homeBadge?: boolean; onClick?: () => void;
}) {
  const logo = null;
  return (
    <div className={`min-w-0 flex-1 ${alignRight ? 'text-right' : ''}`}>
      <span className={`flex items-center gap-1.5 ${alignRight ? 'justify-end' : ''}`}>
        {/* The crest, not the series dot: the dot's job is done one line below
            by the hero label, and two identity marks on one line is one too many. */}
        {!alignRight && <TeamCrest league={league} name={name} code={id} logo={logo} />}
        <button
          onClick={onClick}
          disabled={!onClick}
          // Wraps rather than truncates: at the larger type size the team name
          // no longer fits half a phone-width card, and an ellipsis eats the one
          // thing the card exists to tell you. See nfl/GameCard for the detail.
          className={`max-w-full text-[17px] font-semibold leading-tight break-words text-[#e8eaed] ${
            onClick ? 'hover:underline' : 'cursor-default'
          }`}
          title={onClick ? 'Ver ficha del equipo' : name}
        >
          {name}
        </button>
        {alignRight && <TeamCrest league={league} name={name} code={id} logo={logo} />}
      </span>
      <div className="text-[13px] text-[#7b828d]">
        {homeBadge && 'local · '}
        {elo != null && (
          <>
            Elo {Math.round(elo)}
            {eloRank != null && ` (#${eloRank})`}
          </>
        )}
        {/* Said on the line that carries the number, because it changes what the
            number means: this club has not played a match in this division. */}
        {seededFrom && (
          <span className="ml-1 text-[#c08a2e]" title={`Elo trasladado desde ${seededFrom} con el salto de división medido para esta liga. El equipo aún no ha jugado aquí.`}>
            · recién ascendido
          </span>
        )}
      </div>
    </div>
  );
}

function MissingModel({ item }: { item: FbFixtureWithPrediction }) {
  const { fixture } = item;
  const missing = [
    !fixture.home_id ? fixture.home_name : null,
    !fixture.away_id ? fixture.away_name : null,
  ].filter(Boolean) as string[];
  return (
    <EmptyState title="Sin modelo ni cuotas para este partido" tone="warning">
      {missing.length > 0 && (
        <>
          No encuentro en el historial a <strong>{missing.join(', ')}</strong>. Ocurre en
          competiciones sin fuente de resultados (Champions) o cuando la casa escribe el nombre del
          club de otra forma.
        </>
      )}
    </EmptyState>
  );
}

/** Full breakdown, all figures drawn from the same score distribution. */
function Detail({
  prediction, league, outHome, outAway, onOutHome, onOutAway, adjusting, adjusted,
}: {
  prediction: FbPrediction;
  league: string;
  outHome: string[];
  outAway: string[];
  onOutHome: (ids: string[]) => void;
  onOutAway: (ids: string[]) => void;
  adjusting: boolean;
  adjusted: boolean;
}) {
  const { teams, goals, h2h, market, reasoning, reliability, squads, summary } = prediction;
  const home = teams.home;
  const away = teams.away;
  const hasSquads = squads.home !== null || squads.away !== null;
  const formColors = { W: HOME_COLOR, D: DRAW_COLOR, L: AWAY_COLOR };

  return (
    <div className="space-y-3">
      {hasSquads && (
        <Panel>
          <SectionTitle
            right={adjusting ? 'recalculando…' : adjusted ? 'ajustado a tus bajas' : undefined}
          >
            Quién juega
          </SectionTitle>
          <p className="mb-2.5 text-[13px] leading-relaxed text-[#9aa1ac]">
            Las lesiones y sanciones conocidas ya vienen marcadas. Si sabes la alineación — se
            publica una hora antes — marca al resto y se recalcula todo.
          </p>
          <div className="flex flex-col gap-4 sm:flex-row">
            <SquadPanel
              league={league} side="home" teamId={home.id} teamName={home.name}
              color={HOME_COLOR} availability={squads.home} out={outHome} onChange={onOutHome}
            />
            <SquadPanel
              league={league} side="away" teamId={away.id} teamName={away.name}
              color={AWAY_COLOR} availability={squads.away} out={outAway} onChange={onOutAway}
            />
          </div>
        </Panel>
      )}

      <ScoreMatrix prediction={prediction} />

      <Panel>
        <SectionTitle>Por qué</SectionTitle>
        <p className="mb-2 text-[15px] leading-relaxed text-[#c3c9d1]">{reasoning.text}</p>
        <dl className="space-y-1 text-[13px]">
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
        <SectionTitle>Marcadores más probables</SectionTitle>
        <div className="space-y-1">
          {goals.scorelines.map((s) => (
            <BarRow
              key={s.label}
              label={s.label}
              value={s.probability}
              max={goals.scorelines[0].probability}
              color={s.home > s.away ? HOME_COLOR : s.home === s.away ? DRAW_COLOR : AWAY_COLOR}
              valueLabel={pct(s.probability)}
            />
          ))}
        </div>
      </Panel>

      <Panel>
        <SectionTitle>Los dos equipos</SectionTitle>
        <dl className="grid grid-cols-[1fr_auto_auto] gap-x-3 text-[13px]">
          <div />
          <div className="w-20 truncate text-right font-medium" style={{ color: HOME_COLOR }}>
            {home.name}
          </div>
          <div className="w-20 truncate text-right font-medium" style={{ color: AWAY_COLOR }}>
            {away.name}
          </div>
          <CompareRow label="Elo" left={Math.round(home.elo)} right={Math.round(away.elo)} />
          <CompareRow label="Goles a favor / partido" left={home.gf ?? '—'} right={away.gf ?? '—'} />
          <CompareRow label="Goles en contra / partido" left={home.ga ?? '—'} right={away.ga ?? '—'} />
          <CompareRow
            label="Balance (G-E-P)"
            left={`${home.record.wins}-${home.record.draws}-${home.record.losses}`}
            right={`${away.record.wins}-${away.record.draws}-${away.record.losses}`}
          />
          <CompareRow
            label="Últimos 5"
            title="Azul = ganado · turquesa = empatado · naranja = perdido"
            left={<FormDots results={home.last5} colors={formColors} />}
            right={<FormDots results={away.last5} colors={formColors} />}
          />
        </dl>
      </Panel>

      <Panel>
        <SectionTitle
          right={
            <>
              <span style={{ color: HOME_COLOR }}>{h2h.homeWins}</span>
              <span className="text-[#5c636c]"> · {h2h.draws} · </span>
              <span style={{ color: AWAY_COLOR }}>{h2h.awayWins}</span>
              <span className="ml-1.5 text-[#5c636c]">({h2h.total})</span>
            </>
          }
        >
          Historial directo
        </SectionTitle>
        {h2h.recent.length === 0 ? (
          <p className="text-[13px] text-[#7b828d]">Sin enfrentamientos previos.</p>
        ) : (
          <ul className="space-y-1 text-[13px]">
            {h2h.recent.map((m, i) => (
              <li key={i} className="flex justify-between gap-3 text-[#c3c9d1]">
                <span className="shrink-0 text-[#7b828d]">{formatDate(m.date)}</span>
                <span className="truncate text-right">
                  {m.homeId === home.id ? home.name : away.name} {m.homeGoals}–{m.awayGoals}{' '}
                  {m.awayId === away.id ? away.name : home.name}
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
          <p className="text-[13px] leading-relaxed text-[#c3c9d1]">
            Cuotas {market.market.odds.home} / {market.market.odds.draw} / {market.market.odds.away}{' '}
            · implícitas sin vig {pct(market.market.home)} / {pct(market.market.draw)} /{' '}
            {pct(market.market.away)}
          </p>
        </Panel>
      )}

      <Panel>
        <SectionTitle>Lectura completa</SectionTitle>
        <ul className="space-y-1.5">
          {summary.bullets.map((b, i) => (
            <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-[#9aa1ac]">
              <span aria-hidden className="text-[#5c636c]">
                •
              </span>
              <span>{b}</span>
            </li>
          ))}
        </ul>
      </Panel>

      <div
        className={`rounded-xl border p-3 text-[14px] ${
          reliability.level === 'high'
            ? 'border-emerald-500/25 bg-emerald-500/[0.06]'
            : reliability.level === 'medium'
              ? 'border-amber-500/25 bg-amber-500/[0.06]'
              : 'border-rose-500/25 bg-rose-500/[0.06]'
        }`}
      >
        <p className="text-[#d5d9df]">
          <strong className="capitalize">{reliability.label}</strong> — margen ±
          {reliability.marginPp} pp. Partidos tras cada Elo: {reliability.matchesBehind.home} y{' '}
          {reliability.matchesBehind.away}.
        </p>
        {reliability.reasons.length > 0 && (
          <ul className="mt-1.5 space-y-1">
            {reliability.reasons.map((r, i) => (
              <li key={i} className="flex gap-2 text-[13px] text-[#9aa1ac]">
                <span aria-hidden className="text-[#5c636c]">
                  •
                </span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-[13px] leading-relaxed text-[#7b828d]">{prediction.disclaimer}</p>
    </div>
  );
}

/** Which of the three the model rated highest. */
function topOutcome(m: { home: number; draw: number; away: number }): 'home' | 'draw' | 'away' {
  if (m.draw >= m.home && m.draw >= m.away) return 'draw';
  return m.home >= m.away ? 'home' : 'away';
}

/** Which of the three actually happened. */
function actualOutcome(r: { homeScore: number; awayScore: number }): 'home' | 'draw' | 'away' {
  if (r.homeScore === r.awayScore) return 'draw';
  return r.homeScore > r.awayScore ? 'home' : 'away';
}
