import { readFile, stat, writeFile, readdir, truncate, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  FilePromptHistory,
  MemoryPromptHistory,
  promptHistoryPath,
} from '../src/interactive/history.js';

describe('prompt history', () => {
  it('stores recent unique prompts in memory', async () => {
    const history = new MemoryPromptHistory();
    await history.add('first');
    await history.add('second');
    await history.add('first');

    expect(history.list()).toEqual(['first', 'second']);
    await history.clear();
    expect(history.list()).toEqual([]);
  });

  it('saves a private history file', async () => {
    const directory = join(tmpdir(), `seb-history-${crypto.randomUUID()}`);
    const path = join(directory, 'private.json');
    const history = await FilePromptHistory.load({ SEB_HISTORY_FILE: path });
    await history.add('Who should I start?');

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(['Who should I start?']);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('supports custom and disabled history settings', async () => {
    const path = promptHistoryPath({ SEB_CONFIG_HOME: '/tmp/seb-config-test' });
    const history = await FilePromptHistory.load({ SEB_HISTORY: 'false' });

    expect(path).toBe('/tmp/seb-config-test/history.json');
    expect(history).toBeInstanceOf(MemoryPromptHistory);
  });

  it('preserves an invalid history file and keeps the new prompt in memory', async () => {
    const path = join(tmpdir(), `seb-invalid-history-${crypto.randomUUID()}.json`);
    await writeFile(path, '{invalid json', 'utf8');
    const history = await FilePromptHistory.load({ SEB_HISTORY_FILE: path });

    await expect(history.add('Keep this prompt')).rejects.toThrow(/preserved/u);

    expect(await readFile(path, 'utf8')).toBe('{invalid json');
    expect(history.list()).toEqual(['Keep this prompt']);
  });
});

it('persists concurrent history changes in order without temporary file collisions', async () => {
  const directory = join(tmpdir(), `seb-concurrent-history-${crypto.randomUUID()}`);
  const path = join(directory, 'history.json');
  try {
    const history = await FilePromptHistory.load({ SEB_HISTORY_FILE: path });
    await Promise.all([history.add('first'), history.add('second'), history.clear(), history.add('last')]);
    expect(history.list()).toEqual(['last']);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(['last']);
    expect(await readdir(directory)).toEqual(['history.json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('preserves oversized history files and keeps new prompts in memory', async () => {
  const path = join(tmpdir(), `seb-oversized-history-${crypto.randomUUID()}.json`);
  try {
    await writeFile(path, ''); await truncate(path, 21 * 1024 * 1024);
    const history = await FilePromptHistory.load({ SEB_HISTORY_FILE: path });
    await expect(history.add('new prompt')).rejects.toThrow('size limit');
    expect(history.list()).toEqual(['new prompt']);
    expect((await stat(path)).size).toBe(21 * 1024 * 1024);
  } finally { await rm(path, { force: true }); }
});
