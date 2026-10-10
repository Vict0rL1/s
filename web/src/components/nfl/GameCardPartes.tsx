// Piezas de GameCard.tsx (partido en la Fase 5: ningún fichero de la interfaz pasa de ~400 líneas).
import { type NflPrediction, type NflSpreadQuote } from '../../lib/nfl';
import { AWAY_COLOR, HOME_COLOR, NEUTRAL_COLOR, pct } from '../../lib/theme';
import { PostprocessPanel } from '../PostprocessPanel';
import { BarRow, CompareRow, FactorValue, FormDots, Panel, SectionTitle, TeamCrest } from '../ui';
import { ClimaPanel } from '../ClimaPanel';
import { useI18n } from '../../i18n';
import { num as numF } from '../../lib/formato';

export const twoWay = (m: { home: number; away: number }): { home: number; away: number } => ({
  home: m.home / (m.home + m.away),
  away: m.away / (m.home + m.away),
});

export const fmtLine = (l: number) => (l === 0 ? 'PK' : `${l > 0 ? '+' : ''}${l}`);

/**
 * The key numbers.
 *
 * The single most useful thing this model knows and a normal curve does not.
 * Rendered as plain figures rather than a chart because four numbers are four
 * numbers, and the point is the comparison between them.
 */
export function KeyNumbers({ prediction }: { prediction: NflPrediction }) {
  const { t } = useI18n();
  const three = prediction.keyNumbers.find((k) => k.margin === 3)?.probability ?? 0;
  const seven = prediction.keyNumbers.find((k) => k.margin === 7)?.probability ?? 0;
  return (
    <div className="mt-3 border-b border-(--line) pb-3">
      <SectionTitle right={t('nfld.tresOSiete', { p: pct(three + seven) })}>
        {t('nfld.margenCae')}
      </SectionTitle>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {prediction.keyNumbers.map((k) => (
          <div key={k.margin} className="min-w-0">
            <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-(--ink-muted)">
              {t('nfld.nPuntos', { n: k.margin })}
            </div>
            <div className="text-[16px] font-semibold tabular-nums text-(--ink-strong)">
              {pct(k.probability)}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-(--ink-muted)">
        {t('nfld.numerosClave')}
      </p>
    </div>
  );
}

export function TeamName({
  league, id, name, elo, eloRank, record, alignRight = false, homeBadge = false, onClick,
}: {
  league: string;
  id: string | null;
  name: string;
  elo: number | null;
  eloRank: number | null;
  record: { wins: number; losses: number; ties: number } | null;
  alignRight?: boolean;
  homeBadge?: boolean;
  onClick?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className={`min-w-0 flex-1 ${alignRight ? 'text-right' : ''}`}>
      <span className={`flex min-w-0 items-center gap-1.5 ${alignRight ? 'justify-end' : ''}`}>
        {/* The crest, not the series dot: the dot's job is done one line below
            by the hero label, and two identity marks on one line is one too many. */}
        {!alignRight && <TeamCrest league={league} name={name} code={id} />}
        <button
          onClick={onClick}
          disabled={!onClick}
          // Wraps rather than truncates. At the larger type size "New England
          // Patriots" no longer fits half a 390px card, and `truncate` turned the
          // two team names — the one thing a matchup card exists to tell you —
          // into "New Engl…" and "Seattle S…". Two short lines cost a few pixels
          // of height and lose nothing.
          className={`max-w-full text-left text-[17px] font-semibold leading-tight break-words text-(--ink-strong) ${
            alignRight ? 'text-right' : ''
          } ${onClick ? 'hover:underline' : 'cursor-default'}`}
          title={onClick ? t('eq.verFicha') : name}
        >
          {name}
        </button>
        {alignRight && <TeamCrest league={league} name={name} code={id} />}
      </span>
      <div className="text-[13px] text-(--ink-muted)">
        {homeBadge && t('eq.localPunto')}
        {elo != null && (
          <>
            Elo {Math.round(elo)}
            {eloRank != null && ` (#${eloRank})`}
          </>
        )}
        {record && ` · ${record.wins}-${record.losses}${record.ties ? `-${record.ties}` : ''}`}
      </div>
    </div>
  );
}

export function Detail({ prediction, clima }: { prediction: NflPrediction; clima?: import('../../lib/clima').ClimaFicha | null }) {
  const { t } = useI18n();
  const { teams, spread, total, bands, scorelines, h2h, market, reasoning, summary, context } =
    prediction;
  const home = teams.home;
  const away = teams.away;
  const formColors = { W: HOME_COLOR, D: NEUTRAL_COLOR, L: AWAY_COLOR };
  const maxBand = Math.max(...bands.map((b) => b.probability));
  const maxScore = Math.max(...scorelines.map((s) => s.probability));

  return (
    <div className="space-y-3">
      <Panel>
        <SectionTitle>{t('det.porQue')}</SectionTitle>
        <p className="mb-2 text-[15px] leading-relaxed text-(--ink-body)">{reasoning.text}</p>
        <dl className="space-y-1 text-[13px]">
          {reasoning.factors.map((f) => (
            <div key={f.key} className="flex justify-between gap-3">
              <dt className="text-(--ink-soft)">{f.label}</dt>
              <dd>
                <FactorValue
                  color={f.pointsForHome >= 0 ? HOME_COLOR : AWAY_COLOR}
                  neutral={f.pointsForHome === 0}
                >
                  {f.pointsForHome === 0
                    ? t('eq.neutral')
                    : t('nfld.ptsPara', { n: Math.abs(f.pointsForHome), equipo: f.pointsForHome > 0 ? home.name : away.name })}
                </FactorValue>
              </dd>
            </div>
          ))}
        </dl>
      </Panel>

      {/* WHO IS PLAYING QUARTERBACK.
          Its own panel because it is the only model input a reader can check and
          correct from the news, and because the assumption behind it needs saying
          out loud: the schedule never names a starter, so the model uses whoever
          started last. Stating that is the difference between a reader who knows
          the forecast is stale and one who only suspects it. */}
      {(prediction.quarterbacks.home || prediction.quarterbacks.away) && (
        <Panel>
          <SectionTitle right={t('nfld.ultimoPartido')}>{t('nfld.qbTitular')}</SectionTitle>
          <dl className="space-y-1 text-[13px]">
            {([
              ['home', home.name, prediction.quarterbacks.home, HOME_COLOR],
              ['away', away.name, prediction.quarterbacks.away, AWAY_COLOR],
            ] as const).map(([key, teamName, qb, color]) => (
              <div key={key} className="flex justify-between gap-3">
                <dt className="text-(--ink-soft)">
                  {qb?.name ?? t('nfld.sinDato')}{' '}
                  <span className="text-(--ink-faint)">· {teamName}</span>
                </dt>
                <dd>
                  <FactorValue color={color} neutral={!qb || qb.points === 0}>
                    {!qb
                      ? '—'
                      : qb.points === 0
                        ? t('nfld.nivelMedio')
                        : t('nfld.qbPts', { p: `${qb.points > 0 ? '+' : ''}${qb.points}`, n: qb.starts })}
                  </FactorValue>
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-[13px] leading-relaxed text-(--ink-muted)">
            {t('nfld.qbNota')}
          </p>
        </Panel>
      )}

      {/* El clima (Fase 2C): información, no entrada del modelo. */}
      <ClimaPanel clima={clima} />

      {/* The handicap at the two lines the whole market is built around, priced
          at any line the reader might be looking at. */}
      <Panel>
        <SectionTitle right={spread.fromMarket ? t('nfld.lineaMercado') : t('nfld.lineaModelo')}>
          {t('nfld.handicapLinea')}
        </SectionTitle>
        <div className="space-y-1 text-[13px]">
          {spread.keyLines.map((q) => (
            <SpreadLine key={q.line} quote={q} homeName={home.name} />
          ))}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-(--ink-muted)">
          {t('nfld.nuloExplica')}
        </p>
      </Panel>

      <Panel>
        <SectionTitle right={t('nfld.esperados', { n: total.expected })}>{t('nfld.totalPuntos')}</SectionTitle>
        <div className="flex items-center gap-3 text-[13px]">
          <span className="w-16 shrink-0 text-(--ink-soft)">Over {total.line}</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-(--raised)">
            <div
              className="h-full rounded-full"
              style={{ width: `${total.over * 100}%`, backgroundColor: HOME_COLOR }}
            />
          </div>
          <span className="w-24 shrink-0 text-right tabular-nums text-(--ink-soft)">
            {pct(total.over)} / {pct(total.under)}
          </span>
        </div>
      </Panel>

      <Panel>
        <SectionTitle>{t('bkc.porCuanto')}</SectionTitle>
        <div className="space-y-1">
          {bands.map((b) => (
            <BarRow
              key={b.label}
              label={b.label.replace('local por ', '+').replace('visitante por ', '−')}
              value={b.probability}
              max={maxBand}
              color={
                b.from === 0 && b.to === 0
                  ? NEUTRAL_COLOR
                  : (b.from ?? -1) > 0
                    ? HOME_COLOR
                    : AWAY_COLOR
              }
              valueLabel={pct(b.probability)}
            />
          ))}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-(--ink-muted)">
          {t('nfld.tramos')}
        </p>
      </Panel>

      <Panel>
        <SectionTitle>{t('fbc.marcadoresProbables')}</SectionTitle>
        <div className="space-y-1">
          {scorelines.map((s) => (
            <BarRow
              key={s.label}
              label={s.label}
              value={s.probability}
              max={maxScore}
              color={s.home > s.away ? HOME_COLOR : s.home === s.away ? NEUTRAL_COLOR : AWAY_COLOR}
              valueLabel={pct(s.probability)}
            />
          ))}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-(--ink-muted)">
          {t('nfld.combinar')}
        </p>
      </Panel>

      <Panel>
        <SectionTitle>{t('eq.losDosEquipos')}</SectionTitle>
        <dl className="grid grid-cols-[1fr_auto_auto] gap-x-3 text-[13px]">
          <div />
          <div className="flex w-20 items-center justify-end gap-1.5 font-medium text-(--ink-strong)">
            <span className="break-words">{away.name}</span>
            <TeamCrest league={prediction.league} name={away.name} code={away.id} size={14} />
          </div>
          <div className="flex w-20 items-center justify-end gap-1.5 font-medium text-(--ink-strong)">
            <span className="break-words">{home.name}</span>
            <TeamCrest league={prediction.league} name={home.name} code={home.id} size={14} />
          </div>
          <CompareRow label="Elo" left={Math.round(away.elo)} right={Math.round(home.elo)} />
          <CompareRow label={t('nfld.pfPartido')} left={away.pf ?? '—'} right={home.pf ?? '—'} />
          <CompareRow label={t('nfld.paPartido')} left={away.pa ?? '—'} right={home.pa ?? '—'} />
          <CompareRow
            label={t('nfld.balance')}
            left={`${away.record.wins}-${away.record.losses}${away.record.ties ? `-${away.record.ties}` : ''}`}
            right={`${home.record.wins}-${home.record.losses}${home.record.ties ? `-${home.record.ties}` : ''}`}
          />
          <CompareRow
            label={t('bsd.pitagorico')}
            title={t('nfld.pitagoricoTitulo')}
            left={away.pythagorean != null ? pct(away.pythagorean) : '—'}
            right={home.pythagorean != null ? pct(home.pythagorean) : '—'}
          />
          <CompareRow
            label={t('eq.ultimos5')}
            title={t('nfld.coloresForma')}
            left={<FormDots results={away.last5} colors={formColors} />}
            right={<FormDots results={home.last5} colors={formColors} />}
          />
        </dl>
      </Panel>

      <Panel>
        <SectionTitle right={`${h2h.awayWins} · ${h2h.homeWins} (${h2h.total})`}>
          {t('eq.historialDirecto')}
        </SectionTitle>
        {h2h.recent.length === 0 ? (
          <p className="text-[13px] text-(--ink-muted)">{t('nfld.sinEnfrentamientos')}</p>
        ) : (
          <ul className="space-y-1 text-[13px]">
            {h2h.recent.map((m, i) => (
              <li key={i} className="flex justify-between gap-3 text-(--ink-body)">
                <span className="shrink-0 text-(--ink-muted)">
                  {t('nfld.temporadaSemana', { s: m.season, w: m.week })}
                </span>
                <span className="break-words text-right">
                  {m.awayId === away.id ? away.name : home.name} {m.awayPoints}–{m.homePoints}{' '}
                  {m.homeId === home.id ? home.name : away.name}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel>
        <SectionTitle>{t('eq.deDondeNumero')}</SectionTitle>
        <PostprocessPanel
          postprocess={prediction.postprocess}
          rows={[
            { label: t('eq.local'), raw: twoWay(prediction.model).home, final: prediction.final.home },
            { label: t('eq.visitante'), raw: twoWay(prediction.model).away, final: prediction.final.away },
          ]}
        />
      </Panel>

      {market.market && (
        <Panel>
          <SectionTitle
            right={
              market.market.overround != null
                ? t('eq.margenPct', { p: numF((market.market.overround - 1) * 100, 1) })
                : t('nfld.deCierre')
            }
          >
            {t('eq.mercado')}
          </SectionTitle>
          {market.market.odds ? (
            <p className="text-[13px] leading-relaxed text-(--ink-body)">
              {t('bsd.cuotasLinea', {
                a: market.market.odds.away,
                h: market.market.odds.home,
                pa: pct(market.market.away),
                ph: pct(market.market.home),
              })}
            </p>
          ) : (
            <>
              <p className="text-[13px] leading-relaxed text-(--ink-body)">
                {t('nfld.lineaCierre', {
                  linea: `${market.market.line! > 0 ? '+' : ''}${market.market.line}`,
                  pa: pct(market.market.away),
                  ph: pct(market.market.home),
                })}
              </p>
              {/* Said on the card and not only in the docs, because it changes how the
                  number above it should be read: on this sport the market is the better
                  forecast, and the reader is entitled to know that before comparing. */}
              <p className="mt-1.5 text-[12px] leading-relaxed text-(--ink-soft)">
                {t('nfld.mejorMercado')}
              </p>
            </>
          )}
        </Panel>
      )}

      <Panel>
        <SectionTitle right={t('nfld.ptsVentaja', { n: context.homeAdvantagePoints })}>
          {t('eq.lecturaCompleta')}
        </SectionTitle>
        <ul className="space-y-1.5">
          {summary.bullets.map((b, i) => (
            <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-(--ink-soft)">
              <span aria-hidden className="text-(--ink-faint)">
                •
              </span>
              <span>{b}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

export function SpreadLine({ quote, homeName }: { quote: NflSpreadQuote; homeName: string }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 tabular-nums text-(--ink-body)" title={quote.label}>
        {homeName.split(' ').slice(-1)[0]} {fmtLine(quote.line)}
      </span>
      <div className="flex h-2 flex-1 gap-[2px] overflow-hidden rounded-full">
        <div
          className="rounded-l-full"
          style={{ width: `${quote.cover * 100}%`, backgroundColor: HOME_COLOR }}
        />
        {quote.push > 0.002 && (
          <div style={{ width: `${quote.push * 100}%`, backgroundColor: NEUTRAL_COLOR }} />
        )}
        <div
          className="rounded-r-full"
          style={{ width: `${quote.fail * 100}%`, backgroundColor: AWAY_COLOR }}
        />
      </div>
      <span className="w-24 shrink-0 text-right tabular-nums text-(--ink-soft)">
        {pct(quote.cover)}
        {quote.push > 0.002 && <span className="text-(--ink-muted)"> · {t('nfld.nuloSufijo', { p: pct(quote.push) })}</span>}
      </span>
    </div>
  );
}
