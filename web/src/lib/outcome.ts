// The shape the five sport endpoints use to report a played fixture.
//
// Its own module because all five import it and none of them owns it — putting it
// in any one sport's lib would make the other four import from a namespace they
// have nothing else to do with.

/**
 * The result of a fixture that has already kicked off.
 *
 * `started` without a `result` is a real and common state: the match is being
 * played, or it finished and the score has not been ingested yet. The card says so
 * rather than guessing.
 */
export interface MatchOutcome {
  started: boolean;
  result: { homeScore: number; awayScore: number; playedOn: string } | null;
}

/**
 * Tennis, which has no home side.
 *
 * The archive stores a winner and a loser rather than two score slots, so the
 * result is an id and a set score — not a pair of numbers.
 */
export interface TennisOutcome {
  started: boolean;
  result: {
    winnerId: number;
    winnerName: string | null;
    score: string | null;
    playedOn: string;
  } | null;
}
