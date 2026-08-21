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

  it('recalls history', async () => {
    const history = new MemoryPromptHistory(['older prompt']);
    const terminal = createTerminal();
    const renderer = createRenderer(terminal, history);
    const recalled = renderer.readPrompt();

    terminal.input.type('\x1b[A\r');
    await expect(recalled).resolves.toBe('older prompt');
  });

  it('selects a numbered suggestion on the first prompt', async () => {
    const uiState = new InteractiveUiState();
    uiState.suggestions = ['Compare these players'];
    const terminal = createTerminal();
    const renderer = createRenderer(terminal, new MemoryPromptHistory(), uiState);
    const selected = renderer.readPrompt();

    terminal.input.type('1');
    await expect(selected).resolves.toBe('Compare these players');
  });

  it('uses the mouse wheel for the transcript without recalling history', async () => {
    const history = new MemoryPromptHistory(['older prompt']);
    const terminal = createTerminal();
    terminal.output.rows = 16;
    const renderer = createRenderer(terminal, history);
    const lines = Array.from({ length: 30 }, (_, index) => `Transcript line ${index + 1}`);
    await renderer.renderStream({
      uiMessageStream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'start', messageId: 'long-answer' });
          controller.enqueue({ type: 'text-start', id: 'long-text' });
          controller.enqueue({
            type: 'text-delta',
            id: 'long-text',
            delta: lines.join('\n'),
          });
          controller.enqueue({ type: 'text-end', id: 'long-text' });
          controller.enqueue({ type: 'finish', finishReason: 'stop' });
          controller.close();
        },
      }),
    });
    const prompt = renderer.readPrompt();

    terminal.input.type('\x1b[<64;10;5M');

    const frame = terminal.output.text().split('\x1b[H').at(-1);
    expect(frame).toContain('Viewing earlier transcript');
    expect(frame).toContain('1 line above latest');
    terminal.input.type('new request\r');
    await expect(prompt).resolves.toBe('new request');
    expect(terminal.output.text()).toContain('\x1b[?1000h\x1b[?1006h');
  });

  it('shows each contextual suggestion on its own footer row', async () => {
    const uiState = new InteractiveUiState();
    uiState.suggestions = [
      "Show Derrick Henry's profile.",
      "Summarize Derrick Henry's game log.",
      'Find verified news about Derrick Henry.',
    ];
    const terminal = createTerminal();
    const renderer = createRenderer(terminal, new MemoryPromptHistory(), uiState);
    const prompt = renderer.readPrompt();
    const frame = terminal.output.text().split('\x1b[H').at(-1);

    expect(frame).toContain("1  Show Derrick Henry's profile.");
    expect(frame).toContain("2  Summarize Derrick Henry's game log.");
    expect(frame).toContain('3  Find verified news about Derrick Henry.');
    terminal.input.type('\u0003');
    await expect(prompt).rejects.toThrow('Interrupted');
  });

  it('hides suggestions after the first submitted prompt', async () => {
    const uiState = new InteractiveUiState();
    uiState.suggestions = ['Compare these players'];
    const terminal = createTerminal();
    const renderer = createRenderer(terminal, new MemoryPromptHistory(), uiState);
    const firstPrompt = renderer.readPrompt();

    terminal.input.type('My first prompt\r');
    await expect(firstPrompt).resolves.toBe('My first prompt');

    const secondPrompt = renderer.readPrompt();
    const frame = terminal.output.text().split('\x1b[H').at(-1);
    expect(frame).not.toContain('Compare these players');
    terminal.input.type('\u0003');
    await expect(secondPrompt).rejects.toThrow('Interrupted');
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

  it('runs terminal commands without case-sensitive matching', async () => {
    const uiState = new InteractiveUiState();
    uiState.latestAnswer = 'Latest answer';
    const terminal = createTerminal();
    const renderer = createRenderer(terminal, new MemoryPromptHistory(), uiState);
    const prompt = renderer.readPrompt();

    terminal.input.type('/COPY\r');
    expect(terminal.output.text()).toContain(
      Buffer.from('Latest answer').toString('base64'),
    );
    terminal.input.type('/THEME COMPACT\r');
    expect(uiState.theme).toBe('compact');
    terminal.input.type('\u0003');

    await expect(prompt).rejects.toThrow('Interrupted');
  });

  it('rejects extra terminal-command arguments before submission', async () => {
    const terminal = createTerminal();
    const renderer = createRenderer(terminal);
    const prompt = renderer.readPrompt();

    terminal.input.type('/copy extra\r');
    expect(terminal.output.text()).toContain('Use /copy.');
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
    expect(terminal.output.text()).toContain('\x1b[?1006l\x1b[?1000l');
  });

  it.each(['/exit', '/quit', '/q'])('exits interactive mode with %s', async (command) => {
    const terminal = createTerminal();
    const renderer = createRenderer(terminal);
    const prompt = renderer.readPrompt();

    terminal.input.type(`${command}\r`);

    await expect(prompt).resolves.toBeUndefined();
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

  it('shows useful automatic context without empty setup badges', async () => {
    const terminal = createTerminal();
    terminal.output.columns = 40;
    const renderer = createRenderer(terminal);
    const prompt = renderer.readPrompt();

    const output = terminal.output.text();
    expect(output).toContain('EXPLORE');
    expect(output).toContain('SLEEPER NOT CONNECTED');
    expect(output).toContain('SOURCE NO SOURCE YET');
    expect(output).not.toContain('LEAGUE —');
    expect(output).not.toContain('ROSTER —');
    terminal.input.type('\u0003');
    await expect(prompt).rejects.toThrow('Interrupted');
  });

  it('explains the three experiences on the first screen', async () => {
    const terminal = createTerminal();
    const renderer = createRenderer(terminal);
    const prompt = renderer.readPrompt();
    const output = terminal.output.text();

    expect(output).toContain('Ask naturally');
    expect(output).toContain('EXPLORE');
    expect(output).toContain('MY FANTASY');
    expect(output).toContain('ANALYZE');
    expect(output).toContain('/connect <Sleeper username>');
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
    version: '0.0.7',
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
