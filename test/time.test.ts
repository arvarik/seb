import { describe, expect, it } from 'vitest';

import { easternKickoff } from '../src/time.js';

describe('easternKickoff', () => {
  it('converts kickoff times during daylight time', () => {
    expect(easternKickoff('2026-09-10', '20:20')?.toISOString()).toBe(
      '2026-09-11T00:20:00.000Z',
    );
  });

  it('converts kickoff times during standard time', () => {
    expect(easternKickoff('2026-12-10', '20:20')?.toISOString()).toBe(
      '2026-12-11T01:20:00.000Z',
    );
  });

  it('returns null for an incomplete kickoff', () => {
    expect(easternKickoff('2026-09-10', null)).toBeNull();
  });
});

it.each([
  ['2026-02-29', '12:00'], ['2026-02-30', '12:00'], ['2026-13-01', '12:00'],
  ['2026-09-10', '24:00'], ['2026-09-10', '12:60'], ['2026-03-08', '02:30'],
  ['2026-11-01', '01:30'],
])('rejects invalid or ambiguous kickoff %s %s', (date, time) => {
  expect(easternKickoff(date, time)).toBeNull();
});
it('accepts leap days and midnight without shifting the date', () => {
  expect(easternKickoff('2024-02-29', '00:00')?.toISOString()).toBe('2024-02-29T05:00:00.000Z');
});
