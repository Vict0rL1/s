import { Sugerencia } from './ExtrasApuesta';
import { useEffect, useMemo, useState } from 'react';
import {
  BetRequestError,
  createBet,
  deporteDe,
  fetchBetCandidates,
  mercadoDe,
  patchBet,
  type Bet,
  type BetCandidate,
  type BetInput,
  type FieldError,
} from '../../lib/bets';
import { HOME_COLOR, PROFIT_TEXT } from '../../lib/theme';
import { Payout, ModeTab, Field, inputClass, selectClass, todayLocal } from './BetFormPartes';
import { conNodos, useI18n } from '../../i18n';
import { num as numF } from '../../lib/formato';

const MARKETS = ['moneyline', 'spread', 'total', 'btts', 'score', 'other'];
const SPORTS = ['football', 'basketball', 'baseball', 'nfl', 'nhl', 'ufc', 'tennis', 'other'];

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
  borrador,
  onDone,
  onCancel,
}: {
  editing?: Bet | null;
  /** Un borrador que llega de «Mi selección» (Fase 5.15). */
  borrador?: Record<string, unknown> | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const b = (k: string): string => (borrador && borrador[k] != null ? String(borrador[k]) : '');
  const { t, idioma } = useI18n();
  const [candidates, setCandidates] = useState<BetCandidate[] | null>(null);
  const [pickedKey, setPickedKey] = useState<string>('');
  const [manual, setManual] = useState(!!editing || !!borrador);
  const [tags, setTags] = useState((editing?.tags ?? []).join(', '));

  const [form, setForm] = useState({
    sport: editing?.sport ?? (b('sport') || 'nfl'),
    league: editing?.league ?? b('league'),
    event: editing?.event ?? b('event'),
    market: editing?.market ?? (b('market') || 'moneyline'),
    selection: editing?.selection ?? b('selection'),
    odds: editing ? String(editing.odds) : b('odds'),
    stake: editing ? String(editing.stake) : '',
    placed_on: editing?.placed_on ?? (b('placed_on') || todayLocal()),
    notes: editing?.notes ?? b('notes'),
  });
  const [probs, setProbs] = useState<{ model: number | null; market: number | null }>({
    model: editing?.model_prob ?? (borrador && typeof borrador.model_prob === 'number' ? borrador.model_prob : null),
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
      match_key: picked?.matchKey ?? editing?.match_key ?? (b('match_key') || null),
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
    };
    try {
      if (editing) await patchBet(editing.id, input);
      else await createBet(input);
      onDone();
    } catch (e) {
      if (e instanceof BetRequestError) setErrors(e.errors);
      else setErrors([{ field: '_', message: t('form.errorGuardar') }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-(--line) bg-(--surface-card) p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-[16px] font-semibold text-(--ink-strong)">
          {editing ? t('form.editar') : t('form.registrar')}
        </h3>
        <button onClick={onCancel} className="text-[14px] text-(--ink-soft) hover:text-(--ink-strong)">
          {t('comun.cancelar')}
        </button>
      </div>

      {!editing && (
        <div className="mb-3">
          <div className="mb-1.5 flex gap-1">
            <ModeTab active={!manual} onClick={() => setManual(false)}>
              {t('form.desdePartido')}
            </ModeTab>
            <ModeTab active={manual} onClick={() => setManual(true)}>
              {t('form.aMano')}
            </ModeTab>
          </div>
          {!manual &&
            (candidates == null ? (
              <p className="text-[14px] text-(--ink-muted)">{t('form.cargandoPartidos')}</p>
            ) : candidates.length === 0 ? (
              <p className="text-[14px] text-(--ink-muted)">
                {conNodos(t('form.sinPartidos'), { clave: <code className="text-(--ink-soft)">ODDS_API_KEY</code> })}
              </p>
            ) : (
              <>
                <Field label={t('form.partido')} error={errorFor('event')}>
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
                    <option value="">{t('form.elige')}</option>
                    {candidates.map((c) => (
                      <option key={c.matchKey} value={c.matchKey}>
                        {deporteDe(t, c.sport)} · {c.event} ·{' '}
                        {new Date(c.commenceTime).toLocaleDateString(idioma === 'en' ? 'en-GB' : 'es', {
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
                    <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.06em] text-(--ink-muted)">
                      {t('form.aQue')}
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
                                ? 'bg-(--raised-3) text-(--ink-strong) ring-(--line-strong)'
                                : 'text-(--ink-body) ring-(--line) hover:bg-(--raised)'
                            }`}
                          >
                            <span className="block font-medium">{s.label}</span>
                            <span className="block text-[11px] tabular-nums text-(--ink-muted)">
                              {s.odds ? t('form.cuota', { c: s.odds }) : t('form.sinCuota')}
                              {s.marketProb != null && t('form.mercadoPct', { p: numF(s.marketProb * 100, 0) })}
                              {s.modelProb != null && (
                                <span style={{ color: PROFIT_TEXT }}>
                                  {' '}
                                  {t('form.modeloPct', { p: numF(s.modelProb * 100, 0) })}
                                </span>
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {probs.model == null && form.selection && (
                      <p className="mt-1.5 text-[11px] leading-relaxed text-(--ink-muted)">
                        {t('form.sinProbModelo')}
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
              <Field label={t('form.deporte')} error={errorFor('sport')}>
                <select
                  className={selectClass}
                  value={form.sport}
                  onChange={(e) => setForm({ ...form, sport: e.target.value })}
                >
                  {SPORTS.map((s) => (
                    <option key={s} value={s}>
                      {deporteDe(t, s)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('form.evento')} error={errorFor('event')}>
                <input
                  className={inputClass}
                  value={form.event}
                  placeholder="Seahawks vs Patriots"
                  onChange={(e) => setForm({ ...form, event: e.target.value })}
                />
              </Field>
            </>
          )}

          <Field label={t('form.mercado')} error={errorFor('market')}>
            <select
              className={selectClass}
              value={form.market}
              onChange={(e) => setForm({ ...form, market: e.target.value })}
            >
              {MARKETS.map((m) => (
                <option key={m} value={m}>
                  {mercadoDe(t, m)}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t('form.seleccion')} error={errorFor('selection')}>
            <input
              className={inputClass}
              value={form.selection}
              placeholder="Seahawks -3.5"
              onChange={(e) => setForm({ ...form, selection: e.target.value })}
            />
          </Field>

          <Field label={t('form.cuotaDecimal')} error={errorFor('odds')}>
            <input
              className={inputClass}
              value={form.odds}
              inputMode="decimal"
              placeholder="1.85"
              onChange={(e) => setForm({ ...form, odds: e.target.value })}
            />
          </Field>

          <Field label={t('form.cantidad')} error={errorFor('stake')}>
            <input
              className={inputClass}
              value={form.stake}
              inputMode="decimal"
              placeholder="50"
              onChange={(e) => setForm({ ...form, stake: e.target.value })}
            />
          </Field>

          <Field label={t('form.fecha')} error={errorFor('placed_on')}>
            <input
              type="date"
              className={inputClass}
              value={form.placed_on}
              onChange={(e) => setForm({ ...form, placed_on: e.target.value })}
            />
          </Field>

          <Field label={t('form.nota')} error={errorFor('notes')} full>
            <input
              className={inputClass}
              value={form.notes}
              placeholder={t('form.notaPlaceholder')}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </Field>

          <Field label={t('form.etiquetas')} error={errorFor('tags')} full>
            <input className={inputClass} value={tags} placeholder={t('form.etiquetasPlaceholder')} onChange={(e) => setTags(e.target.value)} />
          </Field>

          {/* The payout the odds imply, so a typo in either field is visible before
              it becomes a wrong P&L. */}
          <Payout odds={form.odds} stake={form.stake} />
          <div className="sm:col-span-2">
            <Sugerencia odds={Number(String(form.odds).replace(',', '.'))} prob={probs.model} />
          </div>

          <div className="sm:col-span-2">
            {errorFor('_') && <p className="mb-2 text-[14px] text-[#d95926]">{errorFor('_')}</p>}
            <button
              onClick={submit}
              disabled={busy}
              className="w-full rounded-lg px-4 py-2.5 text-[16px] font-semibold text-[#0b0d11] transition disabled:opacity-60"
              style={{ backgroundColor: HOME_COLOR }}
            >
              {busy ? t('form.guardando') : editing ? t('form.guardarCambios') : t('form.registrar')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
