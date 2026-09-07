import { describe, expect, it } from 'vitest';

import type { NflverseClient } from '../src/nflverse/client.js';
import type { NflversePlayerWeek } from '../src/nflverse/types.js';
import type { SleeperClient } from '../src/sleeper/client.js';
import { analyzeTradeImpact } from '../src/trades/trade-impact.js';
import { createTradeTools } from '../src/trades/tools.js';
import type {
  SleeperLeague,
  SleeperPlayer,
  SleeperRoster,
} from '../src/sleeper/types.js';

describe('trade impact analysis', () => {
  it('compares scoring-aware value and the roster position change', () => {
    const give = player('give', 'Give Receiver', 'WR');
    const receive = player('receive', 'Receive Runner', 'RB');
    const result = analyzeTradeImpact({
      analysisSeason: 2026,
      givePlayers: [give],
      league: league(),
      receivePlayers: [receive],
      roster: roster(),
      rosterPlayers: [
        give,
        player('quarterback', 'Roster Quarterback', 'QB'),
        player('depth-runner', 'Depth Runner', 'RB'),
      ],
      rows: [
        stat('Give Receiver', 'give', 1, { receptions: 5, receivingYards: 50 }),
        stat('Give Receiver', 'give', 2, { receptions: 6, receivingYards: 60 }),
        stat('Give Receiver', 'give', 3, { receptions: 7, receivingYards: 70 }),
        stat('Receive Runner', 'receive', 1, { rushingYards: 140 }),
        stat('Receive Runner', 'receive', 2, { rushingYards: 160 }),
        stat('Receive Runner', 'receive', 3, { rushingYards: 180 }),
      ],
      throughWeek: 3,
    });

    expect(result.receive.totalWeeklyValue).toBeGreaterThan(result.give.totalWeeklyValue);
    expect(result.analysisSeason).toBe(2026);
    expect(result.valueDelta).toBeGreaterThan(0);
    expect(result.verdict).toBe('insufficient-lineup-data');
    expect(result.rosterFit).toContainEqual({
      after: 2,
      before: 1,
      minimumStarters: 2,
      position: 'RB',
      state: 'improved',
    });
    expect(result.rosterFit).toContainEqual({
      after: 0,
      before: 1,
      minimumStarters: 2,
      position: 'WR',
      state: 'reduced',
    });
    expect(result.recommendationEligible).toBe(false);
    expect(result.limitations).toContain(
      'Current news must support any final accept or decline recommendation.',
    );
  });

  it('requires at least one player on each trade side', () => {
    expect(() => analyzeTradeImpact({
      analysisSeason: 2026,
      givePlayers: [],
      league: league(),
      receivePlayers: [player('receive', 'Receive Runner', 'RB')],
      roster: roster(),
      rosterPlayers: [],
      rows: [],
      throughWeek: 3,
    })).toThrow('at least one player on each side');
  });

  it('uses the prior completed season during the preseason', async () => {
    const give = player('give', 'Give Receiver', 'WR');
    const receive = player('receive', 'Receive Runner', 'RB');
    const calls: Array<{ season: number; throughWeek?: number }> = [];
    const sleeper = {
      getLeague: async () => league(),
      getLeagueRosters: async () => [
        roster(),
        { league_id: 'league-1', players: ['receive'], roster_id: 8, settings: {} },
      ],
      getNflState: async () => ({
        leg: 2,
        previous_season: '2025',
        season: '2026',
        season_type: 'pre',
        week: 2,
      }),
      getPlayers: async () => ({
        give,
        receive,
        quarterback: player('quarterback', 'Roster Quarterback', 'QB'),
        'depth-runner': player('depth-runner', 'Depth Runner', 'RB'),
      }),
    } as unknown as SleeperClient;
    const nflverse = {
      getPlayerWeeklyStats: async (input: { season: number; throughWeek?: number }) => {
        calls.push(input);
        return [
          stat('Give Receiver', 'give', 1, { receivingYards: 80, season: 2025 }),
          stat('Receive Runner', 'receive', 1, { rushingYards: 100, season: 2025 }),
        ];
      },
    } as unknown as NflverseClient;
    const execute = createTradeTools(sleeper, nflverse).analyzeTradeImpact.execute;

    const result = await execute?.({
      givePlayerNames: ['Give Receiver'],
      leagueId: '123456789012345678',
      receivePlayerNames: ['Receive Runner'],
      rosterId: 4,
    }, { context: {}, messages: [], toolCallId: 'trade-test' });

    expect(calls).toEqual([{ season: 2025, seasonType: 'REG', throughWeek: 18 }]);
    expect(result).toMatchObject({ analysisSeason: 2025, throughWeek: 18 });
  });

  it('rejects duplicate players and packages from different opposing rosters', async () => {
    const give = player('give', 'Give Receiver', 'WR');
    const receive = player('receive', 'Receive Runner', 'RB');
    const secondReceive = player('receive-two', 'Second Runner', 'RB');
    const sleeper = {
      getLeague: async () => league(),
      getLeagueRosters: async () => [
        roster(),
        { league_id: 'league-1', players: ['receive'], roster_id: 8, settings: {} },
        { league_id: 'league-1', players: ['receive-two'], roster_id: 9, settings: {} },
      ],
      getNflState: async () => ({
        leg: 4,
        previous_season: '2025',
        season: '2026',
        season_type: 'regular',
        week: 4,
      }),
      getPlayers: async () => ({
        give,
        receive,
        'receive-two': secondReceive,
      }),
    } as unknown as SleeperClient;
    const nflverse = {
      getPlayerWeeklyStats: async () => [
        stat('Give Receiver', 'give', 1, { receivingYards: 100 }),
        stat('Receive Runner', 'receive', 1, { rushingYards: 100 }),
        stat('Second Runner', 'receive-two', 1, { rushingYards: 100 }),
      ],
    } as unknown as NflverseClient;
    const execute = createTradeTools(sleeper, nflverse).analyzeTradeImpact.execute;
    if (!execute) throw new Error('The trade tool execute function is missing.');
    const context = { context: {}, messages: [], toolCallId: 'trade-validation-test' };

    await expect(execute({
      givePlayerNames: ['Give Receiver'],
      leagueId: '123456789012345678',
      receivePlayerNames: ['Receive Runner', 'Receive Runner'],
      rosterId: 4,
    }, context)).rejects.toThrow('receive side must appear only once');

    await expect(execute({
      givePlayerNames: ['Give Receiver'],
      leagueId: '123456789012345678',
      receivePlayerNames: ['Receive Runner', 'Second Runner'],
      rosterId: 4,
    }, context)).rejects.toThrow('same opposing roster');
  });
});

function league(): SleeperLeague {
  return {
    league_id: 'league-1',
    name: 'Home League',
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'FLEX', 'BN'],
    scoring_settings: {
      rec: 1,
      rec_yd: 0.1,
      rush_yd: 0.1,
    },
    season: '2026',
    season_type: 'regular',
    settings: {},
    sport: 'nfl',
    status: 'in_season',
    total_rosters: 12,
  };
}

function roster(): SleeperRoster {
  return {
    league_id: 'league-1',
    players: ['give', 'quarterback', 'depth-runner'],
    roster_id: 4,
    settings: {},
  };
}

function player(
  playerId: string,
  fullName: string,
  position: string,
): SleeperPlayer {
  return {
    full_name: fullName,
    injury_status: null,
    player_id: playerId,
    position,
    team: 'SEA',
  };
}

function stat(
  playerDisplayName: string,
  playerId: string,
  week: number,
  overrides: Partial<NflversePlayerWeek>,
): NflversePlayerWeek {
  return {
    airYardsShare: 0.2,
    attempts: 0,
    carries: 0,
    completions: 0,
    fantasyPoints: 0,
    fantasyPointsPpr: 0,
    gameId: `${playerId}-${week}`,
    interceptions: 0,
    opponentTeam: 'LAR',
    passingTouchdowns: 0,
    passingYards: 0,
    playerDisplayName,
    playerId,
    position: playerDisplayName.includes('Receiver') ? 'WR' : 'RB',
    receivingAirYards: 0,
    receivingTouchdowns: 0,
    receivingYards: 0,
    receptions: 0,
    rushingTouchdowns: 0,
    rushingYards: 0,
    season: 2026,
    seasonType: 'REG',
    targetShare: 0.2,
    targets: 0,
    team: 'SEA',
    week,
    ...overrides,
  };
}
