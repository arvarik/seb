import { readFile, stat } from 'node:fs/promises';
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
});
