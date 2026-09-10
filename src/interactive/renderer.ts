import { randomUUID } from 'node:crypto';
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
  interactiveCommandPrivacyError,
  NFL_TEAM_CODES,
  parseInteractiveCommandInput,
} from './commands.js';
import { PromptEditor, TerminalKeyParser, type TerminalKey } from './editor.js';
import { splitEvidenceText } from './evidence.js';
import type { PromptHistory } from './history.js';
import {
  formatElapsed,
  friendlyToolName,
  osc52,
  renderAnalysisText,
  sanitizeTerminalText,
  sliceTerminalColumns,
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
  provider?: string;
  providerLabel?: string;
  session: SessionState;
  sources: SourceTracker;
  uiState: InteractiveUiState;
  version: string;
}

type SectionKind = 'assistant' | 'error' | 'evidence' | 'reasoning' | 'tool' | 'user';

interface Section {
  content: string;
  id: string;
  kind: SectionKind;
  title: string;
  completedTool?: string;
  details?: string;
  identifier?: string;
  durationMs?: number;
  evidenceCount?: number;
  evidenceGroup?: string;
}

interface BodyRow {
  toggleId?: string;
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
  bodyRows?: BodyRow[];
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
const ESCAPE_SEQUENCE_WAIT_MS = 25;
const MINIMUM_TERMINAL_HEIGHT = 16;
const MINIMUM_TERMINAL_WIDTH = 40;
const MOUSE_WHEEL_LINES = 3;
const TOOL_APPROVAL_INPUT_LIMIT = 500;
const TOOL_APPROVAL_SENSITIVE_KEY = /(?:api[_-]?key|authorization|cookie|password|secret|token)/iu;
const MOUSE_REPORTING_OFF = '\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l';
const MOUSE_REPORTING_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const TERMINAL_CONTROL_AT_START = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/u;

export class SebTerminalRenderer {
  private active = false;
  private activeStartedAt = 0;
  private activeToolIds = new Set<string>();
  private approvalSequence = 0;
  private answerFocus: 'Decision' | 'answer' | null = null;
  private contextChoices = new Map<ContextField, number>();
  private contextDraft = '';
  private contextSelection = 0;
  private editor = new PromptEditor();
  private escapeTimer: ReturnType<typeof setTimeout> | undefined;
  private exitRequested = false;
  private framePlainLines: string[] = [];
  private bodyScreenStart = 0;
  private bodyVisibleStart = 0;
  private bodyVisibleEnd = 0;
  private selectionDrag: ScreenPoint | undefined;
  private selectionTimer: ReturnType<typeof setInterval> | undefined;
  private historyIndex = -1;
  private historyDraft = '';
  private dispatchingInput = false;
  private inputPaintRequested = false;
  private inputClearRequested = false;
  private interrupted = false;
  private keyParser = new TerminalKeyParser();
  private lastFrame = '';
  private lastPaintAt = 0;
  private lastWidth = 0;
  private maximumScrollOffset = 0;
  private maximumOverlayScrollOffset = 0;
  private menuDismissed = false;
  private menuOpen = false;
  private menuSelection = 0;
  private onData: ((chunk: Buffer) => void) | undefined;
  private onResize: (() => void) | undefined;
  private overlay: 'none' | 'shortcuts' | 'history' | 'context' = 'none';
  private readonly options: SebRendererOptions;
  private overlayScrollOffset = 0;
  private paintTimer: ReturnType<typeof setTimeout> | undefined;
  private paintedBodyHeight = 3;
  private pendingPromptDraft: string | undefined;
  private queuedPrompt = false;
  private scrollOffset = 0;
  private screenSelection: ScreenSelection | undefined;
  private selectionMode = false;
  private sections: Section[] = [];
  private status = 'Ready';
  private streamMessage: UIMessage | undefined;
  private streamSequence = 0;
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
    if (!options.uiState.activeModel) {
      options.uiState.setActiveModel({
        model: options.model,
        provider: options.provider ?? 'configured',
        providerLabel: options.providerLabel ?? options.provider ?? 'Configured provider',
      });
    }
    options.uiState.theme = parseThemeName(options.environment.SEB_THEME);
    options.uiState.iconMode = parseIconMode(options.environment.SEB_ICONS);
    this.theme = createTheme(options.environment, options.uiState);
  }

  private readonly expandedDetails = new Set<string>();

  restoreMessages(messages: readonly UIMessage[]): void {
    for (const message of messages) {
      if (message.role === 'user') {
        this.upsert({ id: message.id, kind: 'user', title: 'You', content: message.parts.filter(p => p.type === 'text').map(p => p.text).join('\n') });
      } else if (message.role === 'assistant') this.renderMessage(message, true);
    }
  }

  async readPrompt(options?: SebRendererSessionOptions): Promise<string | undefined> {
    this.start();
    this.status = this.options.uiState.notification || 'Ready';
    this.options.uiState.notification = '';
    if (this.pendingPromptDraft !== undefined) this.editor.set(this.pendingPromptDraft);
    this.pendingPromptDraft = undefined;
    this.menuDismissed = false;
    this.historyIndex = -1;
    this.interrupted = false;
    this.exitRequested = false;
    this.paint();
    return await new Promise<string | undefined>((resolve, reject) => {
      this.onData = (chunk) => {
        this.dispatchInput(chunk, (key) => {
          void this.handlePromptKey(key, resolve, reject);
        });
      };
      this.attachInput();
      if (this.queuedPrompt) {
        this.queuedPrompt = false;
        void this.submitPrompt(resolve).catch(reject);
      }
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
    this.updateStreamStatus(undefined);
    this.streamMessage = undefined;
    this.activeToolIds.clear();
    const sourceReader = toReadableStream(result.uiMessageStream).getReader();
    this.streamStop = () => {
      result.abort?.();
      void sourceReader.cancel().catch(() => undefined);
    };
    this.startTicker();
    this.onData = (chunk) => {
      this.dispatchInput(chunk, (key) => this.handleStreamKey(key));
    };
    this.attachInput();
    const initialMessage: UIMessage = result.message ?? {
      id: randomUUID(), role: 'assistant', parts: [],
    };
    let response = result.message;
    let streamFailed = false;
    const streamErrorId = `stream-error-${++this.streamSequence}`;
    const stream = new ReadableStream<UIMessageChunk>({
      async pull(controller) {
        const next = await sourceReader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
    });
    this.paint();
    try {
      const messages = readUIMessageStream({
        message: initialMessage,
        stream,
        onError: (error) => {
          streamFailed = true;
          this.upsert({
            content: errorMessage(error),
            id: streamErrorId,
            kind: 'error',
            title: 'Error',
          });
        },
      });
      for await (const message of messages) {
        response = message;
        this.streamMessage = message;
        if (!this.interrupted) this.renderMessage(message);
      }
    } catch (error) {
      if (!this.interrupted) {
        streamFailed = true;
        this.upsert({ content: errorMessage(error), id: streamErrorId, kind: 'error', title: 'Error' });
      }
    } finally {
      sourceReader.releaseLock();
      this.stopTicker();
      this.detachInput();
      if (response) this.renderMessage(response, true);
      if (this.interrupted) {
        this.upsert({
          content: 'This response is incomplete. Use /retry to try the prompt again.',
          id: streamErrorId,
          kind: 'error',
          title: 'Request stopped',
        });
      }
      this.activeToolIds.clear();
      if (this.interrupted || streamFailed) this.queuedPrompt = false;
      this.status = this.interrupted
        ? 'Request stopped'
        : streamFailed
          ? `Request failed · ${formatElapsed(Date.now() - this.streamStartedAt)}`
          : `Ready · ${formatElapsed(Date.now() - this.streamStartedAt)}`;
      this.options.uiState.sources = this.options.sources.list();
      const awaitsApproval = response?.parts.some(
        (part) => isToolUIPart(part) && part.state === 'approval-requested',
      ) === true;
      if (!this.interrupted && !streamFailed && !awaitsApproval) {
        this.captureAnswer(response);
        if (this.scrollOffset === 0 && !this.screenSelection) this.focusLatestAnswer();
      }
      this.paint();
      this.streamStop = undefined;
      this.streamMessage = undefined;
      if (!awaitsApproval) {
        this.toolStartedAt.clear();
        this.toolDurations.clear();
      }
    }
    if (this.exitRequested) throw new Error('Interrupted');
    return this.interrupted || streamFailed ? undefined : response;
  }

  async readToolApproval(
    request: SebRendererToolApprovalRequest,
  ): Promise<{ approved: boolean; reason?: string }> {
    this.start();
    this.answerFocus = null;
    this.scrollOffset = 0;
    const title = request.title ?? friendlyToolName(request.toolName);
    const sectionId = `tool-approval-${++this.approvalSequence}`;
    const input = toolApprovalInputSummary(request.input);
    this.upsert({
      content: `Input: ${input}\nPress Y to approve. Press N to deny.`,
      id: sectionId,
      kind: 'tool',
      title: `Approval · ${title}`,
    });
    this.status = `Approve ${title}? y/n`;
    this.paint();
    return await new Promise((resolve, reject) => {
      this.onData = (chunk) => {
        this.dispatchInput(chunk, (key) => {
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
        });
      };
      this.attachInput();
    });
  }

  close(): void {
    this.stop();
  }

  private async handlePromptKey(
    key: TerminalKey,
    resolve: (value: string | undefined) => void,
    reject: (reason: Error) => void,
  ): Promise<void> {
    if (this.handleMouseSelection(key)) return;
    if (key.type === 'ctrl-c' && this.copyScreenSelection()) return;
    if (this.screenSelection) {
      this.clearSelection();
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
      if (key.type === 'page-up' || key.type === 'up' || key.type === 'scroll-up') {
        this.scrollOverlay(key.type === 'page-up' ? -this.pageScrollLines() : -MOUSE_WHEEL_LINES);
        return;
      }
      if (key.type === 'page-down' || key.type === 'down' || key.type === 'scroll-down') {
        this.scrollOverlay(key.type === 'page-down' ? this.pageScrollLines() : MOUSE_WHEEL_LINES);
        return;
      }
      if (key.type === 'escape' || key.type === 'enter' || key.type === 'character') {
        this.overlay = 'none';
        this.overlayScrollOffset = 0;
        this.maximumOverlayScrollOffset = 0;
        this.paint();
      }
      return;
    }
    const menu = this.menuCompletions();
    if (this.menuIsVisible(menu)) {
      if (key.type === 'up' || key.type === 'down') {
        this.menuOpen = true;
        this.menuSelection = cycle(this.menuSelection, key.type === 'up' ? -1 : 1, menu.length);
        this.paint();
        return;
      }
      if (key.type === 'tab' || key.type === 'right') {
        this.acceptMenu();
        return;
      }
      if (key.type === 'escape') {
        this.menuOpen = false;
        this.menuDismissed = true;
        if (this.editor.text() === '/') {
          this.editor.set('');
          this.menuDismissed = false;
        }
        this.paint();
        return;
      }
    }
    switch (key.type) {
      case 'character':
        if (this.editor.text() === '' && key.value === '?') {
          this.overlay = 'shortcuts';
          this.overlayScrollOffset = 0;
          this.paint();
          return;
        }
        this.editor.insert(key.value);
        this.resetMenu();
        if (this.numberedSuggestion()) {
          this.status = `Press Enter to use action ${key.value}, or continue typing`;
        }
        break;
      case 'paste': this.editor.insert(sanitizeTerminalText(key.value.replace(/\r\n?/g, '\n'))); break;
      case 'backspace': this.editor.backspace(); this.resetMenu(); break;
      case 'delete': this.editor.deleteForward(); this.resetMenu(); break;
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
      case 'ctrl-k':
        this.menuDismissed = false;
        this.menuOpen = true;
        if (!this.editor.text()) this.editor.set('/');
        break;
      case 'ctrl-l': this.paint(true); return;
      case 'escape': this.stop(); reject(new Error('Interrupted')); return;
      case 'ctrl-c': this.stop(); reject(new Error('Interrupted')); return;
      case 'enter':
        if (this.menuOpen && this.editor.text() === '/') {
          this.acceptMenu();
          return;
        }
        if (this.acceptNumberedSuggestion()) {
          if (this.editor.text().includes('<')) {
            this.status = 'Replace the placeholder, then press Enter';
            this.paint();
            return;
          }
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
    if (parsed) {
      const privacyError = interactiveCommandPrivacyError(parsed);
      if (privacyError) {
        this.editor.set('');
        this.status = privacyError;
        this.paint();
        return;
      }
      const argumentError = interactiveCommandArgumentError(parsed);
      if (argumentError) {
        this.status = argumentError;
        this.paint();
        return;
      }
    }
    if (localCommand) this.options.uiState.recordCommand(localCommand.name);
    if (localCommand?.name === 'exit') {
      this.editor.set('');
      this.stop();
      resolve(undefined);
      return;
    }
    if (localCommand?.name === 'shortcuts') {
      this.overlay = 'shortcuts';
      this.overlayScrollOffset = 0;
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
      const all = parsed?.arguments[0]?.toLowerCase() === 'all';
      const answer = all ? this.transcriptText() : this.options.uiState.latestAnswer;
      if (answer && this.options.output.isTTY !== false) {
        this.copyText(answer);
        this.status = all ? 'Copied the full conversation' : 'Copied the latest answer';
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
        this.overlayScrollOffset = 0;
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
      this.contextDraft = '';
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
      const draft = this.contextDraft.trim();
      this.contextDraft = '';
      this.editor.set(`/skill player-info ${draft ? `<Player> ${draft}` : ''}`);
      this.status = 'Type a player name and question';
      this.paint();
      return;
    }
    const choiceIndex = this.contextChoices.get(item.field) ?? 0;
    const choice = item.choices[choiceIndex];
    if (!choice) return;
    this.overlay = 'none';
    this.pendingPromptDraft = this.contextDraft;
    this.contextDraft = '';
    this.editor.set(choice.command);
    await this.submitPrompt(resolve);
  }

  private openContextSelector(): void {
    this.contextDraft = this.editor.text();
    this.overlay = 'context';
    this.overlayScrollOffset = 0;
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
    const storedPrompt = promptWithoutModelConfigurationArguments(prompt);
    this.answerFocus = null;
    this.scrollOffset = 0;
    this.options.uiState.showSuggestions = false;
    if (!prompt.startsWith('/')) {
      this.options.uiState.latestPrompt = prompt;
    }
    this.upsert({
      content: storedPrompt,
      id: `user-${randomUUID()}`,
      kind: 'user',
      title: 'You',
    });
    this.editor.set('');
    this.resetMenu();
    this.detachInput();
    this.status = 'Thinking';
    this.paint();
    try {
      await this.options.history.add(storedPrompt);
    } catch (error) {
      this.options.uiState.notification = errorMessage(error);
    }
    resolve(prompt);
  }

  private handleStreamKey(key: TerminalKey): void {
    if (this.handleMouseSelection(key)) return;
    if (key.type === 'ctrl-c' && this.copyScreenSelection()) return;
    if (this.screenSelection) {
      this.clearSelection();
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
    } else {
      const before = this.editor.text();
      switch (key.type) {
        case 'character': this.editor.insert(key.value); break;
        case 'paste': this.editor.insert(sanitizeTerminalText(key.value.replace(/\r\n?/g, '\n'))); break;
        case 'backspace': this.editor.backspace(); break;
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
        case 'enter': this.queuedPrompt = Boolean(this.editor.text().trim()); break;
        default: return;
      }
      // Editing a queued draft requires Enter again before it can run.
      if (this.editor.text() !== before) this.queuedPrompt = false;
      this.paint();
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
        const snapshot = this.options.uiState.evidenceForAnswer(message.id);
        for (const [sectionIndex, section] of splitEvidenceText(part.text).entries()) {
          const sectionId = `${id}:${sectionIndex}`;
          active.add(sectionId);
          this.upsert({
            content: section.content,
            id: sectionId,
            kind: section.evidence ? 'evidence' : 'assistant',
            title: section.evidence ? 'Evidence' : 'Seb',
            ...(section.evidence ? { evidenceGroup: message.id } : {}),
            ...(snapshot ? { evidenceCount: snapshot.sources.length } : {}),
          });
        }
      } else if (part.type === 'reasoning' && part.text.trim()) {
        active.add(id);
        this.upsert({
          content: part.text,
          id,
          kind: 'reasoning',
          title: final || part.state === 'done' ? 'Reasoning' : 'Reasoning · in progress',
        });
      } else if (isToolUIPart(part)) {
        const state = part.state;
        const name = getToolName(part);
        if (state === 'output-error' && hasLaterToolAttempt(message.parts, index, name)) {
          this.activeToolIds.delete(id);
          continue;
        }
        active.add(id);
        const retrying = state === 'output-error' && !final;
        const unfinished = state === 'input-streaming' || state === 'input-available';
        const running = !final && (retrying || unfinished || state === 'approval-requested');
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
        const failed = state === 'output-denied' || (final && (state === 'output-error' || unfinished));
        const marker = failed ? symbol(this.theme, 'danger') : running ? this.spinner() : symbol(this.theme, 'done');
        const startedAt = this.toolStartedAt.get(id) ?? this.activeStartedAt;
        const elapsed = formatElapsed(running
          ? Date.now() - startedAt
          : this.toolDurations.get(id) ?? Date.now() - startedAt);
        const detail = final && unfinished
          ? this.interrupted ? ' · stopped' : ' · incomplete'
          : failed && 'errorText' in part ? ` · ${part.errorText}` : '';
        this.upsert({
          content: `${marker} ${friendlyToolName(name)} · ${retrying ? 'retrying' : elapsed}${detail}`,
          id,
          kind: failed ? 'error' : 'tool',
          title: running ? 'Working' : 'Tool',
          details: toolDetails(part),
          identifier: toolIdentifier(part.input),
          ...(state === 'output-available' ? {
            completedTool: name,
            durationMs: this.toolDurations.get(id) ?? 0,
          } : {}),
        });
        if (running) {
          this.status = retrying
            ? `Retrying ${friendlyToolName(name).toLowerCase()}`
            : `${friendlyToolName(name)} · ${elapsed}`;
        }
      }
    }
    if (!final && this.activeToolIds.size === 0) this.updateStreamStatus(message);
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
    const activeModel = this.options.uiState.activeModel;
    return completeInteractiveInput(this.editor.text(), {
      ...this.options.session,
      ...(activeModel
        ? { model: activeModel.model, provider: activeModel.provider }
        : {}),
      recentCommands: this.options.uiState.recentCommands,
    }, 8);
  }

  private menuIsVisible(completions = this.menuCompletions()): boolean {
    return this.menuOpen || (
      !this.menuDismissed &&
      this.editor.text().startsWith('/') &&
      completions.length > 0
    );
  }

  private acceptMenu(): void {
    const completion = this.menuCompletions()[this.menuSelection];
    if (!completion) return;
    this.editor.set(completion.value);
    this.menuOpen = false;
    this.menuDismissed = true;
    this.menuSelection = 0;
    this.paint();
  }

  private resetMenu(): void {
    this.menuDismissed = false;
    this.menuOpen = false;
    this.menuSelection = 0;
  }

  private numberedSuggestion(): string | undefined {
    if (!this.options.uiState.showSuggestions) return undefined;
    const match = this.editor.text().match(/^[123]$/u);
    return match ? this.suggestions()[Number(match[0]) - 1] : undefined;
  }

  private acceptNumberedSuggestion(): boolean {
    const suggestion = this.numberedSuggestion();
    if (!suggestion) return false;
    this.editor.set(suggestion);
    this.resetMenu();
    return true;
  }

  private recallHistory(direction: 1 | -1): void {
    const entries = this.options.history.list();
    if (entries.length === 0) return;
    if (this.historyIndex === -1) this.historyDraft = this.editor.text();
    this.historyIndex = Math.max(-1, Math.min(entries.length - 1, this.historyIndex + direction));
    this.editor.set(this.historyIndex < 0 ? this.historyDraft : entries[this.historyIndex] ?? '');
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
    this.onResize = () => {
      this.clearSelection();
      this.paint(true);
    };
    this.options.output.on('resize', this.onResize);
  }

  private stop(): void {
    this.clearSelection();
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
    if (!this.onData) return;
    this.options.input.on('data', this.onData);
    if (this.options.input.isTTY) this.options.input.resume();
  }

  private detachInput(): void {
    this.cancelEscapeTimer();
    if (this.onData) this.options.input.off('data', this.onData);
    this.onData = undefined;
    this.keyParser.reset();
    if (this.active && this.options.input.isTTY) this.options.input.pause();
  }

  private dispatchInput(
    chunk: Buffer,
    accept: (key: TerminalKey) => void,
  ): void {
    this.cancelEscapeTimer();
    this.dispatchingInput = true;
    try {
      for (const key of this.keyParser.parse(chunk)) {
        if (!this.onData) break;
        accept(key);
      }
    } finally {
      this.dispatchingInput = false;
      const repaint = this.inputPaintRequested;
      const clear = this.inputClearRequested;
      this.inputPaintRequested = false;
      this.inputClearRequested = false;
      if (repaint) this.paint(clear);
    }
    if (!this.keyParser.hasPendingEscape()) return;
    this.escapeTimer = setTimeout(() => {
      this.escapeTimer = undefined;
      for (const key of this.keyParser.flushPendingEscape()) accept(key);
    }, ESCAPE_SEQUENCE_WAIT_MS);
    this.escapeTimer.unref?.();
  }

  private cancelEscapeTimer(): void {
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
  }

  private startTicker(): void {
    this.stopTicker();
    this.ticker = setInterval(() => {
      if (this.activeToolIds.size > 0) this.renderMessage(this.streamMessage ?? { id: '', role: 'assistant', parts: [] });
      else {
        if (!this.interrupted) this.updateStreamStatus(this.streamMessage);
        this.requestPaint();
      }
    }, 250);
    this.ticker.unref?.();
  }

  private updateStreamStatus(message: UIMessage | undefined): void {
    const latestPart = message?.parts.findLast((part) =>
      part.type === 'text' || part.type === 'reasoning' || isToolUIPart(part));
    const phase = latestPart?.type === 'text' && latestPart.state === 'streaming'
      ? 'Writing answer'
      : latestPart?.type === 'reasoning' && latestPart.state === 'streaming'
        ? 'Reasoning'
        : 'Thinking';
    this.status = `${this.spinner()} ${phase} · ${formatElapsed(Date.now() - this.streamStartedAt)} · Escape stops`;
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
    if (this.selectionDrag && this.screenSelection?.bodyRows &&
      (key.type === 'scroll-up' || key.type === 'scroll-down')) {
      this.scrollOffset = clamp(this.scrollOffset +
        (key.type === 'scroll-up' ? MOUSE_WHEEL_LINES : -MOUSE_WHEEL_LINES),
      0, this.maximumScrollOffset);
      this.screenSelection.moved = true;
      this.paint();
      return true;
    }
    if (key.type !== 'mouse') return false;
    if (this.selectionMode || this.framePlainLines.length === 0) return true;
    if (key.action === 'press') {
      this.clearSelection();
      const bodyRows = this.overlay === 'none' && this.sections.length > 0 &&
        key.row > this.bodyScreenStart &&
        key.row <= this.bodyScreenStart + this.bodyVisibleEnd - this.bodyVisibleStart
        ? this.renderBodyRows(Math.max(1, this.options.output.columns ?? 80)) : undefined;
      const point = bodyRows
        ? this.transcriptPoint(key, bodyRows)
        : clampScreenPoint(key, this.framePlainLines);
      this.screenSelection = {
        anchor: point,
        focus: point,
        moved: false,
        ...(bodyRows ? { bodyRows } : {}),
      };
      this.status = 'Selecting text';
      this.paint();
      return true;
    }
    const selection = this.screenSelection;
    if (!selection) return true;
    const point = selection.bodyRows
      ? this.transcriptPoint(key, selection.bodyRows)
      : clampScreenPoint(key, this.framePlainLines);
    selection.focus = point;
    selection.moved = selection.moved || !sameScreenPoint(selection.anchor, point);
    if (key.action === 'drag') {
      this.selectionDrag = key;
      if (selection.bodyRows && !this.selectionTimer) {
        this.selectionTimer = setInterval(() => this.scrollSelection(), 50);
        this.selectionTimer.unref?.();
      }
      this.requestPaint();
      return true;
    }
    this.stopSelectionDrag();
    if (!selection.moved) {
      const toggle = selection.bodyRows?.[selection.anchor.row - 1]?.toggleId;
      if (toggle) {
        const oldLength = selection.bodyRows!.length;
        this.screenSelection = undefined;
        if (this.expandedDetails.has(toggle)) this.expandedDetails.delete(toggle);
        else this.expandedDetails.add(toggle);
        this.scrollOffset = Math.max(0, this.scrollOffset + this.renderBodyRows(Math.max(1, this.options.output.columns ?? 80)).length - oldLength);
      }
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
    this.stopSelectionDrag();
    const text = selectedScreenText(
      this.screenSelection.bodyRows?.map((row) => stripAnsi(row.text)) ?? this.framePlainLines,
      this.screenSelection,
    );
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

  private transcriptText(): string {
    return this.sections.map((section) =>
      `${sanitizeTerminalText(section.title)}\n${sanitizeTerminalText(section.content)}`,
    ).join('\n\n');
  }

  private clearSelection(): void {
    this.stopSelectionDrag();
    this.screenSelection = undefined;
  }

  private stopSelectionDrag(): void {
    if (this.selectionTimer) clearInterval(this.selectionTimer);
    this.selectionTimer = undefined;
    this.selectionDrag = undefined;
  }

  private transcriptPoint(point: ScreenPoint, rows: BodyRow[]): ScreenPoint {
    const visibleRow = clamp(point.row - this.bodyScreenStart,
      1, Math.max(1, this.bodyVisibleEnd - this.bodyVisibleStart));
    const row = this.bodyVisibleStart + visibleRow;
    return {
      row,
      column: clamp(point.column, 1, Math.max(1, visibleLength(rows[row - 1]?.text ?? ''))),
    };
  }

  private scrollSelection(): void {
    const selection = this.screenSelection;
    const point = this.selectionDrag;
    if (!selection?.bodyRows || !point) return;
    const delta = point.row <= this.bodyScreenStart + 1 ? MOUSE_WHEEL_LINES
      : point.row >= this.bodyScreenStart + this.paintedBodyHeight ? -MOUSE_WHEEL_LINES : 0;
    const next = clamp(this.scrollOffset + delta, 0, this.maximumScrollOffset);
    if (next === this.scrollOffset) return;
    this.answerFocus = null;
    this.scrollOffset = next;
    selection.moved = true;
    this.paint();
  }

  private enterSelectionMode(): void {
    this.clearSelection();
    this.cancelPaint();
    this.selectionMode = true;
    this.editor.set('');
    this.status = 'Selection mode';
    this.options.output.write(`${MOUSE_REPORTING_OFF}\x1b[?1049l\x1b[?25h\r\n` +
      'Selection mode: scroll and select the full conversation. Press Escape to return.\r\n\r\n' +
      this.transcriptText().replace(/\n/g, '\r\n') + '\r\n');
  }

  private leaveSelectionMode(): void {
    if (!this.selectionMode) return;
    this.selectionMode = false;
    this.status = 'Ready';
    this.options.output.write(`\x1b[?1049h\x1b[?25l${MOUSE_REPORTING_ON}`);
    this.paint(true);
  }

  private scroll(delta: number): void {
    this.clearSelection();
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

  private scrollOverlay(delta: number): void {
    const nextOffset = clamp(
      this.overlayScrollOffset + delta,
      0,
      this.maximumOverlayScrollOffset,
    );
    if (nextOffset === this.overlayScrollOffset) return;
    this.overlayScrollOffset = nextOffset;
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
      index > assistantStart && isDecisionHeading(line),
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
    return Math.max(1, this.paintedBodyHeight - 1);
  }

  private requestPaint(): void {
    if (!this.active || this.selectionMode) return;
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
    if (this.selectionMode) return;
    if (this.dispatchingInput) {
      this.inputPaintRequested = true;
      this.inputClearRequested ||= clear;
      return;
    }
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
    this.paintedBodyHeight = bodyHeight;
    const bodyRows = this.renderBodyRows(width);
    const body = bodyRows.map((row) => row.text);
    const maximumOffset = Math.max(0, body.length - bodyHeight);
    const transcriptVisible = this.overlay === 'none' && this.sections.length > 0;
    if (this.overlay !== 'none') {
      this.maximumOverlayScrollOffset = maximumOffset;
      this.overlayScrollOffset = Math.min(this.overlayScrollOffset, maximumOffset);
    } else {
      this.maximumOverlayScrollOffset = 0;
      this.overlayScrollOffset = 0;
    }
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
    const topAligned = this.overlay !== 'none' || this.sections.length === 0;
    const end = this.overlay !== 'none'
      ? Math.min(body.length, this.overlayScrollOffset + bodyHeight)
      : this.sections.length === 0
        ? Math.min(body.length, bodyHeight)
        : body.length - this.scrollOffset;
    const visibleStart = this.overlay !== 'none'
      ? this.overlayScrollOffset
      : topAligned ? 0 : Math.max(0, end - bodyHeight);
    const visible = body.slice(visibleStart, end);
    while (visible.length < bodyHeight) {
      if (topAligned) visible.push('');
      else visible.unshift('');
    }
    if (transcriptVisible) {
      this.viewportAnchor = viewportAnchorForRow(bodyRows[visibleStart]);
    }
    this.bodyScreenStart = header.length + Math.max(0, bodyHeight - (end - visibleStart));
    this.bodyVisibleStart = visibleStart;
    this.bodyVisibleEnd = end;
    if (this.selectionDrag && this.screenSelection?.bodyRows) {
      this.screenSelection.focus = this.transcriptPoint(this.selectionDrag, this.screenSelection.bodyRows);
    }
    const bodySelection = this.screenSelection?.bodyRows ? this.screenSelection : undefined;
    const selectedVisible = bodySelection?.moved
      ? visible.map((line, index) => {
        const row = visibleStart + index - (this.bodyScreenStart - header.length) + 1;
        const columns = selectedColumnsForRow(bodySelection, row, visibleLength(line));
        return columns && columns.end > columns.start
          ? highlightTerminalColumns(line, columns.start, columns.end) : line;
      }) : visible;
    const cleanLines = [...header, ...selectedVisible, ...footer].slice(0, height);
    this.framePlainLines = cleanLines.map(stripAnsi);
    const lines = this.screenSelection?.moved && !bodySelection
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
    const activeModel = this.options.uiState.activeModel;
    const phase = session.seasonType?.toUpperCase() ?? 'NFL';
    const title = sanitizeTerminalText(
      ` SEB ${this.options.version}  ${session.season} ${phase}${session.week ? ` W${session.week}` : ''}`,
    );
    const context = [
      ...(activeModel
        ? [activeModel.model]
        : []),
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
    if (this.screenSelection?.bodyRows) return this.screenSelection.bodyRows;
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
    const evidenceGroups = new Set<string>();
    for (let index = 0; index < this.sections.length; index += 1) {
      const section = this.sections[index]!;
      if (section.kind === 'evidence') {
        if (section.evidenceGroup && evidenceGroups.has(section.evidenceGroup)) continue;
        if (section.evidenceGroup) evidenceGroups.add(section.evidenceGroup);
        const count = section.evidenceCount;
        const summary = count === undefined ? 'Evidence · /sources for details'
          : `Evidence: ${count} source${count === 1 ? '' : 's'} · /sources`;
        rows.push({
          sectionId: section.id,
          sectionRowCount: 1,
          sectionRowIndex: 0,
          text: paint(this.theme, 'source', fit(`  ${summary}`, width)),
        });
        continue;
      }
      if ((section.kind === 'tool' || section.kind === 'error') &&
        (section.title === 'Tool' || section.title === 'Working')) {
        let count = 1;
        let duration = section.durationMs ?? 0;
        while (section.completedTool &&
          this.sections[index + count]?.completedTool === section.completedTool) {
          duration += this.sections[index + count]?.durationMs ?? 0;
          count += 1;
        }
        const content = count > 1
          ? `${symbol(this.theme, 'done')} ${friendlyToolName(section.completedTool!)} ×${count} · ${formatElapsed(duration)} total`
          : section.content;
        const toggleId = count > 1 ? `group:${section.id}` : section.id;
        const expanded = this.expandedDetails.has(toggleId);
        const lines = wrapTerminalLine(sanitizeTerminalText(`${expanded ? '▾' : '▸'} ${content}`), Math.max(20, width - 2));
        rows.push(...lines.map((line, sectionRowIndex) => ({ toggleId,
          sectionId: section.id, sectionRowCount: lines.length, sectionRowIndex,
          text: paint(this.theme, section.kind === 'error' ? 'danger' : 'tool', `  ${line}`),
        })));
        if (expanded) {
          for (const child of this.sections.slice(index, index + count)) {
            if (count > 1) rows.push({ sectionId: child.id, toggleId: child.id,
              text: paint(this.theme, 'tool', fit(`    ${this.expandedDetails.has(child.id) ? '▾' : '▸'} ${child.identifier || friendlyToolName(child.completedTool!)} · ${formatElapsed(child.durationMs ?? 0)}`, width)) });
            if (count === 1 || this.expandedDetails.has(child.id)) {
              for (const line of sanitizeTerminalText(child.details ?? child.content).split('\n')) {
                rows.push(...wrapTerminalLine(line, Math.max(20, width - 6)).map(text => ({ sectionId: child.id, text: `      ${text}` })));
              }
            }
          }
        }
        index += count - 1;
        if (this.sections[index + 1]?.kind !== 'tool' && !this.theme.compact) rows.push({ text: '' });
        continue;
      }
      if (section.kind === 'reasoning' && !this.expandedDetails.has(section.id)) {
        rows.push({ sectionId: section.id, toggleId: section.id, text: paint(this.theme, 'tool', fit(`  ▸ ${sanitizeTerminalText(section.title)} · ${sanitizeTerminalText(section.content.split('\n')[0] ?? '')}`, width)) });
        continue;
      }
      const color = section.kind === 'reasoning' ? 'dim' : section.kind === 'error' ? 'danger' : section.kind === 'tool' ? 'tool' : section.kind === 'assistant' ? 'assistant' : 'accent';
      const lines = [paint(this.theme, color, `${section.kind === 'assistant' ? symbol(this.theme, 'assistant') : symbol(this.theme, 'bullet')} ${sanitizeTerminalText(section.title)}`)];
      const rendered = section.kind === 'assistant'
        ? renderAnalysisText(
          section.content.trimEnd(),
          this.theme,
          Math.max(20, width - 2),
        )
        : sanitizeTerminalText(section.content);
      for (const line of rendered.split('\n')) {
        lines.push(...wrapTerminalLine(line, Math.max(20, width - 2)).map((part) =>
          section.kind === 'reasoning' ? paint(this.theme, 'dim', `  ${part}`) : `  ${part}`));
      }
      if (!this.theme.compact) lines.push('');
      rows.push(...lines.map((text, sectionRowIndex) => ({
        sectionId: section.id,
        sectionRowCount: lines.length,
        sectionRowIndex,
        ...(section.kind === 'reasoning' && sectionRowIndex === 0 ? { toggleId: section.id } : {}),
        text,
      })));
    }
    return rows;
  }

  private renderFooter(width: number, maximumHeight = Number.POSITIVE_INFINITY): string[] {
    let menu = !this.ticker && this.menuIsVisible()
      ? this.renderMenu(width)
      : [];
    let suggestions = this.overlay === 'none' &&
      this.options.uiState.showSuggestions &&
      !this.editor.text() && menu.length === 0
      ? this.suggestions()
      : [];
    const reservedRows = this.overlay === 'none' ? 4 : 2;
    const availableExtraRows = Math.max(0, maximumHeight - reservedRows);
    if (menu.length > 0) {
      menu = menu.slice(0, availableExtraRows);
      suggestions = [];
    } else {
      suggestions = suggestions.slice(0, availableExtraRows);
    }
    const maximumPromptRows = Math.max(
      1,
      Math.min(5, maximumHeight - menu.length - suggestions.length - 3),
    );
    const promptLines = this.overlay === 'none'
      ? renderEditor(this.editor, width - 4, this.theme, maximumPromptRows)
      : [];
    const status = this.overlay !== 'none'
      ? 'Panel open · PgUp/PgDn or the mouse wheel scrolls · Escape closes'
      : this.ticker && this.editor.text()
      ? this.queuedPrompt ? 'Queued · Editing cancels the queue · Esc stops' : 'Draft · Enter queues · Esc stops'
      : this.answerFocus
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
      ...(promptLines.length > 0 ? [''] : []),
      paint(this.theme, 'dim', fit(` ${sanitizeTerminalText(status)}${this.ticker ? ' · Ctrl+C exits · PgUp/PgDn scrolls' : ' · Ctrl+G context · Ctrl+K commands · ? help'}`, width)),
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
    const experienceRow = (title: string, description: string): string => fit(
      `${paint(this.theme, 'accent', title.padEnd(12))}${sanitizeTerminalText(description)}`,
      width,
    );
    return [
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
      experienceRow('EXPLORE', 'Player information · Team information · News'),
      experienceRow('MY FANTASY', 'Lineup review · Waivers · Matchup forecast'),
      experienceRow('ANALYZE', 'Start or sit · Trade review · Projections'),
      '',
    ];
  }

  private shortcuts(width: number): string[] {
    return [
      paint(this.theme, 'accent', 'KEYBOARD SHORTCUTS'),
      '',
      '  Ctrl+K       Open the command palette',
      '  Ctrl+G       Select the active context',
      '  ?            Open this guide from an empty prompt',
      '  Tab / →      Fill the selected command',
      '  1 / 2 / 3    Type a number, then press Enter',
      '  ← / →        Move the cursor',
      '  Option+←/→   Move by one word',
      '  Ctrl+A / E   Move to the start or end',
      '  Ctrl+W       Delete the prior word',
      '  Ctrl+U       Delete to the start',
      '  Alt+Enter    Insert a new line',
      '  During a reply, type the next prompt. Enter queues it.',
      '  Editing cancels the queue. A failed reply keeps the draft.',
      '  ↑ / ↓        Read prompt history',
      '  Ctrl+R       Search prompt history',
      '  PgUp/PgDn    Scroll the transcript or panel',
      '  Mouse wheel  Scroll the transcript or panel',
      '  Mouse drag    Select text, hold at an edge to scroll',
      '  /copy all     Copy the full conversation',
      '  /select       Select the full conversation in scrollback',
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

function isDecisionHeading(line: string): boolean {
  return /^(?:━━|◆|›|==|#|>)\s+DECISION(?:\s|$)/u.test(
    stripAnsi(line).trim().toUpperCase(),
  );
}

function toolApprovalInputSummary(input: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(input, (key, value: unknown) =>
      TOOL_APPROVAL_SENSITIVE_KEY.test(key) ? '[redacted]' : value) ?? String(input);
  } catch {
    serialized = '[Input could not be serialized]';
  }
  const safe = sanitizeTerminalText(serialized).replace(/\s+/gu, ' ').trim() || 'none';
  const graphemes = terminalGraphemes(safe);
  if (graphemes.length <= TOOL_APPROVAL_INPUT_LIMIT) return safe;
  return `${graphemes.slice(0, TOOL_APPROVAL_INPUT_LIMIT - 1).join('')}…`;
}

function promptWithoutModelConfigurationArguments(prompt: string): string {
  const parsed = parseInteractiveCommandInput(prompt);
  return parsed?.argumentText &&
      (parsed.command?.name === 'model' || parsed.command?.name === 'provider')
    ? `/${parsed.command.name}`
    : prompt;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolIdentifier(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const values = input as Record<string, unknown>;
  return ['playerName', 'playerNames', 'team', 'leagueId', 'query', 'url', 'season', 'week', 'rosterId']
    .filter(key => values[key] !== undefined).slice(0, 3)
    .map(key => `${key}: ${String(values[key])}`).join(' · ');
}
function toolDetails(part: unknown): string {
  const value = part as Record<string, unknown>;
  const text = JSON.stringify({ input: value.input, output: value.output, error: value.errorText, state: value.state }, null, 2) ?? '';
  return text.length > 64000 ? `${text.slice(0, 64000)}\n[Display limited to 64,000 characters.]` : text;
}
