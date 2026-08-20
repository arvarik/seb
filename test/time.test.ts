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
