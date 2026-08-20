import { describe, expect, it } from 'vitest';

import { formatDoctorReport, runDoctor } from '../src/doctor.js';

describe('runDoctor', () => {
  it('checks local requirements without network requests', async () => {
    const report = await runDoctor({
      environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'test-key' },
      nodeVersion: '22.12.0',
      offline: true,
    });

    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.status)).toEqual([
      'pass',
      'pass',
      'skip',
      'skip',
    ]);
  });

  it('checks Sleeper and Gemini with injected test services', async () => {
    const report = await runDoctor({
      environment: {
        GOOGLE_GENERATIVE_AI_API_KEY: 'test-key',
        GEMINI_MODEL: 'primary-test',
        GEMINI_FALLBACK_MODEL: 'fallback-test',
      },
      nodeVersion: '26.0.0',
      offline: false,
      verifySleeper: async () => ({
        season: '2026',
        seasonType: 'regular',
        week: 3,
      }),
      verifyGemini: async (apiKey, primaryModel, fallbackModel) => {
        expect(apiKey).toBe('test-key');
        expect(primaryModel).toBe('primary-test');
        expect(fallbackModel).toBe('fallback-test');
        return { fallbackUsed: false, model: primaryModel };
      },
    });

    expect(report.ok).toBe(true);
    expect(formatDoctorReport(report)).toContain(
      '✓ Sleeper API: 2026 regular, week 3.',
    );
    expect(formatDoctorReport(report)).toContain(
      '✓ Gemini API: primary-test answered the test request.',
    );
  });

  it('reports an old Node.js version and a missing key', async () => {
    const report = await runDoctor({
      environment: {},
      nodeVersion: '20.19.0',
      offline: true,
    });

    expect(report.ok).toBe(false);
    expect(report.checks.filter((check) => check.status === 'fail')).toHaveLength(
      2,
    );
  });

  it('reports external service failures without throwing', async () => {
    const report = await runDoctor({
      environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'test-key' },
      nodeVersion: '22.12.0',
      offline: false,
      verifySleeper: async () => {
        throw new Error('Sleeper is unavailable.');
      },
      verifyGemini: async () => {
        throw new Error('The key is invalid.');
      },
    });

    expect(report.ok).toBe(false);
    expect(formatDoctorReport(report)).toContain(
      '✗ Sleeper API: Sleeper is unavailable.',
    );
    expect(formatDoctorReport(report)).toContain(
      '✗ Gemini API: The key is invalid.',
    );
  });
});
