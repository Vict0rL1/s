import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  deleteBet,
  fetchBetSummary,
  fetchBets,
  MARKET_LABEL,
  money,
  patchBet,
  pctSigned,
  signed,
  SPORT_LABEL,
  STATUS_LABEL,
  type Bet,
  type BetStatus,
  type BetSummary,
} from '../../lib/bets';
import { BREAK_EVEN_COLOR, LOSS_COLOR, PROFIT_COLOR } from '../../lib/theme';
import { dayLabel, groupByDay } from '../../lib/format';
import { Card, DayHeading, EmptyState, Panel, SectionTitle, SkeletonList, pillClass } from '../ui';
import BetCalendar from './BetCalendar';
import ProfitCurve from './ProfitCurve';
import BetForm from './BetForm';

/**
 * The bet log.
 *
 * NOT a sixth sport. The five sport tabs show what the MODEL thinks; this shows
 * what YOU did, and the only thing it takes from the models is the probability
 * captured when a bet was logged.
 *
 * The order answers the questions in the order they get asked: how am I doing
 * (the four headline numbers), how did I get here (the curve), which days did it
 * (the calendar), and what exactly did I bet (the list).
 */
export default function BetsDashboard() {
  const [bets, setBets] = useState<Bet[] | null>(null);
  const [summary, setSummary] = useState<BetSummary | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Bet | null>(null);
  const [sport, setSport] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);

  const load = useCallback(() => {
    const q: Record<string, string> = sport ? { sport } : {};
    Promise.all([fetchBets(q), fetchBetSummary(q)])
      .then(([b, s]) => {
        setBets(b);
        setSummary(s);
      })
      .catch(() => {
        setBets([]);
        setSummary(null);
      });
  }, [sport]);

  useEffect(load, [load]);

  const shown = useMemo(() => (day ? (bets ?? []).filter((b) => b.placed_on === day) : bets ?? []), [bets, day]);
  const groups = useMemo(() => groupByDay(shown, (b) => `${b.placed_on}T12:00:00`), [shown]);

  const settle = async (b: Bet, status: BetStatus) => {
    // A cashout needs an amount the odds cannot supply, so it is only settable
    // from the edit form — see the note in bets.ts.
    if (status === 'cashout') {
      setEditing(b);
      return;
    }
    await patchBet(b.id, { status });
    load();
  };

  const remove = async (b: Bet) => {
    if (!confirm(`¿Borrar la apuesta «${b.selection}» de ${b.event}?`)) return;
    await deleteBet(b.id);
    load();
  };

  if (bets == null) return <SkeletonList />;

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-[15px] leading-relaxed text-[#c3c9d1]">
          Tus apuestas: cuánto pusiste, qué volvió y qué días te costaron dinero. Lo que registras
          aquí es tuyo — no sale de ningún modelo, y ningún modelo se puntúa con él.
        </p>
        {!adding && !editing && (
          <button
            onClick={() => setAdding(true)}
            className="rounded-lg bg-white/[0.1] px-3.5 py-2 text-[15px] font-medium text-[#e8eaed] ring-1 ring-inset ring-white/[0.14] transition hover:bg-white/[0.16]"
          >
            + Registrar apuesta
          </button>
        )}
      </div>

      {(adding || editing) && (
        <BetForm
          editing={editing}
          onDone={() => {
            setAdding(false);
            setEditing(null);
            load();
          }}
          onCancel={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      )}

      {summary && summary.totals.bets > 0 ? (
        <>
          <Card className="p-4">
            <Headline summary={summary} />
            {summary.cumulative.length >= 3 && (
              <Panel>
                <ProfitCurve points={summary.cumulative} />
              </Panel>
            )}
          </Card>

          <Card className="p-4">
            <BetCalendar daily={summary.daily} onPickDay={setDay} selectedDay={day} />
          </Card>

          {summary.modelAgreement && <ModelAgreement summary={summary} />}
          {(summary.bySport.length > 1 || summary.byMarket.length > 1) && <Breakdown summary={summary} />}
        </>
      ) : null}

      {/* Sport filter, only once there is more than one to filter. */}
      {summary && summary.bySport.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          <button className={pillClass(sport == null)} onClick={() => setSport(null)}>
            Todos
          </button>
          {summary.bySport.map((g) => (
            <button key={g.key} className={pillClass(sport === g.key)} onClick={() => setSport(g.key)}>
              {SPORT_LABEL[g.key] ?? g.key} <span className="ml-1 text-[#7b828d]">{g.bets}</span>
            </button>
          ))}
        </div>
      )}

      {day && (
        <button
          onClick={() => setDay(null)}
          className="text-[14px] text-[#9aa1ac] underline decoration-white/20 hover:text-[#e8eaed]"
        >
          Viendo solo {dayLabel(day)} — ver todo
        </button>
      )}

      {bets.length === 0 ? (
        <EmptyState title="Todavía no has registrado ninguna apuesta">
          Pulsa «Registrar apuesta». Si la eliges de un partido próximo, la app guarda también lo
          que pensaban el modelo y el mercado en ese momento, y con el tiempo podrá decirte si
          seguirlo te sirvió.
        </EmptyState>
      ) : (
        groups.map((g) => (
          <section key={g.key}>
            <DayHeading
              label={g.label}
              count={g.items.length}
              right={<DayTotal bets={g.items} />}
            />
            <div className="space-y-2">
              {g.items.map((b) => (
                <BetRow key={b.id} bet={b} onSettle={settle} onEdit={setEditing} onDelete={remove} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

/** The four numbers that answer "how am I doing". */
function Headline({ summary }: { summary: BetSummary }) {
  const t = summary.totals;
  const tone = t.profit > 0 ? PROFIT_COLOR : t.profit < 0 ? LOSS_COLOR : BREAK_EVEN_COLOR;
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="block text-[11px] font-medium uppercase tracking-[0.06em] text-[#7b828d]">
            Beneficio
          </span>
          <span className="block text-[26px] font-bold leading-none tabular-nums" style={{ color: tone }}>
            {signed(t.profit)}
          </span>
        </div>
        <div className="text-right">
          <span className="block text-[11px] font-medium uppercase tracking-[0.06em] text-[#7b828d]">
            ROI
          </span>
          <span className="block text-[26px] font-bold leading-none tabular-nums" style={{ color: tone }}>
            {t.roi == null ? '—' : pctSigned(t.roi)}
          </span>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-white/[0.07] pt-3 sm:grid-cols-4">
        <Stat label="Apostado" value={money(t.staked)} hint={`${t.bets} apuesta${t.bets === 1 ? '' : 's'}`} />
        <Stat
          label="Acierto"
          value={t.hitRate == null ? '—' : `${(t.hitRate * 100).toFixed(0)}%`}
          hint={`${t.wins}-${t.losses}`}
        />
        <Stat
          label="Pendientes"
          value={String(summary.pending.bets)}
          hint={summary.pending.bets ? `${money(summary.pending.staked)} en juego` : 'nada en juego'}
        />
        <Stat
          label="Rachas"
          value={`${summary.longestWinStreak}W / ${summary.longestLoseStreak}L`}
          hint="la mejor y la peor"
        />
      </div>
      {/* ROI is over stake AT RISK, and saying so matters: a run of voids would
          otherwise look like it had quietly dragged the number down. */}
      <p className="mt-2 text-[11px] leading-relaxed text-[#7b828d]">
        El ROI se calcula sobre lo que estuvo realmente en riesgo ({money(t.risked)}), así que las
        anuladas no lo diluyen. Las pendientes no cuentan hasta que se resuelven.
      </p>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-[#7b828d]">{label}</div>
      <div className="mt-0.5 text-[16px] font-semibold tabular-nums text-[#e8eaed]">{value}</div>
      {hint && <div className="text-[11px] tabular-nums text-[#7b828d]">{hint}</div>}
    </div>
  );
}

/**
 * Did following the model help?
 *
 * The one thing this log can say that a bookmaker's own history cannot. Withheld
 * below ten answerable bets by the server, because a split over four bets is noise
 * with a headline on it.
 */
function ModelAgreement({ summary }: { summary: BetSummary }) {
  const a = summary.modelAgreement!;
  const row = (g: typeof a.with, label: string) => (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-[14px] text-[#9aa1ac]">
        {label} <span className="text-[#5c636c]">· {g.bets} apuestas</span>
      </span>
      <span
        className="text-[16px] font-semibold tabular-nums"
        style={{ color: g.profit > 0 ? PROFIT_COLOR : g.profit < 0 ? LOSS_COLOR : BREAK_EVEN_COLOR }}
      >
        {signed(g.profit)}
        <span className="ml-2 text-[13px] font-normal text-[#7b828d]">
          {g.roi == null ? '' : pctSigned(g.roi)}
        </span>
      </span>
    </div>
  );
  return (
    <Card className="p-4">
      <SectionTitle right="donde discrepaban">¿Te sirvió seguir al modelo?</SectionTitle>
      {row(a.with, 'Cuando fuiste CON el modelo')}
      {row(a.against, 'Cuando fuiste CONTRA el modelo')}
      <p className="mt-2 text-[11px] leading-relaxed text-[#7b828d]">
        Solo entran las apuestas que elegiste desde un partido de la app y en las que el modelo se
        separaba al menos 2 puntos del mercado. Con pocas apuestas esto es ruido: míralo como una
        tendencia a los meses, no como un veredicto.
      </p>
    </Card>
  );
}

function Breakdown({ summary }: { summary: BetSummary }) {
  const group = (
    title: string,
    rows: BetSummary['bySport'],
    label: (k: string) => string,
  ) => (
    <div className="min-w-0 flex-1">
      <SectionTitle>{title}</SectionTitle>
      <div className="space-y-1">
        {rows.map((g) => (
          <div key={g.key} className="flex items-baseline justify-between gap-3">
            <span className="truncate text-[14px] text-[#9aa1ac]">
              {label(g.key)} <span className="text-[#5c636c]">{g.bets}</span>
            </span>
            <span
              className="shrink-0 text-[14px] font-semibold tabular-nums"
              style={{ color: g.profit > 0 ? PROFIT_COLOR : g.profit < 0 ? LOSS_COLOR : BREAK_EVEN_COLOR }}
            >
              {signed(g.profit)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
  return (
    <Card className="p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:gap-8">
        {summary.bySport.length > 1 && group('Por deporte', summary.bySport, (k) => SPORT_LABEL[k] ?? k)}
        {summary.byMarket.length > 1 && group('Por mercado', summary.byMarket, (k) => MARKET_LABEL[k] ?? k)}
      </div>
    </Card>
  );
}

function DayTotal({ bets }: { bets: Bet[] }) {
  const settled = bets.filter((b) => b.profit != null);
  if (settled.length === 0) return <span className="text-[13px] text-[#7b828d]">sin resolver</span>;
  const net = settled.reduce((s, b) => s + (b.profit as number), 0);
  return (
    <span
      className="text-[13px] font-semibold tabular-nums"
      style={{ color: net > 0 ? PROFIT_COLOR : net < 0 ? LOSS_COLOR : BREAK_EVEN_COLOR }}
    >
      {signed(net)}
    </span>
  );
}

const SETTLE_OPTIONS: BetStatus[] = ['won', 'lost', 'void', 'half_won', 'half_lost', 'cashout'];

function BetRow({
  bet,
  onSettle,
  onEdit,
  onDelete,
}: {
  bet: Bet;
  onSettle: (b: Bet, s: BetStatus) => void;
  onEdit: (b: Bet) => void;
  onDelete: (b: Bet) => void;
}) {
  const [open, setOpen] = useState(false);
  const tone =
    bet.profit == null
      ? BREAK_EVEN_COLOR
      : bet.profit > 0
        ? PROFIT_COLOR
        : bet.profit < 0
          ? LOSS_COLOR
          : BREAK_EVEN_COLOR;

  return (
    <Card className="p-3">
      {/* A 3px bar on the left carries win/loss redundantly with the number, so the
          list scans without relying on reading each figure. */}
      <div className="flex gap-3">
        <span
          aria-hidden
          className="w-[3px] shrink-0 self-stretch rounded-full"
          style={{ backgroundColor: bet.profit == null ? 'rgba(255,255,255,0.14)' : tone }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="break-words text-[16px] font-semibold leading-tight text-[#e8eaed]">
                {bet.selection}
              </div>
              <div className="mt-0.5 break-words text-[13px] text-[#9aa1ac]">{bet.event}</div>
              <div className="mt-0.5 text-[11px] uppercase tracking-[0.06em] text-[#5c636c]">
                {SPORT_LABEL[bet.sport] ?? bet.sport} · {MARKET_LABEL[bet.market] ?? bet.market}
                {bet.withModel != null && (
                  <span style={{ color: bet.withModel ? PROFIT_COLOR : LOSS_COLOR }}>
                    {' '}
                    · {bet.withModel ? 'con el modelo' : 'contra el modelo'}
                  </span>
                )}
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-[16px] font-semibold tabular-nums" style={{ color: tone }}>
                {bet.profit == null ? STATUS_LABEL[bet.status] : signed(bet.profit)}
              </div>
              <div className="text-[13px] tabular-nums text-[#7b828d]">
                {money(bet.stake)} @ {bet.odds}
              </div>
            </div>
          </div>

          {bet.status === 'pending' ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {SETTLE_OPTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => onSettle(bet, s)}
                  className="rounded-md px-2.5 py-1 text-[13px] text-[#c3c9d1] ring-1 ring-inset ring-white/[0.1] transition hover:bg-white/[0.08] hover:text-[#e8eaed]"
                >
                  {STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-1.5 flex items-center gap-3 text-[13px]">
              <span className="text-[#7b828d]">{STATUS_LABEL[bet.status]}</span>
              <button onClick={() => setOpen((o) => !o)} className="text-[#9aa1ac] hover:text-[#e8eaed]">
                {open ? 'menos' : 'más'}
              </button>
            </div>
          )}

          {(open || bet.status === 'pending') && (
            <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-white/[0.07] pt-2 text-[13px]">
              {bet.model_prob != null && (
                <span className="text-[#7b828d]">
                  modelo {(bet.model_prob * 100).toFixed(0)}%
                  {bet.market_prob != null && ` · mercado ${(bet.market_prob * 100).toFixed(0)}%`}
                </span>
              )}
              {bet.notes && <span className="text-[#9aa1ac]">{bet.notes}</span>}
              <button onClick={() => onEdit(bet)} className="text-[#9aa1ac] hover:text-[#e8eaed]">
                Editar
              </button>
              <button onClick={() => onDelete(bet)} className="text-[#9aa1ac] hover:text-[#d95926]">
                Borrar
              </button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
