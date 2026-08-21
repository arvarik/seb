import { describe, expect, it } from 'vitest';

import type { NflverseClient } from '../src/nflverse/client.js';
import type { NflversePlayerWeek } from '../src/nflverse/types.js';
import type { SleeperClient } from '../src/sleeper/client.js';
import type {
  SleeperLeague,
  SleeperPlayerMap,
  SleeperRoster,
  SleeperTrendingPlayer,
} from '../src/sleeper/types.js';
import { rankWaiverTargets } from '../src/waivers/ranking.js';
import { createWaiverTools } from '../src/waivers/tools.js';

describe('waiver and FAAB assistant', () => {
  it('ranks only unrostered targets with scoring, need, demand, and FAAB context', () => {
    const result = rankWaiverTargets({
      analysisSeason: 2026,
      league: league(),
      lookbackHours: 24,
      nflverseRows: [
        stat('n-rb', 'Riley Runner', 'RB', 1, { receptions: 2, receivingYards: 20, rushingYards: 60 }),
        stat('n-rb', 'Riley Runner', 'RB', 2, { receptions: 3, receivingYards: 30, rushingYards: 80 }),
        stat('n-rb', 'Riley Runner', 'RB', 3, { receptions: 4, receivingYards: 40, rushingYards: 100 }),
        stat('n-wr', 'Will Wide', 'WR', 1, { receptions: 5, receivingYards: 70 }),
        stat('n-wr', 'Will Wide', 'WR', 2, { receptions: 5, receivingYards: 70 }),
        stat('n-wr', 'Will Wide', 'WR', 3, { receptions: 5, receivingYards: 70 }),
      ],
      players: players(),
      resultLimit: 10,
      rosters: rosters(),
      selectedRoster: rosters()[0]!,
      throughWeek: 3,
      trendingAdds: trends(),
    });

    expect(result.targets.map((target) => target.player.playerId)).toEqual([
      'free-rb',
      'free-wr',
    ]);
    expect(result.candidatePool).toEqual({
      ranked: 2,
      requestedTrendingAdds: 4,
      skippedInactive: 1,
      skippedRostered: 1,
      skippedUnsupportedPosition: 0,
    });
    expect(result.targets[0]).toMatchObject({
      demand: { adds: 80, lookbackHours: 24, sourceScope: 'Sleeper platform' },
      faab: { budget: 100, lower: 18, remaining: 65, upper: 30, used: 35 },
      player: { name: 'Riley Runner', position: 'RB' },
      production: {
        games: 3,
        recentAverage: 15.5,
        weeklyPoints: [
          { points: 11, week: 1 },
          { points: 15.5, week: 2 },
          { points: 20, week: 3 },
        ],
      },
      rosterNeed: {
        directStarterSlots: 1,
        level: 'critical',
        viableAtPosition: 0,
      },
      risk: { level: 'low' },
    });
    expect(result.faab).toEqual({
      budget: 100,
      minimumBid: 0,
      mode: 'faab',
      remaining: 65,
      used: 35,
    });
    expect(result.methodology.rankFormula).toContain('45% recent production');
    expect(result.methodology.scoringKeysUsed).toContain('rec');
    expect(result.methodology.scoringKeysIgnored).toContain('fum_lost');
  });

  it('reduces the FAAB range when status and missing production create high risk', () => {
    const selectedRoster: SleeperRoster = {
      league_id: '123',
      players: [],
      roster_id: 4,
      settings: { waiver_budget_used: 98 },
      starters: [],
    };
    const result = rankWaiverTargets({
      analysisSeason: 2026,
      league: league(),
      lookbackHours: 48,
      nflverseRows: [],
      players: {
        'free-qb': {
          active: true,
          full_name: 'Unavailable Quarterback',
          injury_status: 'Out',
          player_id: 'free-qb',
          position: 'QB',
          team: 'BUF',
        },
      },
      resultLimit: 5,
      rosters: [selectedRoster],
      selectedRoster,
      throughWeek: 3,
      trendingAdds: [{ count: 50, player_id: 'free-qb' }],
    });

    expect(result.targets[0]).toMatchObject({
      faab: { lower: 0, remaining: 2, upper: 2, upperPercent: 2 },
      production: null,
      risk: { level: 'high', score: 100 },
      rosterNeed: { level: 'critical' },
    });
    expect(result.limitations).toContain(
      'nflverse has no resolved recent production for 1 ranked target.',
    );
  });

  it('exposes a read-only agent tool that derives the latest completed week', async () => {
    const calls: Array<{ season: number; throughWeek?: number }> = [];
    const sleeper = {
      getLeague: async () => league(),
      getLeagueRosters: async () => rosters(),
      getTrendingPlayers: async () => trends().slice(0, 2),
      getPlayers: async () => players(),
      getNflState: async () => ({
        league_season: '2026',
        leg: 4,
        season: '2026',
        season_type: 'regular',
        week: 4,
      }),
    } as unknown as SleeperClient;
    const nflverse = {
      getPlayerWeeklyStats: async (input: { season: number; throughWeek?: number }) => {
        calls.push(input);
        return [
          stat('n-rb', 'Riley Runner', 'RB', 1),
          stat('n-rb', 'Riley Runner', 'RB', 2),
          stat('n-rb', 'Riley Runner', 'RB', 3),
        ];
      },
    } as unknown as NflverseClient;
    const execute = createWaiverTools(sleeper, nflverse).rankWaiverTargets.execute;

    const result = await execute?.(
      {
        leagueId: '123',
        lookbackHours: 24,
        resultLimit: 10,
        rosterId: 4,
        trendingLimit: 50,
      },
      { context: {}, messages: [], toolCallId: 'test' },
    );

    expect(calls).toEqual([{ season: 2026, seasonType: 'REG', throughWeek: 3 }]);
    expect(result).toMatchObject({
      analysisSeason: 2026,
      league: { leagueId: '123' },
      rosterId: 4,
      throughWeek: 3,
    });
  });
});

function league(): SleeperLeague {
  return {
    league_id: '123',
    name: 'Test League',
    roster_positions: ['QB', 'RB', 'WR', 'FLEX', 'BN'],
    scoring_settings: {
      fum_lost: -2,
      pass_int: -2,
      pass_td: 4,
      pass_yd: 0.04,
      rec: 1.5,
      rec_td: 6,
      rec_yd: 0.1,
      rush_td: 6,
      rush_yd: 0.1,
    },
    season: '2026',
    season_type: 'regular',
    settings: {
      waiver_bid_min: 0,
      waiver_budget: 100,
      waiver_type: 2,
    },
    sport: 'nfl',
    status: 'in_season',
    total_rosters: 2,
  };
}

function rosters(): SleeperRoster[] {
  return [
    {
      league_id: '123',
      owner_id: 'user-1',
      players: ['roster-qb', 'roster-wr-1', 'roster-wr-2', 'roster-wr-3'],
      roster_id: 4,
      settings: { waiver_budget_used: 35 },
      starters: ['roster-qb', '0', 'roster-wr-1', 'roster-wr-2'],
    },
    {
      league_id: '123',
      owner_id: 'user-2',
      players: ['owned'],
      roster_id: 8,
      settings: { waiver_budget_used: 0 },
      starters: ['owned'],
    },
  ];
}

function players(): SleeperPlayerMap {
  return {
    inactive: {
      active: false,
      full_name: 'Inactive Player',
      player_id: 'inactive',
      position: 'RB',
      team: null,
    },
    owned: {
      active: true,
      full_name: 'Owned Player',
      player_id: 'owned',
      position: 'RB',
      team: 'MIA',
    },
    'free-rb': {
      active: true,
      full_name: 'Riley Runner',
      injury_status: null,
      player_id: 'free-rb',
      position: 'RB',
      status: 'Active',
      team: 'BUF',
    },
    'free-wr': {
      active: true,
      full_name: 'Will Wide',
      injury_status: null,
      player_id: 'free-wr',
      position: 'WR',
      status: 'Active',
      team: 'SEA',
    },
    'roster-qb': player('roster-qb', 'Roster Quarterback', 'QB'),
    'roster-wr-1': player('roster-wr-1', 'Roster Receiver One', 'WR'),
    'roster-wr-2': player('roster-wr-2', 'Roster Receiver Two', 'WR'),
    'roster-wr-3': player('roster-wr-3', 'Roster Receiver Three', 'WR'),
  };
}

function player(playerId: string, fullName: string, position: string) {
  return {
    active: true,
    full_name: fullName,
    injury_status: null,
    player_id: playerId,
    position,
    status: 'Active',
    team: 'SEA',
  };
}

function trends(): SleeperTrendingPlayer[] {
  return [
    { count: 200, player_id: 'owned' },
    { count: 150, player_id: 'inactive' },
    { count: 100, player_id: 'free-wr' },
    { count: 80, player_id: 'free-rb' },
  ];
}

function stat(
  playerId: string,
  playerDisplayName: string,
  position: string,
  week: number,
  overrides: Partial<NflversePlayerWeek> = {},
): NflversePlayerWeek {
  return {
    airYardsShare: 0.2,
    attempts: 0,
    carries: 0,
    completions: 0,
    fantasyPoints: 0,
    fantasyPointsPpr: 0,
    gameId: `game-${playerId}-${week}`,
    interceptions: 0,
    opponentTeam: 'MIA',
    passingTouchdowns: 0,
    passingYards: 0,
    playerDisplayName,
    playerId,
    position,
    receivingAirYards: 0,
    receivingTouchdowns: 0,
    receivingYards: 0,
    receptions: 0,
    rushingTouchdowns: 0,
    rushingYards: 50,
    season: 2026,
    seasonType: 'REG',
    targetShare: 0.2,
    targets: 4,
    team: position === 'RB' ? 'BUF' : 'SEA',
    week,
    ...overrides,
  };
}
