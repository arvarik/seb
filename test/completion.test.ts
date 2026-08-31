import { execFileSync } from 'node:child_process';

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
    expect(searchInteractiveCommands('token')[0]?.name).toBe('stats');
    expect(searchInteractiveCommands('api usage')[0]?.name).toBe('usage');
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

  it('offers Bash cleanup flags only after a cleanup action', () => {
    const script = generateShellCompletion('bash');

    expect(script).toContain(
      'for word in "${COMP_WORDS[@]:2:COMP_CWORD-2}"',
    );
    expect(script).toContain(
      'if [[ -n "${range}" ]]; then',
    );
    expect(script).toContain(
      'clear) COMPREPLY=( $(compgen -W "--include-unfinished --json --help"',
    );
    expect(script).toContain(
      'prune) COMPREPLY=( $(compgen -W "--retain-days --include-unfinished --json --help"',
    );
    expect(script).not.toContain(
      'today 7d 30d all clear prune --retain-days --include-unfinished',
    );
    expect(script).toContain(
      '--*) COMPREPLY=( $(compgen -W "today 7d 30d all --json --help"',
    );
  });

  it('does not offer a second Bash range or a late cleanup action', () => {
    expect(bashCompletionChoices(['seb', 'usage', '7d', ''])).toEqual([
      '--help',
      '--json',
    ]);
    expect(bashCompletionChoices(['seb', 'stats', '--json', '7d', ''])).toEqual([
      '--help',
      '--json',
    ]);
    expect(bashCompletionChoices(['seb', 'stats', '--json', ''])).toEqual([
      '--help',
      '--json',
      '30d',
      '7d',
      'all',
      'today',
    ]);
    expect(bashCompletionChoices(['seb', 'stats', 'prune', ''])).toEqual([
      '--help',
      '--include-unfinished',
      '--json',
      '--retain-days',
    ]);
  });

  it('uses action-specific Fish conditions for stats cleanup flags', () => {
    const script = generateShellCompletion('fish');

    expect(script).toContain(
      "__fish_seen_subcommand_from stats; and __fish_seen_subcommand_from prune' -l retain-days",
    );
    expect(script).toContain(
      "__fish_seen_subcommand_from stats; and __fish_seen_subcommand_from clear prune' -l include-unfinished",
    );
    expect(script).not.toContain(
      "__fish_seen_subcommand_from stats' -l retain-days",
    );
    expect(script).toContain(
      "test (count (commandline -opc)) -eq 2' -a 'clear prune'",
    );
    expect(script).toContain(
      "clear prune' -a 'today 7d 30d all'",
    );
  });

  it('uses action-specific Zsh arguments for stats cleanup flags', () => {
    const script = generateShellCompletion('zsh');

    expect(script).toContain('case "$words[3]" in');
    expect(script).toContain(
      "today|7d|30d|all) _arguments '--json[Print JSON]' '--help[Show help]'",
    );
    expect(script).toContain(
      "prune) _arguments '--retain-days[Retain recent usage days]:days:'",
    );
    expect(script).toContain(
      "--*) _arguments '1:range:(today 7d 30d all)'",
    );
    expect(script).not.toContain(
      "'1:range or action:(today 7d 30d all clear prune)' '--retain-days",
    );
  });
});

function bashCompletionChoices(words: readonly string[]): string[] {
  const script = generateShellCompletion('bash');
  const command = [
    script,
    `COMP_WORDS=(${words.map(bashQuote).join(' ')})`,
    `COMP_CWORD=${words.length - 1}`,
    '_seb_completion',
    'printf "%s\\n" "${COMPREPLY[@]}"',
  ].join('\n');
  return execFileSync('bash', ['--noprofile', '--norc', '-c', command], {
    encoding: 'utf8',
  }).trim().split('\n').filter(Boolean).sort();
}

function bashQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
