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
import { loadMatches, replayMatches, DC_HYPER } from '../football/ratings.ts';
import { expectedGoalsDc } from '../football/bayes/dixonColes.ts';
import { DcWalkForward } from '../football/bayes/walkforward.ts';
import { footballConfig } from '../config.ts';
import { getDb } from '../db.ts';
import { splitOf } from '../experiments/holdout.ts';
import { writeCalibration, bandasDeAcierto, type CalibrationFile } from '../staking/calibration.ts';
import { listGamesWithMarket } from '../nfl/repo.ts';
import { replayGames } from '../nfl/ratings.ts';
import { buildDistribution, outcomeProbabilities as nflOutcomes } from '../nfl/model.ts';
import { marketFromSpread } from '../nfl/predict.ts';
import { devig } from '../market/devig.ts';
import { postprocess } from '../postprocess/apply.ts';

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

// ===========================================================================
// LAS BANDAS SE MIDEN SOBRE LO QUE SE ENSEÑA, NO SOBRE LO QUE SALE DEL MODELO
// ===========================================================================
// El ECE de arriba es del modelo crudo, y está bien que lo sea: es lo que decide el
// tamaño. Pero la tabla de partidos enseña la probabilidad FINAL —calibrada y, en la
// NFL, mezclada con el mercado—, y el filtro de confianza corta sobre ese número. Si la
// banda midiera el crudo, «70 %+» filtraría por un número y prometería el acierto de
// otro. En la NFL la diferencia es grande: la final es casi el precio (peso del modelo
// 0,10), así que un 75 % del modelo puede ser un 62 % en pantalla.
//
// Los calibradores de `postprocess.json` se ajustaron sobre estos mismos años. Es
// medir dentro de muestra, pero con dos parámetros por resultado sobre decenas de miles
// de partidos el optimismo es de décimas. El holdout, igual que arriba, no se toca.

// ---------------------------------------------------------------------------
// FÚTBOL: los tres resultados cuentan como tres predicciones cada partido.
// ---------------------------------------------------------------------------
// Se mide el MISMO camino que `predict.ts`: Dixon-Coles cuando el ajuste conoce a los
// dos equipos, y el Elo solo de respaldo para los que no (recién ascendidos, primera
// temporada del archivo). La versión anterior medía SOLO el Elo, que en vivo resuelve
// uno de cada siete partidos — así que el ECE que lee el sizing describía otro modelo.
//
// Y no era una diferencia de matiz. Medido sobre 23.773 partidos:
//
//                         victoria local       favoritos del 50 %+
//                         dice / pasa          prometen / aciertan
//     Elo (lo medido)     46,2 / 43,1          61,0 / 58,5
//     en vivo (Dixon-C.)  43,4 / 43,1          60,2 / 60,9
//
// El Elo sobreestima la ventaja de campo en tres puntos; el Dixon-Coles la estima por
// liga y con decaimiento temporal, y la clava. Medir el primero hacía parecer
// sobreconfiado a un modelo que no lo es. Lo destapó la comprobación de bandas de
// `verify:data`, que compara cada banda con lo que prometió.
{
  const preds: Pred[] = [];
  const favs: Pred[] = [];
  let viaDc = 0;
  let viaElo = 0;
  for (const l of footballConfig.leagues) {
    const ms = loadMatches(l.id as never, 0);
    if (ms.length === 0) continue;
    // El mismo reajuste periódico que el backtest: cada partido se predice con
    // parámetros ajustados solo sobre partidos anteriores.
    const wf = new DcWalkForward(
      ms.map((m) => ({
        date: m.match_date,
        homeId: m.home_id,
        awayId: m.away_id,
        homeGoals: m.home_goals,
        awayGoals: m.away_goals,
      })),
      DC_HYPER,
    );
    replayMatches(ms, {
      onMatch: ({ match, home, away, lambda }) => {
        if (home.matches < 10 || away.matches < 10) return;
        if (splitOf('football', Number(match.season)) === 'holdout') return;
        const dc = wf.paramsFor(match.match_date);
        const dcUsable = !!dc && dc.attack.has(match.home_id) && dc.attack.has(match.away_id);
        let lam = lambda;
        let rho = DIXON_COLES_RHO;
        if (dc && dcUsable) {
          lam = expectedGoalsDc(dc, match.home_id, match.away_id);
          rho = dc.rho;
          viaDc++;
        } else viaElo++;
        const p = outcomeProbabilities(scoreDistribution(lam.home, lam.away, rho));
        const res =
          match.home_goals > match.away_goals ? 'H' : match.home_goals === match.away_goals ? 'D' : 'A';
        preds.push({ p: p.home, hit: res === 'H' });
        preds.push({ p: p.draw, hit: res === 'D' });
        preds.push({ p: p.away, hit: res === 'A' });
        // El favorito es el mayor de LOCAL y VISITANTE —nunca el empate—, igual que en
        // `footballSlate`. Y el empate cuenta como fallo del favorito.
        const f = postprocess('football', [p.home, p.draw, p.away], null).final;
        favs.push(f[0] >= f[2] ? { p: f[0], hit: res === 'H' } : { p: f[2], hit: res === 'A' });
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
    bands: bandasDeAcierto(favs),
  };
  console.log(`Fútbol   ECE ${(e * 100).toFixed(3)} pp sobre ${preds.length.toLocaleString('es')} predicciones`);
  console.log(
    `         ${viaDc.toLocaleString('es')} partidos con Dixon-Coles · ${viaElo.toLocaleString('es')} con el Elo de respaldo`,
  );
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
  const favs: Pred[] = [];
  const spread = new Map<string, number>();
  for (const g of games as unknown as { id: string; close_spread: number | null }[]) {
    if (g.close_spread != null) spread.set(g.id, g.close_spread);
  }
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
      const o = nflOutcomes(buildDistribution(expectedMargin, expectedTotal));
      const p = o.home / (o.home + o.away);

      // La final, con el mismo orden de preferencia que `nfl/predict.ts`: moneyline si
      // la hay, y si no la línea. `close_spread` va en signo de MARGEN y la función
      // quiere signo de CASA, de ahí el menos (ver el recuadro en `marketFromSpread`).
      const ml = market.get(game.id);
      const cs = spread.get(game.id);
      const mh = ml
        ? devig(ml).probs[0]
        : cs != null
          ? (marketFromSpread(-cs, expectedTotal)?.home ?? null)
          : null;
      const fh = postprocess('nfl', [p, 1 - p], mh != null ? [mh, 1 - mh] : null).final[0];
      // Un empate es un fallo del favorito, así que entra aquí aunque abajo no.
      favs.push(fh >= 0.5 ? { p: fh, hit: margin > 0 } : { p: 1 - fh, hit: margin < 0 });

      if (margin === 0) return;
      const won = margin > 0;
      preds.push({ p, hit: won });
      const odds = ml;
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
    bands: bandasDeAcierto(favs),
  };
  console.log(`NFL      ECE ${(e * 100).toFixed(3)} pp sobre ${preds.length.toLocaleString('es')} predicciones`);
  console.log(
    `         contra el mercado: ${diff === null ? 'no medible' : (diff >= 0 ? '+' : '') + diff.toFixed(5) + ` de log loss en ${n.toLocaleString('es')} partidos → ${diff < 0 ? 'MEJOR' : 'PEOR'}`}`,
  );
}

for (const [k, c] of Object.entries(out)) {
  console.log(
    `\n${k.padEnd(8)} acierto del favorito por umbral (lo que enseña el filtro de la tabla):`,
  );
  for (const b of c.bands ?? []) {
    console.log(
      `         ${(b.desde * 100).toFixed(0)} %+  ${(b.acierto * 100).toFixed(1)} %  sobre ${b.n.toLocaleString('es')}`,
    );
  }
}

writeCalibration(out);
console.log('\nEscrito en experiments/calibration.json — lo lee el módulo de riesgo.');
getDb();
