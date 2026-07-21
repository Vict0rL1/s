// Recompute Elo ratings for every tour from the matches currently in the DB and
// persist them into player_ratings. Run this after any ingest (Sackmann or seed).

import { getDb } from '../db.ts';
import { computeRatings } from '../model/elo.ts';
import { toursConfig } from '../config.ts';
import type { MatchRow } from '../types.ts';

export function recomputeRatings(): Record<string, number> {
  const db = getDb();
  const perTour: Record<string, number> = {};

  const insert = db.prepare(
    `INSERT INTO player_ratings
       (player_id, tour, overall, hard, clay, grass, matches_played, last_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tour, player_id) DO UPDATE SET
       overall=excluded.overall, hard=excluded.hard, clay=excluded.clay,
       grass=excluded.grass, matches_played=excluded.matches_played,
       last_date=excluded.last_date`,
  );

  for (const tour of toursConfig.tours) {
    const matches = db
      .prepare(
        `SELECT id, tourney_date, surface, winner_id, loser_id
         FROM matches WHERE tour = ? ORDER BY tourney_date ASC, id ASC`,
      )
      .all(tour.id) as unknown as MatchRow[];

    const ratings = computeRatings(matches, tour.id);
    db.exec('BEGIN');
    for (const r of ratings) {
      insert.run(
        r.player_id,
        r.tour,
        r.overall,
        r.hard,
        r.clay,
        r.grass,
        r.matches_played,
        r.last_date,
      );
    }
    db.exec('COMMIT');
    perTour[tour.id] = ratings.length;
  }

  return perTour;
}
