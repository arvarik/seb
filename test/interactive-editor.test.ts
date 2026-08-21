import { describe, expect, it } from 'vitest';

import { PromptEditor, TerminalKeyParser } from '../src/interactive/editor.js';

describe('PromptEditor', () => {
  it('edits at the cursor and moves across words', () => {
    const editor = new PromptEditor('start sit');
    editor.moveWordLeft();
    editor.insert('or ');
    editor.moveHome();
    editor.deleteForward();
    editor.insert('S');

    expect(editor.text()).toBe('Start or sit');
    expect(editor.cursor()).toBe(1);
  });

  it('deletes Unicode code points and prior words', () => {
    const editor = new PromptEditor('hello 🏈 world');
    editor.deleteWordBackward();
    editor.backspace();
    editor.backspace();

    expect(editor.text()).toBe('hello ');
  });
});

describe('TerminalKeyParser', () => {
  it('parses cursor, word, deletion, and multiline keys', () => {
    const parser = new TerminalKeyParser();
    const keys = parser.parse('a\x1b[D\x1b[1;3D\u0017\x1b\r');

    expect(keys).toEqual([
      { type: 'character', value: 'a' },
      { type: 'left' },
      { type: 'word-left' },
      { type: 'ctrl-w' },
      { type: 'newline' },
    ]);
  });

  it('parses the context selector shortcut', () => {
    const parser = new TerminalKeyParser();

    expect(parser.parse('\u0007')).toEqual([{ type: 'ctrl-g' }]);
  });

  it('collects bracketed paste across input chunks', () => {
    const parser = new TerminalKeyParser();

    expect(parser.parse('\x1b[200~first\n')).toEqual([]);
    expect(parser.parse('second\x1b[201~')).toEqual([
      { type: 'paste', value: 'first\nsecond' },
    ]);
  });

  it('ignores an unknown terminal escape sequence', () => {
    const parser = new TerminalKeyParser();

    expect(parser.parse('\x1b[Z')).toEqual([{ type: 'ignore' }]);
  });

  it('parses SGR and legacy mouse-wheel input', () => {
    const parser = new TerminalKeyParser();

    expect(parser.parse('\x1b[<64;12;8M\x1b[<65;12;8M')).toEqual([
      { type: 'scroll-up' },
      { type: 'scroll-down' },
    ]);
    expect(parser.parse('\x1b[M`!!\x1b[Ma!!')).toEqual([
      { type: 'scroll-up' },
      { type: 'scroll-down' },
    ]);
  });

  it('ignores mouse-wheel releases and horizontal trackpad events', () => {
    const parser = new TerminalKeyParser();

    expect(parser.parse(
      '\x1b[<64;12;8m\x1b[<65;12;8m\x1b[<66;12;8M\x1b[<67;12;8M',
    )).toEqual([
      { type: 'ignore' },
      { type: 'ignore' },
      { type: 'ignore' },
      { type: 'ignore' },
    ]);
  });

  it('parses left-button press, drag, and release coordinates', () => {
    const parser = new TerminalKeyParser();

    expect(parser.parse(
      '\x1b[<0;12;8M\x1b[<32;20;10M\x1b[<0;20;10m',
    )).toEqual([
      { type: 'mouse', action: 'press', column: 12, row: 8 },
      { type: 'mouse', action: 'drag', column: 20, row: 10 },
      { type: 'mouse', action: 'release', column: 20, row: 10 },
    ]);
  });

  it('ignores non-primary mouse buttons and motion without a pressed button', () => {
    const parser = new TerminalKeyParser();

    expect(parser.parse(
      '\x1b[<1;12;8M\x1b[<35;20;10M\x1b[<1;20;10m',
    )).toEqual([
      { type: 'ignore' },
      { type: 'ignore' },
      { type: 'ignore' },
    ]);
  });

  it('collects an incomplete legacy mouse event across chunks', () => {
    const parser = new TerminalKeyParser();

    expect(parser.parse('\x1b[M`')).toEqual([]);
    expect(parser.parse('!!')).toEqual([{ type: 'scroll-up' }]);
  });

  it('collects an incomplete SGR mouse event across chunks', () => {
    const parser = new TerminalKeyParser();

    expect(parser.parse('\x1b[<64;12;')).toEqual([]);
    expect(parser.parse('8M')).toEqual([{ type: 'scroll-up' }]);
  });
});
