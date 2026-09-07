import { LearningStore } from '../learning/store.js';
import { resolveCompletedAnalysisWindow } from '../analysis/window.js';
import { NflverseClient } from '../nflverse/client.js';
import type { NflversePlayerWeek } from '../nflverse/types.js';
import { SleeperClient } from '../sleeper/client.js';
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
    private readonly learning: LearningStore | false = new LearningStore(),
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
    const window = resolveCompletedAnalysisWindow(league.season, state, request);
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
    const learned = this.learning ? await this.learning.context(analysisSeason, throughWeek, league.scoring_settings) : null;
    return rankWaiverTargets({
      ...(learned?.parameters ? { parameters: learned.parameters } : {}),
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
