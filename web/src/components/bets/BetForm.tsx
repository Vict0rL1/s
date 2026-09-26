import { useEffect, useMemo, useState } from 'react';
import {
  BetRequestError,
  createBet,
  MARKET_LABEL,
  SPORT_LABEL,
  fetchBetCandidates,
  patchBet,
  type Bet,
  type BetCandidate,
  type BetInput,
  type FieldError,
} from '../../lib/bets';
import { HOME_COLOR, PROFIT_COLOR } from '../../lib/theme';

const MARKETS = ['moneyline', 'spread', 'total', 'btts', 'score', 'other'];
const SPORTS = ['football', 'basketball', 'baseball', 'nfl', 'tennis', 'other'];

/**
 * Log a bet, or edit one.
 *
 * TWO WAYS IN, and the difference matters. Picking an upcoming match captures the
 * model's and the market's probability at that moment, which is what later lets the
 * tab answer "did agreeing with the model help?". Typing it by hand always works
 * but cannot join that comparison — so the form says which mode you are in rather
 * than leaving the missing column unexplained.
 *
 * The stake and the odds are always typed. They come off a betting slip, not from
 * us, and pre-filling a price the book may not have offered would put a number in
 * the profit column that nobody agreed to.
 */
export default function BetForm({
  editing,
  onDone,
  onCancel,
}: {
  editing?: Bet | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [candidates, setCandidates] = useState<BetCandidate[] | null>(null);
  const [pickedKey, setPickedKey] = useState<string>('');
  const [manual, setManual] = useState(!!editing);

  const [form, setForm] = useState({
    sport: editing?.sport ?? 'nfl',
    league: editing?.league ?? '',
    event: editing?.event ?? '',
    market: editing?.market ?? 'moneyline',
    selection: editing?.selection ?? '',
    odds: editing ? String(editing.odds) : '',
    stake: editing ? String(editing.stake) : '',
    placed_on: editing?.placed_on ?? todayLocal(),
    notes: editing?.notes ?? '',
  });
  const [probs, setProbs] = useState<{ model: number | null; market: number | null }>({
    model: editing?.model_prob ?? null,
    market: editing?.market_prob ?? null,
  });
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (editing) return;
    let alive = true;
    fetchBetCandidates()
      .then((c) => alive && setCandidates(c))
      .catch(() => alive && setCandidates([]));
    return () => {
      alive = false;
    };
  }, [editing]);

  const picked = useMemo(
    () => candidates?.find((c) => c.matchKey === pickedKey) ?? null,
    [candidates, pickedKey],
  );

  const errorFor = (field: string) => errors.find((e) => e.field === field)?.message;

  const submit = async () => {
    setBusy(true);
    setErrors([]);
    const input: BetInput = {
      sport: form.sport,
      league: form.league || null,
      event: form.event,
      market: form.market,
      selection: form.selection,
      // Sent as typed. The server parses the comma decimal a Spanish keyboard
      // produces, so "1,85" is accepted rather than silently becoming NaN here.
      odds: form.odds as unknown as number,
      stake: form.stake as unknown as number,
      placed_on: form.placed_on,
      notes: form.notes || null,
      model_prob: probs.model,
      market_prob: probs.market,
      match_key: picked?.matchKey ?? editing?.match_key ?? null,
    };
    try {
      if (editing) await patchBet(editing.id, input);
      else await createBet(input);
      onDone();
    } catch (e) {
      if (e instanceof BetRequestError) setErrors(e.errors);
      else setErrors([{ field: '_', message: 'No se pudo guardar. ¿Está el servidor arriba?' }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/[0.09] bg-[#14161b] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-[16px] font-semibold text-[#e8eaed]">
          {editing ? 'Editar apuesta' : 'Registrar apuesta'}
        </h3>
        <button onClick={onCancel} className="text-[14px] text-[#9aa1ac] hover:text-[#e8eaed]">
          Cancelar
        </button>
      </div>

      {!editing && (
        <div className="mb-3">
          <div className="mb-1.5 flex gap-1">
            <ModeTab active={!manual} onClick={() => setManual(false)}>
              Desde un partido
            </ModeTab>
            <ModeTab active={manual} onClick={() => setManual(true)}>
              A mano
            </ModeTab>
          </div>
          {!manual &&
            (candidates == null ? (
              <p className="text-[14px] text-[#7b828d]">Cargando partidos…</p>
            ) : candidates.length === 0 ? (
              <p className="text-[14px] text-[#7b828d]">
                No hay partidos próximos cargados. Usa «A mano», o configura{' '}
                <code className="text-[#9aa1ac]">ODDS_API_KEY</code> y actualiza.
              </p>
            ) : (
              <>
                <Field label="Partido" error={errorFor('event')}>
                  <select
                    className={selectClass}
                    value={pickedKey}
                    onChange={(e) => {
                      const key = e.target.value;
                      setPickedKey(key);
                      const c = candidates.find((x) => x.matchKey === key);
                      if (c) {
                        setForm((f) => ({
                          ...f,
                          sport: c.sport,
                          league: c.league ?? '',
                          event: c.event,
                          selection: '',
                          odds: '',
                        }));
                        setProbs({ model: null, market: null });
                      }
                    }}
                  >
                    <option value="">Elige un partido…</option>
                    {candidates.map((c) => (
                      <option key={c.matchKey} value={c.matchKey}>
                        {SPORT_LABEL[c.sport] ?? c.sport} · {c.event} ·{' '}
                        {new Date(c.commenceTime).toLocaleDateString('es', {
                          day: 'numeric',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </option>
                    ))}
                  </select>
                </Field>

                {picked && (
                  <div className="mt-2">
                    <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.06em] text-[#7b828d]">
                      A qué le apostaste
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {picked.sides.map((s) => {
                        const on = form.selection === s.label;
                        return (
                          <button
                            key={s.label}
                            type="button"
                            onClick={() => {
                              setForm((f) => ({
                                ...f,
                                selection: s.label,
                                // The market's price is a suggestion, not a
                                // commitment: it is only pre-filled when we have
                                // one, and it stays editable.
                                odds: s.odds ? String(s.odds) : f.odds,
                              }));
                              setProbs({ model: s.modelProb, market: s.marketProb });
                            }}
                            className={`rounded-lg px-3 py-2 text-left text-[14px] ring-1 ring-inset transition ${
                              on
                                ? 'bg-white/[0.12] text-[#e8eaed] ring-white/25'
                                : 'text-[#c3c9d1] ring-white/[0.1] hover:bg-white/[0.05]'
                            }`}
                          >
                            <span className="block font-medium">{s.label}</span>
                            <span className="block text-[11px] tabular-nums text-[#7b828d]">
                              {s.odds ? `cuota ${s.odds}` : 'sin cuota'}
                              {s.marketProb != null && ` · mercado ${(s.marketProb * 100).toFixed(0)}%`}
                              {s.modelProb != null && (
                                <span style={{ color: PROFIT_COLOR }}>
                                  {' '}
                                  · modelo {(s.modelProb * 100).toFixed(0)}%
                                </span>
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {probs.model == null && form.selection && (
                      <p className="mt-1.5 text-[11px] leading-relaxed text-[#7b828d]">
                        Sin probabilidad del modelo para este lado, así que esta apuesta no entrará
                        en la comparación «con o contra el modelo». El resto se registra igual.
                      </p>
                    )}
                  </div>
                )}
              </>
            ))}
        </div>
      )}

      {(manual || editing || picked) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {(manual || editing) && (
            <>
              <Field label="Deporte" error={errorFor('sport')}>
                <select
                  className={selectClass}
                  value={form.sport}
                  onChange={(e) => setForm({ ...form, sport: e.target.value })}
                >
                  {SPORTS.map((s) => (
                    <option key={s} value={s}>
                      {SPORT_LABEL[s] ?? s}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Partido o evento" error={errorFor('event')}>
                <input
                  className={inputClass}
                  value={form.event}
                  placeholder="Seahawks vs Patriots"
                  onChange={(e) => setForm({ ...form, event: e.target.value })}
                />
              </Field>
            </>
          )}

          <Field label="Mercado" error={errorFor('market')}>
            <select
              className={selectClass}
              value={form.market}
              onChange={(e) => setForm({ ...form, market: e.target.value })}
            >
              {MARKETS.map((m) => (
                <option key={m} value={m}>
                  {MARKET_LABEL[m] ?? m}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Selección" error={errorFor('selection')}>
            <input
              className={inputClass}
              value={form.selection}
              placeholder="Seahawks -3.5"
              onChange={(e) => setForm({ ...form, selection: e.target.value })}
            />
          </Field>

          <Field label="Cuota (decimal)" error={errorFor('odds')}>
            <input
              className={inputClass}
              value={form.odds}
              inputMode="decimal"
              placeholder="1.85"
              onChange={(e) => setForm({ ...form, odds: e.target.value })}
            />
          </Field>

          <Field label="Cantidad" error={errorFor('stake')}>
            <input
              className={inputClass}
              value={form.stake}
              inputMode="decimal"
              placeholder="50"
              onChange={(e) => setForm({ ...form, stake: e.target.value })}
            />
          </Field>

          <Field label="Fecha" error={errorFor('placed_on')}>
            <input
              type="date"
              className={inputClass}
              value={form.placed_on}
              onChange={(e) => setForm({ ...form, placed_on: e.target.value })}
            />
          </Field>

          <Field label="Nota (opcional)" error={errorFor('notes')} full>
            <input
              className={inputClass}
              value={form.notes}
              placeholder="por qué la hiciste"
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </Field>

          {/* The payout the odds imply, so a typo in either field is visible before
              it becomes a wrong P&L. */}
          <Payout odds={form.odds} stake={form.stake} />

          <div className="sm:col-span-2">
            {errorFor('_') && <p className="mb-2 text-[14px] text-[#d95926]">{errorFor('_')}</p>}
            <button
              onClick={submit}
              disabled={busy}
              className="w-full rounded-lg px-4 py-2.5 text-[16px] font-semibold text-[#0b0d11] transition disabled:opacity-60"
              style={{ backgroundColor: HOME_COLOR }}
            >
              {busy ? 'Guardando…' : editing ? 'Guardar cambios' : 'Registrar apuesta'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** What this bet returns if it wins — arithmetic shown before it can go wrong. */
function Payout({ odds, stake }: { odds: string; stake: string }) {
  const o = Number(odds.replace(',', '.'));
  const s = Number(stake.replace(',', '.'));
  if (!Number.isFinite(o) || !Number.isFinite(s) || o <= 1 || s <= 0) return <div className="hidden sm:block" />;
  const win = s * (o - 1);
  return (
    <div className="flex items-end pb-1 text-[14px] text-[#9aa1ac] sm:col-span-1">
      Si gana:{' '}
      <strong className="mx-1 font-semibold tabular-nums" style={{ color: PROFIT_COLOR }}>
        +{win.toFixed(2).replace(/\.00$/, '')}
      </strong>
      · si pierde <span className="ml-1 tabular-nums">−{s.toFixed(2).replace(/\.00$/, '')}</span>
    </div>
  );
}

function ModeTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-[14px] font-medium ring-1 ring-inset transition ${
        active ? 'bg-white/[0.12] text-[#e8eaed] ring-white/[0.18]' : 'text-[#9aa1ac] ring-white/[0.08]'
      }`}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  error,
  full,
  children,
}: {
  label: string;
  error?: string;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`block ${full ? 'sm:col-span-2' : ''}`}>
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.06em] text-[#7b828d]">
        {label}
      </span>
      {children}
      {/* The server's own message, under the field it names — not one generic
          "revisa el formulario" that leaves you hunting. */}
      {error && <span className="mt-1 block text-[13px] text-[#d95926]">{error}</span>}
    </label>
  );
}

const inputClass =
  'w-full rounded-lg bg-white/[0.05] px-3 py-2 text-[16px] text-[#e8eaed] ring-1 ring-inset ring-white/[0.1] placeholder:text-[#5c636c] focus:outline-none focus:ring-white/30';
const selectClass = `${inputClass} appearance-none`;

function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
