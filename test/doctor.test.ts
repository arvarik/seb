import { describe, expect, it, vi } from 'vitest';

import { runWithRequestSignal } from '../src/ai/request-signal.js';
import { formatDoctorReport, runDoctor } from '../src/doctor.js';

describe('runDoctor', () => {
  it('checks local requirements without network requests', async () => {
    const report = await runDoctor({
      environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'test-key' },
      nodeVersion: '22.12.0',
      offline: true,
      verifyPermissions: passingPermissions,
      verifyDatabase: () => ({
        cacheEntries: 0,
        file: '/tmp/seb.sqlite',
        identities: 0,
        identityLinks: 0,
        schemaVersion: 1,
        snapshots: 0,
      }),
    });

    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.status)).toEqual([
      'pass',
      'pass',
      'pass',
      'pass',
      'skip',
      'skip',
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
      verifyPermissions: passingPermissions,
      verifyDatabase: () => ({ cacheEntries: 3, file: '/tmp/seb.sqlite', identities: 4, identityLinks: 7, schemaVersion: 2, snapshots: 2 }),
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
      verifyNflverse: async () => ({ games: 100, latestSeason: 2026 }),
      verifyWeather: async () => ({
        periods: 156,
        timeZone: 'America/Los_Angeles',
      }),
    });

    expect(report.ok).toBe(true);
    expect(formatDoctorReport(report)).toContain(
      '✓ Sleeper API: 2026 regular, week 3.',
    );
    expect(formatDoctorReport(report)).toContain(
      '✓ Gemini API: primary-test answered the test request.',
    );
    expect(formatDoctorReport(report)).toContain(
      '✓ nflverse data: 100 schedule rows loaded through the 2026 season.',
    );
    expect(formatDoctorReport(report)).toContain(
      '✓ National Weather Service API: 156 hourly periods loaded',
    );
  });

  it('reports an old Node.js version and a missing key', async () => {
    const report = await runDoctor({
      environment: {},
      nodeVersion: '20.19.0',
      offline: true,
      verifyPermissions: passingPermissions,
      verifyDatabase: () => ({ cacheEntries: 0, file: '/tmp/seb.sqlite', identities: 0, identityLinks: 0, schemaVersion: 2, snapshots: 0 }),
    });

    expect(report.ok).toBe(false);
    expect(report.checks.filter((check) => check.status === 'fail')).toHaveLength(
      2,
    );
  });

  it('preserves caller cancellation after the live checks finish', async () => {
    const controller = new AbortController();
    const reason = new DOMException('The user stopped the doctor.', 'AbortError');
    let geminiSignal: AbortSignal | undefined;
    let markGeminiStarted!: () => void;
    const geminiStarted = new Promise<void>((resolve) => {
      markGeminiStarted = resolve;
    });
    const pending = runWithRequestSignal(controller.signal, () => runDoctor({
      environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'test-key' },
      nodeVersion: '22.12.0',
      offline: false,
      verifyPermissions: passingPermissions,
      verifyDatabase: () => ({
        cacheEntries: 0,
        file: '/tmp/seb.sqlite',
        identities: 0,
        identityLinks: 0,
        schemaVersion: 2,
        snapshots: 0,
      }),
      verifySleeper: async () => ({
        season: '2026',
        seasonType: 'regular',
        week: 3,
      }),
      verifyGemini: async (_apiKey, primaryModel, _fallbackModel, signal) => {
        geminiSignal = signal;
        markGeminiStarted();
        await new Promise<void>((resolve) => {
          controller.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        return { fallbackUsed: false, model: primaryModel };
      },
      verifyNflverse: async () => ({ games: 100, latestSeason: 2026 }),
      verifyWeather: async () => ({
        periods: 156,
        timeZone: 'America/Los_Angeles',
      }),
    }));
    await geminiStarted;

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(geminiSignal).not.toBe(controller.signal);
    expect(geminiSignal?.aborted).toBe(true);
    expect(geminiSignal?.reason).toBe(reason);
  });

  it('limits the Gemini check to 30 seconds', async () => {
    const timeoutController = new AbortController();
    const timeoutReason = new DOMException(
      'The Gemini check timed out.',
      'TimeoutError',
    );
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(timeoutController.signal);
    let geminiSignal: AbortSignal | undefined;
    let markGeminiStarted!: () => void;
    const geminiStarted = new Promise<void>((resolve) => {
      markGeminiStarted = resolve;
    });

    try {
      const pending = runDoctor({
        environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'test-key' },
        nodeVersion: '22.12.0',
        offline: false,
        verifyPermissions: passingPermissions,
        verifyDatabase: () => ({
          cacheEntries: 0,
          file: '/tmp/seb.sqlite',
          identities: 0,
          identityLinks: 0,
          schemaVersion: 2,
          snapshots: 0,
        }),
        verifySleeper: async () => ({
          season: '2026',
          seasonType: 'regular',
          week: 3,
        }),
        verifyGemini: async (_apiKey, _primary, _fallback, signal) => {
          geminiSignal = signal;
          markGeminiStarted();
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          throw signal.reason;
        },
        verifyNflverse: async () => ({ games: 100, latestSeason: 2026 }),
        verifyWeather: async () => ({
          periods: 156,
          timeZone: 'America/Los_Angeles',
        }),
      });
      await geminiStarted;

      timeoutController.abort(timeoutReason);

      const report = await pending;
      const check = report.checks.find(({ name }) => name === 'Gemini API');
      expect(timeoutSpy).toHaveBeenCalledWith(30_000);
      expect(geminiSignal).toBe(timeoutController.signal);
      expect(check).toEqual({
        name: 'Gemini API',
        status: 'fail',
        detail: 'The Gemini check timed out.',
      });
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('reports external service failures without throwing', async () => {
    const report = await runDoctor({
      environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'test-key' },
      nodeVersion: '22.12.0',
      offline: false,
      verifyPermissions: passingPermissions,
      verifyDatabase: () => ({ cacheEntries: 0, file: '/tmp/seb.sqlite', identities: 0, identityLinks: 0, schemaVersion: 2, snapshots: 0 }),
      verifySleeper: async () => {
        throw new Error('Sleeper is unavailable.');
      },
      verifyGemini: async () => {
        throw new Error('The key is invalid.');
      },
      verifyNflverse: async () => {
        throw new Error('nflverse is unavailable.');
      },
      verifyWeather: async () => {
        throw new Error('Weather is unavailable.');
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

  it('fails live checks that return empty source data', async () => {
    const report = await runDoctor({
      environment: {},
      nodeVersion: '22.12.0',
      offline: false,
      verifyPermissions: passingPermissions,
      verifyDatabase: () => ({ cacheEntries: 0, file: '/tmp/seb.sqlite', identities: 0, identityLinks: 0, schemaVersion: 3, snapshots: 0 }),
      verifySleeper: async () => ({ season: '2026', seasonType: 'regular', week: 1 }),
      verifyNflverse: async () => ({ games: 0, latestSeason: Number.NEGATIVE_INFINITY }),
      verifyWeather: async () => ({ periods: 0, timeZone: null }),
    });

    expect(report.ok).toBe(false);
    expect(formatDoctorReport(report)).toContain('nflverse returned no valid schedule rows');
    expect(formatDoctorReport(report)).toContain('returned no hourly periods');
  });
});

function passingPermissions() {
  return {
    name: 'Local file permissions',
    status: 'pass' as const,
    detail: 'Private.',
  };
}
