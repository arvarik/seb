import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';
import type { UIMessageChunk } from 'ai';

import { MemoryPromptHistory } from '../src/interactive/history.js';
import type { PromptHistory } from '../src/interactive/history.js';
import { SebTerminalRenderer } from '../src/interactive/renderer.js';
import { stripAnsi } from '../src/interactive/presentation.js';
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

  it('releases mouse reporting for native text selection', async () => {
    const terminal = createTerminal();
    const renderer = createRenderer(terminal);
    const prompt = renderer.readPrompt();

    terminal.input.type('/select\r');
    expect(terminal.output.text()).toContain('Selection mode');
    expect(terminal.output.text()).toContain('\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l');

    terminal.input.type('ignored while selecting');
    terminal.input.type('\x1b');
    expect(terminal.output.text()).toContain('\x1b[?1000h\x1b[?1002h\x1b[?1006h');

    terminal.input.type('new request\r');
    await expect(prompt).resolves.toBe('new request');
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

  it('opens a completed answer at its Decision section', async () => {
    const terminal = createTerminal();
    terminal.output.columns = 80;
    terminal.output.rows = 18;
    const renderer = createRenderer(terminal);
    const preamble = Array.from({ length: 20 }, (_, index) => `Research note ${index + 1}`);
    const details = Array.from({ length: 20 }, (_, index) => `Decision detail ${index + 1}`);

    await renderer.renderStream({
      uiMessageStream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'start', messageId: 'decision-answer' });
          controller.enqueue({ type: 'text-start', id: 'decision-text' });
          controller.enqueue({
            type: 'text-delta',
            id: 'decision-text',
            delta: [...preamble, '## Decision', ...details].join('\n'),
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

  it('keeps the evidence panel inside the current Seb response', async () => {
    const terminal = createTerminal();
    const renderer = createRenderer(terminal);
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
    expect(frame).toContain('EVIDENCE');
    expect(frame).toContain('NFL report');
    expect(frame).toContain('LIVE');
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
