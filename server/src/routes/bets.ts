// The bet log's endpoints.
//
// Its own namespace and its own file, mirroring how each sport is separated:
// nothing here reads a model and nothing in the model reads a bet. The only
// coupling is that a bet may carry the model's probability at the time it was
// placed, and that arrives as plain numbers in the request body.
//
// VALIDATION IS DONE HERE AND NOT TRUSTED FROM THE CLIENT. Everything below is a
// number a person types under time pressure into a phone, and an odds field that
// silently accepts "1,85" or a stake that accepts "-50" produces a P&L that is
// wrong in a way nobody notices for weeks. Bad input is refused with a message
// naming the field.

import type { FastifyInstance } from 'fastify';
import {
  BET_MARKETS,
  BET_SPORTS,
  BET_STATUSES,
  createBet,
  deleteBet,
  getBet,
  listBets,
  summarizeBets,
  updateBet,
  type BetInput,
  type BetStatus,
} from '../bets.ts';
import { listBetCandidates } from '../betCandidates.ts';

/** A finite number, accepting the comma decimal separator a Spanish keyboard gives. */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const n = Number(v.trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function text(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

interface Problem {
  field: string;
  message: string;
}

/**
 * Validate a body into a BetInput.
 *
 * `partial` skips the required-field checks, for PATCH — where sending only
 * `{status:'won'}` has to be legal.
 */
function parseBet(body: unknown, partial: boolean): { input: Partial<BetInput> } | { errors: Problem[] } {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: Problem[] = [];
  const out: Partial<BetInput> = {};

  const has = (k: string) => k in b && b[k] !== undefined;

  if (has('sport') || !partial) {
    const v = text(b.sport);
    if (!v) errors.push({ field: 'sport', message: 'Falta el deporte.' });
    else if (!(BET_SPORTS as readonly string[]).includes(v))
      errors.push({ field: 'sport', message: `Deporte no válido. Usa: ${BET_SPORTS.join(', ')}.` });
    else out.sport = v;
  }
  if (has('event') || !partial) {
    const v = text(b.event);
    if (!v) errors.push({ field: 'event', message: 'Falta el partido o evento.' });
    else out.event = v.slice(0, 200);
  }
  if (has('market') || !partial) {
    const v = text(b.market);
    if (!v) errors.push({ field: 'market', message: 'Falta el mercado.' });
    else if (!(BET_MARKETS as readonly string[]).includes(v))
      errors.push({ field: 'market', message: `Mercado no válido. Usa: ${BET_MARKETS.join(', ')}.` });
    else out.market = v;
  }
  if (has('selection') || !partial) {
    const v = text(b.selection);
    if (!v) errors.push({ field: 'selection', message: 'Falta qué apostaste.' });
    else out.selection = v.slice(0, 200);
  }
  if (has('odds') || !partial) {
    const v = num(b.odds);
    // Decimal odds below 1 pay less than the stake back, which is not a price a
    // book offers — it is almost always an American odds figure in the wrong box.
    if (v == null) errors.push({ field: 'odds', message: 'La cuota tiene que ser un número.' });
    else if (v <= 1) errors.push({ field: 'odds', message: 'La cuota decimal tiene que ser mayor que 1 (ej. 1.85).' });
    else if (v > 1000) errors.push({ field: 'odds', message: 'Cuota demasiado alta, revisa el número.' });
    else out.odds = v;
  }
  if (has('stake') || !partial) {
    const v = num(b.stake);
    if (v == null) errors.push({ field: 'stake', message: 'La cantidad tiene que ser un número.' });
    else if (v <= 0) errors.push({ field: 'stake', message: 'La cantidad tiene que ser mayor que 0.' });
    else out.stake = v;
  }

  if (has('status')) {
    const v = text(b.status);
    if (!v || !BET_STATUSES.includes(v as BetStatus))
      errors.push({ field: 'status', message: `Estado no válido. Usa: ${BET_STATUSES.join(', ')}.` });
    else out.status = v as BetStatus;
  }
  if (has('placed_on')) {
    const v = text(b.placed_on);
    if (!v || !DAY_RE.test(v)) errors.push({ field: 'placed_on', message: 'La fecha tiene que ser AAAA-MM-DD.' });
    else out.placed_on = v;
  }
  if (has('payout')) {
    const v = b.payout === null ? null : num(b.payout);
    if (v != null && v < 0) errors.push({ field: 'payout', message: 'El retorno no puede ser negativo.' });
    else out.payout = v;
  }
  for (const [key, max] of [['league', 80], ['notes', 500], ['match_key', 200]] as const) {
    if (has(key)) out[key] = b[key] === null ? null : (text(b[key]) ?? '').slice(0, max) || null;
  }
  for (const key of ['model_prob', 'market_prob'] as const) {
    if (has(key)) {
      const v = b[key] === null ? null : num(b[key]);
      if (v != null && (v < 0 || v > 1))
        errors.push({ field: key, message: 'La probabilidad va entre 0 y 1.' });
      else out[key] = v;
    }
  }

  // A cashout without the returned amount cannot be scored, and guessing it from
  // the odds would report a profit the bet never produced.
  const status = out.status ?? (partial ? undefined : 'pending');
  if (status === 'cashout' && out.payout == null) {
    errors.push({ field: 'payout', message: 'Un cashout necesita el importe que te devolvieron.' });
  }

  return errors.length ? { errors } : { input: out };
}

export async function registerBetRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { from?: string; to?: string; sport?: string; status?: string } }>(
    '/',
    async (req) => ({ bets: listBets(req.query) }),
  );

  app.get<{ Querystring: { from?: string; to?: string; sport?: string } }>(
    '/summary',
    async (req) => summarizeBets(req.query),
  );

  /**
   * Upcoming matches to pick from, so a bet can capture the model's and the
   * market's probability at the time it was placed. See betCandidates.ts for why
   * that matters and cannot be recovered later.
   */
  app.get('/candidates', async () => ({ candidates: listBetCandidates() }));

  /** The vocabulary, so the UI never hardcodes a list the server can reject. */
  app.get('/options', async () => ({
    sports: BET_SPORTS,
    markets: BET_MARKETS,
    statuses: BET_STATUSES,
  }));

  app.post('/', async (req, reply) => {
    const parsed = parseBet(req.body, false);
    if ('errors' in parsed) return reply.code(400).send({ errors: parsed.errors });
    return reply.code(201).send(createBet(parsed.input as BetInput));
  });

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const bet = getBet(Number(req.params.id));
    return bet ?? reply.code(404).send({ error: 'no existe esa apuesta' });
  });

  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const parsed = parseBet(req.body, true);
    if ('errors' in parsed) return reply.code(400).send({ errors: parsed.errors });
    const bet = updateBet(Number(req.params.id), parsed.input);
    return bet ?? reply.code(404).send({ error: 'no existe esa apuesta' });
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    return deleteBet(Number(req.params.id))
      ? reply.code(204).send()
      : reply.code(404).send({ error: 'no existe esa apuesta' });
  });
}
