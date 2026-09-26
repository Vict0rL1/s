// El pipeline de noticias: texto libre → estructura → predicción.
//
// CLI:
//   npm run news                      — procesa las notas del feed de plantillas
//   npm run news -- --text "..."      — procesa un texto pegado (rueda de prensa, tuit)
//   npm run news -- --league epl --show  — qué noticias hay y qué le hacen a cada partido
//
// ===========================================================================
// DÓNDE SE GASTA EL MODELO Y DÓNDE NO
// ===========================================================================
// Las notas del feed vienen medio estructuradas y la mayoría se resuelven con dos reglas
// (`fromStructured`). Solo lo que esas reglas NO entienden pasa por la API, y el script
// dice cuántas fueron de cada tipo y cuánto costó. Un pipeline que manda todo al modelo
// funciona igual y cuesta cincuenta veces más, y la diferencia no se ve hasta que llega
// la factura.

import { getDb } from '../db.ts';
import { footballConfig } from '../config.ts';
import { extractNews, fromStructured, hasApiKey, NewsExtractionError } from '../news/extract.ts';
import { storeNews, newsForTeam, newsTiming, matchPlayer } from '../news/repo.ts';
import { buildFootballPrediction } from '../football/predict.ts';
import { rotationRisk } from '../football/lineups.ts';
import type { LeagueId } from '../football/types.ts';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => (a.startsWith('--') ? [[a.slice(2), arr[i + 1] ?? 'true']] : [])),
) as Record<string, string>;

const db = getDb();
const LEAGUES = footballConfig.leagues.map((l) => l.id);

async function ingestSquadNews(): Promise<void> {
  console.log('NOTAS DEL FEED DE PLANTILLAS\n');
  let byRule = 0;
  let byModel = 0;
  let unmatched = 0;
  let cost = { input: 0, output: 0 };

  for (const league of LEAGUES) {
    const rows = db
      .prepare(
        `SELECT id, team_id teamId, name, status, chance_next chanceNext, news, updated_at updatedAt
         FROM fb_players
         WHERE league = ? AND news IS NOT NULL AND news <> ''`,
      )
      .all(league) as unknown as {
      id: string;
      teamId: string;
      name: string;
      status: string | null;
      chanceNext: number | null;
      news: string;
      updatedAt: string | null;
    }[];
    if (rows.length === 0) continue;

    // La fuente no publica CUÁNDO salió cada nota, solo cuándo se descargó la lista. Se
    // usa esa fecha y se dice que es una cota superior: la noticia es de ese momento o
    // de antes, nunca de después. Fingir una hora exacta rompería el reloj de abajo, que
    // es lo único que este campo existe para alimentar.
    const publishedAt = rows[0].updatedAt ?? new Date().toISOString();

    const needModel: typeof rows = [];
    for (const r of rows) {
      const item = fromStructured(r);
      if (!item) {
        needModel.push(r);
        continue;
      }
      const stored = storeNews(league as LeagueId, item, {
        source: 'fpl',
        extractor: 'regla',
        publishedAt,
        teamId: r.teamId,
      });
      byRule++;
      if (!stored.playerId) unmatched++;
    }

    if (needModel.length > 0 && hasApiKey()) {
      // Las que las reglas no entienden van juntas en una llamada: el modelo lee mejor
      // un bloque con contexto que veinte fragmentos sueltos, y una llamada con veinte
      // notas cuesta mucho menos que veinte llamadas con una.
      const text = needModel.map((r) => `${r.name} (${r.teamId}): ${r.news}`).join('\n');
      const res = await extractNews(text, {
        knownPlayers: needModel.map((r) => r.name),
      });
      if (res) {
        cost = { input: cost.input + res.usage.input, output: cost.output + res.usage.output };
        for (const item of res.items) {
          const stored = storeNews(league as LeagueId, item, {
            source: 'fpl',
            extractor: res.model,
            publishedAt,
          });
          byModel++;
          if (!stored.playerId) unmatched++;
        }
      }
    } else if (needModel.length > 0) {
      console.log(
        `  ${league}: ${needModel.length} notas que las reglas no entienden y no hay ` +
          'ANTHROPIC_API_KEY. Se quedan sin procesar (no hay respaldo silencioso).',
      );
    }
  }

  console.log(`  ${byRule} resueltas por regla · ${byModel} por el modelo`);
  if (unmatched > 0) {
    console.log(
      `  ${unmatched} sin emparejar con un jugador de la plantilla: se guardan, no ` +
        'mueven nada, y salen marcadas. Un emparejado dudoso cambiaría una predicción\n' +
        '    sin que nadie pudiera explicar por qué.',
    );
  }
  if (cost.input > 0) {
    // Precios de claude-opus-5: 5 $ y 25 $ por millón.
    const usd = (cost.input / 1e6) * 5 + (cost.output / 1e6) * 25;
    console.log(
      `  Coste: ${cost.input} tokens de entrada, ${cost.output} de salida ≈ ${usd.toFixed(4)} $`,
    );
  }
}

async function ingestFreeText(text: string): Promise<void> {
  console.log('TEXTO LIBRE\n');
  if (!hasApiKey()) {
    console.log(
      '  Sin ANTHROPIC_API_KEY no hay extracción. Ponla en .env:\n' +
        '    ANTHROPIC_API_KEY=sk-ant-...\n' +
        '  No hay un camino de respaldo con expresiones regulares a propósito: sería peor\n' +
        '  y silencioso, y nadie se enteraría de que la pieza buena no funciona.',
    );
    return;
  }
  const league = (args.league ?? 'epl') as LeagueId;
  const known = (
    db.prepare('SELECT name FROM fb_players WHERE league = ? ORDER BY minutes DESC LIMIT 60').all(league) as unknown as {
      name: string;
    }[]
  ).map((r) => r.name);

  const res = await extractNews(text, { knownPlayers: known });
  if (!res) return;
  console.log(`  Modelo: ${res.model} · ${res.usage.input}+${res.usage.output} tokens`);
  if (res.items.length === 0) {
    console.log('  No dice nada sobre la disponibilidad de nadie.');
    return;
  }
  const publishedAt = args.at ?? new Date().toISOString();
  console.log(`  Publicada: ${publishedAt}\n`);
  for (const item of res.items) {
    const stored = storeNews(league, item, {
      source: 'manual',
      extractor: res.model,
      publishedAt,
    });
    const m = matchPlayer(league, item.playerName);
    console.log(
      `  ${item.playerName.padEnd(18)} ${item.kind.padEnd(14)} juega ${(item.playProbability * 100).toFixed(0)}%` +
        ` · confianza ${(item.confidence * 100).toFixed(0)}%` +
        (m ? ` · ${m.name} (${m.teamId})` : ' · SIN EMPAREJAR, no moverá nada'),
    );
    console.log(`      «${item.quote}»`);
    void stored;
  }
}

function show(league: LeagueId): void {
  console.log(`NOTICIAS VIGENTES · ${league}\n`);
  const fixtures = db
    .prepare(
      `SELECT id, home_id homeId, away_id awayId, home_name homeName, away_name awayName,
              commence_time commenceTime
       FROM fb_upcoming WHERE league = ? AND home_id IS NOT NULL AND away_id IS NOT NULL
       ORDER BY commence_time LIMIT 6`,
    )
    .all(league) as unknown as {
    id: string;
    homeId: string;
    awayId: string;
    homeName: string;
    awayName: string;
    commenceTime: string;
  }[];
  if (fixtures.length === 0) {
    console.log('  Sin partidos próximos. Corre `npm run update-data:fb`.');
    return;
  }

  for (const f of fixtures) {
    const date = f.commenceTime.slice(0, 10).replace(/-/g, '');
    const p = buildFootballPrediction(league, f.homeId, f.awayId, undefined, {
      fixtureId: f.id,
      matchDate: date,
    });
    const n = p.news;
    const total = n.applied.home.length + n.applied.away.length;
    console.log(`${f.homeName} vs ${f.awayName}  (${f.commenceTime.slice(0, 10)})`);
    console.log(
      `  1X2 publicado ${(p.final.home * 100).toFixed(1)} / ${(p.final.draw * 100).toFixed(1)} / ` +
        `${(p.final.away * 100).toFixed(1)} · λ ${p.goals.expectedHome} - ${p.goals.expectedAway}`,
    );
    if (total === 0) {
      console.log('  Sin ausencias que muevan la predicción.');
    }
    for (const [side, list, name] of [
      ['local', n.applied.home, f.homeName],
      ['visitante', n.applied.away, f.awayName],
    ] as [string, typeof n.applied.home, string][]) {
      if (list.length === 0) continue;
      const c = side === 'local' ? n.combined.home : n.combined.away;
      console.log(`  ${name} — ${list.length} ausencia(s), efecto conjunto ${c.net >= 0 ? '+' : ''}${c.net} goles`);
      for (const a of list) {
        console.log(
          `    ${a.playerName.padEnd(16)} ${a.kind.padEnd(12)} ` +
            `${(a.missProbability * 100).toFixed(0)}% fuera · ` +
            (a.zeroReason
              ? 'sin efecto'
              : `${a.goalsFor >= 0 ? '+' : ''}${a.goalsFor} a favor, ` +
                `${a.goalsAgainst >= 0 ? '+' : ''}${a.goalsAgainst} en contra`),
        );
        if (a.zeroReason) console.log(`      ${a.zeroReason}`);
      }
    }
    for (const [name, w] of [
      [f.homeName, n.watching.home],
      [f.awayName, n.watching.away],
    ] as [string, typeof n.watching.home][]) {
      if (w.length === 0) continue;
      console.log(
        `  ${name} — en observación (no mueven la λ): ` +
          w.map((x) => `${x.playerName} ${(x.missProbability * 100).toFixed(0)}%`).join(', '),
      );
    }
    for (const [name, r] of [
      [f.homeName, n.rotation.home],
      [f.awayName, n.rotation.away],
    ] as [string, ReturnType<typeof rotationRisk> | null][]) {
      if (r && r.risk > 0.3) console.log(`  ${name} — rotación ${(r.risk * 100).toFixed(0)}%: ${r.reason}`);
    }
    const timing = newsTiming(f.id, [...newsForTeam(league, f.homeId), ...newsForTeam(league, f.awayId)]);
    const withData = timing.filter((t) => t.verdict !== 'sin-datos');
    if (withData.length > 0) {
      console.log('  Reloj noticia → línea:');
      for (const t of withData.slice(0, 5)) {
        console.log(
          `    ${t.playerName.padEnd(16)} ${t.verdict}` +
            (t.minutesToMove != null ? ` · la línea se movió ${t.minutesToMove} min después` : ''),
        );
      }
    } else if (timing.length > 0) {
      console.log(
        '  Reloj noticia → línea: sin histórico de cuotas todavía. Se llena solo en cada\n' +
          '    `npm run update-data:fb`; hacen falta al menos dos observaciones del mismo partido.',
      );
    }
    console.log();
  }
}

const main = async (): Promise<void> => {
  try {
    await run();
  } catch (err) {
    if (err instanceof NewsExtractionError) {
      console.log(`\n  ✗ ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
};

const run = async (): Promise<void> => {
  if (args.text) {
    await ingestFreeText(args.text);
  } else if (!args.show) {
    await ingestSquadNews();
  }
  if (args.show || !args.text) {
    console.log();
    show((args.league ?? 'epl') as LeagueId);
  }
};

await main();
