import { describe, expect, it } from 'vitest';

import {
  completeInteractiveInput,
  generateShellCompletion,
  INTERACTIVE_COMMANDS,
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
    expect(searchInteractiveCommands('token')[0]?.name).toBe('cost');
    expect(searchInteractiveCommands('dctr')[0]?.name).toBe('doctor');
  });

  it('suggests command arguments from metadata and session context', () => {
    expect(completeInteractiveInput('/skill wea')[0]?.value).toBe(
      '/skill weather-watch',
    );
    expect(completeInteractiveInput('/team se')[0]?.value).toBe('/team SEA');
    expect(
      completeInteractiveInput('/league ', { leagueId: '123456' })[0]?.value,
    ).toBe('/league 123456');
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
