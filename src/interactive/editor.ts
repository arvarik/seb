export class PromptEditor {
  private cursorIndex = 0;
  private value = '';

  constructor(initialValue = '') {
    this.set(initialValue);
  }

  cursor(): number {
    return this.cursorIndex;
  }

  deleteForward(): void {
    if (this.cursorIndex >= this.value.length) return;
    const length = codePointLengthAt(this.value, this.cursorIndex);
    this.value = `${this.value.slice(0, this.cursorIndex)}${this.value.slice(this.cursorIndex + length)}`;
  }

  deleteToStart(): void {
    this.value = this.value.slice(this.cursorIndex);
    this.cursorIndex = 0;
  }

  deleteWordBackward(): void {
    if (this.cursorIndex === 0) return;
    const start = previousWordBoundary(this.value, this.cursorIndex);
    this.value = `${this.value.slice(0, start)}${this.value.slice(this.cursorIndex)}`;
    this.cursorIndex = start;
  }

  backspace(): void {
    if (this.cursorIndex === 0) return;
    const start = previousCodePointIndex(this.value, this.cursorIndex);
    this.value = `${this.value.slice(0, start)}${this.value.slice(this.cursorIndex)}`;
    this.cursorIndex = start;
  }

  insert(text: string): void {
    this.value = `${this.value.slice(0, this.cursorIndex)}${text}${this.value.slice(this.cursorIndex)}`;
    this.cursorIndex += text.length;
  }

  moveEnd(): void {
    this.cursorIndex = this.value.length;
  }

  moveHome(): void {
    this.cursorIndex = 0;
  }

  moveLeft(): void {
    this.cursorIndex = previousCodePointIndex(this.value, this.cursorIndex);
  }

  moveRight(): void {
    if (this.cursorIndex >= this.value.length) return;
    this.cursorIndex += codePointLengthAt(this.value, this.cursorIndex);
  }

  moveWordLeft(): void {
    this.cursorIndex = previousWordBoundary(this.value, this.cursorIndex);
  }

  moveWordRight(): void {
    this.cursorIndex = nextWordBoundary(this.value, this.cursorIndex);
  }

  set(value: string): void {
    this.value = value;
    this.cursorIndex = value.length;
  }

  text(): string {
    return this.value;
  }
}

export type TerminalKey =
  | { type: 'character'; value: string }
  | { type: 'paste'; value: string }
  | { type: 'backspace' | 'delete' | 'enter' | 'newline' }
  | { type: 'left' | 'right' | 'word-left' | 'word-right' }
  | { type: 'home' | 'end' | 'up' | 'down' }
  | { type: 'page-up' | 'page-down' }
  | { type: 'ctrl-a' | 'ctrl-c' | 'ctrl-e' | 'ctrl-k' | 'ctrl-l' | 'ctrl-r' | 'ctrl-u' | 'ctrl-w' }
  | { type: 'escape' | 'tab' | 'ignore' };

export class TerminalKeyParser {
  private pending = '';

  parse(chunk: Buffer | string): TerminalKey[] {
    this.pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    const keys: TerminalKey[] = [];
    while (this.pending.length > 0) {
      if (this.pending.startsWith('\x1b[200~')) {
        const end = this.pending.indexOf('\x1b[201~', 6);
        if (end < 0) break;
        keys.push({ type: 'paste', value: this.pending.slice(6, end) });
        this.pending = this.pending.slice(end + 6);
        continue;
      }
      const parsed = parseOne(this.pending);
      if (!parsed) break;
      keys.push(parsed.key);
      this.pending = this.pending.slice(parsed.length);
    }
    return keys;
  }
}

function parseOne(value: string): { key: TerminalKey; length: number } | null {
  const sequences: Array<[string, TerminalKey]> = [
    ['\x1b[1;3D', { type: 'word-left' }],
    ['\x1b[1;3C', { type: 'word-right' }],
    ['\x1b[1;5D', { type: 'word-left' }],
    ['\x1b[1;5C', { type: 'word-right' }],
    ['\x1b[5~', { type: 'page-up' }],
    ['\x1b[6~', { type: 'page-down' }],
    ['\x1b[3~', { type: 'delete' }],
    ['\x1b[H', { type: 'home' }],
    ['\x1b[F', { type: 'end' }],
    ['\x1bOH', { type: 'home' }],
    ['\x1bOF', { type: 'end' }],
    ['\x1b[A', { type: 'up' }],
    ['\x1b[B', { type: 'down' }],
    ['\x1b[C', { type: 'right' }],
    ['\x1b[D', { type: 'left' }],
    ['\x1bb', { type: 'word-left' }],
    ['\x1bf', { type: 'word-right' }],
    ['\x1b\r', { type: 'newline' }],
    ['\x1b\n', { type: 'newline' }],
  ];
  for (const [sequence, key] of sequences) {
    if (value.startsWith(sequence)) return { key, length: sequence.length };
  }
  if (value.startsWith('\x1b[') && !/^\x1b\[[0-9;?]*[ -/]*[@-~]/u.test(value)) {
    return null;
  }
  const unknownEscape = value.match(/^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.)/u)?.[0];
  if (unknownEscape) return { key: { type: 'ignore' }, length: unknownEscape.length };
  const controls: Record<string, TerminalKey> = {
    '\u0001': { type: 'ctrl-a' },
    '\u0003': { type: 'ctrl-c' },
    '\u0005': { type: 'ctrl-e' },
    '\u000b': { type: 'ctrl-k' },
    '\u000c': { type: 'ctrl-l' },
    '\u0012': { type: 'ctrl-r' },
    '\u0015': { type: 'ctrl-u' },
    '\u0017': { type: 'ctrl-w' },
    '\u0008': { type: 'backspace' },
    '\u007f': { type: 'backspace' },
    '\r': { type: 'enter' },
    '\n': { type: 'enter' },
    '\t': { type: 'tab' },
    '\x1b': { type: 'escape' },
  };
  const control = controls[value[0] ?? ''];
  if (control) return { key: control, length: 1 };
  const [character] = [...value];
  if (!character) return null;
  return {
    key: character >= ' ' ? { type: 'character', value: character } : { type: 'ignore' },
    length: character.length,
  };
}

function previousCodePointIndex(value: string, index: number): number {
  if (index <= 0) return 0;
  const point = value.codePointAt(index - 1);
  return point !== undefined && point >= 0xdc00 && point <= 0xdfff
    ? Math.max(0, index - 2)
    : index - 1;
}

function codePointLengthAt(value: string, index: number): number {
  const point = value.codePointAt(index);
  return point !== undefined && point > 0xffff ? 2 : 1;
}

function previousWordBoundary(value: string, index: number): number {
  let cursor = index;
  while (cursor > 0 && /\s/u.test(value[previousCodePointIndex(value, cursor)] ?? '')) {
    cursor = previousCodePointIndex(value, cursor);
  }
  while (cursor > 0 && !/\s/u.test(value[previousCodePointIndex(value, cursor)] ?? '')) {
    cursor = previousCodePointIndex(value, cursor);
  }
  return cursor;
}

function nextWordBoundary(value: string, index: number): number {
  let cursor = index;
  while (cursor < value.length && !/\s/u.test(value[cursor] ?? '')) {
    cursor += codePointLengthAt(value, cursor);
  }
  while (cursor < value.length && /\s/u.test(value[cursor] ?? '')) {
    cursor += codePointLengthAt(value, cursor);
  }
  return cursor;
}
