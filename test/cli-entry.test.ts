import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { SEB_VERSION } from '../src/version.js';

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
    expect(result.stdout).toBe(`seb ${SEB_VERSION}\n`);
  });

  it('returns the usage exit code for an empty one-shot request', () => {
    const result = runSeb('ask');

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Add a question');
  });

  it('requires a terminal for the masked configuration flow', () => {
    const result = runSeb('configure');

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'Model configuration needs a terminal because Seb masks private keys.',
    );
    expect(result.stderr).not.toContain('API_KEY=');
  });

  it('prints a shell completion script without credentials', () => {
    const result = runSeb('completion', 'zsh');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('#compdef seb');
    expect(result.stdout).toContain('replay:Measure historical baseline accuracy');
    expect(result.stderr).toBe('');
  });

  // Four cold Node.js starts share this test's budget on slower CI machines.
  it('runs usage, stats, prune, and clear through the packaged entry point', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'seb-cli-usage-'));
    try {
      const usage = runSebIn(directory, 'usage', '--json');
      expect(usage.status).toBe(0);
      expect(JSON.parse(usage.stdout)).toMatchObject({
        schemaVersion: 1,
        source: 'seb-local-telemetry',
      });

      const stats = runSebIn(directory, 'stats', 'all', '--json');
      expect(stats.status).toBe(0);
      expect(JSON.parse(stats.stdout)).toMatchObject({
        runs: { total: 0 },
        schemaVersion: 1,
        source: 'seb-local-telemetry',
      });

      const prune = runSebIn(
        directory,
        'stats',
        'prune',
        '--retain-days',
        '30',
        '--json',
      );
      expect(prune.status).toBe(0);
      expect(JSON.parse(prune.stdout)).toMatchObject({
        removed: 0,
        retainDays: 30,
        unfinishedPreserved: 0,
      });

      const clear = runSebIn(directory, 'stats', 'clear', '--json');
      expect(clear.status).toBe(0);
      expect(JSON.parse(clear.stdout)).toEqual({
        removed: 0,
        unfinishedPreserved: 0,
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }, 45_000);
});

function runSeb(...arguments_: string[]) {
  return runSebIn(projectDirectory, ...arguments_);
}

function runSebIn(directory: string, ...arguments_: string[]) {
  return spawnSync(process.execPath, [resolve(projectDirectory, 'bin/seb.mjs'), ...arguments_], {
    cwd: directory,
    encoding: 'utf8',
    input: '',
    timeout: 10_000,
  });
}
