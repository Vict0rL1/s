// La cartera: qué se pondría hoy, cuánto riesgo agregado es y qué lo recortó.
//
//   GET /api/staking/book?bankroll=1000
//
// ===========================================================================
// POR QUÉ ESTO ES UN ENDPOINT Y NO UN CÁLCULO EN EL NAVEGADOR
// ===========================================================================
// El tamaño de una apuesta depende de la calibración medida, de las apuestas que ya
// están abiertas en la base y de la correlación con el resto de la cartera. Nada de eso
// está en el navegador, y ponerlo ahí significaría mantener dos implementaciones de la
// misma política de riesgo — que acabarían discrepando el día que una se actualice y la
// otra no. La política vive en un sitio.

import type { FastifyInstance } from 'fastify';
import { listUpcoming } from '../football/repo.ts';
import { buildFootballPrediction } from '../football/predict.ts';
import { bestSelection, lossState, DEFAULT_CONFIG } from '../staking/policy.ts';
import { decideBook, type BookCandidate } from '../staking/book.ts';
import { MEASURED, SAME_LEAGUE_DAY_RHO } from '../staking/correlation.ts';
import { DEMO_SOURCE } from '../freshness.ts';

export async function registerStakingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/book', async (req) => {
    const bankroll = Number((req.query as { bankroll?: string }).bankroll) || 1000;
    const cfg = DEFAULT_CONFIG;

    const fixtures = listUpcoming() as unknown as {
      id: string;
      league: string;
      commence_time: string | null;
      home_name: string;
      away_name: string;
      home_id: string | null;
      away_id: string | null;
      odds_home: number | null;
      odds_draw: number | null;
      odds_away: number | null;
      source: string | null;
    }[];

    const demo = fixtures.filter((f) => f.source === DEMO_SOURCE).length;
    const candidates: BookCandidate[] = [];

    for (const f of fixtures) {
      // Las cuotas de demostración las genera el propio modelo: apostar contra la
      // propia salida no es una ventaja, es una identidad.
      if (f.source === DEMO_SOURCE) continue;
      if (
        !f.home_id ||
        !f.away_id ||
        f.odds_home == null ||
        f.odds_draw == null ||
        f.odds_away == null
      ) {
        continue;
      }
      let pred;
      try {
        pred = buildFootballPrediction(f.league as never, f.home_id, f.away_id);
      } catch {
        continue;
      }
      const best = bestSelection(
        [
          { label: f.home_name, p: pred.model.home, odds: f.odds_home, side: 'canonica' as const },
          { label: 'Empate', p: pred.model.draw, odds: f.odds_draw, side: 'otro' as const },
          { label: f.away_name, p: pred.model.away, odds: f.odds_away, side: 'contraria' as const },
        ],
        cfg,
      );
      if (!best) continue;
      candidates.push({
        key: f.id,
        label: `${f.home_name} vs ${f.away_name} — ${best.label}`,
        sport: 'football',
        league: f.league,
        day: (f.commence_time ?? 'sin-fecha').slice(0, 10),
        matchKey: f.id,
        market: '1x2',
        side: best.side,
        p: best.p,
        odds: best.odds,
      });
    }

    const book = decideBook(candidates, bankroll, cfg);
    const loss = lossState(bankroll, cfg);

    return {
      bankroll,
      // Cuántas se miraron y cuántas quedaron fuera por no tener precio real. Sin esto,
      // una cartera vacía por falta de clave se lee igual que una cartera vacía porque
      // el modelo no encontró ventaja, y son dos situaciones muy distintas.
      considered: fixtures.length,
      demoOdds: demo,
      priced: candidates.length,
      limits: {
        maxPerEvent: cfg.maxPerEvent,
        maxTotalExposure: cfg.maxTotalExposure,
        maxExposurePerDay: cfg.maxExposurePerDay,
        maxExposurePerLeague: cfg.maxExposurePerLeague,
      },
      loss,
      entries: book.entries.filter((e) => e.stake > 0),
      blocked: book.entries.length - book.entries.filter((e) => e.stake > 0).length,
      naiveStake: book.naiveStake,
      totalStake: book.totalStake,
      aggregate: book.aggregate,
      links: book.links.slice(0, 8),
      caps: book.caps,
      notes: book.notes,
      // Lo medido va en la respuesta para que el panel pueda citar el número y no
      // repetirlo escrito a mano en el frontend, que es como acaban divergiendo.
      correlation: {
        sameMatch: MEASURED.sameMatch,
        sameLeagueDay: MEASURED.sameLeagueDay,
        used: SAME_LEAGUE_DAY_RHO,
        control: MEASURED.control.rho,
        n: MEASURED.n,
      },
    };
  });
}
