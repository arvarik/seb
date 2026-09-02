import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { TerminalSetupPrompt } from '../src/setup/prompt.js';

describe('TerminalSetupPrompt', () => {
  it('masks a private key and restores the terminal mode', async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    const writes: string[] = [];
    output.on('data', (chunk) => writes.push(String(chunk)));
    Object.defineProperty(input, 'isTTY', { value: true });
    Object.defineProperty(input, 'isRaw', { value: false, writable: true });
    const setRawMode = vi.fn((enabled: boolean) => {
      input.isRaw = enabled;
      return input;
    });
    input.setRawMode = setRawMode;
    const prompt = new TerminalSetupPrompt(input, output);

    const result = prompt.text('OpenAI API key', {
      required: true,
      secret: true,
    });
    input.write('private-key-value\n');

    await expect(result).resolves.toBe('private-key-value');
    expect(writes.join('')).toContain('*****************');
    expect(writes.join('')).not.toContain('private-key-value');
    expect(setRawMode.mock.calls).toEqual([[true], [false]]);
  });
});
