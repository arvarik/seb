import {
  analyzeLeague,
  predictMatchup,
  type LeagueAnalysis,
  type MatchupPrediction,
  type WeeklyMatchups,
} from './analytics.js';
import { SleeperClient } from './client.js';
import type { SleeperPlayer, SleeperRoster } from './types.js';

export interface RosterDetails {
  roster: SleeperRoster;
  players: SleeperPlayer[];
  missingPlayerIds: string[];
}

export class SleeperAnalysisService {
  constructor(private readonly client: SleeperClient) {}

  async analyzeLeague(
    leagueId: string,
    requestedThroughWeek?: number,
  ): Promise<LeagueAnalysis> {
    const [league, rosters, users, state] = await Promise.all([
      this.client.getLeague(leagueId),
      this.client.getLeagueRosters(leagueId),
      this.client.getLeagueUsers(leagueId),
      this.client.getNflState(),
    ]);

    const throughWeek = chooseThroughWeek(
      league.season,
      league.status,
      league.settings.leg,
      rosters,
      state.season,
      state.week,
      requestedThroughWeek,
    );
    const weeklyMatchups: WeeklyMatchups[] = await Promise.all(
      Array.from({ length: throughWeek }, (_, index) => index + 1).map(
        async (week) => ({
          week,
          matchups: await this.client.getLeagueMatchups(leagueId, week),
        }),
      ),
    );

    return analyzeLeague({
      league,
      rosters,
      users,
      weeklyMatchups,
      throughWeek,
    });
  }

  async predictMatchup(
    leagueId: string,
    rosterAId: number,
    rosterBId: number,
    requestedThroughWeek?: number,
  ): Promise<MatchupPrediction> {
    const analysis = await this.analyzeLeague(leagueId, requestedThroughWeek);
    return predictMatchup(analysis, rosterAId, rosterBId);
  }

  async getRosterDetails(
    leagueId: string,
    rosterId: number,
  ): Promise<RosterDetails> {
    const [rosters, players] = await Promise.all([
      this.client.getLeagueRosters(leagueId),
      this.client.getPlayers(),
    ]);
    const roster = rosters.find((candidate) => candidate.roster_id === rosterId);
    if (!roster) {
      throw new Error(`Roster ${rosterId} does not exist in this league.`);
    }

    const playerIds = roster.players ?? [];
    return {
      roster,
      players: playerIds.flatMap((playerId) => {
        const player = players[playerId];
        return player ? [player] : [];
      }),
      missingPlayerIds: playerIds.filter((playerId) => !players[playerId]),
    };
  }
}

function chooseThroughWeek(
  leagueSeason: string,
  leagueStatus: string,
  leagueLeg: string | number | boolean | null | undefined,
  rosters: SleeperRoster[],
  currentSeason: string,
  currentWeek: number,
  requestedThroughWeek?: number,
): number {
  if (requestedThroughWeek !== undefined) {
    if (
      !Number.isInteger(requestedThroughWeek) ||
      requestedThroughWeek < 0 ||
      requestedThroughWeek > 18
    ) {
      throw new RangeError('The analysis week must be an integer from 0 through 18.');
    }
    return requestedThroughWeek;
  }

  if (leagueStatus === 'pre_draft' || leagueStatus === 'drafting') {
    return 0;
  }

  if (leagueSeason === currentSeason && currentWeek >= 1 && currentWeek <= 18) {
    return Math.max(Math.floor(currentWeek) - 1, 0);
  }

  if (typeof leagueLeg === 'number' && leagueLeg >= 1 && leagueLeg <= 18) {
    return leagueStatus === 'complete'
      ? Math.floor(leagueLeg)
      : Math.max(Math.floor(leagueLeg) - 1, 0);
  }

  const games = Math.max(
    0,
    ...rosters.map(
      (roster) =>
        (roster.settings.wins ?? 0) +
        (roster.settings.losses ?? 0) +
        (roster.settings.ties ?? 0),
    ),
  );
  return Math.min(Math.max(games, 0), 18);
}
