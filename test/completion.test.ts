import { describe, expect, it } from 'vitest';

import {
  completeInteractiveInput,
  findInteractiveCommand,
  generateShellCompletion,
  interactiveCommandArgumentError,
  INTERACTIVE_COMMANDS,
  parseInteractiveCommandInput,
  searchInteractiveCommands,
} from '../src/interactive/commands.js';

describe('interactive command completion', () => {
  it('keeps command names and aliases unique', () => {
    const names = INTERACTIVE_COMMANDS.flatMap(
      (command) => [command.name, ...(command.aliases ?? [])],
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it('finds commands with prefixes, descriptions, and fuzzy characters', () => {
    expect(searchInteractiveCommands('ref')[0]?.name).toBe('refresh');
    expect(searchInteractiveCommands('token')[0]?.name).toBe('usage');
    expect(searchInteractiveCommands('dctr')[0]?.name).toBe('doctor');
  });

  it('suggests command arguments from metadata and session context', () => {
    expect(completeInteractiveInput('/skill wea')[0]?.value).toBe(
      '/skill weather-watch',
    );
    expect(completeInteractiveInput('/team se')[0]?.value).toBe('/team SEA');
    expect(completeInteractiveInput('/team SEA ')).toEqual([]);
    expect(
      completeInteractiveInput('/league ', { leagueId: '123456' })[0]?.value,
    ).toBe('/league 123456');
    expect(completeInteractiveInput('/league 2', {
      leagueOptions: ['200'],
      leagues: [{ leagueId: '200', name: 'Home League' }],
    })[0]).toMatchObject({
      value: '/league 200',
      description: 'Focus My Fantasy on Home League.',
    });
    expect(completeInteractiveInput('/connect ', { user: 'arvarik' })[0]?.value)
      .toBe('/connect arvarik');
    expect(completeInteractiveInput('/leagues arvarik ', {
      leagueSeason: 2026,
      user: 'arvarik',
    })[0]?.value).toBe('/leagues arvarik 2026');
    expect(completeInteractiveInput('/skill player')[0]).toMatchObject({
      value: '/skill player-info',
      description: expect.stringContaining('Player information'),
    });
    expect(completeInteractiveInput('/export ')).toEqual([]);
    expect(completeInteractiveInput('/export report ')[0]?.value).toBe(
      '/export report md',
    );
  });

  it('closes skill completion after one valid skill or inline question', () => {
    expect(completeInteractiveInput('/skill trade-review')).toEqual([]);
    expect(completeInteractiveInput('/skill trade-review ')).toEqual([]);
    expect(completeInteractiveInput('/skill player-info Lamar Jackson')).toEqual([]);
  });

  it('parses aliases and command arguments through one canonical path', () => {
    expect(parseInteractiveCommandInput('/STATUS extra value')).toMatchObject({
      argumentText: 'extra value',
      arguments: ['extra', 'value'],
      command: expect.objectContaining({ name: 'context' }),
      name: 'status',
    });
    expect(parseInteractiveCommandInput('not a command')).toBeNull();
  });

  it('rejects extra arguments for every bounded command', () => {
    for (const command of INTERACTIVE_COMMANDS) {
      if (command.maxArguments === undefined) continue;
      const extras = Array.from(
        { length: command.maxArguments + 1 },
        (_, index) => `value-${index + 1}`,
      ).join(' ');
      const parsed = parseInteractiveCommandInput(`/${command.name} ${extras}`);
      expect(parsed).not.toBeNull();
      expect(interactiveCommandArgumentError(parsed!)).toBe(`Use ${command.usage}.`);
    }
  });

  it('groups commands and places recent commands first', () => {
    const categories = new Set(INTERACTIVE_COMMANDS.map((command) => command.category));
    const recent = completeInteractiveInput('/', { recentCommands: ['sources'] });

    expect(categories).toEqual(new Set([
      'Essentials',
      'Explore',
      'My Fantasy',
      'Analyze',
      'Advanced',
      'Sources',
      'Conversation',
      'Preferences',
      'Diagnostics',
    ]));
    expect(recent[0]?.value).toBe('/sources');
    expect(searchInteractiveCommands('doctor', 8, ['sources']).map((command) => command.name))
      .not.toContain('sources');
    expect(INTERACTIVE_COMMANDS.find((command) => command.name === 'refresh')?.danger).toBe(true);
    expect(INTERACTIVE_COMMANDS.every((command) => command.preview.length > 0)).toBe(true);
  });

  it('puts common tasks first and preserves earlier command names as aliases', () => {
    expect(completeInteractiveInput('/').map((completion) => completion.value)).toEqual([
      '/explore',
      '/fantasy',
      '/analyze',
      '/connect',
      '/account',
      '/next',
      '/help',
      '/exit',
    ]);
    expect(findInteractiveCommand('/status')?.name).toBe('context');
    expect(findInteractiveCommand('/open')?.name).toBe('source');
    expect(findInteractiveCommand('/cost')?.name).toBe('usage');
    expect(findInteractiveCommand('/suggest')?.name).toBe('next');
    expect(findInteractiveCommand('/save')?.name).toBe('export');
    expect(findInteractiveCommand('/completion')?.name).toBe('shell-completion');
    expect(findInteractiveCommand('/quit')?.name).toBe('exit');
    expect(findInteractiveCommand('/my')?.name).toBe('fantasy');
  });

  it.each(['bash', 'fish', 'zsh'] as const)(
    'generates a %s script for the public CLI commands',
    (shell) => {
      const script = generateShellCompletion(shell);
      expect(script).toContain('seb');
      expect(script).toContain('doctor');
      expect(script).toContain('ask');
    },
  );
});
