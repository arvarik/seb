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

  it('calculates offensive lineup impact when the league also has an IDP starter', () => {
    const give = player('give', 'Give Receiver', 'WR');
    const receive = player('receive', 'Receive Receiver', 'WR');
    const settings = { ...league(), roster_positions: ['WR', 'IDP', 'BN'] };
    const result = analyzeTradeImpact({ analysisSeason: 2026, givePlayers: [give], receivePlayers: [receive],
      league: settings, roster: { ...roster(), players: ['give'] }, rosterPlayers: [give], throughWeek: 3,
      rows: [1, 2, 3].flatMap((week) => [stat('Give Receiver', 'give', week, { receivingYards: 50 }),
        stat('Receive Receiver', 'receive', week, { receivingYards: 100 })]),
    });
    expect(result.lineupImpact).toMatchObject({ scope: 'offensive-starters', before: { complete: true }, after: { complete: true } });
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

  it('resolves trade players by numeric player ID', async () => {
    const give = player('650', 'Nick Folk', 'WR');
    const receive = player('4034', 'Christian McCaffrey', 'RB');
    const sleeper = {
      getLeague: async () => league(),
      getLeagueRosters: async () => [
        { league_id: 'league-1', players: ['650'], roster_id: 4, settings: {} },
        { league_id: 'league-1', players: ['4034'], roster_id: 8, settings: {} },
      ],
      getNflState: async () => ({ season: '2026', season_type: 'regular', week: 4, leg: 4 }),
      getPlayers: async () => ({ '650': give, '4034': receive }),
    } as unknown as SleeperClient;
    const nflverse = {
      getPlayerWeeklyStats: async () => [
        stat('Nick Folk', '650', 1, { position: 'WR', receivingYards: 50 }),
        stat('Christian McCaffrey', '4034', 1, { position: 'RB', rushingYards: 100 }),
      ],
    } as unknown as NflverseClient;
    const execute = createTradeTools(sleeper, nflverse).analyzeTradeImpact.execute;
    const result = await execute?.({
      givePlayerNames: ['650'],
      leagueId: '123456789012345678',
      receivePlayerNames: ['4034'],
      rosterId: 4,
    }, { context: {}, messages: [], toolCallId: 'test-id' });

    expect(result).toMatchObject({
      give: { players: [expect.objectContaining({ playerId: '650', name: 'Nick Folk' })] },
      receive: { players: [expect.objectContaining({ playerId: '4034', name: 'Christian McCaffrey' })] },
    });
  });

  it('retains all weeks of stats when a traded player played on multiple teams in the same season', () => {
    const give = player('traded-player', 'Traded Receiver', 'WR');
    give.team = 'BUF';
    const receive = player('receive', 'Receive Runner', 'RB');
    const result = analyzeTradeImpact({
      analysisSeason: 2026,
      givePlayers: [give],
      league: league(),
      receivePlayers: [receive],
      roster: roster(),
      rosterPlayers: [give],
      rows: [
        stat('Traded Receiver', 'other-person-id', 1, { position: 'WR', receivingYards: 20, team: 'KC' }),
        stat('Traded Receiver', 'player-trade-id', 1, { position: 'WR', receivingYards: 50, team: 'TEN' }),
        stat('Traded Receiver', 'player-trade-id', 2, { position: 'WR', receivingYards: 70, team: 'BUF' }),
        stat('Receive Runner', 'receive', 1, { position: 'RB', rushingYards: 80 }),
      ],
      throughWeek: 2,
    });

    const giveImpact = result.give.players.find((p) => p.playerId === 'traded-player');
    expect(giveImpact).toBeDefined();
    expect(giveImpact?.games).toBe(2);
  });

  it('notes uneven roster count trade limitations and disambiguates multi-team player stats', () => {
    const give1 = player('give-1', 'Shared Receiver', 'WR');
    give1.team = 'SEA';
    const give2 = player('give-2', 'Give Two Receiver', 'WR');
    const receive = player('receive', 'Receive Runner', 'RB');
    const result = analyzeTradeImpact({
      analysisSeason: 2026,
      givePlayers: [give1, give2],
      league: league(),
      receivePlayers: [receive],
      roster: roster(),
      rosterPlayers: [give1, give2],
      rows: [
        stat('Shared Receiver', 'other-id', 1, { position: 'WR', receivingYards: 10, team: 'KC' }),
        stat('Shared Receiver', 'sea-id', 1, { position: 'WR', receivingYards: 60, team: 'SEA' }),
        stat('Give Two Receiver', 'give-2', 1, { position: 'WR', receivingYards: 40 }),
        stat('Receive Runner', 'receive', 1, { position: 'RB', rushingYards: 80 }),
      ],
      throughWeek: 1,
    });

    expect(result.limitations).toContainEqual(
      expect.stringContaining('Uneven trade (2 for 1)'),
    );
    expect(result.give.players).toHaveLength(2);
  });

  it('isolates ambiguous bench players with a limitation note, refuses lineup verdicts when a starter lacks stats, uses order-independent priors, and uses Bessel correction', () => {
    const giveQb = player('give-qb', 'Starter Quarterback', 'QB');
    const secondQb = player('second-qb', 'Second Quarterback', 'QB');
    const receiveQb = player('receive-qb', 'Upgrade Quarterback', 'QB');
    const flexWr = player('flex-wr', 'Flex Receiver', 'WR');
    const dualPlayer: SleeperPlayer = {
      ...player('dual-wr', 'Dual Weapon', 'WR'),
      fantasy_positions: ['WR', 'RB'],
    };
    const ambiguousBench = player('ambig-bench', 'Ambiguous Bench', 'WR');
    ambiguousBench.team = 'NYJ';

    const peerRows = Array.from({ length: 20 }, (_, idx) =>
      stat(`Peer QB ${idx}`, `peer-qb-${idx}`, (idx % 3) + 1, {
        passingYards: 200,
        position: 'QB',
      }),
    );

    const baseRows = [
      ...peerRows,
      stat('Starter Quarterback', 'give-qb', 1, { passingYards: 200, position: 'QB' }),
      stat('Starter Quarterback', 'give-qb', 2, { passingYards: 300, position: 'QB' }),
      stat('Second Quarterback', 'second-qb', 1, { passingYards: 400, position: 'QB' }),
      stat('Second Quarterback', 'second-qb', 2, { passingYards: 450, position: 'QB' }),
      stat('Upgrade Quarterback', 'receive-qb', 1, { passingYards: 300, position: 'QB' }),
      stat('Upgrade Quarterback', 'receive-qb', 2, { passingYards: 350, position: 'QB' }),
      stat('Flex Receiver', 'flex-wr', 1, { receivingYards: 80, position: 'WR' }),
      stat('Flex Receiver', 'flex-wr', 2, { receivingYards: 90, position: 'WR' }),
      stat('Dual Weapon', 'dual-wr', 1, { receivingYards: 90, position: 'WR' }),
      stat('Dual Weapon', 'dual-wr', 2, { receivingYards: 110, position: 'WR' }),
      stat('Ambiguous Bench', 'ambig-1', 1, { receivingYards: 30, position: 'WR', team: 'KC' }),
      stat('Ambiguous Bench', 'ambig-2', 1, { receivingYards: 40, position: 'WR', team: 'BUF' }),
    ];

    const result = analyzeTradeImpact({
      analysisSeason: 2026,
      givePlayers: [giveQb, secondQb],
      league: {
        ...league(),
        roster_positions: ['QB', 'SUPER_FLEX', 'RB', 'BN'],
        scoring_settings: { pass_yd: 0.04, rec_yd: 0.1, rush_yd: 0.1 },
      },
      receivePlayers: [receiveQb],
      roster: {
        ...roster(),
        players: ['give-qb', 'second-qb', 'flex-wr', 'dual-wr', 'ambig-bench'],
        starters: ['give-qb', 'flex-wr', 'dual-wr'],
      },
      rosterPlayers: [giveQb, secondQb, flexWr, dualPlayer, ambiguousBench],
      rows: baseRows,
      throughWeek: 3,
    });

    const reversedOrder = analyzeTradeImpact({
      analysisSeason: 2026,
      givePlayers: [secondQb, giveQb],
      league: {
        ...league(),
        roster_positions: ['QB', 'SUPER_FLEX', 'RB', 'BN'],
        scoring_settings: { pass_yd: 0.04, rec_yd: 0.1, rush_yd: 0.1 },
      },
      receivePlayers: [receiveQb],
      roster: {
        ...roster(),
        players: ['give-qb', 'second-qb', 'flex-wr', 'dual-wr', 'ambig-bench'],
        starters: ['give-qb', 'flex-wr', 'dual-wr'],
      },
      rosterPlayers: [giveQb, secondQb, flexWr, dualPlayer, ambiguousBench],
      rows: baseRows,
      throughWeek: 3,
    });

    expect(result.give.totalWeeklyValue).toBe(reversedOrder.give.totalWeeklyValue);
    expect(result.lineupImpact).toMatchObject({
      scope: 'offensive-starters',
      before: { complete: true },
      after: { complete: true },
    });
    expect(result.limitations).toContain(
      'Lineup comparison excluded bench players without resolved historical production: Ambiguous Bench.',
    );
    expect(result.rosterFit).toContainEqual(
      expect.objectContaining({
        minimumStarters: 1,
        position: 'QB',
      }),
    );
    // Scores [8, 12] -> sample std dev with Bessel's correction (n - 1 = 1) is sqrt(8) ≈ 2.83
    expect(result.give.players[0]?.volatility).toBe(2.83);

    // If the ambiguous player is an active starter, refuse to give a lineup verdict
    const withAmbiguousStarter = analyzeTradeImpact({
      analysisSeason: 2026,
      givePlayers: [giveQb],
      league: {
        ...league(),
        roster_positions: ['QB', 'SUPER_FLEX', 'RB', 'BN'],
        scoring_settings: { pass_yd: 0.04, rec_yd: 0.1, rush_yd: 0.1 },
      },
      receivePlayers: [receiveQb],
      roster: {
        ...roster(),
        players: ['give-qb', 'flex-wr', 'dual-wr', 'ambig-bench'],
        starters: ['give-qb', 'ambig-bench', 'dual-wr'],
      },
      rosterPlayers: [giveQb, flexWr, dualPlayer, ambiguousBench],
      rows: baseRows,
      throughWeek: 3,
    });
    expect(withAmbiguousStarter.lineupImpact).toBeNull();
    expect(withAmbiguousStarter.verdict).toBe('insufficient-lineup-data');
  });

  it('narrows duplicate Sleeper player names to the single active player before throwing ambiguity', async () => {
    const giveActive: SleeperPlayer = {
      ...player('active-give', 'Shared Name', 'WR'),
      active: true,
    };
    const giveRetired: SleeperPlayer = {
      ...player('retired-give', 'Shared Name', 'WR'),
      active: false,
    };
    const receive = player('receive', 'Receive Runner', 'RB');
    const sleeper = {
      getLeague: async () => league(),
      getLeagueRosters: async () => [
        { league_id: 'league-1', players: ['active-give'], roster_id: 4, settings: {} },
        { league_id: 'league-1', players: ['receive'], roster_id: 8, settings: {} },
      ],
      getNflState: async () => ({ season: '2026', season_type: 'regular', week: 2, leg: 2 }),
      getPlayers: async () => ({
        'active-give': giveActive,
        'retired-give': giveRetired,
        receive,
      }),
    } as unknown as SleeperClient;
    const nflverse = {
      getPlayerWeeklyStats: async () => [
        stat('Shared Name', 'active-give', 1, { position: 'WR', receivingYards: 80 }),
        stat('Receive Runner', 'receive', 1, { position: 'RB', rushingYards: 90 }),
      ],
    } as unknown as NflverseClient;
    const execute = createTradeTools(sleeper, nflverse).analyzeTradeImpact.execute;
    const result = await execute?.({
      givePlayerNames: ['Shared Name'],
      leagueId: '123456789012345678',
      receivePlayerNames: ['Receive Runner'],
      rosterId: 4,
    }, { context: {}, messages: [], toolCallId: 'trade-active-disambiguation' });

    expect(result).toMatchObject({
      give: { players: [expect.objectContaining({ playerId: 'active-give' })] },
    });
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
