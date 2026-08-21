import { NflverseClient } from '../nflverse/client.js';
import type { NflversePlayerWeek } from '../nflverse/types.js';
import { SleeperClient } from '../sleeper/client.js';
import type { SleeperLeague, SleeperNflState } from '../sleeper/types.js';
import {
  rankWaiverTargets,
  type WaiverAssistantResult,
} from './ranking.js';

export interface WaiverAssistantRequest {
  analysisSeason?: number;
  leagueId: string;
  lookbackHours?: number;
  resultLimit?: number;
  rosterId: number;
  throughWeek?: number;
  trendingLimit?: number;
}

export class WaiverAssistantService {
  constructor(
    private readonly sleeper: SleeperClient,
    private readonly nflverse: NflverseClient,
  ) {}

  async rankTargets(
    request: WaiverAssistantRequest,
  ): Promise<WaiverAssistantResult> {
    const lookbackHours = request.lookbackHours ?? 24;
    const trendingLimit = request.trendingLimit ?? 50;
    const resultLimit = request.resultLimit ?? 10;
    const [league, rosters, trendingAdds, players, state] = await Promise.all([
      this.sleeper.getLeague(request.leagueId),
      this.sleeper.getLeagueRosters(request.leagueId),
      this.sleeper.getTrendingPlayers('add', lookbackHours, trendingLimit),
      this.sleeper.getPlayers(),
      this.sleeper.getNflState(),
    ]);
    const selectedRoster = rosters.find((roster) => roster.roster_id === request.rosterId);
    if (!selectedRoster) {
      throw new Error(
        `Sleeper league ${request.leagueId} has no roster ${request.rosterId}.`,
      );
    }
    const window = resolveAnalysisWindow(league, state, request);
    let rows = await this.readStats(window.analysisSeason, window.throughWeek);
    let analysisSeason = window.analysisSeason;
    let throughWeek = window.throughWeek;
    if (
      rows.length === 0 &&
      request.analysisSeason === undefined &&
      request.throughWeek === undefined
    ) {
      analysisSeason -= 1;
      throughWeek = 18;
      rows = await this.readStats(analysisSeason, throughWeek);
    }
    return rankWaiverTargets({
      analysisSeason,
      league,
      lookbackHours,
      nflverseRows: rows,
      players,
      resultLimit,
      rosters,
      selectedRoster,
      throughWeek,
      trendingAdds,
    });
  }

  private readStats(
    season: number,
    throughWeek: number,
  ): Promise<NflversePlayerWeek[]> {
    return this.nflverse.getPlayerWeeklyStats({
      season,
      seasonType: 'REG',
      throughWeek,
    });
  }
}

function resolveAnalysisWindow(
  league: SleeperLeague,
  state: SleeperNflState,
  request: WaiverAssistantRequest,
): { analysisSeason: number; throughWeek: number } {
  const leagueSeason = parseSeason(league.season);
  if (request.analysisSeason !== undefined || request.throughWeek !== undefined) {
    return {
      analysisSeason: request.analysisSeason ?? leagueSeason,
      throughWeek: request.throughWeek ?? 18,
    };
  }
  const stateSeason = parseSeason(state.season);
  if (leagueSeason < stateSeason) {
    return { analysisSeason: leagueSeason, throughWeek: 18 };
  }
  const phase = state.season_type.trim().toLowerCase();
  if (phase === 'regular' && state.week > 1) {
    return { analysisSeason: leagueSeason, throughWeek: state.week - 1 };
  }
  if (phase === 'post' || phase === 'postseason') {
    return { analysisSeason: leagueSeason, throughWeek: 18 };
  }
  return {
    analysisSeason: parseOptionalSeason(state.previous_season) ?? leagueSeason - 1,
    throughWeek: 18,
  };
}

function parseSeason(value: string): number {
  const season = Number(value);
  if (!Number.isInteger(season) || season < 1999 || season > 2200) {
    throw new Error(`The season ${value} is invalid.`);
  }
  return season;
}

function parseOptionalSeason(value: string | undefined): number | null {
  return value ? parseSeason(value) : null;
}
