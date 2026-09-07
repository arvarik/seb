import { describe, expect, it } from 'vitest';
import { DEFAULT_PROJECTION_PARAMETERS, forecastMean, forecastInterval, quantile, rollingResiduals, normalCdf } from '../src/projection/statistics.js';
import { projectPlayer, scorePlayerWeek } from '../src/projection/player-projection.js';
import { compareProjections } from '../src/projection/comparison.js';
import { PPR_SCORING } from '../src/learning/engine.js';
import { stat } from './analysis-fixtures.js';
const input = { analysisSeason: 2025, leagueId: '123', leagueName: 'Test', throughWeek: 3, week: 4,
  rows: [1, 2, 3].map((week) => stat({ week })), scoringSettings: PPR_SCORING };

describe('forecast statistics and safeguards', () => {
  it('weights recent observations without discarding the stable mean', () => {
    expect(forecastMean([10, 10, 10, 30])).toBeGreaterThan(15);
    expect(forecastMean([10, 10, 10, 30])).toBeLessThan(20);
  });
  it('shrinks a small sample toward an explicit position prior', () => {
    expect(forecastMean([30], 10)).toBeCloseTo(35 / 1.5);
    expect(forecastMean([30], null)).toBe(30);
  });
  it.each([{ values: [] }, { values: [NaN] }, { values: [Infinity] }])('rejects invalid observations $values', ({ values }) => {
    expect(() => forecastMean(values)).toThrow();
  });
  it.each([-0.1, 0.9])('rejects out-of-bounds recency weights %s', (recentWeight) => {
    expect(() => forecastMean([1], null, { ...DEFAULT_PROJECTION_PARAMETERS, recentWeight })).toThrow();
  });
  it('uses only previous games for calibration errors', () => {
    expect(rollingResiduals([10, 10, 10, 1000], DEFAULT_PROJECTION_PARAMETERS)).toEqual([990]);
  });
  it('uses a finite-sample residual rank for an 80 percent interval', () => {
    const interval = forecastInterval(10, Array.from({ length: 20 }, (_, i) => i + 1), [10, 10]);
    expect(interval).toMatchObject({ lower: -7, upper: 27, level: 0.8, calibrationSamples: 20 });
  });
  it('labels sparse calibration and preserves negative fantasy outcomes', () => {
    const result = projectPlayer({ ...input, rows: input.rows.map((row) => ({ ...row, rushingYards: -20 })) });
    expect(result.expectedPoints).toBe(-2);
    expect(result.interval.method).toBe('uncalibrated-small-sample');
    expect(result.floor).toBeLessThan(0);
  });
  it('calculates quantiles and symmetric normal probabilities', () => {
    expect(quantile([3, 1, 2, 4], 0.5)).toBe(2.5);
    expect(normalCdf(0)).toBeCloseTo(0.5);
    expect(normalCdf(-2) + normalCdf(2)).toBeCloseTo(1);
  });
  it.each([4, 5])('rejects future training through week %s', (throughWeek) => {
    expect(() => projectPlayer({ ...input, throughWeek })).toThrow('before');
  });
  it('excludes postseason rows and rejects duplicate player weeks', () => {
    expect(projectPlayer({ ...input, rows: [...input.rows, stat({ seasonType: 'POST', rushingYards: 1000 })] }).games).toBe(3);
    expect(() => projectPlayer({ ...input, rows: [...input.rows, stat()] })).toThrow('duplicate');
  });
  it.each(['Injured Reserve', 'NFI', 'PUP', 'Suspended Active'])('blocks unavailable status %s', (injuryStatus) => {
    expect(projectPlayer({ ...input, injuryStatus }).recommendationEligible).toBe(false);
  });
  it('blocks a bye-week recommendation', () => {
    expect(projectPlayer({ ...input, scheduled: false }).recommendationEligible).toBe(false);
  });
  it('calculates tight-end premiums and volume scoring', () => {
    expect(scorePlayerWeek(stat({ position: 'TE', receptions: 5, targets: 8 }), { rec: 1, bonus_rec_te: 0.5, rec_tgt: 0.1 })).toBe(8.3);
    expect(scorePlayerWeek(stat({ attempts: 30, completions: 20 }), { pass_inc: -0.1, pass_cmp: 0.2 })).toBe(3);
  });
  it('flags close choices and refuses mixed leagues or duplicate players', () => {
    const a = projectPlayer(input);
    const b = projectPlayer({ ...input, rows: input.rows.map((row) => ({ ...row, playerId: 'p2', rushingYards: 101 })) });
    expect(compareProjections([a, b]).closeDecision).toBe(true);
    expect(() => compareProjections([a, a])).toThrow('distinct');
    expect(() => compareProjections([a, { ...b, league: { ...b.league, leagueId: 'other' } }])).toThrow('same league');
    expect(compareProjections([a, { ...b, recommendationEligible: false }]).preferredPlayerId).toBeNull();
  });
});

it('requires a legal starter slot for comparisons across positions', () => {
  const rb = projectPlayer(input);
  const qb = projectPlayer({ ...input, rows: input.rows.map((row) => ({ ...row, playerId: 'qb', position: 'QB' })) });
  expect(compareProjections([rb, qb]).preferredPlayerId).toBeNull();
  expect(compareProjections([rb, qb], 'FLEX').recommendationEligible).toBe(false);
  expect(compareProjections([rb, qb], 'SUPER_FLEX').recommendationEligible).toBe(true);
  expect(() => compareProjections([rb, { ...qb, season: 2024 }])).toThrow('same league');
});

it('blocks a starter change after kickoff and excludes observed target-game weather', () => {
  expect(projectPlayer({ ...input, gameStarted: true }).recommendationEligible).toBe(false);
  const historical = projectPlayer({ ...input, weatherRisk: 'high', weatherStatus: 'historical' });
  expect(historical.adjustments.some((adjustment) => adjustment.label === 'Weather adjustment')).toBe(false);
});

it('withholds a starter recommendation when kickoff or the current team is unknown', () => {
  expect(projectPlayer({ ...input, kickoffKnown: false }).recommendationEligible).toBe(false);
  expect(projectPlayer({ ...input, currentProfileKnown: false }).recommendationEligible).toBe(false);
});
