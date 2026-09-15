// Alineación esperada contra alineación confirmada.
//
// ===========================================================================
// LAS DOS SON PREDICCIONES HASTA QUE UNA DEJA DE SERLO
// ===========================================================================
// Hasta una hora antes del partido, quién juega es una suposición del modelo: el once
// más usado, con las bajas conocidas fuera. Cuando el club publica el equipo, esa
// suposición se convierte en un hecho — y la DIFERENCIA entre las dos es la noticia.
//
// Que un titular fijo no esté en la lista publicada es información que no estaba en
// ningún parte médico: los clubes no anuncian «hoy descansa». Es el caso en el que este
// módulo gana de verdad, y por eso la comparación no se hace solo con quien tiene una
// noticia asociada, sino con TODO el once esperado.
//
// ===========================================================================
// LA ROTACIÓN POR CALENDARIO NO ES UNA PREDICCIÓN, ES UN AVISO
// ===========================================================================
// La congestión de calendario se midió a nivel de EQUIPO en momentum.ts y salió en cero:
// jugar cada tres días no hace peor al equipo de forma medible, porque el entrenador
// rota y el equipo rotado sigue siendo bueno. Ese resultado se respeta y no se
// reintroduce por la puerta de atrás.
//
// Lo que sí cambia con el calendario es QUIÉN juega, que es otra cosa. Un titular con
// tres partidos en siete días tiene más probabilidad de descansar, y eso no contradice
// la medición anterior: dice que la incertidumbre sobre la alineación es mayor, no que
// el equipo vaya a rendir menos. Así que `rotationRisk` NO toca la λ — ensancha la banda
// de fiabilidad y avisa. Convertirlo en un ajuste de fuerza sería resucitar un efecto
// que este proyecto ya midió y descartó.

import { getDb } from '../db.ts';
import { getSquad, type SquadPlayer } from './players.ts';
import type { LeagueId } from './types.ts';

export type LineupKind = 'esperada' | 'confirmada';

export interface LineupEntry {
  playerId: string;
  starting: boolean;
}

export function storeLineup(
  fixtureId: string,
  league: LeagueId,
  teamId: string,
  kind: LineupKind,
  entries: LineupEntry[],
  recordedAt = new Date().toISOString(),
): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO fb_lineups (fixture_id, league, team_id, player_id, kind, starting, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(fixture_id, team_id, player_id, kind) DO UPDATE SET
       starting = excluded.starting, recorded_at = excluded.recorded_at`,
  );
  db.exec('BEGIN');
  try {
    for (const e of entries) {
      stmt.run(fixtureId, league, teamId, e.playerId, kind, e.starting ? 1 : 0, recordedAt);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getLineup(
  fixtureId: string,
  teamId: string,
  kind: LineupKind,
): { entries: LineupEntry[]; recordedAt: string } | null {
  const rows = getDb()
    .prepare(
      `SELECT player_id playerId, starting, recorded_at recordedAt
       FROM fb_lineups WHERE fixture_id = ? AND team_id = ? AND kind = ?`,
    )
    .all(fixtureId, teamId, kind) as unknown as {
    playerId: string;
    starting: number;
    recordedAt: string;
  }[];
  if (rows.length === 0) return null;
  return {
    entries: rows.map((r) => ({ playerId: r.playerId, starting: !!r.starting })),
    recordedAt: rows[0].recordedAt,
  };
}

/** El once que el modelo supone: el habitual, quitando a quien la fuente marca fuera. */
export function expectedLineup(league: LeagueId, teamId: string): SquadPlayer[] {
  return getSquad(league, teamId).filter((p) => p.regular && !p.flaggedOut);
}

export interface LineupDiff {
  /** Estaban en el once esperado y NO en el confirmado. La noticia de verdad. */
  unexpectedlyOut: SquadPlayer[];
  /** Están en el confirmado y no se esperaban. */
  unexpectedlyIn: string[];
  /** Cuántos del once esperado se confirmaron. */
  matched: number;
  confirmedAt: string;
}

/**
 * Comparar lo confirmado con lo esperado.
 *
 * Devuelve null mientras no haya alineación confirmada, que es el estado normal hasta
 * una hora antes. Ese null importa: es lo que hace que la tarjeta diga «alineación
 * esperada» en vez de dar a entender que sabe quién juega.
 */
export function diffLineup(
  league: LeagueId,
  fixtureId: string,
  teamId: string,
): LineupDiff | null {
  const confirmed = getLineup(fixtureId, teamId, 'confirmada');
  if (!confirmed) return null;
  const starters = new Set(confirmed.entries.filter((e) => e.starting).map((e) => e.playerId));
  const expected = expectedLineup(league, teamId);
  const expectedIds = new Set(expected.map((p) => p.id));
  return {
    unexpectedlyOut: expected.filter((p) => !starters.has(p.id)),
    unexpectedlyIn: [...starters].filter((id) => !expectedIds.has(id)),
    matched: expected.filter((p) => starters.has(p.id)).length,
    confirmedAt: confirmed.recordedAt,
  };
}

export interface RotationRisk {
  /** Partidos del equipo en los últimos `windowDays` días. */
  recentMatches: number;
  /** Días desde el último partido. */
  daysRest: number | null;
  /** 0..1. Cuánta más incertidumbre hay sobre quién sale de inicio. */
  risk: number;
  reason: string;
}

const WINDOW_DAYS = 10;

/**
 * Riesgo de rotación por calendario.
 *
 * NO devuelve un ajuste de fuerza — devuelve incertidumbre. Ver la cabecera: el efecto
 * del calendario sobre el RENDIMIENTO se midió y salió cero; lo que crece con la
 * congestión es la duda sobre la alineación.
 */
export function rotationRisk(
  league: LeagueId,
  teamId: string,
  onDate: string,
  windowDays = WINDOW_DAYS,
): RotationRisk {
  const db = getDb();
  const d = new Date(
    Date.UTC(
      Number(onDate.slice(0, 4)),
      Number(onDate.slice(4, 6)) - 1,
      Number(onDate.slice(6, 8)),
    ),
  );
  const from = new Date(d.getTime() - windowDays * 86400_000);
  const fmt = (x: Date): string =>
    `${x.getUTCFullYear()}${String(x.getUTCMonth() + 1).padStart(2, '0')}${String(x.getUTCDate()).padStart(2, '0')}`;
  const rows = db
    .prepare(
      `SELECT match_date d FROM fb_matches
       WHERE league = ? AND (home_id = ? OR away_id = ?)
         AND match_date >= ? AND match_date < ?
       ORDER BY match_date DESC`,
    )
    .all(league, teamId, teamId, fmt(from), onDate) as unknown as { d: string }[];

  const recentMatches = rows.length;
  const daysRest = rows.length
    ? Math.round(
        (d.getTime() -
          Date.UTC(
            Number(rows[0].d.slice(0, 4)),
            Number(rows[0].d.slice(4, 6)) - 1,
            Number(rows[0].d.slice(6, 8)),
          )) /
          86400_000,
      )
    : null;

  // Tres partidos en diez días es un calendario cargado; dos es lo normal de una semana
  // con competición europea; uno es una semana limpia. El riesgo sube con el número de
  // partidos y con la falta de descanso, y se recorta en 1.
  let risk = Math.max(0, (recentMatches - 1) / 3);
  if (daysRest != null && daysRest <= 3) risk += 0.25;
  risk = Math.min(1, Math.round(risk * 100) / 100);

  const reason =
    recentMatches <= 1
      ? 'Semana limpia: un partido o menos en los últimos diez días.'
      : daysRest != null && daysRest <= 3
        ? `${recentMatches} partidos en ${windowDays} días y solo ${daysRest} de descanso: es probable que rote.`
        : `${recentMatches} partidos en ${windowDays} días.`;

  return { recentMatches, daysRest, risk, reason };
}
