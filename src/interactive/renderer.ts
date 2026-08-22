import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';

import {
  getToolName,
  isToolUIPart,
  readUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';

import type { SourceTracker } from '../sources.js';
import {
  completeInteractiveInput,
  findInteractiveCommand,
  interactiveCommandArgumentError,
  NFL_TEAM_CODES,
  parseInteractiveCommandInput,
} from './commands.js';
import { PromptEditor, TerminalKeyParser, type TerminalKey } from './editor.js';
import type { PromptHistory } from './history.js';
import {
  formatElapsed,
  friendlyToolName,
  osc52,
  renderAnalysisText,
  sanitizeTerminalText,
  sliceTerminalColumns,
  sourceBadge,
  stripAnsi,
  terminalGraphemes,
  visibleLength,
  wrapTerminalLine,
} from './presentation.js';
import {
  compareFantasyLeagueActions,
  type FantasyLeagueAction,
} from '../sleeper/action-center.js';
import {
  experienceTitle,
  getContextualSuggestions,
  type SessionState,
} from './session.js';
import { getSkill } from './skills.js';
import {
  createTheme,
  paint,
  parseIconMode,
  parseThemeName,
  symbol,
  type SebTheme,
} from './theme.js';
import type { InteractiveUiState } from './ui-state.js';

export interface SebTerminalInput {
  isTTY?: boolean;
  off(event: 'data', listener: (chunk: Buffer) => void): SebTerminalInput;
  on(event: 'data', listener: (chunk: Buffer) => void): SebTerminalInput;
  pause(): SebTerminalInput;
  resume(): SebTerminalInput;
  setRawMode?(mode: boolean): SebTerminalInput;
}

export interface SebTerminalOutput {
  columns?: number;
  isTTY?: boolean;
  rows?: number;
  off(event: 'resize', listener: () => void): SebTerminalOutput;
  on(event: 'resize', listener: () => void): SebTerminalOutput;
  write(chunk: string | Uint8Array): boolean;
}

export interface SebRendererStreamResult {
  abort?: () => void;
  message?: UIMessage;
  uiMessageStream: AsyncIterable<UIMessageChunk> | ReadableStream<UIMessageChunk>;
}

export interface SebRendererSessionOptions {
  continueSession?: boolean;
  submittedPrompt?: string;
  title?: string;
}

export interface SebRendererToolApprovalRequest {
  input: unknown;
  title?: string;
  toolName: string;
}

export interface SebRendererOptions {
  copyText?: (text: string) => void;
  environment: NodeJS.ProcessEnv;
  history: PromptHistory;
  input: SebTerminalInput;
  model: string;
  output: SebTerminalOutput;
  session: SessionState;
  sources: SourceTracker;
  uiState: InteractiveUiState;
  version: string;
}

type SectionKind = 'assistant' | 'error' | 'tool' | 'user';

interface Section {
  content: string;
  id: string;
  kind: SectionKind;
  title: string;
}

interface BodyRow {
  sectionId?: string;
  sectionRowCount?: number;
  sectionRowIndex?: number;
  text: string;
}

interface ViewportAnchor {
  rowRatio: number;
  sectionId: string;
}

interface ScreenPoint {
  column: number;
  row: number;
}

interface ScreenSelection {
  anchor: ScreenPoint;
  focus: ScreenPoint;
  moved: boolean;
}

type ContextField = 'league' | 'roster' | 'week' | 'player' | 'team';

interface ContextChoice {
  command: string;
  label: string;
  selected: boolean;
}

interface ContextItem {
  choices: ContextChoice[];
  field: ContextField;
  label: string;
  value: string;
}

const SPINNERS = ['◐', '◓', '◑', '◒'] as const;
const FRAME_INTERVAL_MS = Math.ceil(1000 / 60);
const MINIMUM_TERMINAL_HEIGHT = 16;
const MINIMUM_TERMINAL_WIDTH = 40;
const MOUSE_WHEEL_LINES = 3;
const MOUSE_REPORTING_OFF = '\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l';
const MOUSE_REPORTING_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const TERMINAL_CONTROL_AT_START = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/u;

export class SebTerminalRenderer {
  private active = false;
  private activeStartedAt = 0;
  private activeToolIds = new Set<string>();
  private answerFocus: 'Decision' | 'answer' | null = null;
  private contextChoices = new Map<ContextField, number>();
  private contextSelection = 0;
  private editor = new PromptEditor();
  private exitRequested = false;
  private framePlainLines: string[] = [];
  private historyIndex = -1;
  private interrupted = false;
  private keyParser = new TerminalKeyParser();
  private lastFrame = '';
  private lastPaintAt = 0;
  private lastWidth = 0;
  private maximumScrollOffset = 0;
  private menuOpen = false;
  private menuSelection = 0;
  private onData: ((chunk: Buffer) => void) | undefined;
  private onResize: (() => void) | undefined;
  private overlay: 'none' | 'shortcuts' | 'history' | 'context' = 'none';
  private readonly options: SebRendererOptions;
  private paintTimer: ReturnType<typeof setTimeout> | undefined;
  private scrollOffset = 0;
  private screenSelection: ScreenSelection | undefined;
  private selectionMode = false;
  private sections: Section[] = [];
  private status = 'Ready';
  private streamMessage: UIMessage | undefined;
  private streamStartedAt = 0;
  private streamStop: (() => void) | undefined;
  private theme: SebTheme;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private toolDurations = new Map<string, number>();
  private toolStartedAt = new Map<string, number>();
  private viewportAnchor: ViewportAnchor | undefined;
  private viewportHeight = 3;

  constructor(options: SebRendererOptions) {
    this.options = options;
    options.uiState.theme = parseThemeName(options.environment.SEB_THEME);
    options.uiState.iconMode = parseIconMode(options.environment.SEB_ICONS);
    this.theme = createTheme(options.environment, options.uiState);
  }

  async readPrompt(options?: SebRendererSessionOptions): Promise<string | undefined> {
    this.start();
    this.status = this.options.uiState.notification || 'Ready';
    this.options.uiState.notification = '';
    this.editor.set('');
    this.historyIndex = -1;
    this.interrupted = false;
    this.exitRequested = false;
    this.paint();
    return await new Promise<string | undefined>((resolve, reject) => {
      this.onData = (chunk) => {
        for (const key of this.keyParser.parse(chunk)) {
          void this.handlePromptKey(key, resolve, reject);
        }
      };
      this.attachInput();
      if (options?.title) this.paint();
    });
  }

  async renderStream(
    result: SebRendererStreamResult,
  ): Promise<UIMessage | undefined> {
    this.start();
    this.detachInput();
    this.interrupted = false;
    this.streamStartedAt = Date.now();
    this.activeStartedAt = this.streamStartedAt;
    this.status = 'Thinking';
    this.streamStop = result.abort;
    this.startTicker();
    this.onData = (chunk) => {
      for (const key of this.keyParser.parse(chunk)) this.handleStreamKey(key);
    };
    this.attachInput();
    let response = result.message;
    const stream = toReadableStream(result.uiMessageStream);
    try {
      const messages = readUIMessageStream({
        ...(result.message ? { message: result.message } : {}),
        stream,
        onError: (error) => this.upsert({
          content: errorMessage(error),
          id: 'stream-error',
          kind: 'error',
          title: 'Error',
        }),
      });
      for await (const message of messages) {
        response = message;
        this.streamMessage = message;
        this.renderMessage(message);
        if (this.interrupted) break;
      }
    } catch (error) {
      if (!this.interrupted) {
        this.upsert({ content: errorMessage(error), id: 'stream-error', kind: 'error', title: 'Error' });
      }
    } finally {
      if (this.interrupted) result.abort?.();
      this.stopTicker();
      this.detachInput();
      if (!this.interrupted && response) this.renderMessage(response, true);
      this.activeToolIds.clear();
      this.status = this.interrupted
        ? 'Request stopped'
        : `Ready · ${formatElapsed(Date.now() - this.streamStartedAt)}`;
      this.captureAnswer(response);
      this.options.uiState.sources = this.options.sources.list();
      this.focusLatestAnswer();
      this.paint();
      this.streamStop = undefined;
    }
    if (this.exitRequested) throw new Error('Interrupted');
    return response;
  }

  async readToolApproval(
    request: SebRendererToolApprovalRequest,
  ): Promise<{ approved: boolean; reason?: string }> {
    this.start();
    this.status = `Approve ${request.title ?? friendlyToolName(request.toolName)}? y/n`;
    this.paint();
    return await new Promise((resolve, reject) => {
      this.onData = (chunk) => {
        for (const key of this.keyParser.parse(chunk)) {
          if (key.type === 'character' && key.value.toLowerCase() === 'y') {
            this.detachInput();
            resolve({ approved: true });
          } else if (key.type === 'character' && key.value.toLowerCase() === 'n') {
            this.detachInput();
            resolve({ approved: false, reason: 'The user denied the tool call.' });
          } else if (key.type === 'ctrl-c' || key.type === 'escape') {
            this.stop();
            reject(new Error('Interrupted'));
          }
        }
      };
      this.attachInput();
    });
  }

  private async handlePromptKey(
    key: TerminalKey,
    resolve: (value: string | undefined) => void,
    reject: (reason: Error) => void,
  ): Promise<void> {
    if (this.handleMouseSelection(key)) return;
    if (key.type === 'ctrl-c' && this.copyScreenSelection()) return;
    if (this.screenSelection) {
      this.screenSelection = undefined;
      this.requestPaint();
    }
    if (this.selectionMode) {
      if (key.type === 'ctrl-c') {
        this.stop();
        reject(new Error('Interrupted'));
      } else if (key.type === 'escape' || key.type === 'enter') {
        this.leaveSelectionMode();
      }
      return;
    }
    if (this.overlay === 'context') {
      await this.handleContextKey(key, resolve, reject);
      return;
    }
    if (this.overlay !== 'none') {
      if (key.type === 'ctrl-c') {
        this.stop();
        reject(new Error('Interrupted'));
        return;
      }
      if (key.type === 'escape' || key.type === 'enter' || key.type === 'character') {
        this.overlay = 'none';
        this.paint();
      }
      return;
    }
    const menu = this.menuCompletions();
    if (this.menuOpen || (this.editor.text().startsWith('/') && menu.length > 0)) {
      if (key.type === 'up' || key.type === 'down') {
        this.menuOpen = true;
        this.menuSelection = cycle(this.menuSelection, key.type === 'up' ? -1 : 1, menu.length);
        this.paint();
        return;
      }
      if (key.type === 'tab') {
        this.acceptMenu();
        return;
      }
      if (key.type === 'escape') {
        this.menuOpen = false;
        if (this.editor.text() === '/') this.editor.set('');
        this.paint();
        return;
      }
    }
    switch (key.type) {
      case 'character':
        if (this.editor.text() === '' && /^[123]$/u.test(key.value)) {
          const suggestion = this.suggestions()[Number(key.value) - 1];
          if (suggestion) {
            this.editor.set(suggestion);
            if (!suggestion.includes('<')) await this.submitPrompt(resolve);
            else this.paint();
            return;
          }
        }
        if (this.editor.text() === '' && key.value === '?') {
          this.overlay = 'shortcuts';
          this.paint();
          return;
        }
        this.editor.insert(key.value);
        this.resetMenu();
        break;
      case 'paste': this.editor.insert(sanitizeTerminalText(key.value.replace(/\r\n?/g, '\n'))); break;
      case 'backspace': this.editor.backspace(); this.resetMenu(); break;
      case 'delete': this.editor.deleteForward(); break;
      case 'left': this.editor.moveLeft(); break;
      case 'right': this.editor.moveRight(); break;
      case 'word-left': this.editor.moveWordLeft(); break;
      case 'word-right': this.editor.moveWordRight(); break;
      case 'home':
      case 'ctrl-a': this.editor.moveHome(); break;
      case 'end':
      case 'ctrl-e': this.editor.moveEnd(); break;
      case 'ctrl-u': this.editor.deleteToStart(); break;
      case 'ctrl-w': this.editor.deleteWordBackward(); break;
      case 'newline': this.editor.insert('\n'); break;
      case 'up': this.recallHistory(1); break;
      case 'down': this.recallHistory(-1); break;
      case 'page-up': this.scroll(this.pageScrollLines()); return;
      case 'page-down': this.scroll(-this.pageScrollLines()); return;
      case 'scroll-up': this.scroll(MOUSE_WHEEL_LINES); return;
      case 'scroll-down': this.scroll(-MOUSE_WHEEL_LINES); return;
      case 'ctrl-r': this.reverseSearch(); break;
      case 'ctrl-g': this.openContextSelector(); break;
      case 'ctrl-k': this.menuOpen = true; if (!this.editor.text()) this.editor.set('/'); break;
      case 'ctrl-l': this.paint(true); return;
      case 'escape': this.stop(); reject(new Error('Interrupted')); return;
      case 'ctrl-c': this.stop(); reject(new Error('Interrupted')); return;
      case 'enter':
        if (this.menuOpen && this.editor.text() === '/') {
          this.acceptMenu();
          return;
        }
        await this.submitPrompt(resolve);
        return;
      case 'tab':
      case 'ignore': return;
    }
    this.paint();
  }

  private async submitPrompt(resolve: (value: string | undefined) => void): Promise<void> {
    const prompt = this.editor.text().trim();
    if (!prompt) return;
    const parsed = parseInteractiveCommandInput(prompt);
    const localCommand = parsed?.command ?? null;
    if (localCommand) this.options.uiState.recordCommand(localCommand.name);
    if (parsed) {
      const argumentError = interactiveCommandArgumentError(parsed);
      if (argumentError) {
        this.status = argumentError;
        this.paint();
        return;
      }
    }
    if (localCommand?.name === 'exit') {
      this.editor.set('');
      this.stop();
      resolve(undefined);
      return;
    }
    if (localCommand?.name === 'shortcuts') {
      this.overlay = 'shortcuts';
      this.editor.set('');
      this.paint();
      return;
    }
    if (localCommand?.name === 'edit') {
      this.editor.set(this.options.uiState.latestPrompt);
      this.status = this.editor.text() ? 'Editing the last prompt' : 'No model prompt is available';
      this.paint();
      return;
    }
    if (localCommand?.name === 'retry') {
      if (!this.options.uiState.latestPrompt) {
        this.status = 'No model prompt is available';
        this.editor.set('');
        this.paint();
        return;
      }
      this.editor.set(this.options.uiState.latestPrompt);
      await this.finishSubmission(this.options.uiState.latestPrompt, resolve);
      return;
    }
    if (localCommand?.name === 'copy') {
      const answer = this.options.uiState.latestAnswer;
      if (answer && this.options.output.isTTY !== false) {
        this.copyText(answer);
        this.status = 'Copied the latest answer';
      } else {
        this.status = 'No answer is available to copy';
      }
      this.editor.set('');
      this.paint();
      return;
    }
    if (localCommand?.name === 'select') {
      this.enterSelectionMode();
      return;
    }
    if (localCommand?.name === 'history' && (
      parsed?.arguments.length === 0 || parsed?.arguments[0]?.toLowerCase() === 'clear'
    )) {
      if (parsed.arguments[0]?.toLowerCase() === 'clear') {
        try {
          await this.options.history.clear();
          this.status = 'Cleared the private prompt history';
        } catch (error) {
          this.status = errorMessage(error);
        }
      } else {
        this.overlay = 'history';
      }
      this.editor.set('');
      this.paint();
      return;
    }
    const theme = localCommand?.name === 'theme' && parsed?.arguments.length === 1
      ? parsed.arguments[0]?.toLowerCase().match(/^(default|high-contrast|contrast|compact)$/u)?.[1]
      : undefined;
    if (theme) {
      this.options.uiState.theme = parseThemeName(theme);
      this.theme = createTheme(this.options.environment, this.options.uiState);
      this.editor.set('');
      this.status = `Selected the ${this.options.uiState.theme} theme`;
      this.paint(true);
      return;
    }
    const icons = localCommand?.name === 'icons' && parsed?.arguments.length === 1
      ? parsed.arguments[0]?.toLowerCase().match(/^(unicode|ascii)$/u)?.[1]
      : undefined;
    if (icons) {
      this.options.uiState.iconMode = parseIconMode(icons);
      this.theme = createTheme(this.options.environment, this.options.uiState);
      this.editor.set('');
      this.status = `Selected ${icons} symbols`;
      this.paint(true);
      return;
    }
    await this.finishSubmission(prompt, resolve);
  }

  private async handleContextKey(
    key: TerminalKey,
    resolve: (value: string | undefined) => void,
    reject: (reason: Error) => void,
  ): Promise<void> {
    const items = this.contextItems();
    const item = items[this.contextSelection];
    if (key.type === 'ctrl-c') {
      this.stop();
      reject(new Error('Interrupted'));
      return;
    }
    if (key.type === 'escape' || key.type === 'ctrl-g') {
      this.overlay = 'none';
      this.status = 'Ready';
      this.paint();
      return;
    }
    if (key.type === 'up' || key.type === 'down') {
      this.contextSelection = cycle(
        this.contextSelection,
        key.type === 'up' ? -1 : 1,
        items.length,
      );
      this.paint();
      return;
    }
    if ((key.type === 'left' || key.type === 'right') && item?.choices.length) {
      const current = this.contextChoices.get(item.field) ?? 0;
      this.contextChoices.set(
        item.field,
        cycle(current, key.type === 'left' ? -1 : 1, item.choices.length),
      );
      this.paint();
      return;
    }
    if (key.type !== 'enter' || !item) return;
    if (item.field === 'player') {
      this.overlay = 'none';
      this.editor.set('/skill player-info ');
      this.status = 'Type a player name and question';
      this.paint();
      return;
    }
    const choiceIndex = this.contextChoices.get(item.field) ?? 0;
    const choice = item.choices[choiceIndex];
    if (!choice) return;
    this.overlay = 'none';
    this.editor.set(choice.command);
    await this.submitPrompt(resolve);
  }

  private openContextSelector(): void {
    this.overlay = 'context';
    this.menuOpen = false;
    this.contextSelection = 0;
    this.contextChoices.clear();
    for (const item of this.contextItems()) {
      const selected = item.choices.findIndex((choice) => choice.selected);
      this.contextChoices.set(item.field, Math.max(0, selected));
    }
    this.status = 'Context selector';
  }

  private contextItems(): ContextItem[] {
    const session = this.options.session;
    const focusedLeague = session.leagues.find(
      (league) => league.leagueId === session.leagueId,
    );
    const rosterOptions = focusedLeague?.rosterIds ?? session.rosterOptions;
    const items: Array<Omit<ContextItem, 'value'>> = [
      {
        choices: [
          { command: '/league all', label: 'All leagues', selected: session.leagueId === null },
          ...session.leagues.map((league) => ({
            command: `/league ${league.leagueId}`,
            label: league.name,
            selected: session.leagueId === league.leagueId,
          })),
        ],
        field: 'league',
        label: 'League',
      },
      {
        choices: [
          { command: '/roster clear', label: 'Automatic', selected: session.rosterId === null },
          ...[...new Set(rosterOptions)].map((rosterId) => ({
            command: `/roster ${rosterId}`,
            label: `Roster ${rosterId}`,
            selected: session.rosterId === rosterId,
          })),
        ],
        field: 'roster',
        label: 'Roster',
      },
      {
        choices: [
          { command: '/week current', label: 'Refresh current', selected: false },
          { command: '/week clear', label: 'Unset', selected: session.week === null },
          ...Array.from({ length: 22 }, (_, index) => index + 1).map((week) => ({
            command: `/week ${week}`,
            label: `Week ${week}`,
            selected: session.week === week,
          })),
        ],
        field: 'week',
        label: 'Week',
      },
      {
        choices: [],
        field: 'player',
        label: 'Player',
      },
      {
        choices: [
          { command: '/team clear', label: 'No team', selected: session.team === null },
          ...NFL_TEAM_CODES.map((team) => ({
            command: `/team ${team}`,
            label: team,
            selected: session.team === team,
          })),
        ],
        field: 'team',
        label: 'Team',
      },
    ];
    return items.map((item) => {
      if (item.field === 'player') {
        return { ...item, value: session.player ?? 'No player' };
      }
      const fallback = Math.max(0, item.choices.findIndex((choice) => choice.selected));
      const choice = item.choices[this.contextChoices.get(item.field) ?? fallback];
      return { ...item, value: choice?.label ?? 'Not available' };
    });
  }

  private async finishSubmission(
    prompt: string,
    resolve: (value: string | undefined) => void,
  ): Promise<void> {
    this.answerFocus = null;
    this.scrollOffset = 0;
    this.options.uiState.showSuggestions = false;
    try {
      await this.options.history.add(prompt);
    } catch (error) {
      this.options.uiState.notification = errorMessage(error);
    }
    if (!prompt.startsWith('/')) {
      this.options.uiState.latestPrompt = prompt;
    }
    this.upsert({ content: prompt, id: `user-${Date.now()}`, kind: 'user', title: 'You' });
    this.editor.set('');
    this.detachInput();
    this.status = 'Thinking';
    this.paint();
    resolve(prompt);
  }

  private handleStreamKey(key: TerminalKey): void {
    if (this.handleMouseSelection(key)) return;
    if (key.type === 'ctrl-c' && this.copyScreenSelection()) return;
    if (this.screenSelection) {
      this.screenSelection = undefined;
      this.requestPaint();
    }
    if (key.type === 'escape') {
      this.interrupted = true;
      this.status = 'Stopping the current request';
      this.streamStop?.();
      this.paint();
    } else if (key.type === 'ctrl-c') {
      this.interrupted = true;
      this.exitRequested = true;
      this.streamStop?.();
      this.stop();
    } else if (key.type === 'page-up' || key.type === 'up') {
      this.scroll(key.type === 'page-up' ? this.pageScrollLines() : 1);
    } else if (key.type === 'page-down' || key.type === 'down') {
      this.scroll(key.type === 'page-down' ? -this.pageScrollLines() : -1);
    } else if (key.type === 'scroll-up' || key.type === 'scroll-down') {
      this.scroll(key.type === 'scroll-up' ? MOUSE_WHEEL_LINES : -MOUSE_WHEEL_LINES);
    } else if (key.type === 'ctrl-l') {
      this.paint(true);
    }
  }

  private renderMessage(message: UIMessage, final = false): void {
    const width = Math.max(40, this.options.output.columns ?? 80);
    const previousBodyLength = this.scrollOffset > 0
      ? this.renderBody(width).length
      : null;
    const active = new Set<string>();
    for (const [index, part] of message.parts.entries()) {
      const id = `${message.id}:${index}`;
      if (part.type === 'text' && part.text.trim()) {
        const continuationIndex = /^(?:##\s+Evidence\b|Web sources:)/u.test(part.text.trimStart())
          ? previousTextPartIndex(message.parts, index)
          : undefined;
        if (continuationIndex !== undefined) {
          const continuationId = `${message.id}:${continuationIndex}`;
          const previousPart = message.parts[continuationIndex];
          active.add(continuationId);
          this.upsert({
            content: `${previousPart?.type === 'text' ? previousPart.text : ''}${part.text}`,
            id: continuationId,
            kind: 'assistant',
            title: 'Seb',
          });
        } else {
          active.add(id);
          this.upsert({ content: part.text, id, kind: 'assistant', title: 'Seb' });
        }
      } else if (isToolUIPart(part)) {
        const state = part.state;
        const name = getToolName(part);
        if (state === 'output-error' && hasLaterToolAttempt(message.parts, index, name)) {
          this.activeToolIds.delete(id);
          continue;
        }
        active.add(id);
        const retrying = state === 'output-error' && !final;
        const running = retrying || state === 'input-streaming' || state === 'input-available' || state === 'approval-requested';
        if (running) {
          this.activeToolIds.add(id);
          if (!this.toolStartedAt.has(id)) this.toolStartedAt.set(id, Date.now());
        } else {
          this.activeToolIds.delete(id);
          const startedAt = this.toolStartedAt.get(id);
          if (startedAt !== undefined && !this.toolDurations.has(id)) {
            this.toolDurations.set(id, Date.now() - startedAt);
          }
        }
        const failed = state === 'output-denied' || (state === 'output-error' && final);
        const marker = failed ? symbol(this.theme, 'danger') : running ? this.spinner() : symbol(this.theme, 'done');
        const startedAt = this.toolStartedAt.get(id) ?? this.activeStartedAt;
        const elapsed = formatElapsed(running
          ? Date.now() - startedAt
          : this.toolDurations.get(id) ?? Date.now() - startedAt);
        const detail = failed && 'errorText' in part ? ` · ${part.errorText}` : '';
        this.upsert({
          content: `${marker} ${friendlyToolName(name)} · ${retrying ? 'retrying' : elapsed}${detail}`,
          id,
          kind: failed ? 'error' : 'tool',
          title: running ? 'Working' : 'Tool',
        });
        if (running) {
          this.status = retrying
            ? `Retrying ${friendlyToolName(name).toLowerCase()}`
            : `${friendlyToolName(name)} · ${elapsed}`;
        }
      }
    }
    this.sections = this.sections.filter((section) =>
      !section.id.startsWith(`${message.id}:`) || active.has(section.id));
    if (previousBodyLength !== null) {
      const bodyLengthChange = this.renderBody(width).length - previousBodyLength;
      this.maximumScrollOffset = Math.max(
        0,
        this.maximumScrollOffset + bodyLengthChange,
      );
      this.scrollOffset = clamp(
        this.scrollOffset + bodyLengthChange,
        0,
        this.maximumScrollOffset,
      );
    }
    this.requestPaint();
  }

  private captureAnswer(message: UIMessage | undefined): void {
    if (!message) return;
    const answer = message.parts
      .filter((part): part is Extract<UIMessage['parts'][number], { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n\n')
      .trim();
    if (answer) this.options.uiState.latestAnswer = answer;
  }

  private menuCompletions() {
    return completeInteractiveInput(this.editor.text(), {
      ...this.options.session,
      recentCommands: this.options.uiState.recentCommands,
    }, 8);
  }

  private acceptMenu(): void {
    const completion = this.menuCompletions()[this.menuSelection];
    if (!completion) return;
    this.editor.set(completion.value);
    this.menuOpen = false;
    this.menuSelection = 0;
    this.paint();
  }

  private resetMenu(): void {
    this.menuOpen = false;
    this.menuSelection = 0;
  }

  private recallHistory(direction: 1 | -1): void {
    const entries = this.options.history.list();
    if (entries.length === 0) return;
    this.historyIndex = Math.max(-1, Math.min(entries.length - 1, this.historyIndex + direction));
    this.editor.set(this.historyIndex < 0 ? '' : entries[this.historyIndex] ?? '');
  }

  private reverseSearch(): void {
    const query = this.editor.text().toLowerCase();
    const match = this.options.history.list().find((entry) => entry.toLowerCase().includes(query));
    if (match) {
      this.editor.set(match);
      this.status = `History match for ${query || 'the latest prompt'}`;
    } else {
      this.status = 'No prompt history match';
    }
  }

  private suggestions(): string[] {
    const suggestions = this.options.uiState.suggestions.length > 0
      ? this.options.uiState.suggestions
      : getContextualSuggestions(this.options.session);
    return suggestions.slice(0, 3);
  }

  private upsert(section: Section): void {
    const index = this.sections.findIndex((candidate) => candidate.id === section.id);
    if (index >= 0) this.sections[index] = section;
    else this.sections.push(section);
  }

  private start(): void {
    if (this.active) return;
    this.active = true;
    this.lastFrame = '';
    this.lastPaintAt = 0;
    this.screenSelection = undefined;
    this.selectionMode = false;
    this.options.output.write(`\x1b[?1049h\x1b[?25l\x1b[?2004h${MOUSE_REPORTING_ON}`);
    if (this.options.input.isTTY) {
      this.options.input.setRawMode?.(true);
      this.options.input.resume();
    }
    this.onResize = () => this.paint(true);
    this.options.output.on('resize', this.onResize);
  }

  private stop(): void {
    this.detachInput();
    this.stopTicker();
    this.cancelPaint();
    if (!this.active) return;
    if (this.options.input.isTTY) {
      this.options.input.setRawMode?.(false);
      this.options.input.pause();
    }
    if (this.onResize) this.options.output.off('resize', this.onResize);
    this.screenSelection = undefined;
    this.selectionMode = false;
    this.options.output.write(`${MOUSE_REPORTING_OFF}\x1b[?2004l\x1b[?25h\x1b[?1049l`);
    this.active = false;
  }

  private attachInput(): void {
    if (this.onData) this.options.input.on('data', this.onData);
  }

  private detachInput(): void {
    if (this.onData) this.options.input.off('data', this.onData);
    this.onData = undefined;
  }

  private startTicker(): void {
    this.stopTicker();
    this.ticker = setInterval(() => {
      if (this.activeToolIds.size > 0) this.renderMessage(this.streamMessage ?? { id: '', role: 'assistant', parts: [] });
      else {
        this.status = `Thinking · ${formatElapsed(Date.now() - this.streamStartedAt)}`;
        this.requestPaint();
      }
    }, 250);
    this.ticker.unref?.();
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private spinner(): string {
    if (this.theme.iconMode === 'ascii') return '*';
    return SPINNERS[Math.floor(Date.now() / 250) % SPINNERS.length] ?? '◌';
  }

  private handleMouseSelection(key: TerminalKey): boolean {
    if (key.type !== 'mouse') return false;
    if (this.selectionMode || this.framePlainLines.length === 0) return true;
    const point = clampScreenPoint(key, this.framePlainLines);
    if (key.action === 'press') {
      this.screenSelection = {
        anchor: point,
        focus: point,
        moved: false,
      };
      this.status = 'Selecting text';
      this.paint();
      return true;
    }
    const selection = this.screenSelection;
    if (!selection) return true;
    selection.focus = point;
    selection.moved = selection.moved || !sameScreenPoint(selection.anchor, point);
    if (key.action === 'drag') {
      this.requestPaint();
      return true;
    }
    if (!selection.moved || !this.copyScreenSelection()) {
      this.screenSelection = undefined;
      this.status = 'Ready';
    }
    this.paint();
    return true;
  }

  private copyScreenSelection(): boolean {
    if (!this.screenSelection?.moved) return false;
    const text = selectedScreenText(this.framePlainLines, this.screenSelection);
    if (!text) return false;
    this.copyText(text);
    const characterCount = terminalGraphemes(text).length;
    this.status = `Copied selection · ${characterCount} character${characterCount === 1 ? '' : 's'}`;
    this.requestPaint();
    return true;
  }

  private copyText(text: string): void {
    this.options.output.write(osc52(text));
    try {
      if (this.options.copyText) this.options.copyText(text);
      else copyToLocalClipboard(text);
    } catch {
      // OSC 52 remains available when the local clipboard command fails.
    }
  }

  private enterSelectionMode(): void {
    this.screenSelection = undefined;
    this.selectionMode = true;
    this.editor.set('');
    this.status = 'Selection mode · drag to select, copy with the terminal shortcut, then press Escape';
    this.options.output.write(MOUSE_REPORTING_OFF);
    this.paint();
  }

  private leaveSelectionMode(): void {
    if (!this.selectionMode) return;
    this.selectionMode = false;
    this.status = 'Ready';
    this.options.output.write(MOUSE_REPORTING_ON);
    this.paint(true);
  }

  private scroll(delta: number): void {
    this.screenSelection = undefined;
    const nextOffset = clamp(
      this.scrollOffset + delta,
      0,
      this.maximumScrollOffset,
    );
    if (nextOffset === this.scrollOffset) return;
    this.answerFocus = null;
    this.scrollOffset = nextOffset;
    this.requestPaint();
  }

  private focusLatestAnswer(): void {
    const width = Math.max(1, this.options.output.columns ?? 80);
    const height = Math.max(1, this.options.output.rows ?? 24);
    if (width < MINIMUM_TERMINAL_WIDTH || height < MINIMUM_TERMINAL_HEIGHT) return;
    const headerHeight = this.renderHeader(width).length;
    const maximumFooterHeight = Math.max(2, height - headerHeight - 3);
    const bodyHeight = Math.max(
      3,
      height - headerHeight - this.renderFooter(width, maximumFooterHeight).length,
    );
    const body = this.renderBody(width);
    const assistantMarker = `${symbol(this.theme, 'assistant')} Seb`;
    let assistantStart = -1;
    for (let index = body.length - 1; index >= 0; index -= 1) {
      if (stripAnsi(body[index] ?? '').trim() === assistantMarker) {
        assistantStart = index;
        break;
      }
    }
    if (assistantStart < 0) return;
    const decision = body.findIndex((line, index) =>
      index > assistantStart && /\bDECISION\b/u.test(stripAnsi(line).toUpperCase()),
    );
    const anchor = decision >= 0 ? decision : assistantStart;
    const maximumOffset = Math.max(0, body.length - bodyHeight);
    const targetOffset = clamp(
      body.length - anchor - bodyHeight,
      0,
      maximumOffset,
    );
    this.maximumScrollOffset = maximumOffset;
    this.viewportHeight = bodyHeight;
    this.scrollOffset = targetOffset;
    this.answerFocus = targetOffset > 0
      ? decision >= 0 ? 'Decision' : 'answer'
      : null;
  }

  private pageScrollLines(): number {
    return Math.max(1, this.viewportHeight - 1);
  }

  private requestPaint(): void {
    if (!this.active) return;
    if (this.paintTimer) return;
    const elapsed = performance.now() - this.lastPaintAt;
    const delay = Math.max(0, FRAME_INTERVAL_MS - elapsed);
    this.paintTimer = setTimeout(() => {
      this.paintTimer = undefined;
      this.paint();
    }, delay);
    this.paintTimer.unref?.();
  }

  private cancelPaint(): void {
    if (this.paintTimer) clearTimeout(this.paintTimer);
    this.paintTimer = undefined;
  }

  private paint(clear = false): void {
    this.cancelPaint();
    if (!this.active) return;
    const width = Math.max(1, this.options.output.columns ?? 80);
    const height = Math.max(1, this.options.output.rows ?? 24);
    if (width < MINIMUM_TERMINAL_WIDTH || height < MINIMUM_TERMINAL_HEIGHT) {
      this.paintSmallTerminal(width, height, clear);
      return;
    }
    const header = this.renderHeader(width);
    const maximumFooterHeight = Math.max(2, height - header.length - 3);
    const footer = this.renderFooter(width, maximumFooterHeight);
    const footerHeight = footer.length;
    const bodyHeight = Math.max(3, height - header.length - footerHeight);
    const bodyRows = this.renderBodyRows(width);
    const body = bodyRows.map((row) => row.text);
    const maximumOffset = Math.max(0, body.length - bodyHeight);
    const transcriptVisible = this.overlay === 'none' && this.sections.length > 0;
    if (transcriptVisible) {
      this.maximumScrollOffset = maximumOffset;
      const widthChanged = this.lastWidth > 0 && width !== this.lastWidth;
      const anchoredOffset = widthChanged && this.scrollOffset > 0 && this.viewportAnchor
        ? offsetForViewportAnchor(bodyRows, bodyHeight, this.viewportAnchor)
        : undefined;
      if (anchoredOffset !== undefined) {
        this.scrollOffset = clamp(anchoredOffset, 0, maximumOffset);
      } else if (this.scrollOffset > 0 && bodyHeight !== this.viewportHeight) {
        this.scrollOffset = clamp(
          this.scrollOffset + this.viewportHeight - bodyHeight,
          0,
          maximumOffset,
        );
      }
      this.viewportHeight = bodyHeight;
      this.scrollOffset = Math.min(this.scrollOffset, maximumOffset);
      this.lastWidth = width;
    }
    const end = this.overlay === 'none' ? body.length - this.scrollOffset : body.length;
    const topAligned = this.overlay !== 'none' || this.sections.length === 0;
    const visibleStart = topAligned ? 0 : Math.max(0, end - bodyHeight);
    const visible = topAligned
      ? body.slice(0, bodyHeight)
      : body.slice(visibleStart, end);
    while (visible.length < bodyHeight) {
      if (topAligned) visible.push('');
      else visible.unshift('');
    }
    if (transcriptVisible) {
      this.viewportAnchor = viewportAnchorForRow(bodyRows[visibleStart]);
    }
    const cleanLines = [...header, ...visible, ...footer].slice(0, height);
    this.framePlainLines = cleanLines.map(stripAnsi);
    const lines = this.screenSelection?.moved
      ? highlightScreenSelection(cleanLines, this.screenSelection)
      : cleanLines;
    const frame = `${width}x${height}\n${lines.join('\n')}`;
    if (!clear && frame === this.lastFrame) return;
    const output = [
      '\x1b[?2026h',
      clear ? '\x1b[2J\x1b[H' : '\x1b[H',
      ...lines.map((line, index) => `${line}\x1b[K${index < lines.length - 1 ? '\r\n' : ''}`),
      '\x1b[?2026l',
    ].join('');
    this.options.output.write(output);
    this.lastFrame = frame;
    this.lastPaintAt = performance.now();
  }

  private paintSmallTerminal(width: number, height: number, clear: boolean): void {
    const lines = [
      paint(this.theme, 'accent', fit(' SEB', width)),
      fit(' Terminal too small', width),
      fit(` Current size: ${width} x ${height}`, width),
      fit(` Required size: ${MINIMUM_TERMINAL_WIDTH} x ${MINIMUM_TERMINAL_HEIGHT}`, width),
      fit(' Resize the terminal to continue.', width),
    ].slice(0, height);
    while (lines.length < height) lines.push('');
    this.framePlainLines = lines.map(stripAnsi);
    const frame = `${width}x${height}\n${lines.join('\n')}`;
    if (!clear && frame === this.lastFrame) return;
    const output = [
      '\x1b[?2026h',
      clear ? '\x1b[2J\x1b[H' : '\x1b[H',
      ...lines.map((line, index) => `${line}\x1b[K${index < lines.length - 1 ? '\r\n' : ''}`),
      '\x1b[?2026l',
    ].join('');
    this.options.output.write(output);
    this.lastFrame = frame;
    this.lastPaintAt = performance.now();
  }

  private renderHeader(width: number): string[] {
    const session = this.options.session;
    const recentSource = this.options.sources.list()[0];
    const source = recentSource ? sourceBadge(recentSource) : 'NO SOURCE YET';
    const phase = session.seasonType?.toUpperCase() ?? 'NFL';
    const title = sanitizeTerminalText(
      ` SEB ${this.options.version}  ${experienceTitle(session.mode).toUpperCase()}  ${session.season} ${phase}${session.week ? ` W${session.week}` : ''}`,
    );
    const context = [
      ...(session.user
        ? [`SLEEPER @${session.user} · ${session.leagues.length} LEAGUE${session.leagues.length === 1 ? '' : 'S'}`]
        : ['SLEEPER NOT CONNECTED']),
      ...(session.leagueId
        ? [`FOCUS ${session.leagues.find((league) => league.leagueId === session.leagueId)?.name ?? session.leagueId}`]
        : []),
      ...(session.rosterId ? [`ROSTER ${session.rosterId}`] : []),
      ...(session.player ? [`PLAYER ${session.player}`] : []),
      ...(session.team ? [`TEAM ${session.team}`] : []),
      ...(session.skillId !== 'general'
        ? [`WORKFLOW ${getSkill(session.skillId).title}`]
        : []),
      ...(session.accountError ? [`ACCOUNT WARNING ${session.accountError}`] : []),
      `SOURCE ${source}`,
    ];
    const contextRows = packRows(context.map(sanitizeTerminalText), width - 1).map((row) =>
      paint(this.theme, 'dim', fit(` ${row}`, width)));
    return [
      paint(this.theme, 'accent', fit(title, width)),
      ...contextRows,
      paint(this.theme, 'dim', '─'.repeat(width)),
    ];
  }

  private renderBody(width: number): string[] {
    return this.renderBodyRows(width).map((row) => row.text);
  }

  private renderBodyRows(width: number): BodyRow[] {
    if (this.overlay === 'shortcuts') {
      return this.shortcuts(width).map((text) => ({ text }));
    }
    if (this.overlay === 'history') {
      return this.historyRows(width).map((text) => ({ text }));
    }
    if (this.overlay === 'context') {
      return this.contextRows(width).map((text) => ({ text }));
    }
    if (this.sections.length === 0) {
      return this.home(width).map((text) => ({ text }));
    }
    const rows: BodyRow[] = [];
    for (const section of this.sections) {
      const color = section.kind === 'error' ? 'danger' : section.kind === 'tool' ? 'tool' : section.kind === 'assistant' ? 'assistant' : 'accent';
      const lines = [paint(this.theme, color, `${section.kind === 'assistant' ? symbol(this.theme, 'assistant') : symbol(this.theme, 'bullet')} ${sanitizeTerminalText(section.title)}`)];
      const rendered = section.kind === 'assistant'
        ? renderAnalysisText(
          section.content,
          this.theme,
          Math.max(20, width - 2),
        )
        : sanitizeTerminalText(section.content);
      for (const line of rendered.split('\n')) {
        lines.push(...wrapTerminalLine(line, Math.max(20, width - 2)).map((part) => `  ${part}`));
      }
      if (!this.theme.compact) lines.push('');
      rows.push(...lines.map((text, sectionRowIndex) => ({
        sectionId: section.id,
        sectionRowCount: lines.length,
        sectionRowIndex,
        text,
      })));
    }
    return rows;
  }

  private renderFooter(width: number, maximumHeight = Number.POSITIVE_INFINITY): string[] {
    let menu = this.menuOpen || this.editor.text().startsWith('/')
      ? this.renderMenu(width)
      : [];
    let suggestions = this.overlay === 'none' &&
      this.options.uiState.showSuggestions &&
      !this.editor.text() && menu.length === 0
      ? this.suggestions()
      : [];
    const reservedRows = this.overlay === 'none' ? 3 : 2;
    const availableExtraRows = Math.max(0, maximumHeight - reservedRows);
    if (menu.length > 0) {
      menu = menu.slice(0, availableExtraRows);
      suggestions = [];
    } else {
      suggestions = suggestions.slice(0, availableExtraRows);
    }
    const maximumPromptRows = Math.max(
      1,
      maximumHeight - menu.length - suggestions.length - 2,
    );
    const promptLines = this.overlay === 'none'
      ? renderEditor(this.editor, width - 4, this.theme, maximumPromptRows)
      : [];
    const status = this.answerFocus
      ? `Opened at ${this.answerFocus} · ${this.scrollOffset} ${this.scrollOffset === 1 ? 'line' : 'lines'} to latest · PgDn continues`
      : this.scrollOffset > 0
        ? `Viewing earlier transcript · ${this.scrollOffset} ${this.scrollOffset === 1 ? 'line' : 'lines'} above latest · PgDn returns`
      : this.status;
    return [
      ...menu,
      ...suggestions.map((value, index) =>
        paint(this.theme, 'source', fit(` ${index + 1}  ${sanitizeTerminalText(value)}`, width))),
      paint(this.theme, 'dim', '─'.repeat(width)),
      ...promptLines.map((line, index) => `${index === 0 ? `${symbol(this.theme, 'prompt')} ` : '  '}${line}`),
      paint(this.theme, 'dim', fit(` ${sanitizeTerminalText(status)} · Ctrl+G context · Ctrl+K commands · ? help`, width)),
    ];
  }

  private renderMenu(width: number): string[] {
    const completions = this.menuCompletions();
    this.menuSelection = Math.min(this.menuSelection, Math.max(0, completions.length - 1));
    const count = Math.min(6, Math.max(2, (this.options.output.rows ?? 24) - 14));
    const start = Math.max(0, Math.min(
      this.menuSelection - count + 1,
      completions.length - count,
    ));
    const rows = completions.slice(start, start + count);
    const lines = rows.map((completion, index) => {
      const command = findInteractiveCommand(completion.value.split(/\s+/u)[0] ?? '');
      const marker = start + index === this.menuSelection ? symbol(this.theme, 'prompt') : ' ';
      const warning = command?.danger ? ` ${symbol(this.theme, 'danger')}` : '';
      const row = `${marker} ${completion.value}${warning}  ${completion.description}`;
      return paint(this.theme, command?.danger ? 'warning' : start + index === this.menuSelection ? 'accent' : 'dim', fit(row, width));
    });
    const selected = completions[this.menuSelection];
    const command = selected ? findInteractiveCommand(selected.value.split(/\s+/u)[0] ?? '') : null;
    if (command) lines.push(paint(this.theme, command.danger ? 'warning' : 'source', fit(`  Effect: ${command.preview}`, width)));
    return lines;
  }

  private home(width: number): string[] {
    const session = this.options.session;
    const attention = homeFantasyActions(session);
    const visibleAttention = attention.slice(0, 2);
    const remainingAttention = attention.length - visibleAttention.length;
    const fantasy = session.user
      ? session.accountError
        ? `Connected as @${session.user}. Refresh warning: ${session.accountError}`
        : `Connected as @${session.user} with ${session.leagues.length} discovered league${session.leagues.length === 1 ? '' : 's'}.`
      : 'Optional. Run /connect <Sleeper username> once for automatic league context.';
    const experienceRow = (title: string, description: string): string => fit(
      `${paint(this.theme, 'accent', title.padEnd(12))}${sanitizeTerminalText(description)}`,
      width,
    );
    return [
      '',
      fit(paint(this.theme, 'assistant', `${symbol(this.theme, 'assistant')} Ask naturally. Seb selects the current NFL week and the right data.`), width),
      '',
      ...(session.user
        ? [
            paint(
              this.theme,
              attention.length > 0 || session.accountError ? 'warning' : 'accent',
              fit('WHAT NEEDS ATTENTION  /fantasy shows details and next steps', width),
            ),
            ...(session.accountError
              ? [paint(this.theme, 'warning', fit('  CHECK · Fantasy data needs a refresh. Run /refresh.', width))]
              : visibleAttention.map(({ action, leagueName }) => paint(
                this.theme,
                action.urgency === 'high' ? 'warning' : 'source',
                fit(`  ${homeUrgencyLabel(action)} · ${leagueName}${action.rosterId === null ? '' : ` · Roster ${action.rosterId}`} · ${action.title}`, width),
              ))),
            ...(!session.accountError && remainingAttention > 0
              ? [paint(this.theme, 'dim', fit(`  +${remainingAttention} more urgent action${remainingAttention === 1 ? '' : 's'}`, width))]
              : []),
            ...(!session.accountError && attention.length === 0
              ? [paint(this.theme, 'accent', fit('  CLEAR · No urgent lineup, player-status, or deadline actions.', width))]
              : []),
            '',
          ]
        : []),
      experienceRow('EXPLORE', 'Players, teams, statistics, schedules, and verified news.'),
      experienceRow('MY FANTASY', fantasy),
      experienceRow('ANALYZE', 'Compare players with matchup, usage, roster, news, and weather.'),
      '',
      paint(this.theme, 'dim', fit('Use a numbered action below, or type any question.', width)),
    ];
  }

  private shortcuts(width: number): string[] {
    return [
      paint(this.theme, 'accent', 'KEYBOARD SHORTCUTS'),
      '',
      '  Ctrl+K       Open the command palette',
      '  Ctrl+G       Select the active context',
      '  ?            Open this guide from an empty prompt',
      '  Tab          Fill the selected command',
      '  1 / 2 / 3    Select a contextual suggestion',
      '  ← / →        Move the cursor',
      '  Option+←/→   Move by one word',
      '  Ctrl+A / E   Move to the start or end',
      '  Ctrl+W       Delete the prior word',
      '  Ctrl+U       Delete to the start',
      '  Alt+Enter    Insert a new line',
      '  ↑ / ↓        Read prompt history',
      '  Ctrl+R       Search prompt history',
      '  PgUp/PgDn    Scroll the transcript',
      '  Mouse wheel   Scroll the transcript',
      '  Mouse drag    Select and copy visible text',
      '  /select       Use native selection as a fallback',
      '  Escape       Close a panel or stop a request',
      '  Ctrl+C       Exit Seb',
      '  /exit        Exit Seb',
      '',
      paint(this.theme, 'dim', fit('Press Escape, Enter, or any character to close this guide.', width)),
    ];
  }

  private historyRows(width: number): string[] {
    const entries = this.options.history.list().slice(0, 20);
    return [
      paint(this.theme, 'accent', 'PRIVATE PROMPT HISTORY'),
      '',
      ...(entries.length > 0
        ? entries.flatMap((entry, index) => wrapTerminalLine(`  ${index + 1}. ${sanitizeTerminalText(entry).replace(/\n/g, ' ↵ ')}`, width))
        : ['  No saved prompts.']),
      '',
      paint(this.theme, 'dim', 'Run /history clear to delete this file.'),
    ];
  }

  private contextRows(width: number): string[] {
    const items = this.contextItems();
    return [
      paint(this.theme, 'accent', fit('ACTIVE CONTEXT', width)),
      paint(this.theme, 'dim', fit('Use ↑/↓ to select. Use ←/→ to choose. Press Enter to apply.', width)),
      '',
      ...items.map((item, index) => {
        const marker = index === this.contextSelection ? symbol(this.theme, 'prompt') : ' ';
        const playerHint = item.field === 'player' ? '  Enter to change' : '  ←/→';
        const row = `${marker} ${item.label.padEnd(8)} ${item.value}${playerHint}`;
        return paint(
          this.theme,
          index === this.contextSelection ? 'accent' : 'dim',
          fit(row, width),
        );
      }),
      '',
      paint(this.theme, 'dim', fit('Escape closes this selector without applying the staged value.', width)),
    ];
  }
}

function renderEditor(
  editor: PromptEditor,
  width: number,
  theme: SebTheme,
  maximumRows = Number.POSITIVE_INFINITY,
): string[] {
  const before = sanitizeTerminalText(editor.text().slice(0, editor.cursor()));
  const after = sanitizeTerminalText(editor.text().slice(editor.cursor()));
  const cursorCharacter = terminalGraphemes(after)[0] ?? ' ';
  const remainder = after.slice(cursorCharacter.length);
  const cursorValue = cursorCharacter === '\n' ? ' ' : cursorCharacter;
  const cursor = theme.color ? `\x1b[7m${cursorValue}\x1b[0m` : `|${cursorValue}`;
  const tokens = [
    ...editorTokens(before),
    { cursor: true, text: cursor, width: visibleLength(cursor) },
    ...(cursorCharacter === '\n' ? [{ cursor: false, text: '\n', width: 0 }] : []),
    ...editorTokens(remainder),
  ];
  const maximumWidth = Math.max(1, width);
  const lines = [''];
  const lineWidths = [0];
  let cursorRow = 0;
  for (const token of tokens) {
    if (token.text === '\n') {
      lines.push('');
      lineWidths.push(0);
      continue;
    }
    let row = lines.length - 1;
    const lineWidth = lineWidths[row] ?? 0;
    if (lineWidth > 0 && lineWidth + token.width > maximumWidth) {
      lines.push('');
      lineWidths.push(0);
      row += 1;
    }
    if (token.cursor) cursorRow = row;
    lines[row] = `${lines[row] ?? ''}${token.text}`;
    lineWidths[row] = (lineWidths[row] ?? 0) + token.width;
  }
  const rowLimit = Number.isFinite(maximumRows)
    ? Math.max(1, Math.floor(maximumRows))
    : lines.length;
  const start = clamp(
    cursorRow - Math.floor(rowLimit / 2),
    0,
    Math.max(0, lines.length - rowLimit),
  );
  return lines.slice(start, start + rowLimit);
}

function editorTokens(value: string): Array<{
  cursor: false;
  text: string;
  width: number;
}> {
  return terminalGraphemes(value).map((text) => ({
    cursor: false,
    text,
    width: text === '\n' ? 0 : visibleLength(text),
  }));
}

function fit(value: string, width: number): string {
  if (visibleLength(value) <= width) return value;
  const plain = stripAnsi(value);
  return width <= 1
    ? sliceTerminalColumns(plain, 0, width)
    : `${sliceTerminalColumns(plain, 0, width - 1)}…`;
}

function cycle(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (index + delta + length) % length;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function offsetForViewportAnchor(
  rows: readonly BodyRow[],
  bodyHeight: number,
  anchor: ViewportAnchor,
): number | undefined {
  const sectionRows = rows
    .map((row, index) => ({ index, row }))
    .filter(({ row }) => row.sectionId === anchor.sectionId);
  if (sectionRows.length === 0) return undefined;
  const rowIndex = Math.round(anchor.rowRatio * Math.max(0, sectionRows.length - 1));
  const target = sectionRows[rowIndex];
  return target ? rows.length - target.index - bodyHeight : undefined;
}

function viewportAnchorForRow(row: BodyRow | undefined): ViewportAnchor | undefined {
  if (
    !row?.sectionId ||
    row.sectionRowIndex === undefined ||
    row.sectionRowCount === undefined
  ) {
    return undefined;
  }
  return {
    rowRatio: row.sectionRowCount <= 1
      ? 0
      : row.sectionRowIndex / (row.sectionRowCount - 1),
    sectionId: row.sectionId,
  };
}

function packRows(values: readonly string[], width: number): string[] {
  const rows: string[] = [];
  let row = '';
  for (const value of values) {
    if (row && visibleLength(row) + visibleLength(value) + 2 > width) {
      rows.push(row);
      row = value;
    } else {
      row = row ? `${row}  ${value}` : value;
    }
  }
  if (row) rows.push(row);
  return rows;
}

function homeFantasyActions(session: SessionState): Array<{
  action: FantasyLeagueAction;
  leagueName: string;
}> {
  return session.leagues.flatMap((league) =>
    (league.actionCenter?.actions ?? [])
      .filter((action) => action.urgency !== 'low')
      .map((action) => ({ action, leagueName: league.name })),
  ).sort((left, right) =>
    compareFantasyLeagueActions(left.action, right.action) ||
    left.leagueName.localeCompare(right.leagueName),
  );
}

function homeUrgencyLabel(action: FantasyLeagueAction): 'CHECK' | 'NOW' {
  return action.urgency === 'high' ? 'NOW' : 'CHECK';
}

function toReadableStream<T>(source: AsyncIterable<T> | ReadableStream<T>): ReadableStream<T> {
  if (source instanceof ReadableStream) return source;
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<T>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
}

function previousTextPartIndex(parts: UIMessage['parts'], index: number): number | undefined {
  for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex -= 1) {
    const candidate = parts[candidateIndex];
    if (candidate?.type === 'source-url' || candidate?.type === 'source-document' || candidate?.type === 'step-start') {
      continue;
    }
    return candidate?.type === 'text' ? candidateIndex : undefined;
  }
  return undefined;
}

function clampScreenPoint(point: ScreenPoint, lines: readonly string[]): ScreenPoint {
  const row = clamp(point.row, 1, Math.max(1, lines.length));
  const line = lines[row - 1] ?? '';
  return {
    column: clamp(point.column, 1, Math.max(1, visibleLength(line))),
    row,
  };
}

function sameScreenPoint(left: ScreenPoint, right: ScreenPoint): boolean {
  return left.column === right.column && left.row === right.row;
}

function orderedSelection(selection: ScreenSelection): [ScreenPoint, ScreenPoint] {
  const { anchor, focus } = selection;
  return anchor.row < focus.row || (anchor.row === focus.row && anchor.column <= focus.column)
    ? [anchor, focus]
    : [focus, anchor];
}

function selectedColumnsForRow(
  selection: ScreenSelection,
  row: number,
  lineLength: number,
): { end: number; start: number } | undefined {
  const [start, end] = orderedSelection(selection);
  if (row < start.row || row > end.row) return undefined;
  if (start.row === end.row) {
    return {
      end: Math.min(lineLength, end.column),
      start: Math.min(lineLength, start.column - 1),
    };
  }
  if (row === start.row) {
    return { end: lineLength, start: Math.min(lineLength, start.column - 1) };
  }
  if (row === end.row) {
    return { end: Math.min(lineLength, end.column), start: 0 };
  }
  return { end: lineLength, start: 0 };
}

function selectedScreenText(
  lines: readonly string[],
  selection: ScreenSelection,
): string {
  const [start, end] = orderedSelection(selection);
  const selected: string[] = [];
  for (let row = start.row; row <= end.row; row += 1) {
    const line = lines[row - 1] ?? '';
    const columns = selectedColumnsForRow(selection, row, visibleLength(line));
    selected.push(columns ? sliceTerminalColumns(line, columns.start, columns.end) : '');
  }
  return selected.join('\n');
}

function highlightScreenSelection(
  lines: readonly string[],
  selection: ScreenSelection,
): string[] {
  return lines.map((line, index) => {
    const columns = selectedColumnsForRow(selection, index + 1, visibleLength(line));
    return columns && columns.end > columns.start
      ? highlightTerminalColumns(line, columns.start, columns.end)
      : line;
  });
}

function highlightTerminalColumns(value: string, start: number, end: number): string {
  let highlighted = false;
  let index = 0;
  let output = '';
  let visibleIndex = 0;
  while (index < value.length) {
    const control = value.slice(index).match(TERMINAL_CONTROL_AT_START)?.[0];
    if (control) {
      output += control;
      if (highlighted) output += '\x1b[7m';
      index += control.length;
      continue;
    }
    const grapheme = terminalGraphemes(value.slice(index))[0] ?? '';
    const graphemeWidth = visibleLength(grapheme);
    const nextVisibleIndex = visibleIndex + graphemeWidth;
    const selected = nextVisibleIndex > start && visibleIndex < end;
    if (selected && !highlighted) {
      output += '\x1b[7m';
      highlighted = true;
    }
    output += grapheme;
    visibleIndex = nextVisibleIndex;
    index += grapheme.length;
    if (highlighted && visibleIndex >= end) {
      output += '\x1b[27m';
      highlighted = false;
    }
  }
  if (highlighted) output += '\x1b[27m';
  return output;
}

function copyToLocalClipboard(text: string): void {
  const command = process.platform === 'darwin'
    ? { executable: 'pbcopy', arguments: [] as string[] }
    : process.platform === 'win32'
      ? { executable: 'clip.exe', arguments: [] as string[] }
      : process.env.WAYLAND_DISPLAY
        ? { executable: 'wl-copy', arguments: [] as string[] }
        : process.env.DISPLAY
          ? { executable: 'xclip', arguments: ['-selection', 'clipboard'] }
          : undefined;
  if (!command) return;
  const child = spawn(command.executable, command.arguments, {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.on('error', () => undefined);
  child.stdin.on('error', () => undefined);
  child.stdin.end(text);
}

function hasLaterToolAttempt(
  parts: UIMessage['parts'],
  index: number,
  toolName: string,
): boolean {
  return parts.slice(index + 1).some((part) =>
    isToolUIPart(part) && getToolName(part) === toolName);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
