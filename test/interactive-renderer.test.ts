import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';
import type { UIMessageChunk } from 'ai';

import { MemoryPromptHistory } from '../src/interactive/history.js';
import type { PromptHistory } from '../src/interactive/history.js';
import { SebTerminalRenderer } from '../src/interactive/renderer.js';
import { createSessionState } from '../src/interactive/session.js';
import { InteractiveUiState } from '../src/interactive/ui-state.js';
import { SourceTracker } from '../src/sources.js';

describe('SebTerminalRenderer prompt input', () => {
  it('supports cursor editing and multiline input', async () => {
    const terminal = createTerminal();
    const renderer = createRenderer(terminal);
    const prompt = renderer.readPrompt();

    terminal.input.type('helo\x1b[D');
    terminal.input.type('l\x1b[C\x1b\rworld\r');

    await expect(prompt).resolves.toBe('hello\nworld');
    expect(terminal.input.rawModes).toContain(true);
  });

  it('recalls history and selects a numbered suggestion', async () => {
    const history = new MemoryPromptHistory(['older prompt']);
    const uiState = new InteractiveUiState();
    uiState.suggestions = ['Compare these players'];
    const terminal = createTerminal();
    const renderer = createRenderer(terminal, history, uiState);
    const recalled = renderer.readPrompt();

    terminal.input.type('\x1b[A\r');
    await expect(recalled).resolves.toBe('older prompt');

    const selected = renderer.readPrompt();
    terminal.input.type('1');
    await expect(selected).resolves.toBe('Compare these players');
  });

  it('opens the command palette and copies the latest answer', async () => {
    const uiState = new InteractiveUiState();
    uiState.latestAnswer = 'Latest answer';
    const terminal = createTerminal();
    const renderer = createRenderer(terminal, new MemoryPromptHistory(), uiState);
    const prompt = renderer.readPrompt();

    terminal.input.type('\u000b');
    expect(terminal.output.text()).toContain('Effect:');
    terminal.input.type('\x1b');
    terminal.input.type('/copy\r');
    expect(terminal.output.text()).toContain(Buffer.from('Latest answer').toString('base64'));
    terminal.input.type('\u0003');
    await expect(prompt).rejects.toThrow('Interrupted');
  });

  it('exits from the shortcut overlay with Ctrl+C', async () => {
    const terminal = createTerminal();
    const renderer = createRenderer(terminal);
    const prompt = renderer.readPrompt();

    terminal.input.type('?\u0003');

    await expect(prompt).rejects.toThrow('Interrupted');
    expect(terminal.input.rawModes.at(-1)).toBe(false);
    expect(terminal.output.text()).toContain('\x1b[?1049l');
  });

  it('continues when the history file cannot accept a prompt', async () => {
    const history: PromptHistory = {
      add: () => Promise.reject(new Error('history is read-only')),
      clear: () => Promise.resolve(),
      list: () => [],
    };
    const uiState = new InteractiveUiState();
    const terminal = createTerminal();
    const renderer = createRenderer(terminal, history, uiState);
    const prompt = renderer.readPrompt();

    terminal.input.type('Keep running\r');

    await expect(prompt).resolves.toBe('Keep running');
    expect(uiState.notification).toContain('history is read-only');
  });

  it('keeps every context badge on a narrow supported screen', async () => {
    const terminal = createTerminal();
    terminal.output.columns = 40;
    const renderer = createRenderer(terminal);
    const prompt = renderer.readPrompt();

    expect(terminal.output.text()).toContain('LEAGUE');
    expect(terminal.output.text()).toContain('ROSTER');
    expect(terminal.output.text()).toContain('TEAM');
    expect(terminal.output.text()).toContain('SKILL');
    expect(terminal.output.text()).toContain('SOURCE');
    terminal.input.type('\u0003');
    await expect(prompt).rejects.toThrow('Interrupted');
  });

  it('renders compact tool progress and analysis presentation', async () => {
    const uiState = new InteractiveUiState();
    const terminal = createTerminal();
    const renderer = createRenderer(terminal, new MemoryPromptHistory(), uiState);
    const chunks: UIMessageChunk[] = [
      { type: 'start', messageId: 'answer-1' },
      { type: 'start-step' },
      {
        type: 'tool-input-available',
        toolCallId: 'tool-1',
        toolName: 'getNflState',
        input: {},
      },
      {
        type: 'tool-output-available',
        toolCallId: 'tool-1',
        output: { season: 2026, week: 1 },
      },
      { type: 'text-start', id: 'text-1' },
      {
        type: 'text-delta',
        id: 'text-1',
        delta: '## Decision\nConfidence: 72%\nWeekly points: 8, 14, 10, 19',
      },
      { type: 'text-end', id: 'text-1' },
      { type: 'finish-step' },
      { type: 'finish', finishReason: 'stop' },
    ];
    const message = await renderer.renderStream({
      uiMessageStream: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    });

    expect(message?.parts.some((part) => part.type === 'text')).toBe(true);
    expect(terminal.output.text()).toContain('Read the current NFL state');
    expect(terminal.output.text()).toContain('DECISION');
    expect(terminal.output.text()).toContain('72%');
    expect(uiState.latestAnswer).toContain('Weekly points');
  });
});

function createRenderer(
  terminal: ReturnType<typeof createTerminal>,
  history: PromptHistory = new MemoryPromptHistory(),
  uiState = new InteractiveUiState(),
) {
  return new SebTerminalRenderer({
    environment: { NO_COLOR: '1' },
    history,
    input: terminal.input,
    model: 'test-model',
    output: terminal.output,
    session: createSessionState(new Date('2026-08-20T12:00:00Z')),
    sources: new SourceTracker(),
    uiState,
    version: '0.0.3',
  });
}

function createTerminal() {
  class Input extends EventEmitter {
    isTTY = true;
    rawModes: boolean[] = [];
    pause(): this { return this; }
    resume(): this { return this; }
    setRawMode(mode: boolean): this { this.rawModes.push(mode); return this; }
    type(value: string): void { this.emit('data', Buffer.from(value)); }
  }
  class Output extends EventEmitter {
    columns = 100;
    isTTY = true;
    rows = 30;
    chunks: string[] = [];
    write(chunk: string | Uint8Array): boolean {
      this.chunks.push(String(chunk));
      return true;
    }
    text(): string { return this.chunks.join(''); }
  }
  return { input: new Input(), output: new Output() };
}
