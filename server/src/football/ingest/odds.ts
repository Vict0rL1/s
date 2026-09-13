// Upcoming fixtures + bookmaker prices for football, from The Odds API.
//
// Football is the only one of the three sports with a THREE-way market, so the
// h2h outcomes here include the draw and the row carries three prices. Which
// leagues appear is driven by config/football.json matched against the provider's
// own /sports listing, so the app follows whatever is in season.
//
// Rows go to fb_upcoming only: the three sports never share a fixtures table.

import { getDb, setMeta } from '../../db.ts';
import { recordOddsReason, type OddsReason } from '../../oddsReason.ts';
import { pruneUpcoming } from '../../freshness.ts';
import { env, footballConfig } from '../../config.ts';
import { canSpend, creditCost, listSports, recordQuota } from '../../oddsQuota.ts';
import { demoKickoffs } from '../../demoSchedule.ts';
import { eloExpectation, HOME_ADVANTAGE } from '../model.ts';
import { buildTeamIndex as buildNameIndex, resolveTeam as resolve } from './teamNames.ts';
import { secondDivisionOf } from '../promotion.ts';
import { seedPromotedTeam } from '../ratings.ts';
import type { LeagueId } from '../types.ts';
import { recordOdds } from '../../news/repo.ts';
import { recordLatency, recordFreshness } from '../../latency/record.ts';
import { publish } from '../../latency/alert.ts';

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

interface Aggregated {
  id: string;
  commence_time: string;
  home: string;
  away: string;
  /** name → median decimal odds. The draw arrives as the literal "Draw". */
  price: Record<string, number>;
  books: number;
  /**
   * El `last_update` MÁS RECIENTE de entre todas las casas del evento.
   *
   * Es la única marca de tiempo del origen que da el proveedor, y sin ella la palabra
   * «latencia» solo puede referirse al tiempo dentro de nuestra máquina — que es la
   * parte que menos tarda con diferencia. Se coge el máximo y no la media porque la
   * pregunta es «¿cuándo se publicó el precio más nuevo que tengo?».
   */
  sourceUpdatedAt: string | null;
}

function leagueByKey(): Map<string, LeagueId> {
  const m = new Map<string, LeagueId>();
  for (const l of footballConfig.leagues) for (const k of l.oddsSportKeys) m.set(k, l.id);
  return m;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function fetchActive(): Promise<{ key: string }[]> {
  // Shared and cached — see the note in oddsQuota.ts.
  const all = await listSports();
  const known = leagueByKey();
  return all.filter((s) => s.active && !s.has_outrights && known.has(s.key));
}

async function fetchLive(sportKey: string): Promise<Aggregated[]> {
  const url =
    `${ODDS_API_BASE}/sports/${sportKey}/odds/?apiKey=${encodeURIComponent(env.oddsApiKey)}` +
    `&regions=${encodeURIComponent(env.oddsRegions)}&markets=h2h&oddsFormat=decimal`;
  // The guard comes BEFORE the request, obviously: checking afterwards would be
  // checking whether we could afford something already bought.
  const allowed = canSpend(creditCost('h2h'));
  if (!allowed.ok) {
    console.warn(`[odds] ${sportKey} saltado: ${allowed.reason}`);
    return [];
  }
  const res = await fetch(url);
  // Every response carries x-requests-remaining, so this is free knowledge.
  recordQuota(res);

  if (!res.ok) throw new Error(`Odds API ${sportKey}: HTTP ${res.status}`);
  const events = (await res.json()) as any[];
  return events.map((ev) => {
    const prices: Record<string, number[]> = {};
    let newest = 0;
    for (const bk of ev.bookmakers ?? []) {
      const h2h = (bk.markets ?? []).find((m: any) => m.key === 'h2h');
      if (!h2h) continue;
      // `last_update` viene en el mercado en las versiones nuevas y en la casa en las
      // viejas. Se miran los dos: si solo se leyera uno, media API devolvería null y la
      // latencia de origen saldría «sin datos» sin que nadie supiera por qué.
      for (const t of [h2h.last_update, bk.last_update]) {
        const ms = t ? Date.parse(String(t)) : NaN;
        if (Number.isFinite(ms) && ms > newest) newest = ms;
      }
      for (const o of h2h.outcomes ?? []) (prices[o.name] ??= []).push(o.price);
    }
    const price: Record<string, number> = {};
    for (const [n, arr] of Object.entries(prices)) price[n] = median(arr);
    return {
      id: String(ev.id),
      commence_time: String(ev.commence_time),
      home: String(ev.home_team ?? ''),
      away: String(ev.away_team ?? ''),
      price,
      books: (ev.bookmakers ?? []).length,
      sourceUpdatedAt: newest > 0 ? new Date(newest).toISOString() : null,
    };
  });
}


/** Demo fixtures from current Elo, so the tab works with no key / out of season. */
function generateFixtures(league: LeagueId, count = 6): Aggregated[] {
  const teams = getDb()
    .prepare(
      `SELECT r.team_id AS id, t.name, r.elo FROM fb_team_ratings r
       JOIN fb_teams t ON t.league = r.league AND t.id = r.team_id
       WHERE r.league = ? ORDER BY r.elo DESC LIMIT ?`,
    )
    .all(league, count * 2) as unknown as { id: string; name: string; elo: number }[];
  if (teams.length < 2) return [];
  const out: Aggregated[] = [];
  // Plausible kick-off times on the clock, always still ahead — see demoSchedule.ts
  // for why this is not `Date.now() + n days`.
  const kickoffs = demoKickoffs('football', count);
  for (let i = 0; i + 1 < teams.length && out.length < count; i += 2) {
    const home = teams[i];
    const away = teams[i + 1];
    // Rough 1X2 from the Elo expectation, holding the draw near its real rate.
    const e = eloExpectation(home.elo, away.elo, HOME_ADVANTAGE);
    const pd = 0.26;
    const ph = e * (1 - pd);
    const pa = 1 - pd - ph;
    // Priced so implied probabilities sum to MORE than 1 — a real book's margin.
    const vig = 1.06;
    out.push({
      // The kick-off INSTANT is part of the id, and it has to be. These ids used to
      // be `fixture-epl-0`, stable per league and index, so a regenerated slate
      // reused them — and the ON CONFLICT UPDATE rewrote this morning's
      // already-started match with tonight's kick-off, mutating it out of today
      // instead of leaving it where the reader expects to find it.
      //
      // The full instant and not just the date: `demoKickoffs` only ever emits slots
      // at least 45 minutes ahead, so once 14:00 has passed the next slate starts at
      // 16:15 and gets its own id. The date alone collides, because the new slate is
      // usually still the same day.
      id: `fixture-${league}-${kickoffs[out.length]}-${i / 2}`,
      commence_time: kickoffs[out.length],
      // Sin origen: son inventadas. Poner `ahora` aquí daría una latencia de cero y
      // haría que el panel presumiera de una velocidad que no existe.
      sourceUpdatedAt: null,
      home: home.name,
      away: away.name,
      price: {
        [home.name]: Math.round((1 / (ph * vig)) * 100) / 100,
        Draw: Math.round((1 / (pd * vig)) * 100) / 100,
        [away.name]: Math.round((1 / (pa * vig)) * 100) / 100,
      },
      books: 0,
    });
  }
  return out;
}

export interface FootballOddsResult {
  source: 'live' | 'fixture';
  count: number;
  leagues: string[];
  /**
   * Clubes cuyo Elo hubo que traer de la división de abajo porque acaban de subir.
   *
   * Se contaba y no se decía. Merece salir por pantalla: es el número que explica
   * por qué unas cuantas tarjetas llevan la banda más ancha y la etiqueta «recién
   * ascendido», y si algún agosto sale 0 en una liga que acaba de tener ascensos,
   * es que el emparejamiento de nombres se rompió.
   */
  promoted: number;
}

export async function refreshFootballOdds(): Promise<FootballOddsResult> {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO fb_upcoming
       (id, league, commence_time, home_name, away_name, home_id, away_id,
        odds_home, odds_draw, odds_away, books, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       -- NEVER move a match that has already kicked off. A feed re-sending an
       -- event id with a new time — which both the demo generator and a live API
       -- can do — would otherwise drag this morning's match into tonight, and it
       -- would vanish from today without anything being deleted. Measured: it did
       -- exactly that, and the row still existed afterwards, so only its time gave
       -- the bug away.
       commence_time = CASE WHEN fb_upcoming.commence_time >= ? THEN excluded.commence_time
                            ELSE fb_upcoming.commence_time END, odds_home = excluded.odds_home,
       odds_draw = excluded.odds_draw, odds_away = excluded.odds_away,
       books = excluded.books, home_id = excluded.home_id, away_id = excluded.away_id,
       source = excluded.source, updated_at = excluded.updated_at`,
  );

  const known = leagueByKey();
  const perLeague = new Map<LeagueId, Aggregated[]>();
  let source: 'live' | 'fixture' = 'fixture';
  // El reloj arranca cuando TERMINA la descarga: a partir de ahí, todo lo que pase es
  // nuestro. Lo de antes es del proveedor y de la cadencia, y se mide con la marca de
  // origen de cada evento, no con este cronómetro.
  let fetchDoneAt = 0;

  // Por qué acaba en demostración, si acaba. Se va afinando según avanza: empieza en
  // «no hay clave» y cada etapa que se supera la sustituye por la siguiente causa
  // posible. Sin esto, las 140 filas de demostración del fútbol no tenían explicación
  // en ninguna parte — ni en el log, porque las ligas que no se reconocen se descartan
  // con un `continue` mudo.
  let motivo: OddsReason = 'sin_clave';
  let detalle = '';

  if (env.oddsApiKey) {
    motivo = 'fuente_falla';
    let sports: { key: string }[] = [];
    try {
      sports = await fetchActive();
      motivo = 'sin_ligas';
    } catch (e) {
      detalle = (e as Error).message;
      process.stderr.write(`  no pude listar ligas de fútbol: ${(e as Error).message}\n`);
    }
    const reconocidas: string[] = [];
    for (const s of sports) {
      const league = known.get(s.key);
      if (!league) continue;
      reconocidas.push(s.key);
      motivo = 'sin_eventos';
      try {
        const events = await fetchLive(s.key);
        if (events.length) {
          perLeague.set(league, [...(perLeague.get(league) ?? []), ...events]);
          source = 'live';
        }
      } catch (e) {
        motivo = 'fuente_falla';
        detalle = `${s.key}: ${(e as Error).message}`;
        process.stderr.write(`  odds de ${s.key} fallaron: ${(e as Error).message}\n`);
      }
    }
    if (motivo === 'sin_ligas') {
      // EL DATO CON EL QUE SE ARREGLA: qué ofreció el proveedor frente a lo que sabemos
      // traducir. Sin los nombres no hay forma de saber si la liga está fuera de
      // temporada o si al proveedor le cambió la clave del deporte.
      detalle =
        `el proveedor ofrece ${sports.length} competiciones y ninguna coincide con las ` +
        `${known.size} configuradas. Ofrece: ${sports.map((x) => x.key).slice(0, 8).join(', ')}` +
        (sports.length > 8 ? '…' : '');
    }
    fetchDoneAt = Date.now();
  }

  if (perLeague.size === 0) {
    for (const l of footballConfig.leagues) {
      const fx = generateFixtures(l.id);
      if (fx.length) perLeague.set(l.id, fx);
    }
    source = 'fixture';
  }

  const nowIso = new Date().toISOString();

  // ===========================================================================
  // ETAPA «ORIGEN»: LA CASA PUBLICA → LO TENEMOS
  // ===========================================================================
  // Solo se mide cuando el precio es NUEVO: `recordFreshness` devuelve null si ya se
  // había visto esa marca de origen. Medir en cada sondeo el mismo precio inflaría la
  // muestra con no-cambios y haría bajar los percentiles sin que nada mejorara — que es
  // la forma más fácil de que un panel de latencia mienta a su favor.
  if (source === 'live' && fetchDoneAt > 0) {
    const fetchedAt = new Date(fetchDoneAt).toISOString();
    const nuevos: { ev: Aggregated; ms: number; minutesToStart: number }[] = [];
    for (const [, events] of perLeague) {
      for (const ev of events) {
        if (!ev.sourceUpdatedAt) continue;
        const ms = recordFreshness({
          fixtureId: ev.id,
          sport: 'football',
          sourceUpdatedAt: ev.sourceUpdatedAt,
          fetchedAt,
          books: ev.books,
        });
        if (ms == null) continue;
        const minutesToStart = (Date.parse(ev.commence_time) - fetchDoneAt) / 60_000;
        recordLatency({ stage: 'origen', ms, sport: 'football', fixtureId: ev.id, minutesToStart });
        nuevos.push({ ev, ms, minutesToStart });
      }
    }

    // ===========================================================================
    // AVISAR DE ALGUNOS, NO DE TODOS
    // ===========================================================================
    // MEDIR es de todos —cada precio nuevo es una muestra válida y tirarlas sesgaría
    // los percentiles—, pero AVISAR de todos es otra cosa. El primer sondeo con una
    // clave nueva ve por primera vez cada partido de cada liga: sin techo, eso son
    // decenas de notificaciones de golpe, cada una con su propia etiqueta, y la persona
    // silencia el canal el primer día. Un canal de alertas que se silencia es un canal
    // de alertas que no existe.
    //
    // Así que se avisa de los más inminentes, que son los accionables —una línea de un
    // partido del sábado que se mueve el miércoles no exige mirar ahora mismo— y el
    // resto va en UN aviso que dice cuántos son.
    const MAX_AVISOS = 5;
    nuevos.sort((a, b) => a.minutesToStart - b.minutesToStart);
    for (const { ev, ms } of nuevos.slice(0, MAX_AVISOS)) {
      publish({
        type: 'odds',
        title: `${ev.home} vs ${ev.away}`,
        body: `Precio nuevo (${ev.books} casas), publicado hace ${(ms / 60_000).toFixed(1)} min.`,
        fixtureId: ev.id,
        at: fetchedAt,
      });
    }
    if (nuevos.length > MAX_AVISOS) {
      publish({
        type: 'odds',
        title: `${nuevos.length - MAX_AVISOS} precios más se movieron`,
        body: 'Están en las tarjetas, ya actualizadas. Se avisa aparte de los partidos más próximos.',
        at: fetchedAt,
      });
    }
  }

  const ingestStart = Date.now();
  db.exec('BEGIN');
  try {
    // Keeps the matches that already kicked off today — see pruneUpcoming.
    // An unconditional DELETE here is what made this morning's game vanish.
    pruneUpcoming(db, 'fb_upcoming');
    let count = 0;
    let promoted = 0;
    for (const [league, events] of perLeague) {
      const idx = buildNameIndex(league);
      const second = secondDivisionOf(league);
      const secondIdx = second ? buildNameIndex(second) : null;

      /**
       * The club's id in THIS division, seeding it from the one below if it has
       * just come up.
       *
       * Without this a promoted club never resolves — it has never played a match
       * in this division, so it is not in the table the index is built from — and
       * every one of its fixtures falls back to the market's implied numbers with
       * no breakdown at all. That is what "Atlético Madrid vs Málaga" looked like:
       * three clubs a league, every August, roughly a fifth of the fixtures for the
       * first months of a season.
       */
      const resolveOrSeed = (name: string): string | null => {
        const here = resolve(idx, name);
        if (here) return here;
        if (!secondIdx || !second) return null;
        const below = resolve(secondIdx, name);
        if (!below) return null;
        const seeded = seedPromotedTeam(league, below);
        if (!seeded) return null;
        promoted++;
        process.stdout.write(
          `  ↑ ${name}: Elo trasladado desde ${second} (${seeded.elo}, salto ${seeded.offset})\n`,
        );
        // The index is rebuilt so a second fixture for the same club in this run
        // resolves normally instead of seeding it again.
        idx.set(name.toLowerCase().trim(), below);
        return below;
      };

      for (const ev of events) {
        // The draw price is keyed by the literal "Draw" in this provider's h2h
        // market; anything else means the payload changed shape.
        const drawPrice = ev.price['Draw'] ?? ev.price['draw'] ?? null;
        insert.run(
          ev.id,
          league,
          ev.commence_time,
          ev.home,
          ev.away,
          resolveOrSeed(ev.home),
          resolveOrSeed(ev.away),
          ev.price[ev.home] ?? null,
          drawPrice,
          ev.price[ev.away] ?? null,
          ev.books,
          source,
          new Date().toISOString(),
          // Last arg feeds the CASE guard above: the row may only be re-timed
          // while its stored kick-off is still in the future.
          nowIso,
        );
        // El histórico de precios: una fila por cada CAMBIO, con su hora. Es lo único
        // que permite después preguntar si la línea se movió antes o después de que
        // saliera una noticia — sin esta serie, esa pregunta no tiene datos.
        recordOdds(
          ev.id,
          league,
          {
            home: ev.price[ev.home] ?? null,
            draw: drawPrice,
            away: ev.price[ev.away] ?? null,
            books: ev.books,
          },
          nowIso,
        );
        count++;
      }
    }
    db.exec('COMMIT');
    // ETAPA «INGESTA»: lo teníamos en la mano → está escrito. Es la parte más rápida de
    // las cuatro con diferencia, y se mide igualmente: sin medirla no se puede afirmar
    // que es pequeña, solo suponerlo.
    if (source === 'live' && fetchDoneAt > 0) {
      recordLatency({ stage: 'ingesta', ms: Date.now() - ingestStart, sport: 'football' });
    }
    setMeta('fb_odds_source', source);
    setMeta('fb_odds_refreshed_at', new Date().toISOString());
    recordOddsReason('fb_', source === 'live' ? null : motivo, detalle);
    return { source, count, leagues: [...perLeague.keys()], promoted };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
