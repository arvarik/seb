import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';
import type { UIMessageChunk } from 'ai';

import { MemoryPromptHistory } from '../src/interactive/history.js';
import type { PromptHistory } from '../src/interactive/history.js';
import { SebTerminalRenderer } from '../src/interactive/renderer.js';
import { stripAnsi, visibleLength } from '../src/interactive/presentation.js';
import { createSessionState } from '../src/interactive/session.js';
import { InteractiveUiState } from '../src/interactive/ui-state.js';
import { SourceTracker } from '../src/sources.js';

describe('SebTerminalRenderer prompt input', () => {
  it('shows reasoning and keeps the writing status through timer updates', async () => {
    const terminal = createTerminal();
    const uiState = new InteractiveUiState();
    const renderer = createRenderer(terminal, new MemoryPromptHistory(), uiState);
    let controller!: ReadableStreamDefaultController<UIMessageChunk>;
    const rendered = renderer.renderStream({
      uiMessageStream: new ReadableStream({ start(value) { controller = value; } }),
    });
    const frame = () => stripAnsi(terminal.output.text().split('\x1b[H').at(-1) ?? '');
    controller.enqueue({ type: 'reasoning-start', id: 'reason' });
    controller.enqueue({ type: 'reasoning-delta', id: 'reason', delta: 'Checking the available sources.' });
    await expect.poll(frame).toContain('Reasoning · in progress');
    expect(frame()).toContain('Checking the available sources.');
    controller.enqueue({ type: 'reasoning-end', id: 'reason' });
    controller.enqueue({ type: 'text-start', id: 'answer' });
    controller.enqueue({ type: 'text-delta', id: 'answer', delta: 'Here is the answer.' });
    await expect.poll(frame).toContain('Writing answer');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(frame()).toContain('Writing answer');
    expect(frame()).not.toContain('Reasoning · in progress');
    controller.enqueue({ type: 'text-end', id: 'answer' });
    controller.enqueue({ type: 'finish', finishReason: 'stop' });
    controller.close();
    await rendered;
    expect(uiState.latestAnswer).toBe('Here is the answer.');
    expect(frame()).toContain('Ready');
    renderer.close();
  });

  it('cancels a stalled source even when the provider ignores abort', async () => {
    const terminal = createTerminal();
    const renderer = createRenderer(terminal);
    let cancelled = false;
    let aborted = false;
    const rendered = renderer.renderStream({
      abort: () => { aborted = true; },
      uiMessageStream: new ReadableStream({
        cancel() { cancelled = true; },
      }),
    });
    terminal.input.type('\x1b');
    await expect.poll(() => cancelled).toBe(true);
    await expect(rendered).resolves.toBeUndefined();
    expect(aborted).toBe(true);
    const prompt = renderer.readPrompt();
    terminal.input.type('Try again\r');
    await expect(prompt).resolves.toBe('Try again');
    renderer.close();
  });

  it('keeps the reading position when an answer finishes after scrolling', async () => {
    const terminal = createTerminal();
    const renderer = createRenderer(terminal);
    let controller!: ReadableStreamDefaultController<UIMessageChunk>;
    const rendered = renderer.renderStream({
      uiMessageStream: new ReadableStream({ start(value) { controller = value; } }),
    });
    controller.enqueue({ type: 'text-start', id: 'answer' });
    controller.enqueue({ type: 'text-delta', id: 'answer', delta:
      Array.from({ length: 80 }, (_, index) => `Unique answer row ${index}`).join('\n') });
    const frame = () => stripAnsi(terminal.output.text().split('\x1b[H').at(-1) ?? '');
    await expect.poll(frame).toContain('Unique answer row 79');
    terminal.input.type('\x1b[5~');
    await expect.poll(frame).toContain('Viewing earlier transcript');
    const before = frame().match(/Unique answer row \d+/gu);
    controller.enqueue({ type: 'text-end', id: 'answer' });
    controller.enqueue({ type: 'finish', finishReason: 'stop' });
    controller.close();
    await rendered;
    expect(frame().match(/Unique answer row \d+/gu)).toEqual(before);
    renderer.close();
  });

  it.each([40, 80, 120])('wraps reasoning within a %i-column terminal', async (columns) => {
    const terminal = createTerminal();
    terminal.output.columns = columns;
    const renderer = createRenderer(terminal);
    await renderer.renderStream({
      uiMessageStream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'reasoning-start', id: 'reason' });
          controller.enqueue({ type: 'reasoning-delta', id: 'reason', delta:
            'Check the matchup 🏈 and the sources. '.repeat(4) + '\x1b[2J' });
          controller.enqueue({ type: 'reasoning-end', id: 'reason' });
          controller.enqueue({ type: 'text-start', id: 'answer' });
          controller.enqueue({ type: 'text-delta', id: 'answer', delta: '## Result\nA readable answer.' });
          controller.enqueue({ type: 'text-end', id: 'answer' });
          controller.enqueue({ type: 'finish', finishReason: 'stop' });
          controller.close();
        },
      }),
    });
    const rawFrame = terminal.output.text().split('\x1b[H').at(-1) ?? '';
    expect(rawFrame).not.toContain('\x1b[2J');
    const frame = stripAnsi(rawFrame);
    expect(frame).toContain('Reasoning');
    expect(frame).toContain('A readable answer.');
    expect(frame.split('\n').every((line) => visibleLength(line) <= columns)).toBe(true);
    renderer.close();
  });

  it('marks an interrupted tool as stopped and restores prompt input', async () => {
    const terminal = createTerminal();
    const renderer = createRenderer(terminal);
    const rendered = renderer.renderStream({
      uiMessageStream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'tool-input-available', toolCallId: 'search',
            toolName: 'searchCurrentNews', input: {} });
        },
      }),
    });
    await expect.poll(() => terminal.output.text()).toContain('Response in progress');
    terminal.input.type('\x1b');
    await rendered;
    const frame = stripAnsi(terminal.output.text().split('\x1b[H').at(-1) ?? '');
    expect(frame).toContain('stopped');
    expect(frame).toContain('This response is incomplete');
    expect(frame).not.toContain('Working');
    expect(frame).not.toContain('Response in progress');
    renderer.close();
  });

  it('retains consecutive answers when streams omit message IDs', async () => {
    const terminal = createTerminal();
    const renderer = createRenderer(terminal);
    const responses = [];
    for (const answer of ['First answer remains.', 'Second answer remains.']) {
      const prompt = renderer.readPrompt();
      terminal.input.type(`${answer}\r`);
      await prompt;
      responses.push(await renderer.renderStream({
        uiMessageStream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'start' });
            controller.enqueue({ type: 'text-start', id: 'text' });
            controller.enqueue({ type: 'text-delta', id: 'text', delta: answer });
            controller.enqueue({ type: 'text-end', id: 'text' });
            controller.enqueue({ type: 'finish', finishReason: 'stop' });
            controller.close();
          },
        }),
      }));
    }
    expect(responses[0]?.id).toBeTruthy();
    expect(responses[1]?.id).not.toBe(responses[0]?.id);
    const frame = terminal.output.text().split('\x1b[H').at(-1) ?? '';
    expect(frame.match(/First answer remains\./gu)).toHaveLength(2);
    expect(frame.match(/Second answer remains\./gu)).toHaveLength(2);
    renderer.close();
  });

  it('paints one frame per input chunk and restores the draft after history navigation', async () => {
    const terminal = createTerminal();
    const renderer = createRenderer(terminal, new MemoryPromptHistory(['old prompt']));
    const prompt = renderer.readPrompt();
    const before = terminal.output.chunks.length;
    terminal.input.type('My unfinished question');
    expect(terminal.output.chunks.length - before).toBe(1);
    terminal.input.type('\x1b[A\x1b[B\r');
    await expect(prompt).resolves.toBe('My unfinished question');
    renderer.close();
  });

  it('keeps the prior answer visible while editing a long pasted prompt', async () => {
    const terminal = createTerminal();
    const renderer = createRenderer(terminal);
    await renderer.renderStream({
      uiMessageStream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-start', id: 'answer' });
          controller.enqueue({ type: 'text-delta', id: 'answer', delta: 'Keep this answer visible.' });
          controller.enqueue({ type: 'text-end', id: 'answer' });
          controller.enqueue({ type: 'finish', finishReason: 'stop' });
          controller.close();
        },
      }),
    });
    const prompt = renderer.readPrompt();
    const pasted = Array.from({ length: 40 }, (_, index) => `Draft line ${index}`).join('\n');
    terminal.input.type(`\x1b[200~${pasted}\x1b[201~`);
    const frame = terminal.output.text().split('\x1b[H').at(-1) ?? '';
    expect(frame).toContain('Keep this answer visible.');
    expect(frame).toContain('Draft line 39');
    terminal.input.type('\r');
    await expect(prompt).resolves.toBe(pasted);
    renderer.close();
  });

  it('ignores duplicate Enter keys during one submission', async () => {
    const terminal = createTerminal();
    const history = new MemoryPromptHistory();
    const renderer = createRenderer(terminal, history);
    const prompt = renderer.readPrompt();
    terminal.input.type('One question\r\r');
    await expect(prompt).resolves.toBe('One question');
    expect(history.list()).toEqual(['One question']);
    renderer.close();
  });

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

  it('rejects a likely API key before transcript or history storage', async () => {
    const history = new MemoryPromptHistory();
    const terminal = createTerminal();
    const renderer = createRenderer(terminal, history);
    const prompt = renderer.readPrompt();
    const privateKeys = [
      'sk-ant-0123456789abcdef0123456789abcdef',
      'local-token-0123456789abcdef',
      'Bearer unknown-private-value',
    ];

    for (const privateKey of privateKeys) {
      terminal.input.type(`/model ${privateKey}\r`);

      await expect.poll(() => {
        const frame = stripAnsi(terminal.output.text().split('\x1b[H').at(-1) ?? '');
        return frame.includes('Seb does not accept API keys in slash commands') &&
          !frame.includes(privateKey);
      }).toBe(true);
      expect(history.list()).toEqual([]);
      expect(terminal.output.text().split('\x1b[H').at(-1)).not.toContain(
        privateKey,
      );
    }

    terminal.input.type('/model claude-sonnet-test\r');
    await expect(prompt).resolves.toBe('/model claude-sonnet-test');
    expect(history.list()).toEqual(['/model']);
    expect(terminal.output.text().split('\x1b[H').at(-1)).not.toContain(
      'claude-sonnet-test',
    );
  });

  it('keeps provider arguments out of the transcript and prompt history', async () => {
    const history = new MemoryPromptHistory();
    const terminal = createTerminal();
    const renderer = createRenderer(terminal, history);
    const prompt = renderer.readPrompt();

    terminal.input.type('/provider openai\r');

    await expect(prompt).resolves.toBe('/provider openai');
    expect(history.list()).toEqual(['/provider']);
    expect(terminal.output.text().split('\x1b[H').at(-1)).not.toContain(
      '/provider openai',
    );
  });

  it('selects a numbered suggestion on the first prompt', async () => {
    const uiState = new InteractiveUiState();
    uiState.suggestions = ['Compare these players'];
    const terminal = createTerminal();
    const renderer = createRenderer(terminal, new MemoryPromptHistory(), uiState);
    const selected = renderer.readPrompt();

    terminal.input.type('1\r');
    await expect(selected).resolves.toBe('Compare these players');
  });

  it('submits a year-first question instead of a numbered suggestion', async () => {
    const uiState = new InteractiveUiState();
    uiState.suggestions = ['Compare these players', 'Show current news'];
    const terminal = createTerminal();
    const renderer = createRenderer(terminal, new MemoryPromptHistory(), uiState);
    const prompt = renderer.readPrompt();

    terminal.input.type('2026 season news\r');

    await expect(prompt).resolves.toBe('2026 season news');
  });

  it('opens a long answer at its start and scrolls without recalling history', async () => {
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
    const focusedFrame = terminal.output.text().split('\x1b[H').at(-1);
    expect(focusedFrame).toContain('Transcript line 1');
    expect(focusedFrame).toContain('Opened at answer');

    terminal.input.type('\x1b[<65;10;5M');

    await expect.poll(() => terminal.output.text().split('\x1b[H').at(-1)).toContain(
      'Viewing earlier transcript',
    );
    const frame = terminal.output.text().split('\x1b[H').at(-1);
    expect(frame).not.toContain('older prompt');
    terminal.input.type('new request\r');
    await expect(prompt).resolves.toBe('new request');
    expect(terminal.output.text()).toContain('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
  });

  it('keeps the visible answer anchored while the next prompt wraps', async () => {
    const terminal = createTerminal();
    terminal.output.columns = 40;
    terminal.output.rows = 18;
    const renderer = createRenderer(terminal);
    const lines = Array.from({ length: 30 }, (_, index) => `Transcript line ${index + 1}`);
    await renderer.renderStream({
      uiMessageStream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'start', messageId: 'anchored-answer' });
          controller.enqueue({ type: 'text-start', id: 'answer-text' });
          controller.enqueue({
            type: 'text-delta',
            id: 'answer-text',
            delta: lines.join('\n'),
          });
          controller.enqueue({ type: 'text-end', id: 'answer-text' });
          controller.enqueue({ type: 'finish', finishReason: 'stop' });
          controller.close();
        },
      }),
    });
    const prompt = renderer.readPrompt();
    expect(terminal.output.text().split('\x1b[H').at(-1)).toContain('Transcript line 1');

    terminal.input.type('word '.repeat(50));

    const frame = terminal.output.text().split('\x1b[H').at(-1);
    expect(frame).toContain('◆ Seb');
    expect(frame).toContain('Transcript line 1');
    expect(frame).toContain('Opened at answer');
    terminal.input.type('\u0003');
    await expect(prompt).rejects.toThrow('Interrupted');
  });

  it('keeps the cursor and status visible when the prompt exceeds the screen', async () => {
    const terminal = createTerminal();
    terminal.output.columns = 40;
    terminal.output.rows = 18;
    const renderer = createRenderer(terminal);
    const prompt = renderer.readPrompt();

    terminal.input.type(`${'word '.repeat(80)}END`);

    const frame = stripAnsi(terminal.output.text().split('\x1b[H').at(-1) ?? '');
    expect(frame).toContain('END| ');
    expect(frame).toContain('Ctrl+G context');
    expect(frame.split('\r\n')).toHaveLength(18);
    terminal.input.type('\u0003');
    await expect(prompt).rejects.toThrow('Interrupted');
  });

  it('preserves repeated spaces when a prompt wraps', async () => {
    const terminal = createTerminal();
    terminal.output.columns = 40;
    const renderer = createRenderer(terminal);
    const prompt = renderer.readPrompt();

    terminal.input.type(`alpha  beta ${'x'.repeat(40)}`);

    const frame = stripAnsi(terminal.output.text().split('\x1b[H').at(-1) ?? '');
    expect(frame).toContain('alpha  beta');
    terminal.input.type('\u0003');
    await expect(prompt).rejects.toThrow('Interrupted');
  });

  it('keeps the visible answer anchored after a width change', async () => {
    const terminal = createTerminal();
    terminal.output.columns = 80;
    terminal.output.rows = 18;
    const renderer = createRenderer(terminal);
    const lines = Array.from(
      { length: 30 },
      (_, index) => `Transcript line ${index + 1} ${'detail '.repeat(10)}`,
    );
    await renderer.renderStream({
      uiMessageStream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'start', messageId: 'resized-answer' });
          controller.enqueue({ type: 'text-start', id: 'answer-text' });
          controller.enqueue({ type: 'text-delta', id: 'answer-text', delta: lines.join('\n') });
          controller.enqueue({ type: 'text-end', id: 'answer-text' });
          controller.enqueue({ type: 'finish', finishReason: 'stop' });
          controller.close();
        },
      }),
    });
    const prompt = renderer.readPrompt();
    expect(terminal.output.text().split('\x1b[H').at(-1)).toContain('Transcript line 1');

    terminal.output.columns = 40;
    terminal.output.emit('resize');

    const frame = terminal.output.text().split('\x1b[H').at(-1);
    expect(frame).toContain('◆ Seb');
    expect(frame).toContain('Transcript line 1');
    terminal.input.type('\u0003');
    await expect(prompt).rejects.toThrow('Interrupted');
  });

  it('restores the transcript position after an overlay closes', async () => {
    const terminal = createTerminal();
    terminal.output.rows = 16;
    const renderer = createRenderer(terminal);
    const lines = Array.from({ length: 30 }, (_, index) => `Transcript line ${index + 1}`);
    await renderer.renderStream({
      uiMessageStream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'start', messageId: 'overlay-answer' });
          controller.enqueue({ type: 'text-start', id: 'answer-text' });
          controller.enqueue({ type: 'text-delta', id: 'answer-text', delta: lines.join('\n') });
          controller.enqueue({ type: 'text-end', id: 'answer-text' });
          controller.enqueue({ type: 'finish', finishReason: 'stop' });
          controller.close();
        },
      }),
    });
    const prompt = renderer.readPrompt();

    terminal.input.type('?\x1b');

    await expect.poll(() => terminal.output.text().split('\x1b[H').at(-1)).toContain('◆ Seb');
    const frame = terminal.output.text().split('\x1b[H').at(-1);
    expect(frame).toContain('◆ Seb');
    expect(frame).toContain('Transcript line 1');
    terminal.input.type('\u0003');
    await expect(prompt).rejects.toThrow('Interrupted');
  });

  it('scrolls a shortcut panel that is taller than the terminal', async () => {
    const terminal = createTerminal();
    terminal.output.rows = 16;
    const renderer = createRenderer(terminal);
    const prompt = renderer.readPrompt();

    terminal.input.type('?');
    const firstFrame = stripAnsi(terminal.output.text().split('\x1b[H').at(-1) ?? '');
    expect(firstFrame).toContain('KEYBOARD SHORTCUTS');
    expect(firstFrame).not.toContain('/exit');

    terminal.input.type('\x1b[6~\x1b[6~');

    await expect.poll(() => stripAnsi(
      terminal.output.text().split('\x1b[H').at(-1) ?? '',
    )).toContain('/exit');
    terminal.input.type('\u0003');
    await expect(prompt).rejects.toThrow('Interrupted');
  });

  it('coalesces fast scrolling and skips redraws at both boundaries', async () => {
    const terminal = createTerminal();
    terminal.output.rows = 16;
    const renderer = createRenderer(terminal);
    const lines = Array.from({ length: 100 }, (_, index) => `Transcript line ${index + 1}`);
    await renderer.renderStream({
      uiMessageStream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'start', messageId: 'long-answer' });
          controller.enqueue({ type: 'text-start', id: 'long-text' });
          controller.enqueue({ type: 'text-delta', id: 'long-text', delta: lines.join('\n') });
          controller.enqueue({ type: 'text-end', id: 'long-text' });
          controller.enqueue({ type: 'finish', finishReason: 'stop' });
          controller.close();
        },
      }),
    });
    const prompt = renderer.readPrompt();
    const scrollUp = '\x1b[<64;10;5M';
    const scrollDown = '\x1b[<65;10;5M';

    const atAnswerStart = terminal.output.chunks.length;
    for (let index = 0; index < 100; index += 1) terminal.input.type(scrollUp);
    expect(terminal.output.chunks).toHaveLength(atAnswerStart);

    for (let index = 0; index < 100; index += 1) terminal.input.type(scrollDown);
    await expect.poll(() => terminal.output.chunks.length).toBe(atAnswerStart + 1);
    const afterBottom = terminal.output.chunks.length;
    expect(terminal.output.text().split('\x1b[H').at(-1)).not.toContain(
      'Viewing earlier transcript',
    );

    for (let index = 0; index < 100; index += 1) terminal.input.type(scrollDown);
    expect(terminal.output.chunks).toHaveLength(afterBottom);

    for (let index = 0; index < 100; index += 1) terminal.input.type(scrollUp);
    await expect.poll(() => terminal.output.chunks.length).toBe(afterBottom + 1);
    const afterTop = terminal.output.chunks.length;
    expect(terminal.output.text().split('\x1b[H').at(-1)).toContain(
      'Viewing earlier transcript',
    );

    for (let index = 0; index < 100; index += 1) terminal.input.type(scrollUp);
    expect(terminal.output.chunks).toHaveLength(afterTop);
    terminal.input.type('\u0003');
    await expect(prompt).rejects.toThrow('Interrupted');
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

  it('closes a partial command menu with Escape', async () => {
    const terminal = createTerminal();
    const renderer = createRenderer(terminal);
    const prompt = renderer.readPrompt();

    terminal.input.type('/co');
    expect(terminal.output.text().split('\x1b[H').at(-1)).toContain('Effect:');

    terminal.input.type('\x1b');

    await expect.poll(() => terminal.output.text().split('\x1b[H').at(-1)).not.toContain(
      'Effect:',
    );
    terminal.input.type('\u0003');
    await expect(prompt).rejects.toThrow('Interrupted');
  });

  it('fills the selected command with Right Arrow', async () => {
    const terminal = createTerminal();
    const renderer = createRenderer(terminal);
    const prompt = renderer.readPrompt();

    terminal.input.type('\u000b');
    expect(terminal.output.text().split('\x1b[H').at(-1)).toContain('Effect:');
    terminal.input.type('\x1b[C');

    const frame = stripAnsi(terminal.output.text().split('\x1b[H').at(-1) ?? '');
    expect(frame).toContain('/explore');
    expect(frame).not.toContain('Effect:');
    terminal.input.type('\u0003');
    await expect(prompt).rejects.toThrow('Interrupted');
  });

  it('shows a bounded and safe tool-approval input summary', async () => {
    const terminal = createTerminal();
    const renderer = createRenderer(terminal);
    const approval = renderer.readToolApproval({
      input: {
        apiToken: 'do-not-display-this-token',
        url: `https://example.com/news\x1b[2J${'x'.repeat(1_000)}`,
      },
      toolName: 'readNewsUrl',
    });

    const frame = stripAnsi(terminal.output.text().split('\x1b[H').at(-1) ?? '');
    expect(frame).toContain('Approval · Read the supplied web page');
    expect(frame).toContain('Input:');
    expect(frame).toContain('[redacted]');
    expect(frame).toContain('…');
    expect(terminal.output.text()).not.toContain('\x1b[2J');
    expect(terminal.output.text()).not.toContain('do-not-display-this-token');

    terminal.input.type('n');
    await expect(approval).resolves.toEqual({
      approved: false,
      reason: 'The user denied the tool call.',
    });
  });

  it('releases mouse reporting for native text selection', async () => {
    const terminal = createTerminal();
    const renderer = createRenderer(terminal);
    const prompt = renderer.readPrompt();

    terminal.input.type('/select\r');
    expect(terminal.output.text()).toContain('Selection mode');
    expect(terminal.output.text()).toContain('\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l');

    terminal.input.type('ignored while selecting');
    terminal.input.type('\x1b');
    await expect.poll(() => terminal.output.text()).toContain('\x1b[?1000h\x1b[?1002h\x1b[?1006h');

    terminal.input.type('new request\r');
    await expect(prompt).resolves.toBe('new request');
  });

  it('copies every turn without screen wrapping and exposes native scrollback', async () => {
    const terminal = createTerminal();
    const copied: string[] = [];
    const renderer = createRenderer(terminal, new MemoryPromptHistory(), new InteractiveUiState(),
      (text) => copied.push(text));
    const first = renderer.readPrompt();
    terminal.input.type('Check my bye weeks\r');
    await first;
    const answer = Array.from({ length: 90 }, (_, index) => `Transcript row ${index}`).join('\n');
    await renderText(renderer, answer);
    const prompt = renderer.readPrompt();
    terminal.input.type('/copy all\r');
    expect(copied).toEqual([`You\nCheck my bye weeks\n\nSeb\n${answer}`]);
    const start = terminal.output.chunks.length;
    terminal.input.type('/select\r');
    const native = terminal.output.chunks.slice(start).join('');
    expect(native).toContain('\x1b[?1049l');
    expect(native).toContain('Check my bye weeks');
    expect(native).toContain(answer.replace(/\n/g, '\r\n'));
    const count = terminal.output.chunks.length;
    terminal.output.columns = 70;
    terminal.output.emit('resize');
    expect(terminal.output.chunks).toHaveLength(count);
    terminal.input.type('\r');
    expect(terminal.output.chunks.slice(count).join('')).toContain('\x1b[?1049h');
    terminal.input.type('Next question\r');
    await expect(prompt).resolves.toBe('Next question');
    renderer.close();
  });

  it.each(['down', 'up'])('extends a drag %s across multiple screens', async (direction) => {
    const terminal = createTerminal();
    const copied: string[] = [];
    const renderer = createRenderer(terminal, new MemoryPromptHistory(), new InteractiveUiState(),
      (text) => copied.push(text));
    await renderText(renderer, Array.from({ length: 70 }, (_, index) => `Selection row ${index}`).join('\n'));
    const prompt = renderer.readPrompt();
    const frame = () => stripAnsi(terminal.output.text().split('\x1b[H').at(-1) ?? '');
    if (direction === 'up') {
      for (let index = 0; index < 8; index += 1) terminal.input.type('\x1b[6~');
      await expect.poll(frame).toContain('Selection row 69');
    }
    const lines = frame().split('\r\n');
    const matches = lines.flatMap((line, index) => line.includes('Selection row') ? [index] : []);
    const anchor = direction === 'down' ? matches[0]! : matches.at(-1)!;
    const label = lines[anchor]!.trim();
    const edge = direction === 'down' ? terminal.output.rows : 1;
    const anchorColumn = direction === 'down' ? 3 : lines[anchor]!.length;
    const edgeColumn = direction === 'down' ? 100 : 1;
    terminal.input.type(`\x1b[<0;${anchorColumn};${anchor + 1}M`);
    terminal.input.type(`\x1b[<32;${edgeColumn};${edge}M`);
    const expected = direction === 'down' ? 'Selection row 45' : 'Selection row 20';
    await expect.poll(frame, { timeout: 3000 }).toContain(expected);
    terminal.input.type(`\x1b[<0;${edgeColumn};${edge}m`);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain(label);
    expect(copied[0]).toContain(expected);
    expect(copied[0]).not.toContain('MODEL');
    expect(copied[0]).not.toContain('Ready');
    expect(copied[0]!.split('\n').length).toBeGreaterThan(25);
    terminal.input.type('Next\r');
    await prompt;
    renderer.close();
  });

  it('keeps a wheel selection stable during streaming and clears it on resize', async () => {
    const terminal = createTerminal();
    const copied: string[] = [];
    const renderer = createRenderer(terminal, new MemoryPromptHistory(), new InteractiveUiState(),
      (text) => copied.push(text));
    let controller!: ReadableStreamDefaultController<UIMessageChunk>;
    const rendered = renderer.renderStream({ uiMessageStream: new ReadableStream({
      start(value) { controller = value; },
    }) });
    controller.enqueue({ type: 'text-start', id: 'streaming' });
    controller.enqueue({ type: 'text-delta', id: 'streaming', delta:
      Array.from({ length: 80 }, (_, index) => `Stable row ${index}`).join('\n') });
    const frame = () => stripAnsi(terminal.output.text().split('\x1b[H').at(-1) ?? '');
    await expect.poll(frame).toContain('Stable row 79');
    const lines = frame().split('\r\n');
    const anchor = lines.findIndex((line) => line.includes('Stable row 70'));
    expect(anchor).toBeGreaterThan(0);
    terminal.input.type(`\x1b[<0;100;${anchor + 1}M`);
    terminal.input.type(`\x1b[<32;1;${anchor + 1}M`);
    for (let index = 0; index < 10; index += 1) terminal.input.type('\x1b[<64;1;15M');
    controller.enqueue({ type: 'text-delta', id: 'streaming', delta: '\nNew arrival' });
    controller.enqueue({ type: 'text-end', id: 'streaming' });
    controller.enqueue({ type: 'finish', finishReason: 'stop' });
    controller.close();
    await rendered;
    const prompt = renderer.readPrompt();
    terminal.input.type(`\x1b[<0;1;${anchor + 1}m`);
    expect(copied[0]).toContain('Stable row 41');
    expect(copied[0]).toContain('Stable row 70');
    expect(copied[0]).not.toContain('New arrival');
    terminal.output.columns = 70;
    terminal.output.emit('resize');
    expect(terminal.output.text().split('\x1b[H').at(-1)).not.toContain('\x1b[7m');
    for (let index = 0; index < 10; index += 1) terminal.input.type('\x1b[6~');
    await expect.poll(frame).toContain('New arrival');
    terminal.input.type('Next\r');
    await prompt;
    renderer.close();
  });

  it('combines repeated successful tools and retains failed calls', async () => {
    const terminal = createTerminal();
    const renderer = createRenderer(terminal);
    await renderer.renderStream({ uiMessageStream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'start', messageId: 'compact-tools' });
      for (let index = 0; index < 12; index += 1) {
        controller.enqueue({ type: 'tool-input-available', toolCallId: `schedule-${index}`,
          toolName: 'getNflSchedule', input: { week: index + 1 } });
        controller.enqueue({ type: 'tool-output-available', toolCallId: `schedule-${index}`, output: {} });
      }
      controller.enqueue({ type: 'tool-input-available', toolCallId: 'failed',
        toolName: 'getLeague', input: {} });
      controller.enqueue({ type: 'tool-output-error', toolCallId: 'failed', errorText: 'League unavailable' });
      controller.enqueue({ type: 'finish', finishReason: 'stop' });
      controller.close();
    } }) });
    const frame = stripAnsi(terminal.output.text().split('\x1b[H').at(-1) ?? '');
    expect(frame).toContain('×12');
    expect(frame).toContain('total');
    expect(frame).toContain('League unavailable');
    expect(frame.match(/×12/g)).toHaveLength(1);
    expect(frame).not.toContain('• Tool');
    renderer.close();
  });

  it('selects visible text by dragging and copies it on release', async () => {
    const copied: string[] = [];
    const terminal = createTerminal();
    const renderer = createRenderer(
      terminal,
      new MemoryPromptHistory(),
      new InteractiveUiState(),
      (text) => copied.push(text),
    );
    await renderer.renderStream({
      uiMessageStream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'start', messageId: 'selectable-answer' });
          controller.enqueue({ type: 'text-start', id: 'answer-text' });
          controller.enqueue({
            type: 'text-delta',
            id: 'answer-text',
            delta: 'Selectable text remains visible.',
          });
          controller.enqueue({ type: 'text-end', id: 'answer-text' });
          controller.enqueue({ type: 'finish', finishReason: 'stop' });
          controller.close();
        },
      }),
    });
    const prompt = renderer.readPrompt();
    const frame = stripAnsi(terminal.output.text().split('\x1b[H').at(-1) ?? '');
    const rows = frame.split('\r\n');
    const rowIndex = rows.findIndex((row) => row.includes('Selectable text'));
    const columnIndex = rows[rowIndex]?.indexOf('Selectable text') ?? -1;
    expect(rowIndex).toBeGreaterThanOrEqual(0);
    expect(columnIndex).toBeGreaterThanOrEqual(0);
    const row = rowIndex + 1;
    const startColumn = columnIndex + 1;
    const endColumn = startColumn + 'Selectable text'.length - 1;

    terminal.input.type(`\x1b[<0;${startColumn};${row}M`);
    terminal.input.type(`\x1b[<32;${endColumn};${row}M`);
    terminal.input.type(`\x1b[<0;${endColumn};${row}m`);

    expect(copied).toEqual(['Selectable text']);
    expect(terminal.output.text()).toContain(Buffer.from('Selectable text').toString('base64'));
    expect(terminal.output.text().split('\x1b[H').at(-1)).toContain('\x1b[7m');
    terminal.input.type('new request\r');
    await expect(prompt).resolves.toBe('new request');
  });

  it('selects one complete grapheme by terminal columns', async () => {
    const copied: string[] = [];
    const terminal = createTerminal();
    const renderer = createRenderer(
      terminal,
      new MemoryPromptHistory(),
      new InteractiveUiState(),
      (text) => copied.push(text),
    );
    const family = '👨‍👩‍👧‍👦';
    await renderer.renderStream({
      uiMessageStream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'start', messageId: 'unicode-selection' });
          controller.enqueue({ type: 'text-start', id: 'answer-text' });
          controller.enqueue({ type: 'text-delta', id: 'answer-text', delta: `Family ${family} selected.` });
          controller.enqueue({ type: 'text-end', id: 'answer-text' });
          controller.enqueue({ type: 'finish', finishReason: 'stop' });
          controller.close();
        },
      }),
    });
    const prompt = renderer.readPrompt();
    const frame = stripAnsi(terminal.output.text().split('\x1b[H').at(-1) ?? '');
    const rows = frame.split('\r\n');
    const rowIndex = rows.findIndex((row) => row.includes(family));
    const columnIndex = rows[rowIndex]?.indexOf(family) ?? -1;
    expect(rowIndex).toBeGreaterThanOrEqual(0);
    expect(columnIndex).toBeGreaterThanOrEqual(0);
    const row = rowIndex + 1;
    const startColumn = columnIndex + 1;
    const endColumn = startColumn + 1;

    terminal.input.type(`\x1b[<0;${startColumn};${row}M`);
    terminal.input.type(`\x1b[<32;${endColumn};${row}M`);
    terminal.input.type(`\x1b[<0;${endColumn};${row}m`);

    expect(copied).toEqual([family]);
    expect(terminal.output.text().split('\x1b[H').at(-1)).toContain('1 character');
    terminal.input.type('\x1b');
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
    expect(terminal.output.text()).toContain('Use /copy [all].');
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
    expect(terminal.output.text()).toContain('\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l');
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

  it('detaches prompt input before a history save completes', async () => {
    let finishSave: (() => void) | undefined;
    const history: PromptHistory = {
      add: () => new Promise<void>((resolve) => { finishSave = resolve; }),
      clear: () => Promise.resolve(),
      list: () => [],
    };
    const terminal = createTerminal();
    const renderer = createRenderer(terminal, history);
    const prompt = renderer.readPrompt();

    terminal.input.type('Save this prompt\r');

    expect(terminal.input.listenerCount('data')).toBe(0);
    expect(terminal.input.pauseCount).toBeGreaterThan(0);
    finishSave?.();
    await expect(prompt).resolves.toBe('Save this prompt');
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

  it('shows provider-neutral model state and updates it after a switch', async () => {
    const uiState = new InteractiveUiState();
    uiState.setActiveModel({
      model: 'gpt-test',
      provider: 'openai',
      providerLabel: 'OpenAI',
    });
    const terminal = createTerminal();
    const renderer = createRenderer(
      terminal,
      new MemoryPromptHistory(),
      uiState,
    );
    const prompt = renderer.readPrompt();

    expect(stripAnsi(
      terminal.output.text().split('\x1b[H').at(-1) ?? '',
    )).toContain('MODEL OPENAI · gpt-test');

    uiState.setActiveModel({
      model: 'claude-test',
      provider: 'anthropic',
      providerLabel: 'Anthropic',
    });
    terminal.output.emit('resize');

    await expect.poll(() => stripAnsi(
      terminal.output.text().split('\x1b[H').at(-1) ?? '',
    )).toContain('MODEL ANTHROPIC · claude-test');
    terminal.input.type('\u0003');
    await expect(prompt).rejects.toThrow('Interrupted');
  });

  it('renders a bounded resize notice in a terminal below the minimum size', async () => {
    const terminal = createTerminal();
    terminal.output.columns = 30;
    terminal.output.rows = 10;
    const renderer = createRenderer(terminal);
    const prompt = renderer.readPrompt();

    const frame = stripAnsi(terminal.output.text().split('\x1b[H').at(-1) ?? '');
    const lines = frame.replace('\x1b[?2026l', '').split('\r\n');
    expect(frame).toContain('Terminal too small');
    expect(lines).toHaveLength(10);
    expect(lines.every((line) => line.length <= 30)).toBe(true);
    terminal.input.type('\u0003');
    await expect(prompt).rejects.toThrow('Interrupted');
  });

  it('selects league context from one visible keyboard panel', async () => {
    const session = createSessionState(new Date('2026-08-20T12:00:00Z'));
    session.leagues = [
      {
        deadlines: [],
        leagueId: '100',
        name: 'Home League',
        rosterIds: [4],
        status: 'in_season',
        warning: null,
      },
      {
        deadlines: [],
        leagueId: '200',
        name: 'Dynasty League',
        rosterIds: [8],
        status: 'in_season',
        warning: null,
      },
    ];
    session.leagueOptions = ['100', '200'];
    const terminal = createTerminal();
    terminal.output.columns = 80;
    terminal.output.rows = 24;
    const renderer = createRenderer(
      terminal,
      new MemoryPromptHistory(),
      new InteractiveUiState(),
      () => undefined,
      session,
    );
    const prompt = renderer.readPrompt();

    terminal.input.type('\u0007');
    const frame = stripAnsi(terminal.output.text().split('\x1b[H').at(-1) ?? '');
    expect(frame).toContain('ACTIVE CONTEXT');
    expect(frame).toContain('League   All leagues');
    expect(frame).toContain('Roster   Automatic');
    expect(frame).toContain('Week     Unset');
    expect(frame).toContain('Player   No player');
    expect(frame).toContain('Team     No team');

    terminal.input.type('\x1b[C\r');
    await expect(prompt).resolves.toBe('/league 100');
  });

  it('restores the prompt draft after a context command', async () => {
    const session = createSessionState(new Date('2026-08-20T12:00:00Z'));
    session.leagues = [{
      deadlines: [],
      leagueId: '100',
      name: 'Home League',
      rosterIds: [4],
      status: 'in_season',
      warning: null,
    }];
    session.leagueOptions = ['100'];
    const terminal = createTerminal();
    const renderer = createRenderer(
      terminal,
      new MemoryPromptHistory(),
      new InteractiveUiState(),
      () => undefined,
      session,
    );
    const contextCommand = renderer.readPrompt();

    terminal.input.type('Compare my flex options\u0007\x1b[C\r');
    await expect(contextCommand).resolves.toBe('/league 100');

    const restoredPrompt = renderer.readPrompt();
    const frame = stripAnsi(terminal.output.text().split('\x1b[H').at(-1) ?? '');
    expect(frame).toContain('Compare my flex options');
    terminal.input.type('\u0003');
    await expect(restoredPrompt).rejects.toThrow('Interrupted');
  });

  it('opens a completed answer at its Decision section', async () => {
    const terminal = createTerminal();
    terminal.output.columns = 80;
    terminal.output.rows = 18;
    const renderer = createRenderer(terminal);
    const preamble = Array.from({ length: 20 }, (_, index) => `Research note ${index + 1}`);
    const bridge = Array.from({ length: 20 }, (_, index) => `Additional evidence ${index + 1}`);
    const details = Array.from({ length: 20 }, (_, index) => `Decision detail ${index + 1}`);

    await renderer.renderStream({
      uiMessageStream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'start', messageId: 'decision-answer' });
          controller.enqueue({ type: 'text-start', id: 'decision-text' });
          controller.enqueue({
            type: 'text-delta',
            id: 'decision-text',
            delta: [
              ...preamble,
              'The decision depends on the final injury report.',
              ...bridge,
              '## Decision',
              ...details,
            ].join('\n'),
          });
          controller.enqueue({ type: 'text-end', id: 'decision-text' });
          controller.enqueue({ type: 'finish', finishReason: 'stop' });
          controller.close();
        },
      }),
    });

    const prompt = renderer.readPrompt();
    const frame = stripAnsi(terminal.output.text().split('\x1b[H').at(-1) ?? '');
    expect(frame).toContain('DECISION');
    expect(frame).toContain('Decision detail 1');
    expect(frame).not.toContain('Research note 20');
    expect(frame).not.toContain('The decision depends');
    expect(frame).toContain('Opened at Decision');
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

  it('shows fantasy actions before the three experiences', async () => {
    const session = createSessionState(new Date('2026-08-20T12:00:00Z'));
    session.user = 'seb-user';
    session.leagues = [
      {
        actionCenter: {
          actions: [{
            details: 'One starter slot is empty.',
            id: 'league-1:roster-4:lineup',
            kind: 'lineup',
            nextStep: 'Fill the slot before kickoff.',
            playerId: null,
            rosterId: 4,
            title: '1 open starter slot',
            urgency: 'high',
          }],
          lineups: [],
          playerStatusSignals: [],
        },
        deadlines: [],
        leagueId: 'league-1',
        name: 'Home League',
        rosterIds: [4],
        status: 'in_season',
        warning: null,
      },
      {
        actionCenter: {
          actions: [
            {
              details: 'A starter is out.',
              id: 'league-2:roster-8:player-1',
              kind: 'player-status',
              nextStep: 'Choose a healthy replacement.',
              playerId: 'player-1',
              rosterId: 8,
              title: 'Jordan Example needs a lineup check',
              urgency: 'high',
            },
            {
              details: 'A starter is questionable.',
              id: 'league-2:roster-8:player-2',
              kind: 'player-status',
              nextStep: 'Check the final status.',
              playerId: 'player-2',
              rosterId: 8,
              title: 'Taylor Example needs a lineup check',
              urgency: 'medium',
            },
            {
              details: 'The playoffs start next week.',
              id: 'league-2:playoffs',
              kind: 'deadline',
              nextStep: 'Review the roster.',
              playerId: null,
              rosterId: null,
              title: 'Fantasy playoffs start next week',
              urgency: 'low',
            },
          ],
          lineups: [],
          playerStatusSignals: [],
        },
        deadlines: [],
        leagueId: 'league-2',
        name: 'Dynasty League',
        rosterIds: [8],
        status: 'in_season',
        warning: null,
      },
    ];
    const terminal = createTerminal();
    terminal.output.columns = 80;
    terminal.output.rows = 24;
    const renderer = createRenderer(
      terminal,
      new MemoryPromptHistory(),
      new InteractiveUiState(),
      () => undefined,
      session,
    );
    const prompt = renderer.readPrompt();
    const output = stripAnsi(terminal.output.text().split('\x1b[H').at(-1) ?? '');

    expect(output.indexOf('WHAT NEEDS ATTENTION')).toBeLessThan(output.lastIndexOf('EXPLORE'));
    expect(output).toContain('NOW · Home League · Roster 4 · 1 open starter slot');
    expect(output).toContain('NOW · Dynasty League · Roster 8 · Jordan Example needs a lineup check');
    expect(output).toContain('+1 more urgent action');
    expect(output).not.toContain('Fantasy playoffs start next week');
    expect(output).toContain('MY FANTASY');
    expect(output).toContain('ANALYZE');
    expect(output).toContain('Use a numbered action below');
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

  it.each([40, 80, 120])('shows evidence on one line at %i columns and keeps full copy text', async (columns) => {
    const terminal = createTerminal();
    terminal.output.columns = columns;
    const uiState = new InteractiveUiState();
    const renderer = createRenderer(terminal, new MemoryPromptHistory(), uiState);
    const chunks: UIMessageChunk[] = [
      { type: 'start', messageId: 'answer-with-sources' },
      { type: 'start-step' },
      { type: 'text-start', id: 'answer-text' },
      { type: 'text-delta', id: 'answer-text', delta: 'Model answer.' },
      { type: 'text-end', id: 'answer-text' },
      { type: 'finish-step' },
      {
        type: 'source-url',
        sourceId: 'news-1',
        url: 'https://example.com/nfl-report',
        title: 'NFL report',
      },
      { type: 'start-step' },
      { type: 'text-start', id: 'source-text' },
      {
        type: 'text-delta',
        id: 'source-text',
        delta: '\n\n## Evidence\n\n1. [NFL report](<https://example.com/nfl-report>) · **LIVE** · accessed now',
      },
      { type: 'text-end', id: 'source-text' },
      { type: 'finish-step' },
      { type: 'finish', finishReason: 'stop' },
    ];

    await renderer.renderStream({
      uiMessageStream: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    });

    const frame = terminal.output.text().split('\x1b[H').at(-1) ?? '';
    expect(frame.match(/◆ Seb/gu)).toHaveLength(1);
    expect(frame).toContain('Model answer.');
    expect(frame).toContain('Evidence · /sources for details');
    expect(frame).not.toContain('NFL report');
    expect(frame).not.toContain('accessed now');
    expect(stripAnsi(frame).split('\r\n').filter((line) => line.includes('Evidence'))).toHaveLength(1);
    expect(uiState.latestAnswer).toContain('NFL report');
    expect(uiState.latestAnswer).toContain('LIVE');
    renderer.close();
  });

  it('colors the one-line evidence summary and leaves requested details expanded', async () => {
    const terminal = createTerminal();
    terminal.output.columns = 40;
    const uiState = new InteractiveUiState();
    uiState.recordAnswerEvidence({ answerId: 'evidence-color', capturedAt: new Date().toISOString(),
      sources: Array.from({ length: 7 }, (_, index) => ({
        id: `source-${index}`, label: `Source ${index}`, url: `https://example.com/${index}`,
        accessedAt: new Date().toISOString(),
      })) });
    const renderer = new SebTerminalRenderer({
      input: terminal.input, output: terminal.output, environment: {}, history: new MemoryPromptHistory(),
      model: 'test-model', session: createSessionState(), sources: new SourceTracker(), uiState, version: 'test',
    });
    await renderer.renderStream({ uiMessageStream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'start', messageId: 'evidence-color' });
      controller.enqueue({ type: 'text-start', id: 'answer' });
      controller.enqueue({ type: 'text-delta', id: 'answer', delta: 'Answer.' });
      controller.enqueue({ type: 'text-end', id: 'answer' });
      controller.enqueue({ type: 'text-start', id: 'evidence' });
      controller.enqueue({ type: 'text-delta', id: 'evidence', delta: '## Evidence\n\n1. Long source details' });
      controller.enqueue({ type: 'text-end', id: 'evidence' });
      controller.enqueue({ type: 'finish', finishReason: 'stop' });
      controller.close();
    } }) });
    const frame = terminal.output.text().split('\x1b[H').at(-1) ?? '';
    expect(frame).toContain('\x1b[94m  Evidence: 7 sources · /sources');
    expect(stripAnsi(frame).split('\r\n').every((line) => visibleLength(line) <= 40)).toBe(true);
    await renderText(renderer, '## Evidence for the latest answer\n\nFull source details stay visible.');
    expect(stripAnsi(terminal.output.text().split('\x1b[H').at(-1) ?? '')).toContain('Full source details stay visible.');
    renderer.close();
  });

  it('keeps errors from separate streams in the transcript', async () => {
    const terminal = createTerminal();
    terminal.output.rows = 40;
    const renderer = createRenderer(terminal);

    await renderer.renderStream({
      uiMessageStream: new ReadableStream({
        start(controller) {
          controller.error(new Error('First stream failed'));
        },
      }),
    });
    await renderer.renderStream({
      uiMessageStream: new ReadableStream({
        start(controller) {
          controller.error(new Error('Second stream failed'));
        },
      }),
    });

    const frame = stripAnsi(terminal.output.text().split('\x1b[H').at(-1) ?? '');
    expect(frame).toContain('First stream failed');
    expect(frame).toContain('Second stream failed');
  });

  it('keeps the last completed answer when Escape stops a stream', async () => {
    const uiState = new InteractiveUiState();
    uiState.latestAnswer = 'Last complete answer';
    const terminal = createTerminal();
    const renderer = createRenderer(terminal, new MemoryPromptHistory(), uiState);
    let controller: ReadableStreamDefaultController<UIMessageChunk> | undefined;
    let closed = false;
    const rendered = renderer.renderStream({
      abort: () => {
        if (closed) return;
        closed = true;
        controller?.close();
      },
      uiMessageStream: new ReadableStream({
        start(streamController) {
          controller = streamController;
          streamController.enqueue({ type: 'start', messageId: 'partial-answer' });
          streamController.enqueue({ type: 'text-start', id: 'partial-text' });
          streamController.enqueue({
            type: 'text-delta',
            id: 'partial-text',
            delta: 'Partial current answer',
          });
        },
      }),
    });

    await expect.poll(() => terminal.output.text()).toContain('Partial current answer');
    terminal.input.type('\x1b');
    await rendered;

    expect(uiState.latestAnswer).toBe('Last complete answer');
  });

  it('keeps the last completed answer when the provider stream fails', async () => {
    const uiState = new InteractiveUiState();
    uiState.latestAnswer = 'Last complete answer';
    const terminal = createTerminal();
    const renderer = createRenderer(terminal, new MemoryPromptHistory(), uiState);

    const response = await renderer.renderStream({
      uiMessageStream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'start', messageId: 'failed-answer' });
          controller.enqueue({ type: 'text-start', id: 'partial-text' });
          controller.enqueue({
            type: 'text-delta',
            id: 'partial-text',
            delta: 'Partial current answer',
          });
          controller.enqueue({ type: 'text-end', id: 'partial-text' });
          controller.enqueue({
            type: 'error',
            errorText: 'Gemini rejected the request as invalid.',
          });
          controller.enqueue({ type: 'finish', finishReason: 'error' });
          controller.close();
        },
      }),
    });

    expect(response).toBeUndefined();
    expect(uiState.latestAnswer).toBe('Last complete answer');
    expect(stripAnsi(terminal.output.text())).toContain(
      'Gemini rejected the request as invalid.',
    );
  });

  it('keeps the last completed answer while tool approval is pending', async () => {
    const uiState = new InteractiveUiState();
    uiState.latestAnswer = 'Last complete answer';
    const terminal = createTerminal();
    const renderer = createRenderer(terminal, new MemoryPromptHistory(), uiState);

    const response = await renderer.renderStream({
      uiMessageStream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'start', messageId: 'approval-answer' });
          controller.enqueue({ type: 'start-step' });
          controller.enqueue({ type: 'text-start', id: 'approval-text' });
          controller.enqueue({
            type: 'text-delta',
            id: 'approval-text',
            delta: 'I will make this change.',
          });
          controller.enqueue({ type: 'text-end', id: 'approval-text' });
          controller.enqueue({
            type: 'tool-input-available',
            dynamic: true,
            input: { target: 'example' },
            toolCallId: 'approval-tool',
            toolName: 'exampleTool',
          });
          controller.enqueue({
            type: 'tool-approval-request',
            approvalId: 'approval-1',
            toolCallId: 'approval-tool',
          });
          controller.enqueue({ type: 'finish-step' });
          controller.enqueue({ type: 'finish', finishReason: 'tool-calls' });
          controller.close();
        },
      }),
    });

    expect(response?.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'approval-requested' }),
    ]));
    expect(uiState.latestAnswer).toBe('Last complete answer');
  });

  it('shows an intermediate tool error as a retry and removes it after success', async () => {
    const terminal = createTerminal();
    const renderer = createRenderer(terminal);
    let streamController: ReadableStreamDefaultController<UIMessageChunk> | undefined;
    const rendered = renderer.renderStream({
      uiMessageStream: new ReadableStream({
        start(controller) {
          streamController = controller;
          controller.enqueue({ type: 'start', messageId: 'retried-search' });
          controller.enqueue({
            type: 'tool-input-available',
            toolCallId: 'search-1',
            toolName: 'searchCurrentNews',
            input: {},
          });
          controller.enqueue({
            type: 'tool-output-error',
            toolCallId: 'search-1',
            errorText: 'Temporary provider error',
          });
        },
      }),
    });

    await expect.poll(() => terminal.output.text().split('\x1b[H').at(-1)).toContain('retrying');
    const retryFrame = terminal.output.text().split('\x1b[H').at(-1) ?? '';
    expect(retryFrame).not.toContain('Temporary provider error');

    streamController?.enqueue({
      type: 'tool-input-available',
      toolCallId: 'search-2',
      toolName: 'searchCurrentNews',
      input: {},
    });
    streamController?.enqueue({
      type: 'tool-output-available',
      toolCallId: 'search-2',
      output: { result: 'Found' },
    });
    streamController?.enqueue({ type: 'text-start', id: 'answer-text' });
    streamController?.enqueue({
      type: 'text-delta',
      id: 'answer-text',
      delta: 'Search completed.',
    });
    streamController?.enqueue({ type: 'text-end', id: 'answer-text' });
    streamController?.enqueue({ type: 'finish', finishReason: 'stop' });
    streamController?.close();
    await rendered;

    const finalFrame = terminal.output.text().split('\x1b[H').at(-1) ?? '';
    expect(finalFrame).not.toContain('Temporary provider error');
    expect(finalFrame).not.toContain('retrying');
    expect(finalFrame).toContain('Search completed.');
  });

  it('shows an unrecovered tool error after the stream ends', async () => {
    const terminal = createTerminal();
    const renderer = createRenderer(terminal);

    await renderer.renderStream({
      uiMessageStream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'start', messageId: 'failed-search' });
          controller.enqueue({
            type: 'tool-input-available',
            toolCallId: 'search-1',
            toolName: 'searchCurrentNews',
            input: {},
          });
          controller.enqueue({
            type: 'tool-output-error',
            toolCallId: 'search-1',
            errorText: 'Final provider error',
          });
          controller.enqueue({ type: 'finish', finishReason: 'error' });
          controller.close();
        },
      }),
    });

    const frame = terminal.output.text().split('\x1b[H').at(-1) ?? '';
    expect(frame).toContain('Final provider error');
    expect(frame).not.toContain('retrying');
  });
});

function createRenderer(
  terminal: ReturnType<typeof createTerminal>,
  history: PromptHistory = new MemoryPromptHistory(),
  uiState = new InteractiveUiState(),
  copyText: (text: string) => void = () => undefined,
  session = createSessionState(new Date('2026-08-20T12:00:00Z')),
) {
  return new SebTerminalRenderer({
    copyText,
    environment: { NO_COLOR: '1' },
    history,
    input: terminal.input,
    model: 'test-model',
    output: terminal.output,
    session,
    sources: new SourceTracker(),
    uiState,
    version: '0.0.10',
  });
}

function createTerminal() {
  class Input extends EventEmitter {
    isTTY = true;
    pauseCount = 0;
    rawModes: boolean[] = [];
    pause(): this { this.pauseCount += 1; return this; }
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

async function renderText(renderer: SebTerminalRenderer, text: string): Promise<void> {
  await renderer.renderStream({ uiMessageStream: new ReadableStream({ start(controller) {
    controller.enqueue({ type: 'text-start', id: 'text' });
    controller.enqueue({ type: 'text-delta', id: 'text', delta: text });
    controller.enqueue({ type: 'text-end', id: 'text' });
    controller.enqueue({ type: 'finish', finishReason: 'stop' });
    controller.close();
  } }) });
}
