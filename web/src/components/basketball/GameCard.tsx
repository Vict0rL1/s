import type { BbGameWithPrediction, BbTeamSide } from '../../lib/basketball';
import { AWAY_COLOR, HOME_COLOR, pct } from '../../lib/theme';
import {
  Badge,
  BarRow,
  Card,
  Disclosure,
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
  MarketGap,
} from '../ui';
import GameDetail from './GameDetail';
import { realMarket } from '../../lib/picks';
import { EnlacePartido } from '../ui';
import EventTrustPanel from '../trust/EventTrustPanel';
import { conNodos, useI18n } from '../../i18n';
import { pct as pctF } from '../../lib/formato';

/**
 * A readable label for a margin band.
 *
 * The obvious shortcut — print the band's lower edge — produces "0" for the band
 * "away team by 1 to 5", which is both wrong and the opposite of what the colour
 * next to it says. Bands are ranges, so the label has to be a range.
 */
function marginBandLabel(b: { from: number; to: number }): string {
  if (b.from <= -99) return `≤ −${Math.abs(b.to)}`;
  if (b.to >= 99) return `≥ +${b.from}`;
  const lo = b.from >= 0 ? b.from + 1 : Math.abs(b.to) + 1;
  const hi = b.from >= 0 ? b.to : Math.abs(b.from);
  return `${b.from >= 0 ? '+' : '−'}${lo}–${hi}`;
}

export default function GameCard({
  item,
  onOpenTeam,
}: {
  item: BbGameWithPrediction;
  onOpenTeam: (league: string, id: string) => void;
}) {
  const { t } = useI18n();
  const { game, prediction, teams } = item;

  const value = prediction?.market.verdict;
  const valueTeam =
    value === 'value_p1'
      ? prediction?.teams.home.name
      : value === 'value_p2'
        ? prediction?.teams.away.name
        : null;

  return (
    <Card as="article" className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2 text-[13px] text-(--ink-muted)">
        <MatchTime iso={game.commence_time} />
        <div className="flex items-center gap-1.5">
          {prediction?.neutral && <Badge>{t('bkc.neutral')}</Badge>}
          {game.source === 'fixture' && <Badge tone="warning">{t('eq.partidoDemo')}</Badge>}
        </div>
      </div>

      {/* The result, when there is one. Above the forecast because once a game
          has been played the score is the headline and the prediction is
          history — see ResultBanner for the three states it distinguishes. */}
      <ResultBanner
        started={item.outcome.started}
        score={
          item.outcome.result
            ? `${item.outcome.result.awayScore}-${item.outcome.result.homeScore}`
            : null
        }
        detail={
          item.outcome.result
            ? `${game.away_name} ${item.outcome.result.awayScore} · ${game.home_name} ${item.outcome.result.homeScore}`
            : null
        }
        modelCalledIt={
          item.prediction && item.outcome.result
            ? item.outcome.result.homeScore === item.outcome.result.awayScore
              ? null
              : (item.outcome.result.homeScore > item.outcome.result.awayScore) ===
                (item.prediction.model.probHome >= 0.5)
            : null
        }
      />

      {/* Away @ Home — the order North American basketball is always written in */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <TeamName
          league={game.league}
          id={game.away_id}
          logo={prediction?.teams.away.logo ?? teams.away?.logo ?? null}
          name={prediction?.teams.away.name ?? game.away_name}
          elo={prediction?.teams.away.elo ?? teams.away?.elo ?? null}
          eloRank={prediction?.teams.away.eloRank ?? teams.away?.eloRank ?? null}
          record={prediction?.teams.away.record ?? teams.away?.record ?? null}
          onClick={game.away_id ? () => onOpenTeam(game.league, game.away_id!) : undefined}
        />
        <span className="shrink-0 pt-1 text-[13px] font-medium text-(--ink-faint)">@</span>
        <TeamName
          league={game.league}
          id={game.home_id}
          logo={prediction?.teams.home.logo ?? teams.home?.logo ?? null}
          name={prediction?.teams.home.name ?? game.home_name}
          elo={prediction?.teams.home.elo ?? teams.home?.elo ?? null}
          eloRank={prediction?.teams.home.eloRank ?? teams.home?.eloRank ?? null}
          record={prediction?.teams.home.record ?? teams.home?.record ?? null}
          alignRight
          homeBadge
          onClick={game.home_id ? () => onOpenTeam(game.league, game.home_id!) : undefined}
        />
      </div>

      {prediction ? (
        <>
          <div className="flex items-end justify-between gap-3">
            <HeroStat
              value={pct(prediction.model.probAway)}
              label={t('eq.visitante')}
              sub={game.away_odds ? t('tt.cuota', { c: game.away_odds }) : undefined}
              color={AWAY_COLOR}
            />
            <HeroStat
              value={pct(prediction.model.probHome)}
              label={t('eq.local')}
              sub={game.home_odds ? t('tt.cuota', { c: game.home_odds }) : undefined}
              color={HOME_COLOR}
              align="right"
            />
          </div>
          {/* UNA barra, con el mercado marcado encima — no dos apiladas.
              La segunda barra («Mercado, sin vig») era más fina, no llevaba ni un número,
              y para saber si el modelo se apartaba del precio había que comparar a ojo
              dos rectángulos casi iguales. Tres puntos porcentuales son once píxeles: eso
              no se compara mirando. Ahora la distancia entre el corte y la marca ES la
              discrepancia, y la cifra va al lado. */}
          <div className="mt-2.5">
            <div className="mb-1 flex items-center justify-end">
              <MarketGap
                model={prediction.model.probAway}
                market={prediction.market.market?.implied2}
              />
            </div>
            <ProbabilityBar
              segments={[
                { value: prediction.model.probAway, color: AWAY_COLOR, label: game.away_name },
                { value: prediction.model.probHome, color: HOME_COLOR, label: game.home_name },
              ]}
              marker={prediction.market.market?.implied2}
            />
          </div>

          {/* The numbers a basketball bettor looks at — as probabilities now, not
              just point estimates. A spread with no likelihood attached invites
              the reader to treat it as a certainty. */}

          <div className="mt-3">
            <SectionTitle right={t('bkc.sigma')}>{t('bkc.porCuanto')}</SectionTitle>
            <div className="space-y-1">
              {prediction.projection.distribution.bands
                .slice()
                .reverse()
                .map((b) => (
                  <BarRow
                    key={b.label}
                    label={marginBandLabel(b)}
                    value={b.probability}
                    max={Math.max(
                      ...prediction.projection.distribution.bands.map((x) => x.probability),
                    )}
                    color={b.from >= 0 ? HOME_COLOR : AWAY_COLOR}
                    valueLabel={pct(b.probability)}
                    title={`${b.label}: ${pct(b.probability)}`}
                  />
                ))}
            </div>
            <p className="mt-1.5 text-[13px] text-(--ink-muted)">
              {t('bkc.positivo')}
            </p>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-(--line) pt-3">
            <p className="min-w-0 text-[15px] leading-snug text-(--ink-body)">
              {prediction.verdict.favored ? (
                <>
                  {conNodos(t('eq.favorece'), {
                    nombre: (
                      <strong className="font-semibold text-(--ink-strong)">
                        {prediction.verdict.favoredName}
                      </strong>
                    ),
                  })}
                </>
              ) : (
                t('tt.parejo')
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
                  {realMarket(game.source) && valueTeam && (
                <Badge tone="good" title={t('eq.valueTitulo')}>
                  {t('eq.value', { nombre: valueTeam })}
                </Badge>
              )}
              <ReliabilityChip
                level={prediction.reliability.level}
                label={prediction.reliability.label}
                marginPp={prediction.reliability.marginPp}
                title={[
                  t('eq.margenPp', { pp: prediction.reliability.marginPp }),
                  t('eq.trasCadaElo', { a: prediction.reliability.gamesBehind.home, b: prediction.reliability.gamesBehind.away }),
                  ...prediction.reliability.reasons,
                ].join('\n')}
              />
            </div>
          </div>

          <div className="mt-2 flex justify-end">
            <EnlacePartido sport="basketball" id={game.id} clave={item.prePartido?.matchKey} />
          </div>
          <EventTrustPanel confianza={item.confianza} prePartido={item.prePartido} />
          <div className="mt-1">
            <Disclosure summary={t('bkc.porQue')}>
              <div className="space-y-3">
                <StatRow>
            <StatTile
              label={t('bkc.diferencia')}
              value={prediction.projection.spreadLabel}
              hint={t('bkc.margenEsperado')}
            />
            <StatTile
              label={t('bkc.cubre', { linea: `${prediction.projection.distribution.spreadLine > 0 ? '+' : ''}${prediction.projection.distribution.spreadLine}` })}
              value={pct(prediction.projection.distribution.homeCovers)}
              hint={t('bkc.localHandicap')}
              title={t('bkc.cubreTitulo')}
            />
            <StatTile
              label="Total"
              value={prediction.projection.total != null ? String(Math.round(prediction.projection.total)) : '—'}
              hint={t('bkc.puntosEsperados')}
            />
            <StatTile
              label={
                prediction.projection.distribution.totalLine != null
                  ? `+${prediction.projection.distribution.totalLine}`
                  : 'Over'
              }
              value={
                prediction.projection.distribution.over != null
                  ? pct(prediction.projection.distribution.over)
                  : '—'
              }
              hint={
                prediction.projection.distribution.under != null
                  ? t('bkc.under', { p: pct(prediction.projection.distribution.under) })
                  : undefined
              }
            />
          </StatRow>
                <GameDetail prediction={prediction} />
                <Panel>
                  <SectionTitle>{t('eq.lecturaCompleta')}</SectionTitle>
                  <ul className="space-y-1.5">
                    {prediction.summary.bullets.map((b, i) => (
                      <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-(--ink-soft)">
                        <span aria-hidden className="text-(--ink-faint)">•</span>
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                </Panel>
              </div>
            </Disclosure>
          </div>
        </>
      ) : (
        <MissingModel item={item} />
      )}
    </Card>
  );
}




function TeamName({
  league, id, logo, name, elo, eloRank, record, alignRight = false, homeBadge = false, onClick,
}: {
  league: string;
  id: string | null;
  /** The basketball ingest fetches real badges; use one when we have it. */
  logo?: string | null;
  name: string;
  elo: number | null;
  eloRank: number | null;
  record: { wins: number; losses: number } | null;
  alignRight?: boolean;
  homeBadge?: boolean;
  onClick?: () => void;
}) {
  const { t } = useI18n();
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
          className={`max-w-full text-[17px] font-semibold leading-tight break-words text-(--ink-strong) ${
            onClick ? 'hover:underline' : 'cursor-default'
          }`}
          title={onClick ? t('eq.verFicha') : name}
        >
          {name}
        </button>
        {alignRight && <TeamCrest league={league} name={name} code={id} logo={logo} />}
      </span>
      <div className="text-[13px] text-(--ink-muted)">
        {homeBadge && t('eq.localPunto')}
        {elo != null && (
          <>
            Elo {Math.round(elo)}
            {eloRank != null && ` (#${eloRank})`}
          </>
        )}
        {record && ` · ${record.wins}–${record.losses}`}
      </div>
    </div>
  );
}

/**
 * How much data is behind this probability, shown where it changes the reading:
 * "62% (fiabilidad baja, ±11 pp)" is a very different claim from "62% (alta, ±3)".
 */

/**
 * A prediction needs both teams in the history. Naming what is missing points at
 * the cause — usually a league with no results feed, or a team the odds provider
 * spells differently — instead of a vague "no prediction".
 */
function MissingModel({ item }: { item: BbGameWithPrediction }) {
  const { t } = useI18n();
  const { game, marketOnly } = item;
  const missing = [
    !game.home_id ? game.home_name : null,
    !game.away_id ? game.away_name : null,
  ].filter(Boolean) as string[];
  return (
    <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 p-3 text-[14px] text-amber-200">
      <p className="font-medium">{t('bkc.sinModelo')}</p>
      {missing.length > 0 ? (
        <p className="mt-1">
          {conNodos(t('bkc.noEncuentro'), { quien: <strong>{missing.join(', ')}</strong> })}
        </p>
      ) : (
        <p className="mt-1">{t('bkc.faltanDatos')}</p>
      )}
      {marketOnly && (
        <p className="mt-2 text-amber-100">
          {conNodos(t('bkc.implicita', { equipoA: game.away_name, equipoB: game.home_name }), {
            a: <strong>{pctF(marketOnly.implied2, 1)}</strong>,
            b: <strong>{pctF(marketOnly.implied1, 1)}</strong>,
          })}
        </p>
      )}
    </div>
  );
}

export type { BbTeamSide };
