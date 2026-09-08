import { describe, expect, it } from 'vitest';
import { sanitizeTerminalText, TerminalTextSanitizer } from '../src/terminal-text.js';

describe('untrusted terminal text', () => {
  it.each([
    '\x1b[2J', '\x1b]52;c;Y2xpcGJvYXJk\x07', '\x1b]8;;https://example.com\x1b\\',
    '\x1bPprivate data\x1b\\', '\x9d52;c;Y2xpcGJvYXJk\x9c', '\x9b31m', '\x1b(B',
  ])('removes commands at every chunk boundary: %j', (command) => {
    const input = `before${command}after`;
    for (let split = 0; split <= input.length; split += 1) {
      const sanitizer = new TerminalTextSanitizer();
      expect(sanitizer.push(input.slice(0, split)) + sanitizer.push(input.slice(split))).toBe('beforeafter');
    }
  });
  it('retains Unicode and readable whitespace while dropping control characters', () => {
    expect(sanitizeTerminalText('🏈 café\tteam\r\x00\x08\nnext')).toBe('🏈 café    team\nnext');
  });
  it('discards an unfinished command without buffering its payload', () => {
    const sanitizer = new TerminalTextSanitizer();
    expect(sanitizer.push('answer\x1b]52;c;')).toBe('answer');
    expect(sanitizer.push('x'.repeat(100_000))).toBe('');
    expect(sanitizer.push('\x07safe')).toBe('safe');
  });
});
