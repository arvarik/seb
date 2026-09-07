import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ stream: vi.fn(), generate: vi.fn(), format: vi.fn(), models: [] as string[], cleanup: undefined as (() => void) | undefined }));
vi.mock('../src/agent.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/agent.js')>(),
  createFantasyFootballAgent: (options: { modelProvider: { model: string } }) => {
    mocks.models.push(options.modelProvider.model);
    return { stream: mocks.stream, generate: mocks.generate };
  },
  createFantasyFootballAnalysisAgent: () => ({ generate: mocks.format }),
}));
vi.mock('../src/ai/model-configuration.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/ai/model-configuration.js')>(),
  loadModelConfiguration: async () => ({ selection: {
    provider: 'google', model: 'primary-test', fallbackModel: 'fallback-test', apiKey: 'test-key',
  } }),
}));
vi.mock('../src/setup/profile.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/setup/profile.js')>(),
  FileSetupProfileStore: class { async load() { return null; } },
}));
vi.mock('../src/setup/wizard.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/setup/wizard.js')>(),
  refreshAutomaticSession: async () => undefined,
}));
vi.mock('../src/data/sqlite-store.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/data/sqlite-store.js')>();
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'seb-execution-test-'));
  const database = new original.SebDatabase(join(directory, 'cache.sqlite'));
  mocks.cleanup = () => { database.close(); rmSync(directory, { recursive: true, force: true }); };
  return { ...original, getSharedSebDatabase: () => database };
});

import { runCli } from '../src/cli.js';

afterAll(() => mocks.cleanup?.());

beforeEach(() => {
  mocks.stream.mockReset();
  mocks.generate.mockReset();
  mocks.format.mockReset();
  mocks.models.length = 0;
});

function stream(parts: unknown[]) {
  return { fullStream: (async function* () { yield* parts; })() };
}
function output() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, streams: {
    stdin: { async *[Symbol.asyncIterator]() {} },
    stdout: { write: (text: string) => stdout.push(text) },
    stderr: { write: (text: string) => stderr.push(text) },
  } };
}

describe('CLI agent execution', () => {
  it.each(['length', 'content-filter', 'tool-calls', undefined])(
    'rejects incomplete recommendations with finish reason %s', async (finishReason) => {
      mocks.stream.mockResolvedValue(stream([
        { type: 'text-delta', text: 'Start Example Player.' },
        ...(finishReason ? [{ type: 'finish', finishReason }] : []),
      ]));
      const io = output();
      await expect(runCli(['ask', 'Should I start Example Player?'], io.streams, {})).rejects.toThrow('stopped before it completed');
      expect(io.stdout).toEqual([]);
      expect(mocks.models).toEqual(['primary-test']);
    },
  );

  it('rejects an aborted stream instead of printing its buffered recommendation', async () => {
    mocks.stream.mockResolvedValue(stream([
      { type: 'text-delta', text: 'Start Example Player.' }, { type: 'abort' },
    ]));
    const io = output();
    await expect(runCli(['ask', 'Should I start Example Player?'], io.streams, {})).rejects.toThrow('request stopped');
    expect(io.stdout).toEqual([]);
    expect(mocks.models).toEqual(['primary-test']);
  });

  it('rejects truncated JSON research before calling the formatter', async () => {
    mocks.generate.mockResolvedValue({ finishReason: 'length', text: 'Partial research', sources: [] });
    const io = output();
    await expect(runCli(['ask', '--json', 'Compare these players'], io.streams, {})).rejects.toThrow('stopped before it completed');
    expect(mocks.format).not.toHaveBeenCalled();
    expect(io.stdout).toEqual([]);
  });

  it('rejects an incomplete formatter result before publishing JSON', async () => {
    mocks.generate.mockResolvedValue({ finishReason: 'stop', text: 'Complete research', sources: [] });
    mocks.format.mockResolvedValue({ finishReason: 'length' });
    const io = output();
    await expect(runCli(['ask', '--json', 'Show current news'], io.streams, {})).rejects.toThrow('stopped before it completed');
    expect(io.stdout).toEqual([]);
  });

  it('reports truncated ordinary text as a failure without retrying it', async () => {
    mocks.stream.mockResolvedValue(stream([{ type: 'text-delta', text: 'Partial news.' }, { type: 'finish', finishReason: 'length' }]));
    const io = output();
    await expect(runCli(['ask', 'Show current news'], io.streams, {})).rejects.toThrow('stopped before it completed');
    expect(io.stdout.join('')).toBe('Partial news.');
    expect(mocks.models).toEqual(['primary-test']);
  });

  it.each(['123456', '654321'])('uses the tool input to verify league %s in JSON answers', async (leagueId) => {
    mocks.generate.mockResolvedValue({
      finishReason: 'stop', text: 'Use the league scoring settings.',
      sources: [{ sourceType: 'url', id: 'scoring', url: 'https://example.com/scoring' }],
      toolResults: [{ toolName: 'getLeagueOverview', input: { leagueId }, output: { league: { scoring_settings: { rec: 1 } } } }],
      toolCalls: [{ toolName: 'getLeagueOverview' }], usage: {},
    });
    mocks.format.mockResolvedValue({ finishReason: 'stop', usage: {}, output: {
      schemaVersion: 1, kind: 'general', subject: 'Scoring', summary: 'Scoring comparison.',
      recommendation: { action: 'Use these scoring settings.', rationale: 'The league supplies these values.' },
      confidence: { level: 'medium', score: 0.6, rationale: 'Current league data.' },
      metrics: [], strengths: [], weaknesses: [], risks: [], assumptions: [], limitations: [],
    } });
    const io = output();
    await expect(runCli(['ask', '--json', 'Compare league 123456 scoring settings'], io.streams, {})).resolves.toBe(0);
    const answer = JSON.parse(io.stdout.join(''));
    expect(answer.recommendationEligibility.outcome).toBe(leagueId === '123456' ? 'allowed' : 'blocked');
    expect(answer.analysis.recommendation !== null).toBe(leagueId === '123456');
  });

  it('uses fallback once after capacity failure before visible text', async () => {
    mocks.stream.mockResolvedValueOnce(stream([{ type: 'error', error: { statusCode: 503 } }]))
      .mockResolvedValueOnce(stream([{ type: 'text-delta', text: 'Complete answer.' }, { type: 'finish', finishReason: 'stop' }]));
    const io = output();
    await expect(runCli(['ask', 'Show current news'], io.streams, {})).resolves.toBe(0);
    expect(mocks.models).toEqual(['primary-test', 'fallback-test']);
    expect(io.stdout.join('')).toBe('Complete answer.\n');
  });

  it('does not repeat a request after visible output', async () => {
    mocks.stream.mockResolvedValue(stream([{ type: 'text-delta', text: 'Partial answer.' }, { type: 'error', error: { statusCode: 503 } }]));
    const io = output();
    await expect(runCli(['ask', 'Show current news'], io.streams, {})).rejects.toThrow('capacity');
    expect(mocks.models).toEqual(['primary-test']);
  });
});
