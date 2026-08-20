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
        'Analyze',
        'league 123',
      ]),
    ).toEqual({
      name: 'ask',
      json: true,
      model: 'gemini-test',
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
  });

  it('accepts an inline model value', () => {
    expect(parseCliArguments(['chat', '--model=gemini-test'])).toEqual({
      name: 'chat',
      model: 'gemini-test',
    });
  });

  it('rejects an unknown option', () => {
    expect(() => parseCliArguments(['ask', '--jsoon'])).toThrow(CliUsageError);
  });

  it('requires a model value', () => {
    expect(() => parseCliArguments(['chat', '--model'])).toThrow(
      '--model needs a value.',
    );
  });
});
