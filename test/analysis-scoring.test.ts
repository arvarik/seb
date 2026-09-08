import { describe, expect, it } from 'vitest';
import { scorePlayerWeek, inspectPlayerScoringSettings } from '../src/projection/player-projection.js';
import { analyzeTradeImpact } from '../src/trades/trade-impact.js';
import type { SleeperPlayer } from '../src/sleeper/types.js';
import { stat, league } from './analysis-fixtures.js';

describe('Sleeper scoring rules', () => {
  it.each([
    { yards: 299, expected: 0 }, { yards: 300, expected: 3 }, { yards: 399, expected: 3 },
    { yards: 400, expected: 6 }, { yards: 500, expected: 6 },
  ])('awards one passing bonus at $yards yards', ({ yards, expected }) => {
    expect(scorePlayerWeek(stat({ passingYards: yards }), { bonus_pass_yd_300: 3, bonus_pass_yd_400: 6 })).toBe(expected);
  });
  it.each([100, 199, 200, 250])('does not stack rushing or receiving yardage tiers at %s yards', (yards) => {
    expect(scorePlayerWeek(stat({ rushingYards: yards, receivingYards: yards }), {
      bonus_rush_yd_100: 3, bonus_rush_yd_200: 6, bonus_rec_yd_100: 3, bonus_rec_yd_200: 6,
    })).toBe(yards < 200 ? 6 : 12);
  });
  it('removes the lower bonus even when the upper bonus has no configured points', () => {
    expect(scorePlayerWeek(stat({ passingYards: 400 }), { bonus_pass_yd_300: 3 })).toBe(0);
  });
  it('counts total fumbles, lost fumbles, and each two-point conversion separately', () => {
    expect(scorePlayerWeek(stat({ fumbles: 2, fumblesLost: 1, passingTwoPointConversions: 1,
      rushingTwoPointConversions: 2, receivingTwoPointConversions: 1 }),
    { fum: -1, fum_lost: -2, pass_2pt: 2, rush_2pt: 2, rec_2pt: 2 })).toBe(4);
  });
  it('separates kicker rules from offensive scoring and keeps unknown rules explicit', () => {
    expect(inspectPlayerScoringSettings({ rec: 1, fgm_0_19: 3, xpm: 1, unsupported: 1 })).toEqual({ usedSettings: ['rec'], ignoredSettings: ['unsupported'] });
    expect(scorePlayerWeek(stat({ specialTeamsTouchdowns: 1, fumbleRecoveryTouchdowns: 1 }), { st_td: 6, fum_rec_td: 6 })).toBe(12);
  });
  it('does not substitute zero for missing scoring components', () => {
    expect(() => scorePlayerWeek(stat({ fumblesLost: null }), { fum_lost: -2 })).toThrow('missing values');
    expect(scorePlayerWeek(stat({ fumblesLost: null }), { rush_yd: 0.1 })).toBe(10);
  });
});

describe('lineup-aware trade value', () => {
  const player = (id: string): SleeperPlayer => ({ player_id: id, full_name: `Runner ${id}`, position: 'RB', team: 'BUF', status: 'Active' });
  const a = player('a'); const b = player('b'); const c = player('c'); const d = player('d');
  const base = {
    league: league({ roster_positions: ['RB', 'BN', 'BN'] }), analysisSeason: 2025, throughWeek: 3,
    roster: { roster_id: 1, league_id: '123456', players: ['a', 'd'], settings: {}, starters: ['a'] },
    rosterPlayers: [a, d], givePlayers: [a], receivePlayers: [b, c],
    rows: [[a, 20], [b, 12], [c, 12], [d, 5]].flatMap(([p, points]) => [1, 2, 3].map((week) =>
      stat({ week, playerId: (p as SleeperPlayer).player_id, playerDisplayName: (p as SleeperPlayer).full_name!, rushingYards: Number(points) * 10 }))),
  };
  it('rejects a bench-heavy package that increases summed value but weakens the starting lineup', () => {
    const result = analyzeTradeImpact(base);
    expect(result.valueDelta).toBe(4);
    expect(result.lineupImpact?.delta).toBe(-8);
    expect(result.verdict).toBe('gives-more-weekly-value');
  });
  it('does not combine earlier seasons or postseason games', () => {
    const result = analyzeTradeImpact({ ...base, rows: [...base.rows,
      stat({ playerId: 'a', playerDisplayName: 'Runner a', season: 2024, rushingYards: 9999 }),
      stat({ playerId: 'a', playerDisplayName: 'Runner a', seasonType: 'POST', rushingYards: 9999 })] });
    expect(result.lineupImpact?.delta).toBe(-8);
  });
  it('rejects ambiguous historical identities and duplicate weeks', () => {
    expect(() => analyzeTradeImpact({ ...base, rows: [...base.rows, { ...base.rows[0]!, playerId: 'another' }] })).toThrow('ambiguous');
    expect(() => analyzeTradeImpact({ ...base, rows: [...base.rows, base.rows[0]!] })).toThrow('Duplicate');
  });
  it('withholds a lineup verdict when a roster identity is missing', () => {
    expect(analyzeTradeImpact({ ...base, rosterPlayers: [a] }).lineupImpact).toBeNull();
  });
});

it.each([NaN, Infinity, '1', true])('rejects malformed scoring weights: %s', (weight) => {
  expect(() => inspectPlayerScoringSettings({ rec: weight })).toThrow('finite number');
  expect(() => scorePlayerWeek(stat(), { rec: weight })).toThrow('finite number');
});
it('rejects score overflow', () => {
  expect(() => scorePlayerWeek(stat(), { rush_yd: Number.MAX_VALUE })).toThrow('must be finite');
});
