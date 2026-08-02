import type { BbGameWithPrediction, BbTeamSide } from '../../lib/basketball';
import { formatDateTime } from '../../lib/format';
import { AWAY_COLOR, HOME_COLOR, pct } from '../../lib/theme';
import {
  Badge,
  BarRow,
  Card,
  Disclosure,
  HeroStat,
  Panel,
  ProbabilityBar,
  ReliabilityChip,
  SectionTitle,
  TeamCrest,
  StatRow,
  StatTile,
} from '../ui';
import GameDetail from './GameDetail';

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
      <div className="mb-3 flex items-center justify-between gap-2 text-[11px] text-[#7b828d]">
        <time>{formatDateTime(game.commence_time)}</time>
        <div className="flex items-center gap-1.5">
          {prediction?.neutral && <Badge>cancha neutral</Badge>}
          {game.source === 'fixture' && <Badge tone="warning">partido demo</Badge>}
        </div>
      </div>

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
        <span className="shrink-0 pt-1 text-[11px] font-medium text-[#5c636c]">@</span>
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
              label="Visitante"
              sub={game.away_odds ? `cuota ${game.away_odds}` : undefined}
              color={AWAY_COLOR}
            />
            <HeroStat
              value={pct(prediction.model.probHome)}
              label="Local"
              sub={game.home_odds ? `cuota ${game.home_odds}` : undefined}
              color={HOME_COLOR}
              align="right"
            />
          </div>
          <div className="mt-2.5">
            <ProbabilityBar
              segments={[
                { value: prediction.model.probAway, color: AWAY_COLOR, label: game.away_name },
                { value: prediction.model.probHome, color: HOME_COLOR, label: game.home_name },
              ]}
            />
          </div>
          {prediction.market.market && (
            <div className="mt-1.5">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.06em] text-[#7b828d]">
                Mercado, sin vig
              </div>
              <ProbabilityBar
                height={5}
                segments={[
                  { value: prediction.market.market.implied2, color: AWAY_COLOR, label: 'mercado visitante' },
                  { value: prediction.market.market.implied1, color: HOME_COLOR, label: 'mercado local' },
                ]}
              />
            </div>
          )}

          {/* The numbers a basketball bettor looks at — as probabilities now, not
              just point estimates. A spread with no likelihood attached invites
              the reader to treat it as a certainty. */}
          <StatRow className="mt-3">
            <StatTile
              label="Diferencia"
              value={prediction.projection.spreadLabel}
              hint="margen esperado"
            />
            <StatTile
              label={`Cubre ${prediction.projection.distribution.spreadLine > 0 ? '+' : ''}${prediction.projection.distribution.spreadLine}`}
              value={pct(prediction.projection.distribution.homeCovers)}
              hint="el local, con hándicap"
              title="Probabilidad de que el local cubra ese hándicap, con σ = 11.7 puntos medida sobre 58.281 partidos"
            />
            <StatTile
              label="Total"
              value={prediction.projection.total != null ? String(Math.round(prediction.projection.total)) : '—'}
              hint="puntos esperados"
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
                  ? `under: ${pct(prediction.projection.distribution.under)}`
                  : undefined
              }
            />
          </StatRow>

          <div className="mt-3">
            <SectionTitle right="σ 11.7 puntos, medida">Por cuánto gana</SectionTitle>
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
            <p className="mt-1.5 text-[11px] text-[#7b828d]">
              Positivo = gana el local. La barra más larga es el resultado más probable, no el único.
            </p>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-3">
            <p className="min-w-0 text-[13px] leading-snug text-[#c3c9d1]">
              {prediction.verdict.favored ? (
                <>
                  El modelo favorece a{' '}
                  <strong className="font-semibold text-[#e8eaed]">
                    {prediction.verdict.favoredName}
                  </strong>
                </>
              ) : (
                'Partido muy parejo'
              )}
            </p>
            <div className="flex shrink-0 items-center gap-1.5">
              {valueTeam && (
                <Badge tone="good" title="El modelo da más probabilidad que el mercado">
                  Value: {valueTeam}
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
            <Disclosure summary="Ver desglose · Elo, campo, descanso y mercado">
              <div className="space-y-3">
                <GameDetail prediction={prediction} />
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
  return (
    <div className={`min-w-0 flex-1 ${alignRight ? 'text-right' : ''}`}>
      <span className={`flex items-center gap-1.5 ${alignRight ? 'justify-end' : ''}`}>
        {/* The crest, not the series dot: the dot's job is done one line below
            by the hero label, and two identity marks on one line is one too many. */}
        {!alignRight && <TeamCrest league={league} name={name} code={id} logo={logo} />}
        <button
          onClick={onClick}
          disabled={!onClick}
          className={`max-w-full truncate text-[15px] font-semibold leading-tight text-[#e8eaed] ${
            onClick ? 'hover:underline' : 'cursor-default'
          }`}
          title={onClick ? 'Ver ficha del equipo' : name}
        >
          {name}
        </button>
        {alignRight && <TeamCrest league={league} name={name} code={id} logo={logo} />}
      </span>
      <div className="truncate text-[11px] text-[#7b828d]">
        {homeBadge && 'local · '}
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
  const { game, marketOnly } = item;
  const missing = [
    !game.home_id ? game.home_name : null,
    !game.away_id ? game.away_name : null,
  ].filter(Boolean) as string[];
  return (
    <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 p-3 text-xs text-amber-200">
      <p className="font-medium">Sin modelo para este partido.</p>
      {missing.length > 0 ? (
        <p className="mt-1">
          No encuentro en el historial a: <strong>{missing.join(', ')}</strong>. Suele pasar en ligas
          sin fuente de resultados (EuroLeague, NBL) o cuando la casa escribe el nombre de otra
          forma.
        </p>
      ) : (
        <p className="mt-1">Faltan datos históricos de esta liga.</p>
      )}
      {marketOnly && (
        <p className="mt-2 text-amber-100">
          Probabilidad implícita del mercado (sin vig):{' '}
          <strong>{(marketOnly.implied2 * 100).toFixed(1)}%</strong> {game.away_name} ·{' '}
          <strong>{(marketOnly.implied1 * 100).toFixed(1)}%</strong> {game.home_name}
        </p>
      )}
    </div>
  );
}

export type { BbTeamSide };
