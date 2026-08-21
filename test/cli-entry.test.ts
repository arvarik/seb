import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));

describe('Seb executable', () => {
  it('shows help through the packaged entry point', () => {
    const result = runSeb('--help');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Seb reads Sleeper, nflverse, weather, and grounded news',
    );
    expect(result.stdout).toContain('seb ask [OPTIONS] [QUESTION]');
    expect(result.stderr).toBe('');
  });

  it('shows the package version', () => {
    const result = runSeb('--version');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('seb 0.0.9\n');
  });

  it('returns the usage exit code for an empty one-shot request', () => {
    const result = runSeb('ask');

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Add a question');
  });

  it('prints a shell completion script without credentials', () => {
    const result = runSeb('completion', 'zsh');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('#compdef seb');
    expect(result.stdout).toContain('replay:Measure historical baseline accuracy');
    expect(result.stderr).toBe('');
  });
});

function runSeb(...arguments_: string[]) {
  return spawnSync(process.execPath, ['bin/seb.mjs', ...arguments_], {
    cwd: projectDirectory,
    encoding: 'utf8',
    input: '',
    timeout: 10_000,
  });
}
