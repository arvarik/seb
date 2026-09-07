import type { SleeperNflState } from '../sleeper/types.js';
export function resolveCompletedAnalysisWindow(
  leagueSeasonText: string, state: SleeperNflState,
  request: { analysisSeason?: number; throughWeek?: number },
) {
  const leagueSeason = Number(leagueSeasonText);
  const currentSeason = Number(state.season);
  const currentCompleteWeek = completedNflWeek(state);
  const defaultSeason = leagueSeason < currentSeason ? leagueSeason
    : currentCompleteWeek > 0 ? currentSeason : currentSeason - 1;
  const analysisSeason = request.analysisSeason ?? defaultSeason;
  const maximumWeek = analysisSeason < currentSeason ? 18 : currentCompleteWeek;
  const throughWeek = request.throughWeek ?? maximumWeek;
  if (!Number.isInteger(analysisSeason) || analysisSeason < 1999 || analysisSeason > currentSeason ||
    !Number.isInteger(throughWeek) || throughWeek < 1 || throughWeek > maximumWeek) {
    throw new Error('Analysis must use completed regular-season weeks. Choose a prior season when no current week is complete.');
  }
  return { analysisSeason, throughWeek };
}

export function completedNflWeek(state: SleeperNflState): number {
  const phase = state.season_type.toLowerCase();
  if (phase === 'regular') return Math.max(0, Math.min(18, state.week - 1));
  if (['post', 'postseason'].includes(phase)) return 18;
  if (phase === 'off' && Number(state.league_season) > Number(state.season)) return 18;
  return 0;
}
