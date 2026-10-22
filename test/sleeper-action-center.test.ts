import { describe, expect, it } from 'vitest';
import { buildFantasyLeagueActionCenter } from '../src/sleeper/action-center.js';
import type { SleeperPlayerMap, SleeperRoster } from '../src/sleeper/types.js';
import { league } from './analysis-fixtures.js';

describe('action center league rules and statuses', () => {
  const players: SleeperPlayerMap = {
    cov: {
      full_name: 'Covid Reserve',
      injury_status: 'COV',
      player_id: 'cov',
      position: 'WR',
      team: 'KC',
    },
    doubt: {
      full_name: 'Doubtful Bench',
      injury_status: 'Doubtful',
      player_id: 'doubt',
      position: 'RB',
      team: 'BUF',
    },
    ir1: {
      full_name: 'Existing IR',
      injury_status: 'IR',
      player_id: 'ir1',
      position: 'TE',
      team: 'SF',
    },
  };

  it('suppresses lineup and player-status actions in best ball leagues', () => {
    const roster: SleeperRoster = {
      league_id: '123456',
      players: ['cov', 'doubt'],
      reserve: [],
      roster_id: 1,
      settings: {},
      starters: ['cov', '0'],
    };
    const result = buildFantasyLeagueActionCenter({
      league: league({
        roster_positions: ['WR', 'RB', 'IR'],
        settings: { best_ball: 1, trade_deadline: 6 },
      }),
      players,
      rosters: [roster],
      week: 6,
    });

    expect(result.actions.map((action) => action.kind)).toEqual(['deadline']);
  });

  it('enforces reserve capacity and COV status urgency', () => {
    const fullReserveRoster: SleeperRoster = {
      league_id: '123456',
      players: ['cov', 'doubt', 'ir1'],
      reserve: ['ir1'],
      roster_id: 1,
      settings: {},
      starters: [],
    };
    const atCapacity = buildFantasyLeagueActionCenter({
      league: league({
        roster_positions: ['WR', 'BN', 'IR'],
        settings: { reserve_slots: 1 },
      }),
      players,
      rosters: [fullReserveRoster],
      week: 6,
    });
    expect(atCapacity.playerStatusSignals.find((s) => s.playerId === 'cov')?.urgency).toBe('high');
    expect(atCapacity.actions.filter((a) => a.id.includes(':reserve-'))).toEqual([]);

    const openReserveRoster: SleeperRoster = {
      ...fullReserveRoster,
      reserve: [],
      players: ['cov', 'doubt'],
    };
    const openReserve = buildFantasyLeagueActionCenter({
      league: league({
        roster_positions: ['WR', 'BN', 'IR'],
        settings: { reserve_slots: 1 },
      }),
      players,
      rosters: [openReserveRoster],
      week: 6,
    });
    expect(openReserve.actions.filter((a) => a.id.includes(':reserve-')).map((a) => a.id)).toEqual([
      '123456:roster-1:reserve-cov',
      '123456:roster-1:reserve-doubt',
    ]);
  });
});
