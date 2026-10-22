import { describe, expect, it } from 'vitest';
import { formatFantasyAnalysis, type FantasyAnalysis } from '../src/analysis/output.js';

describe('formatFantasyAnalysis formatting', () => {
  it('collapses multiline bullet items and rounds non-integer float metric values', () => {
    const analysis: FantasyAnalysis = {
      schemaVersion: 1,
      kind: 'player',
      subject: 'Example Player',
      summary: 'Summary line.',
      recommendation: null,
      confidence: {
        level: 'medium',
        score: 0.72,
        rationale: 'Grounded in recent usage.',
      },
      metrics: [
        { name: 'Target share', value: 24.56789, unit: '%', context: 'Weeks 1-4' },
        { name: 'Games played', value: 4, unit: null, context: null },
        { name: 'Role tier', value: 'WR1', unit: null, context: 'Depth chart' },
      ],
      strengths: ['First line\n  second line\tthird'],
      weaknesses: [],
      risks: ['Risk A\r\nRisk B'],
      assumptions: [],
      limitations: [],
    };

    const formatted = formatFantasyAnalysis(analysis);
    expect(formatted).toContain('| Target share | 24.57 % | Weeks 1-4 |');
    expect(formatted).toContain('| Games played | 4 |  |');
    expect(formatted).toContain('| Role tier | WR1 | Depth chart |');
    expect(formatted).toContain('- First line second line third');
    expect(formatted).toContain('- Risk A Risk B');
  });
});
