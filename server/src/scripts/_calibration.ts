// Medir cuánto miente cada modelo, y dejarlo escrito para el módulo de riesgo.
//
// CLI: `npm run study:calibration`
//
// Escribe experiments/calibration.json, que es lo que lee staking/calibration.ts para
// decidir el multiplicador de tamaño. Sin este fichero, el sizing es cero — el módulo
// de riesgo falla cerrado a propósito.
//
// ===========================================================================
// QUÉ ES ECE Y POR QUÉ ESTE Y NO OTRO
// ===========================================================================
// Se agrupan las predicciones por probabilidad dicha y en cada grupo se compara con la
// frecuencia real; la media ponderada de esas diferencias es el ECE. Un ECE de 0.01
// significa «cuando digo 40 %, pasa entre el 39 y el 41».
//
// No se usa el log loss para esto, aunque sea la métrica de todo lo demás, y la razón
// importa: el log loss mezcla calibración con RESOLUCIÓN —cuánto se separa el modelo de
// la media—, y para decidir el tamaño de una apuesta solo interesa la primera. Un
// modelo cauto que siempre dice 50 % tiene mal log loss y calibración perfecta, y es
// perfectamente seguro apostarlo... solo que nunca encontrará una ventaja. Kelly ya se
// encarga de eso: sin ventaja, el tamaño es cero por su cuenta.
//
// ===========================================================================
// EL HOLDOUT NO SE TOCA
// ===========================================================================
// Esto mide sobre entrenamiento + validación, igual que todo lo demás. La calibración
// es un insumo de una decisión, así que mirar el holdout para calcularla sería gastarlo
// exactamente igual que gastarlo eligiendo un hiperparámetro.

import {
  scoreDistribution,
  outcomeProbabilities,
  DIXON_COLES_RHO,
} from '../football/model.ts';
import { loadMatches, replayMatches } from '../football/ratings.ts';
import { footballConfig } from '../config.ts';
import { getDb } from '../db.ts';
import { splitOf } from '../experiments/holdout.ts';
import { writeCalibration, type CalibrationFile } from '../staking/calibration.ts';
import { listGamesWithMarket } from '../nfl/repo.ts';
import { replayGames } from '../nfl/ratings.ts';
import { buildDistribution, outcomeProbabilities as nflOutcomes } from '../nfl/model.ts';
import { devig } from '../market/devig.ts';

interface Pred {
  p: number;
  hit: boolean;
}

/**
 * ECE con grupos de anchura fija.
 *
 * Anchura fija y no cuantiles porque el resultado tiene que ser comparable entre
 * deportes: con cuantiles, cada deporte define sus propios grupos según su distribución
 * de predicciones y dos ECE dejan de medir lo mismo.
 */
function ece(preds: Pred[], bins = 20): number {
  const buckets = Array.from({ length: bins }, () => ({ n: 0, sumP: 0, hits: 0 }));
  for (const { p, hit } of preds) {
    const b = Math.min(bins - 1, Math.floor(p * bins));
    buckets[b].n++;
    buckets[b].sumP += p;
    if (hit) buckets[b].hits++;
  }
  let total = 0;
  for (const b of buckets) {
    if (b.n === 0) continue;
    total += (b.n / preds.length) * Math.abs(b.sumP / b.n - b.hits / b.n);
  }
  return total;
}

const out: CalibrationFile = {};
const measuredAt = new Date().toISOString();

// ---------------------------------------------------------------------------
// FÚTBOL: los tres resultados cuentan como tres predicciones cada partido.
// ---------------------------------------------------------------------------
{
  const preds: Pred[] = [];
  for (const l of footballConfig.leagues) {
    const ms = loadMatches(l.id as never, 0);
    if (ms.length === 0) continue;
    replayMatches(ms, {
      onMatch: ({ match, home, away, lambda }) => {
        if (home.matches < 10 || away.matches < 10) return;
        if (splitOf('football', Number(match.season)) === 'holdout') return;
        const p = outcomeProbabilities(scoreDistribution(lambda.home, lambda.away, DIXON_COLES_RHO));
        const res =
          match.home_goals > match.away_goals ? 'H' : match.home_goals === match.away_goals ? 'D' : 'A';
        preds.push({ p: p.home, hit: res === 'H' });
        preds.push({ p: p.draw, hit: res === 'D' });
        preds.push({ p: p.away, hit: res === 'A' });
      },
    });
  }
  const e = ece(preds);
  out.football = {
    ece: e,
    n: preds.length,
    // No hay ni una cuota histórica en fb_matches, así que no se puede saber. NULL, y
    // el módulo de riesgo trata ese null como «tope a la mitad», no como un sí.
    beatsMarket: null,
    vsMarketLogLoss: null,
    measuredAt,
  };
  console.log(`Fútbol   ECE ${(e * 100).toFixed(3)} pp sobre ${preds.length.toLocaleString('es')} predicciones`);
  console.log('         contra el mercado: NO MEDIBLE (cero cuotas históricas)');
}

// ---------------------------------------------------------------------------
// NFL: el único con cuotas reales, así que el único donde se puede contestar la
// pregunta que de verdad decide el tamaño.
// ---------------------------------------------------------------------------
{
  const games = listGamesWithMarket('nfl');
  const market = new Map<string, [number, number]>();
  for (const g of games as unknown as {
    id: string;
    close_ml_home: number | null;
    close_ml_away: number | null;
  }[]) {
    if (g.close_ml_home != null && g.close_ml_away != null) {
      const dec = (a: number): number => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
      market.set(g.id, [dec(g.close_ml_home), dec(g.close_ml_away)]);
    }
  }
  const preds: Pred[] = [];
  let modelLL = 0;
  let marketLL = 0;
  let n = 0;
  replayGames(games as never, {
    onGame: ({ game, expectedMargin, expectedTotal }: {
      game: { id: string; season: number; home_points: number; away_points: number };
      expectedMargin: number;
      expectedTotal: number;
    }) => {
      if (splitOf('nfl', game.season) === 'holdout') return;
      const margin = game.home_points - game.away_points;
      if (margin === 0) return;
      const o = nflOutcomes(buildDistribution(expectedMargin, expectedTotal));
      const p = o.home / (o.home + o.away);
      const won = margin > 0;
      preds.push({ p, hit: won });
      const odds = market.get(game.id);
      if (!odds) return;
      const mp = devig(odds).probs[0];
      const lg = (q: number): number => -Math.log(Math.max(won ? q : 1 - q, 1e-9));
      modelLL += lg(p);
      marketLL += lg(mp);
      n++;
    },
  } as never);
  const e = ece(preds);
  const diff = n > 0 ? modelLL / n - marketLL / n : null;
  out.nfl = {
    ece: e,
    n: preds.length,
    // Positivo = el modelo tiene MÁS log loss = es peor.
    beatsMarket: diff === null ? null : diff < 0,
    vsMarketLogLoss: diff,
    measuredAt,
  };
  console.log(`NFL      ECE ${(e * 100).toFixed(3)} pp sobre ${preds.length.toLocaleString('es')} predicciones`);
  console.log(
    `         contra el mercado: ${diff === null ? 'no medible' : (diff >= 0 ? '+' : '') + diff.toFixed(5) + ` de log loss en ${n.toLocaleString('es')} partidos → ${diff < 0 ? 'MEJOR' : 'PEOR'}`}`,
  );
}

writeCalibration(out);
console.log('\nEscrito en experiments/calibration.json — lo lee el módulo de riesgo.');
getDb();
