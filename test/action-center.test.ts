import { describe, expect, it } from 'vitest';

import {
  buildFantasyLeagueActionCenter,
} from '../src/sleeper/action-center.js';
import type {
  SleeperLeague,
  SleeperPlayerMap,
  SleeperRoster,
} from '../src/sleeper/types.js';
import {
  createSessionState,
  fantasyAttentionCount,
  formatFantasyDashboard,
} from '../src/interactive/session.js';

describe('fantasy weekly action center', () => {
  it('finds lineup gaps, starter risks, reserve opportunities, and deadlines', () => {
    const actionCenter = buildFantasyLeagueActionCenter({
      league: league(),
      players: players(),
      rosters: [roster()],
      week: 11,
    });

    expect(actionCenter.lineups).toEqual([{
      filledSlots: 3,
      openSlots: 1,
      rosterId: 4,
      starterSlots: 4,
    }]);
    expect(actionCenter.playerStatusSignals).toMatchObject([
      { name: 'Alex Out', starter: true, urgency: 'high' },
      { name: 'Quinn Check', starter: true, urgency: 'medium' },
      { name: 'Ben Reserve', starter: false, urgency: 'high' },
    ]);
    expect(actionCenter.actions.map((action) => action.title)).toEqual([
      '1 open starter slot',
      'Alex Out needs a lineup check',
      'Trade deadline is this week',
      'Ben Reserve could need a reserve move',
      'Quinn Check needs a lineup check',
    ]);
    expect(actionCenter.actions.every((action) => action.nextStep.length > 0)).toBe(true);
  });

  it('keeps the result stable when roster and player order changes', () => {
    const firstRoster = roster();
    const secondRoster: SleeperRoster = {
      ...roster(),
      roster_id: 8,
      players: ['healthy'],
      starters: ['healthy', '0', '0', '0'],
    };
    const first = buildFantasyLeagueActionCenter({
      league: league(),
      players: players(),
      rosters: [secondRoster, firstRoster],
      week: 11,
    });
    const second = buildFantasyLeagueActionCenter({
      league: league(),
      players: players(),
      rosters: [firstRoster, secondRoster],
      week: 11,
    });

    expect(first).toEqual(second);
  });

  it('does not present weekly lineup actions for an inactive league', () => {
    const inactiveLeague = league();
    inactiveLeague.status = 'pre_draft';
    const actionCenter = buildFantasyLeagueActionCenter({
      league: inactiveLeague,
      players: players(),
      rosters: [roster()],
      week: 11,
    });

    expect(actionCenter.lineups).toHaveLength(1);
    expect(actionCenter.playerStatusSignals).toEqual([]);
    expect(actionCenter.actions).toEqual([]);
  });

  it('puts the account action list before league details and limits clutter', () => {
    const session = createSessionState(new Date('2026-10-01T00:00:00Z'));
    const actionCenter = buildFantasyLeagueActionCenter({
      league: league(),
      players: players(),
      rosters: [roster()],
      week: 11,
    });
    session.user = 'seb-user';
    session.accountStatus = 'ready';
    session.week = 11;
    session.leagues = [{
      actionCenter,
      deadlines: ['Trade deadline: end of NFL Week 11'],
      leagueId: 'league-1',
      name: 'Home League',
      rosterIds: [4],
      status: 'in_season',
      warning: null,
    }];

    const dashboard = formatFantasyDashboard(session);

    expect(dashboard.indexOf('### What needs attention')).toBeLessThan(
      dashboard.indexOf('### Account'),
    );
    expect(dashboard).toContain('**NOW** · Home League · Roster 4 · 1 open starter slot');
    expect(dashboard).toContain('Next: Fill every open starter slot');
    expect(dashboard).toContain('Lineup 4: 3/4 starter slots filled');
    expect(dashboard).toContain('Player status alerts: 2 starters, 1 bench or reserve');
    expect(fantasyAttentionCount(session)).toBe(5);
  });
});

function league(): SleeperLeague {
  return {
    league_id: 'league-1',
    name: 'Home League',
    roster_positions: ['QB', 'RB', 'WR', 'FLEX', 'BN', 'IR'],
    scoring_settings: {},
    season: '2026',
    season_type: 'regular',
    settings: {
      playoff_week_start: 15,
      trade_deadline: 11,
      waiver_clear_days: 2,
      waiver_hour: 5,
    },
    sport: 'nfl',
    status: 'in_season',
    total_rosters: 12,
  };
}

function roster(): SleeperRoster {
  return {
    league_id: 'league-1',
    owner_id: 'user-1',
    players: ['healthy', 'bench-out', 'questionable', 'out'],
    reserve: [],
    roster_id: 4,
    settings: {},
    starters: ['healthy', 'out', 'questionable', '0'],
  };
}

function players(): SleeperPlayerMap {
  return {
    'bench-out': {
      full_name: 'Ben Reserve',
      injury_status: 'IR',
      player_id: 'bench-out',
      position: 'RB',
      team: 'SEA',
    },
    healthy: {
      full_name: 'Healthy Player',
      injury_status: null,
      player_id: 'healthy',
      position: 'QB',
      status: 'Active',
      team: 'BAL',
    },
    out: {
      full_name: 'Alex Out',
      injury_status: 'Out',
      player_id: 'out',
      position: 'WR',
      team: 'LAR',
    },
    questionable: {
      full_name: 'Quinn Check',
      injury_status: 'Questionable',
      player_id: 'questionable',
      position: 'WR',
      team: 'GB',
    },
  };
}
