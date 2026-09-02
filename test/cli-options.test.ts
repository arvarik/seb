import { describe, expect, it } from 'vitest';

import {
  CliUsageError,
  parseCliArguments,
} from '../src/cli-options.js';

describe('parseCliArguments', () => {
  it('starts interactive chat when no argument exists', () => {
    expect(parseCliArguments([])).toEqual({ name: 'chat' });
  });

  it('parses a one-shot question and its script options', () => {
    expect(
      parseCliArguments([
        'ask',
        '--json',
        '--no-progress',
        '--model',
        'gemini-test',
        '--provider',
        'google',
        'Analyze',
        'league 123',
      ]),
    ).toEqual({
      name: 'ask',
      json: true,
      model: 'gemini-test',
      provider: 'google',
      progress: false,
      prompt: 'Analyze league 123',
    });
  });

  it('keeps the original direct-question syntax', () => {
    expect(parseCliArguments(['Show', 'the current NFL state.'])).toEqual({
      name: 'ask',
      json: false,
      progress: true,
      prompt: 'Show the current NFL state.',
    });
  });

  it('treats values after the option terminator as prompt text', () => {
    expect(parseCliArguments(['ask', '--', '--compare', 'these rosters'])).toEqual(
      {
        name: 'ask',
        json: false,
        progress: true,
        prompt: '--compare these rosters',
      },
    );
  });

  it('parses offline JSON diagnostics', () => {
    expect(parseCliArguments(['doctor', '--offline', '--json'])).toEqual({
      name: 'doctor',
      json: true,
      offline: true,
    });
  });

  it('shows help after a subcommand', () => {
    expect(parseCliArguments(['ask', '--help'])).toEqual({ name: 'help' });
    expect(parseCliArguments(['doctor', '-h'])).toEqual({ name: 'help' });
    expect(parseCliArguments(['setup', '--help'])).toEqual({ name: 'help' });
    expect(parseCliArguments(['completion', '-h'])).toEqual({ name: 'help' });
  });

  it('accepts an inline model value', () => {
    expect(parseCliArguments([
      'chat',
      '--provider=openai-compatible',
      '--model=local-test',
    ])).toEqual({
      name: 'chat',
      model: 'local-test',
      provider: 'openai-compatible',
    });
  });

  it('parses provider configuration and rejects an unknown provider', () => {
    expect(parseCliArguments(['configure'])).toEqual({ name: 'configure' });
    expect(parseCliArguments(['ask', '-p', 'anthropic', 'Compare players'])).toEqual({
      name: 'ask',
      json: false,
      progress: true,
      prompt: 'Compare players',
      provider: 'anthropic',
    });
    expect(() => parseCliArguments(['chat', '--provider', 'other'])).toThrow(
      '--provider must equal google, anthropic, openai, or openai-compatible.',
    );
    expect(() => parseCliArguments(['configure', 'extra'])).toThrow(
      'configure does not accept more arguments.',
    );
  });

  it('rejects an unknown option', () => {
    expect(() => parseCliArguments(['ask', '--jsoon'])).toThrow(CliUsageError);
  });

  it('requires a model value', () => {
    expect(() => parseCliArguments(['chat', '--model'])).toThrow(
      '--model needs a value.',
    );
  });

  it('parses setup, completion, cache, and snapshot commands', () => {
    expect(parseCliArguments(['setup'])).toEqual({ name: 'setup' });
    expect(parseCliArguments(['setup', 'arvarik'])).toEqual({
      name: 'setup',
      username: 'arvarik',
    });
    expect(() => parseCliArguments(['setup', 'one', 'two'])).toThrow(
      'Use seb setup [SLEEPER_USERNAME].',
    );
    expect(parseCliArguments(['completion', 'zsh'])).toEqual({
      name: 'completion',
      shell: 'zsh',
    });
    expect(parseCliArguments(['cache', 'clear', '--json'])).toEqual({
      name: 'cache',
      action: 'clear',
      json: true,
    });
    expect(() => parseCliArguments(['cache', 'status', 'clear'])).toThrow(
      'Use only one cache action: status, clear, or prune.',
    );
    expect(parseCliArguments([
      'cache', 'prune', '--max-size-mb', '256', '--max-age-days', '90', '--retain', '8',
    ])).toEqual({
      name: 'cache',
      action: 'prune',
      json: false,
      maxBytes: 256 * 1024 * 1024,
      snapshotMaxAgeDays: 90,
      snapshotRetention: 8,
    });
    expect(parseCliArguments([
      'snapshots', '--kind', 'nws-alerts', '--entity', 'SEA', '--limit', '5', '--json',
    ])).toEqual({
      name: 'snapshots',
      kind: 'nws-alerts',
      entityKey: 'SEA',
      limit: 5,
      json: true,
    });
  });

  it('parses and validates a historical replay request', () => {
    expect(parseCliArguments([
      'replay', '--season', '2025', '--through-week', '17', '--position', 'QB,WR', '--output', 'report.json',
    ])).toEqual({
      name: 'replay',
      json: false,
      season: 2025,
      throughWeek: 17,
      positions: ['QB', 'WR'],
      output: 'report.json',
    });
    expect(() => parseCliArguments(['replay', '--season', '2025', '--position', 'DST'])).toThrow(
      '--position accepts QB, RB, WR, TE, and K',
    );
  });

  it('parses local usage and statistics reports', () => {
    expect(parseCliArguments(['usage'])).toEqual({
      name: 'usage',
      json: false,
      scope: 'today',
    });
    expect(parseCliArguments(['stats', '30d', '--json'])).toEqual({
      action: 'report',
      name: 'stats',
      json: true,
      scope: '30d',
    });
    expect(parseCliArguments(['stats'])).toEqual({
      action: 'report',
      name: 'stats',
      json: false,
      scope: '7d',
    });
    expect(parseCliArguments([
      'stats', 'clear', '--include-unfinished', '--json',
    ])).toEqual({
      action: 'clear',
      includeUnfinished: true,
      name: 'stats',
      json: true,
      scope: 'all',
    });
    expect(parseCliArguments([
      'stats', 'prune', '--retain-days', '30', '--include-unfinished',
    ])).toEqual({
      action: 'prune',
      includeUnfinished: true,
      name: 'stats',
      json: false,
      retainDays: 30,
      scope: 'all',
    });
    expect(parseCliArguments(['stats', 'clear'])).toMatchObject({
      includeUnfinished: false,
    });
    expect(parseCliArguments(['stats', 'prune'])).toMatchObject({
      includeUnfinished: false,
    });
    expect(parseCliArguments(['stats', 'clear', '--help'])).toEqual({ name: 'help' });
    expect(parseCliArguments(['stats', 'prune', '-h'])).toEqual({ name: 'help' });
    expect(() => parseCliArguments(['stats', 'prune', '--retain-days', '0'])).toThrow(
      '--retain-days must be an integer from 1 through 36500.',
    );
    expect(() => parseCliArguments(['stats', 'prune', '--retain-days', '36501'])).toThrow(
      '--retain-days must be an integer from 1 through 36500.',
    );
    expect(() => parseCliArguments(['usage', '7d', 'all'])).toThrow(
      'Use only one usage time range.',
    );
    expect(() => parseCliArguments(['stats', 'session'])).toThrow(
      'Use seb stats [today|7d|30d|all] [--json].',
    );
  });
});
