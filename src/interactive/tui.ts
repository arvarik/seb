import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ChatTransport, UIMessage } from 'ai';

import type { SessionState } from './session.js';
import {
  completeInteractiveInput,
  type InteractiveCompletion,
} from './commands.js';

const SUPPORTED_TUI_VERSION = '1.0.72';

interface TerminalInputLike {
  isTTY?: boolean;
  off(event: 'data', listener: (chunk: Buffer) => void): TerminalInputLike;
  on(event: 'data', listener: (chunk: Buffer) => void): TerminalInputLike;
  pause(): TerminalInputLike;
  resume(): TerminalInputLike;
  setRawMode?(mode: boolean): TerminalInputLike;
}

interface TerminalOutputLike {
  columns?: number;
  rows?: number;
  off(event: 'resize', listener: () => void): TerminalOutputLike;
  on(event: 'resize', listener: () => void): TerminalOutputLike;
  write(
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean;
}

interface InternalAgentTUIRunner {
  run(): Promise<void>;
}

type InternalAgentTUIRunnerConstructor = new (options: {
  reasoning: 'collapsed';
  responseStatistics: 'outputTokensPerSecond';
  screen: TerminalOutputLike;
  title: string;
  tools: 'auto-collapsed';
  transport: ChatTransport<UIMessage>;
  userInput: TerminalInputLike;
}) => InternalAgentTUIRunner;

export interface SebInteractiveTuiOptions {
  input?: TerminalInputLike;
  output?: TerminalOutputLike;
  session: SessionState;
  title: string;
  transport: ChatTransport<UIMessage>;
}

export class SlashCommandPalette {
  private dismissed = false;
  private input = '';
  private selectedIndex = 0;

  constructor(private readonly context: SessionState) {}

  accept(): string | null {
    return this.suggestions()[this.selectedIndex]?.value ?? null;
  }

  dismiss(): void {
    this.dismissed = true;
  }

  isActive(): boolean {
    return !this.dismissed && this.input.startsWith('/') && this.suggestions().length > 0;
  }

  move(direction: -1 | 1): void {
    const length = this.suggestions().length;
    if (length === 0) return;
    this.selectedIndex = (this.selectedIndex + direction + length) % length;
  }

  reset(): void {
    this.dismissed = false;
    this.input = '';
    this.selectedIndex = 0;
  }

  reservedRows(terminalRows: number): number {
    if (!this.isActive()) return 0;
    const available = Math.max(0, terminalRows - 8);
    return Math.min(available, this.suggestions().length + 1, 9);
  }

  rows(limit: number): Array<InteractiveCompletion & { selected: boolean }> {
    const suggestions = this.suggestions();
    const count = Math.max(0, limit);
    const start = Math.max(0, this.selectedIndex - count + 1);
    return suggestions
      .slice(start, start + count)
      .map((completion, index) => ({
        ...completion,
        selected: start + index === this.selectedIndex,
      }));
  }

  setInput(value: string): void {
    if (value !== this.input) {
      this.dismissed = false;
      this.selectedIndex = 0;
    }
    this.input = value;
  }

  value(): string {
    return this.input;
  }

  private suggestions(): InteractiveCompletion[] {
    return completeInteractiveInput(this.input, this.context, 8);
  }
}

export class SlashCommandInput implements TerminalInputLike {
  readonly isTTY: boolean;
  private readonly listeners = new Set<(chunk: Buffer) => void>();

  constructor(
    private readonly source: TerminalInputLike,
    private readonly palette: SlashCommandPalette,
    private readonly screen: Pick<CompletionScreen, 'repaintPalette'>,
  ) {
    this.isTTY = source.isTTY === true;
    source.on('data', this.readSource);
  }

  off(_event: 'data', listener: (chunk: Buffer) => void): this {
    this.listeners.delete(listener);
    return this;
  }

  on(_event: 'data', listener: (chunk: Buffer) => void): this {
    this.listeners.add(listener);
    return this;
  }

  pause(): this {
    this.source.pause();
    return this;
  }

  resume(): this {
    this.source.resume();
    return this;
  }

  setRawMode(mode: boolean): this {
    this.source.setRawMode?.(mode);
    return this;
  }

  private readonly readSource = (chunk: Buffer): void => {
    for (const value of splitTerminalInput(chunk.toString('utf8'))) {
      this.readValue(value);
    }
  };

  private readValue(value: string): void {
    const chunk = Buffer.from(value);
    if (this.palette.isActive()) {
      if (value === '\x1b[A' || value === '\x1b[Z') {
        this.palette.move(-1);
        this.screen.repaintPalette();
        return;
      }
      if (value === '\x1b[B') {
        this.palette.move(1);
        this.screen.repaintPalette();
        return;
      }
      if (value === '\t' || value === '\x1b[C') {
        this.acceptCompletion();
        return;
      }
      if (value === '\x1b') {
        this.palette.dismiss();
        this.forceRendererRepaint();
        return;
      }
    }

    if (value === '\r' || value === '\n') {
      this.palette.reset();
      this.forceRendererRepaint();
      this.emit(chunk);
      return;
    }
    if (value === '\u0003') {
      this.palette.reset();
      this.emit(chunk);
      return;
    }
    if (value === '\u007f' || value === '\b') {
      this.palette.setInput(this.palette.value().slice(0, -1));
      this.emit(chunk);
      if (!this.palette.isActive()) this.forceRendererRepaint();
      return;
    }
    if (value >= ' ' && value !== '\x7f' && !value.startsWith('\x1b')) {
      this.palette.setInput(`${this.palette.value()}${value}`);
    }
    this.emit(chunk);
  }

  private acceptCompletion(): void {
    const completion = this.palette.accept();
    if (!completion) return;
    const previous = this.palette.value();
    this.palette.reset();
    for (let index = 0; index < previous.length; index += 1) {
      this.emit(Buffer.from('\u007f'));
    }
    this.palette.setInput(completion);
    this.emit(Buffer.from(completion));
  }

  private emit(chunk: Buffer): void {
    for (const listener of this.listeners) listener(chunk);
  }

  private forceRendererRepaint(): void {
    this.emit(Buffer.from('\u000c'));
  }
}

export class CompletionScreen implements TerminalOutputLike {
  constructor(
    private readonly output: TerminalOutputLike,
    private readonly palette: SlashCommandPalette,
  ) {}

  get columns(): number {
    return this.output.columns ?? 80;
  }

  get rows(): number {
    const physicalRows = this.output.rows ?? 24;
    return physicalRows - this.palette.reservedRows(physicalRows);
  }

  off(_event: 'resize', listener: () => void): this {
    this.output.off('resize', listener);
    return this;
  }

  on(_event: 'resize', listener: () => void): this {
    this.output.on('resize', listener);
    return this;
  }

  repaintPalette(): void {
    const overlay = renderPaletteOverlay(
      this.palette,
      this.columns,
      this.output.rows ?? 24,
    );
    if (overlay) this.output.write(overlay);
  }

  write(
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const result = this.output.write(chunk, encodingOrCallback, callback);
    this.repaintPalette();
    return result;
  }
}

export async function runSebInteractiveTui(
  options: SebInteractiveTuiOptions,
): Promise<void> {
  const palette = new SlashCommandPalette(options.session);
  const screen = new CompletionScreen(
    options.output ?? process.stdout,
    palette,
  );
  const input = new SlashCommandInput(
    options.input ?? process.stdin,
    palette,
    screen,
  );
  const AgentTUIRunner = await loadAgentTUIRunner();
  await new AgentTUIRunner({
    transport: options.transport,
    title: `${options.title} · type / for commands`,
    tools: 'auto-collapsed',
    reasoning: 'collapsed',
    responseStatistics: 'outputTokensPerSecond',
    screen,
    userInput: input,
  }).run();
}

export function renderPaletteOverlay(
  palette: SlashCommandPalette,
  columns: number,
  terminalRows: number,
): string {
  const reservedRows = palette.reservedRows(terminalRows);
  if (reservedRows === 0) return '';
  const rows = palette.rows(reservedRows - 1);
  const startRow = terminalRows - reservedRows + 1;
  const updates: string[] = ['\x1b[?2026h', '\x1b[s'];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const marker = row.selected ? '❯' : ' ';
    const available = Math.max(1, columns - 4);
    const value = truncate(`${marker} ${row.value}`, available);
    const descriptionWidth = Math.max(0, columns - value.length - 4);
    const description = descriptionWidth > 8
      ? `  ${truncate(row.description, descriptionWidth)}`
      : '';
    const color = row.selected ? '\x1b[96m' : '\x1b[2m';
    updates.push(
      `\x1b[${startRow + index};1H\x1b[2K${color}${value}${description}\x1b[0m`,
    );
  }
  const hintRow = startRow + rows.length;
  updates.push(
    `\x1b[${hintRow};1H\x1b[2K\x1b[2m  ↑↓ select · Tab/→ fill · Enter run · Esc close\x1b[0m`,
    '\x1b[u',
    '\x1b[?2026l',
  );
  return updates.join('');
}

async function loadAgentTUIRunner(): Promise<InternalAgentTUIRunnerConstructor> {
  const require = createRequire(import.meta.url);
  const packageFile = require.resolve('@ai-sdk/tui/package.json');
  const packageData = require(packageFile) as { version?: string };
  if (packageData.version !== SUPPORTED_TUI_VERSION) {
    throw new Error(
      `Seb command completion supports @ai-sdk/tui ${SUPPORTED_TUI_VERSION}, but version ${packageData.version ?? 'unknown'} is installed.`,
    );
  }
  // The public TUI runner has no prompt-completion hook. The exact dependency
  // pin protects this small input and screen adapter until the SDK adds one.
  const runnerFile = resolve(dirname(packageFile), 'src/agent-tui-runner.ts');
  const module = await import(pathToFileURL(runnerFile).href) as {
    AgentTUIRunner?: InternalAgentTUIRunnerConstructor;
  };
  if (!module.AgentTUIRunner) {
    throw new Error('The installed AI SDK TUI does not expose its internal runner source.');
  }
  return module.AgentTUIRunner;
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function splitTerminalInput(value: string): string[] {
  const result: string[] = [];
  let remaining = value;
  while (remaining.length > 0) {
    const escapeSequence = remaining.match(/^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.)/u)?.[0];
    if (escapeSequence) {
      result.push(escapeSequence);
      remaining = remaining.slice(escapeSequence.length);
      continue;
    }
    const [character] = [...remaining];
    if (!character) break;
    result.push(character);
    remaining = remaining.slice(character.length);
  }
  return result;
}
