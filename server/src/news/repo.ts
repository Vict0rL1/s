// Guardar noticias, emparejarlas con jugadores reales, y medir si el precio se movió
// antes o después.

import { getDb } from '../db.ts';
import type { NewsItem } from './schema.ts';
import type { LeagueId } from '../football/types.ts';

export interface StoredNews extends NewsItem {
  id: string;
  league: string;
  teamId: string | null;
  playerId: string | null;
  publishedAt: string;
  ingestedAt: string;
  source: string;
  extractor: string;
}

/**
 * Emparejar el nombre del texto con un jugador de la plantilla.
 *
 * ===========================================================================
 * POR QUÉ ESTO NO LO HACE EL MODELO
 * ===========================================================================
 * Se le pasan los nombres conocidos en el prompt y suele acertar, pero «suele» no basta
 * para una decisión que mueve una λ. Aquí el emparejado es determinista y CONSERVADOR:
 * exacto, luego por apellido, y si hay dos candidatos con el mismo apellido no elige —
 * devuelve null y la noticia se guarda sin jugador.
 *
 * Una noticia sin emparejar no mueve nada y sale en pantalla marcada como tal. Es el
 * fallo correcto: equivocarse de jugador no da un error, da una predicción distinta que
 * nadie va a poder explicar.
 */
export function matchPlayer(
  league: LeagueId,
  name: string,
  teamId?: string | null,
): { id: string; teamId: string; name: string } | null {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, team_id teamId, name FROM fb_players
       WHERE league = ?${teamId ? ' AND team_id = ?' : ''}`,
    )
    .all(...(teamId ? [league, teamId] : [league])) as unknown as {
    id: string;
    teamId: string;
    name: string;
  }[];
  if (rows.length === 0) return null;

  const norm = (s: string): string =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z ]/g, '')
      .trim();
  const target = norm(name);
  if (!target) return null;

  const exact = rows.filter((r) => norm(r.name) === target);
  if (exact.length === 1) return exact[0];

  // El feed abrevia («J.Timber», «Bruno G.»), así que el apellido es lo que casi siempre
  // coincide. Se exige que sea el ÚLTIMO token por los dos lados para no emparejar
  // «Silva» con «Silva Junior» por accidente.
  const lastOf = (s: string): string => {
    const parts = norm(s).split(' ').filter(Boolean);
    return parts[parts.length - 1] ?? '';
  };
  const targetLast = lastOf(name);
  if (targetLast.length >= 3) {
    const bySurname = rows.filter((r) => lastOf(r.name) === targetLast);
    // Exactamente uno. Dos «Timber» en la misma liga son un empate, y un empate se
    // resuelve NO eligiendo.
    if (bySurname.length === 1) return bySurname[0];
  }
  return null;
}

export function storeNews(
  league: LeagueId,
  item: NewsItem,
  meta: { source: string; extractor: string; publishedAt: string; teamId?: string | null },
): StoredNews {
  const db = getDb();
  const matched = matchPlayer(league, item.playerName, meta.teamId ?? null);
  const ingestedAt = new Date().toISOString();
  // El id incluye la cita para que la MISMA noticia no se duplique en cada pasada, pero
  // una nota distinta del mismo jugador sí entre: el estado de una lesión cambia, y
  // guardar solo la última perdería justo la secuencia que hace falta para el reloj.
  const id = `${league}:${matched?.id ?? item.playerName}:${hash(item.quote)}`;
  db.prepare(
    `INSERT INTO fb_news
       (id, league, team_id, player_id, player_name, kind, play_prob, body_part,
        return_date, confidence, quote, published_at, ingested_at, source, extractor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       play_prob = excluded.play_prob, confidence = excluded.confidence,
       return_date = excluded.return_date, ingested_at = excluded.ingested_at`,
  ).run(
    id,
    league,
    matched?.teamId ?? meta.teamId ?? null,
    matched?.id ?? null,
    item.playerName,
    item.kind,
    item.playProbability,
    item.bodyPart,
    item.returnDate,
    item.confidence,
    item.quote,
    meta.publishedAt,
    ingestedAt,
    meta.source,
    meta.extractor,
  );
  return {
    ...item,
    id,
    league,
    teamId: matched?.teamId ?? meta.teamId ?? null,
    playerId: matched?.id ?? null,
    publishedAt: meta.publishedAt,
    ingestedAt,
    source: meta.source,
    extractor: meta.extractor,
  };
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Las noticias vigentes de un equipo, la más reciente por jugador. */
export function newsForTeam(league: string, teamId: string): StoredNews[] {
  const rows = getDb()
    .prepare(
      `SELECT id, league, team_id teamId, player_id playerId, player_name playerName,
              kind, play_prob playProbability, body_part bodyPart, return_date returnDate,
              confidence, quote, published_at publishedAt, ingested_at ingestedAt,
              source, extractor
       FROM fb_news WHERE league = ? AND team_id = ?
       ORDER BY published_at DESC`,
    )
    .all(league, teamId) as unknown as StoredNews[];
  // Una por jugador: la más reciente manda. Un jugador puede tener «duda» del lunes y
  // «descartado» del viernes, y la del lunes ya no describe nada.
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = r.playerId ?? r.playerName;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ===========================================================================
// EL RELOJ: LA NOTICIA CONTRA EL MOVIMIENTO DE LA LÍNEA
// ===========================================================================
// La pregunta que esto contesta no es «¿se movió el precio?» sino «¿se movió ANTES o
// DESPUÉS de que la noticia fuera pública?», y las dos respuestas significan cosas
// opuestas:
//
//   · Se movió DESPUÉS  → hubo una ventana. La noticia era información y el mercado
//     tardó en digerirla. Es el único caso en el que enterarse rápido vale algo.
//
//   · Se movió ANTES    → el mercado ya lo sabía. Lo que salió en la prensa a las 14:00
//     lo sabía alguien a las 11:00, y la línea lo dice. Actuar sobre esa noticia es
//     llegar tarde a algo que ya está en el precio.
//
// El segundo caso es el normal y es incómodo, así que se mide y se enseña en vez de
// suponerlo. Lo que NO se hace es afirmar causalidad: que el precio se mueva después de
// una noticia no demuestra que se moviera por ella.

/** Un precio observado. Se llama en cada refresco de cuotas. */
export function recordOdds(
  fixtureId: string,
  league: string,
  odds: { home: number | null; draw: number | null; away: number | null; books?: number },
  observedAt = new Date().toISOString(),
): void {
  const db = getDb();
  // Solo si CAMBIÓ. Guardar el mismo precio cada seis horas llena la tabla de filas que
  // no son movimientos y hace más difícil encontrar los que sí.
  const last = db
    .prepare(
      `SELECT odds_home h, odds_draw d, odds_away a FROM fb_odds_history
       WHERE fixture_id = ? ORDER BY observed_at DESC LIMIT 1`,
    )
    .get(fixtureId) as unknown as { h: number | null; d: number | null; a: number | null } | undefined;
  if (
    last &&
    last.h === odds.home &&
    last.d === odds.draw &&
    last.a === odds.away
  ) {
    return;
  }
  db.prepare(
    `INSERT INTO fb_odds_history (fixture_id, league, odds_home, odds_draw, odds_away, books, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(fixtureId, league, odds.home, odds.draw, odds.away, odds.books ?? null, observedAt);
}

export interface LineMove {
  observedAt: string;
  /** Cambio en la probabilidad implícita del local, en puntos. */
  deltaHome: number;
  /** El mayor cambio de las tres salidas, en puntos. Para el umbral. */
  magnitude: number;
}

/**
 * Movimientos de línea de un partido por encima de un umbral.
 *
 * 1,5 puntos de probabilidad: por debajo de eso el precio se mueve solo, por el redondeo
 * de las casas y por qué casas están en la muestra en cada momento. Un umbral más bajo
 * llenaría la lista de ruido y haría que siempre hubiera «un movimiento» cerca de
 * cualquier noticia, que es como se fabrica una correlación.
 */
export function lineMoves(fixtureId: string, thresholdPp = 1.5): LineMove[] {
  const rows = getDb()
    .prepare(
      `SELECT odds_home h, odds_draw d, odds_away a, observed_at observedAt
       FROM fb_odds_history WHERE fixture_id = ? ORDER BY observed_at`,
    )
    .all(fixtureId) as unknown as {
    h: number | null;
    d: number | null;
    a: number | null;
    observedAt: string;
  }[];
  const out: LineMove[] = [];
  const implied = (r: { h: number | null; d: number | null; a: number | null }): number[] | null => {
    if (!r.h || !r.d || !r.a) return null;
    const raw = [1 / r.h, 1 / r.d, 1 / r.a];
    const s = raw[0] + raw[1] + raw[2];
    return raw.map((x) => x / s);
  };
  for (let i = 1; i < rows.length; i++) {
    const prev = implied(rows[i - 1]);
    const now = implied(rows[i]);
    if (!prev || !now) continue;
    const deltas = now.map((x, k) => (x - prev[k]) * 100);
    const magnitude = Math.max(...deltas.map(Math.abs));
    if (magnitude < thresholdPp) continue;
    out.push({
      observedAt: rows[i].observedAt,
      deltaHome: Math.round(deltas[0] * 100) / 100,
      magnitude: Math.round(magnitude * 100) / 100,
    });
  }
  return out;
}

export interface NewsTiming {
  newsId: string;
  playerName: string;
  publishedAt: string;
  /** El primer movimiento posterior a la noticia, si lo hay. */
  moveAfter: LineMove | null;
  /** El último movimiento ANTERIOR a la noticia, dentro de la ventana. */
  moveBefore: LineMove | null;
  /** Minutos entre la noticia y el movimiento posterior. Null si no hubo. */
  minutesToMove: number | null;
  /**
   * El veredicto, en una palabra.
   *
   *   'mercado-primero' — el precio ya se había movido antes de que la noticia fuera
   *                       pública. Lo más frecuente, y significa llegar tarde.
   *   'noticia-primero' — el precio se movió después. Hubo ventana.
   *   'sin-movimiento'  — el precio no se movió. La noticia no cambió el precio, y eso
   *                       puede querer decir que no importaba o que nadie la vio.
   *   'sin-datos'       — no hay suficiente historia de precios para decir nada.
   */
  verdict: 'mercado-primero' | 'noticia-primero' | 'sin-movimiento' | 'sin-datos';
}

/** Ventana hacia atrás en la que un movimiento se considera «anticipación». */
const BEFORE_WINDOW_HOURS = 12;

export function newsTiming(fixtureId: string, news: StoredNews[]): NewsTiming[] {
  const moves = lineMoves(fixtureId);
  return news.map((n) => {
    const t = Date.parse(n.publishedAt);
    if (!Number.isFinite(t) || moves.length === 0) {
      return {
        newsId: n.id,
        playerName: n.playerName,
        publishedAt: n.publishedAt,
        moveAfter: null,
        moveBefore: null,
        minutesToMove: null,
        verdict: moves.length === 0 ? ('sin-datos' as const) : ('sin-movimiento' as const),
      };
    }
    const after = moves.find((m) => Date.parse(m.observedAt) >= t) ?? null;
    const before =
      [...moves]
        .reverse()
        .find(
          (m) =>
            Date.parse(m.observedAt) < t &&
            t - Date.parse(m.observedAt) <= BEFORE_WINDOW_HOURS * 3600_000,
        ) ?? null;
    return {
      newsId: n.id,
      playerName: n.playerName,
      publishedAt: n.publishedAt,
      moveAfter: after,
      moveBefore: before,
      minutesToMove: after ? Math.round((Date.parse(after.observedAt) - t) / 60000) : null,
      verdict: before ? 'mercado-primero' : after ? 'noticia-primero' : 'sin-movimiento',
    };
  });
}
