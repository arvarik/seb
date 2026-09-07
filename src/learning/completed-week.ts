import type { NflverseGame } from '../nflverse/types.js';
import { easternKickoff } from '../time.js';

/** Require final scores for every game and a full reporting day after kickoff. */
export function completedLearningWeek(games: readonly NflverseGame[], season: number, requestedWeek?: number, now = new Date()): number {
  if (!Number.isInteger(season) || season < 1999 || season > 2100 || !Number.isFinite(now.getTime()) ||
    (requestedWeek !== undefined && (!Number.isInteger(requestedWeek) || requestedWeek < 1 || requestedWeek > 18))) {
    throw new Error('The completed-week boundary requires a valid season, week, and date.');
  }
  let throughWeek = 0;
  for (let week = 1; week <= (requestedWeek ?? 18); week += 1) {
    const selected = games.filter((game) => game.season === season && game.gameType === 'REG' && game.week === week);
    if (!selected.length || selected.some((game) => {
      const kickoff = easternKickoff(game.gameDate, game.gameTime);
      return !kickoff || kickoff.getTime() + 24 * 60 * 60 * 1000 > now.getTime() ||
        game.homeScore === null || game.awayScore === null;
    })) break;
    throughWeek = week;
  }
  if (!throughWeek || (requestedWeek !== undefined && throughWeek < requestedWeek)) {
    throw new Error('Wait until every game in the requested week has results and at least 24 hours pass after kickoff.');
  }
  return throughWeek;
}
