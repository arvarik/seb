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
  parseInteractiveCommandInput,
} from './commands.js';
import { PromptEditor, TerminalKeyParser, type TerminalKey } from './editor.js';
import type { PromptHistory } from './history.js';
import {
  formatElapsed,
  friendlyToolName,
  osc52,
  renderAnalysisText,
  sourceBadge,
  stripAnsi,
  visibleLength,
  wrapTerminalLine,
} from './presentation.js';
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

const SPINNERS = ['◐', '◓', '◑', '◒'] as const;

export class SebTerminalRenderer {
  private active = false;
  private activeStartedAt = 0;
  private activeToolIds = new Set<string>();
  private editor = new PromptEditor();
  private exitRequested = false;
  private historyIndex = -1;
  private interrupted = false;
  private keyParser = new TerminalKeyParser();
  private menuOpen = false;
  private menuSelection = 0;
  private onData: ((chunk: Buffer) => void) | undefined;
  private onResize: (() => void) | undefined;
  private overlay: 'none' | 'shortcuts' | 'history' = 'none';
  private readonly options: SebRendererOptions;
  private scrollOffset = 0;
  private sections: Section[] = [];
  private status = 'Ready';
  private streamMessage: UIMessage | undefined;
  private streamStartedAt = 0;
  private streamStop: (() => void) | undefined;
  private theme: SebTheme;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private toolDurations = new Map<string, number>();
  private toolStartedAt = new Map<string, number>();

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
    options?: SebRendererSessionOptions,
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
      this.activeToolIds.clear();
      this.status = this.interrupted
        ? 'Request stopped'
        : `Ready · ${formatElapsed(Date.now() - this.streamStartedAt)}`;
      this.captureAnswer(response);
      this.options.uiState.sources = this.options.sources.list();
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
      case 'paste': this.editor.insert(key.value.replace(/\r\n?/g, '\n')); break;
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
      case 'page-up': this.scroll(8); break;
      case 'page-down': this.scroll(-8); break;
      case 'scroll-up': this.scroll(1); break;
      case 'scroll-down': this.scroll(-1); break;
      case 'ctrl-r': this.reverseSearch(); break;
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
        this.options.output.write(osc52(answer));
        this.status = 'Copied the latest answer';
      } else {
        this.status = 'No answer is available to copy';
      }
      this.editor.set('');
      this.paint();
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

  private async finishSubmission(
    prompt: string,
    resolve: (value: string | undefined) => void,
  ): Promise<void> {
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
      this.scroll(key.type === 'page-up' ? 8 : 1);
    } else if (key.type === 'page-down' || key.type === 'down') {
      this.scroll(key.type === 'page-down' ? -8 : -1);
    } else if (key.type === 'scroll-up' || key.type === 'scroll-down') {
      this.scroll(key.type === 'scroll-up' ? 1 : -1);
    } else if (key.type === 'ctrl-l') {
      this.paint(true);
    }
  }

  private renderMessage(message: UIMessage): void {
    const width = Math.max(40, this.options.output.columns ?? 80);
    const previousBodyLength = this.scrollOffset > 0
      ? this.renderBody(width).length
      : null;
    const active = new Set<string>();
    for (const [index, part] of message.parts.entries()) {
      const id = `${message.id}:${index}`;
      if (part.type === 'text' && part.text.trim()) {
        active.add(id);
        this.upsert({ content: part.text, id, kind: 'assistant', title: 'Seb' });
      } else if (isToolUIPart(part)) {
        active.add(id);
        const state = part.state;
        const name = getToolName(part);
        const running = state === 'input-streaming' || state === 'input-available' || state === 'approval-requested';
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
        const failed = state === 'output-error' || state === 'output-denied';
        const marker = failed ? symbol(this.theme, 'danger') : running ? this.spinner() : symbol(this.theme, 'done');
        const startedAt = this.toolStartedAt.get(id) ?? this.activeStartedAt;
        const elapsed = formatElapsed(running
          ? Date.now() - startedAt
          : this.toolDurations.get(id) ?? Date.now() - startedAt);
        const detail = failed && 'errorText' in part ? ` · ${part.errorText}` : '';
        this.upsert({
          content: `${marker} ${friendlyToolName(name)} · ${elapsed}${detail}`,
          id,
          kind: failed ? 'error' : 'tool',
          title: running ? 'Working' : 'Tool',
        });
        if (running) this.status = `${friendlyToolName(name)} · ${elapsed}`;
      }
    }
    this.sections = this.sections.filter((section) =>
      !section.id.startsWith(`${message.id}:`) || active.has(section.id));
    if (previousBodyLength !== null) {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset + this.renderBody(width).length - previousBodyLength,
      );
    }
    this.paint();
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
    this.options.output.write('\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1006h');
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
    if (!this.active) return;
    if (this.options.input.isTTY) {
      this.options.input.setRawMode?.(false);
      this.options.input.pause();
    }
    if (this.onResize) this.options.output.off('resize', this.onResize);
    this.options.output.write('\x1b[?1006l\x1b[?1000l\x1b[?2004l\x1b[?25h\x1b[?1049l');
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
        this.paint();
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

  private scroll(delta: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
    this.paint();
  }

  private paint(clear = false): void {
    if (!this.active) return;
    const width = Math.max(40, this.options.output.columns ?? 80);
    const height = Math.max(16, this.options.output.rows ?? 24);
    const header = this.renderHeader(width);
    const footerHeight = this.renderFooter(width).length;
    const bodyHeight = Math.max(3, height - header.length - footerHeight);
    const body = this.renderBody(width);
    const maximumOffset = Math.max(0, body.length - bodyHeight);
    this.scrollOffset = Math.min(this.scrollOffset, maximumOffset);
    const footer = this.renderFooter(width);
    const end = body.length - this.scrollOffset;
    const visible = body.slice(Math.max(0, end - bodyHeight), end);
    while (visible.length < bodyHeight) visible.unshift('');
    const lines = [...header, ...visible, ...footer].slice(0, height);
    const output = [
      '\x1b[?2026h',
      clear ? '\x1b[2J\x1b[H' : '\x1b[H',
      ...lines.map((line, index) => `${line}\x1b[K${index < lines.length - 1 ? '\r\n' : ''}`),
      '\x1b[?2026l',
    ].join('');
    this.options.output.write(output);
  }

  private renderHeader(width: number): string[] {
    const session = this.options.session;
    const recentSource = this.options.sources.list()[0];
    const source = recentSource ? sourceBadge(recentSource) : 'NO SOURCE YET';
    const phase = session.seasonType?.toUpperCase() ?? 'NFL';
    const title = ` SEB ${this.options.version}  ${experienceTitle(session.mode).toUpperCase()}  ${session.season} ${phase}${session.week ? ` W${session.week}` : ''}`;
    const context = [
      ...(session.user
        ? [`SLEEPER @${session.user} · ${session.leagues.length} LEAGUE${session.leagues.length === 1 ? '' : 'S'}`]
        : ['SLEEPER NOT CONNECTED']),
      ...(session.leagueId
        ? [`FOCUS ${session.leagues.find((league) => league.leagueId === session.leagueId)?.name ?? session.leagueId}`]
        : []),
      ...(session.player ? [`PLAYER ${session.player}`] : []),
      ...(!session.player && session.team ? [`TEAM ${session.team}`] : []),
      ...(session.skillId !== 'general'
        ? [`WORKFLOW ${getSkill(session.skillId).title}`]
        : []),
      ...(session.accountError ? [`ACCOUNT WARNING ${session.accountError}`] : []),
      `SOURCE ${source}`,
    ];
    const contextRows = packRows(context, width - 1).map((row) =>
      paint(this.theme, 'dim', fit(` ${row}`, width)));
    return [
      paint(this.theme, 'accent', fit(title, width)),
      ...contextRows,
      paint(this.theme, 'dim', '─'.repeat(width)),
    ];
  }

  private renderBody(width: number): string[] {
    if (this.overlay === 'shortcuts') return this.shortcuts(width);
    if (this.overlay === 'history') return this.historyRows(width);
    if (this.sections.length === 0) return this.home(width);
    const lines: string[] = [];
    for (const section of this.sections) {
      const color = section.kind === 'error' ? 'danger' : section.kind === 'tool' ? 'tool' : section.kind === 'assistant' ? 'assistant' : 'accent';
      lines.push(paint(this.theme, color, `${section.kind === 'assistant' ? symbol(this.theme, 'assistant') : symbol(this.theme, 'bullet')} ${section.title}`));
      const rendered = section.kind === 'assistant'
        ? renderAnalysisText(
          section.content,
          this.theme,
          Math.max(20, width - 2),
        )
        : section.content;
      for (const line of rendered.split('\n')) {
        lines.push(...wrapTerminalLine(line, Math.max(20, width - 2)).map((part) => `  ${part}`));
      }
      if (!this.theme.compact) lines.push('');
    }
    return lines;
  }

  private renderFooter(width: number): string[] {
    const menu = this.menuOpen || this.editor.text().startsWith('/')
      ? this.renderMenu(width)
      : [];
    const suggestions = this.options.uiState.showSuggestions &&
      !this.editor.text() && menu.length === 0
      ? this.suggestions()
      : [];
    const promptLines = renderEditor(this.editor, width - 4, this.theme);
    const status = this.scrollOffset > 0
      ? `Viewing earlier transcript · ${this.scrollOffset} ${this.scrollOffset === 1 ? 'line' : 'lines'} above latest · scroll down to return`
      : this.status;
    return [
      ...menu,
      ...suggestions.map((value, index) =>
        paint(this.theme, 'source', fit(` ${index + 1}  ${value}`, width))),
      paint(this.theme, 'dim', '─'.repeat(width)),
      ...promptLines.map((line, index) => `${index === 0 ? `${symbol(this.theme, 'prompt')} ` : '  '}${line}`),
      paint(this.theme, 'dim', fit(` ${status} · Ctrl+K commands · /exit quit · ? shortcuts`, width)),
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
    const fantasy = session.user
      ? session.accountError
        ? `Connected as @${session.user}. Refresh warning: ${session.accountError}`
        : `Connected as @${session.user} with ${session.leagues.length} discovered league${session.leagues.length === 1 ? '' : 's'}.`
      : 'Optional. Run /connect <Sleeper username> once for automatic league context.';
    return [
      '',
      paint(this.theme, 'assistant', `${symbol(this.theme, 'assistant')} Ask naturally. Seb selects the current NFL week and the right data.`),
      '',
      paint(this.theme, 'accent', 'EXPLORE'),
      '  Player profiles, team information, statistics, schedules, and verified news.',
      '',
      paint(this.theme, 'accent', 'MY FANTASY'),
      `  ${fantasy}`,
      '',
      paint(this.theme, 'accent', 'ANALYZE'),
      '  Compare players, then add matchup, usage, roster, news, and weather context.',
      '',
      paint(this.theme, 'dim', 'Use the numbered actions below, or type any question.'),
    ];
  }

  private shortcuts(width: number): string[] {
    return [
      paint(this.theme, 'accent', 'KEYBOARD SHORTCUTS'),
      '',
      '  Ctrl+K       Open the command palette',
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
        ? entries.flatMap((entry, index) => wrapTerminalLine(`  ${index + 1}. ${entry.replace(/\n/g, ' ↵ ')}`, width))
        : ['  No saved prompts.']),
      '',
      paint(this.theme, 'dim', 'Run /history clear to delete this file.'),
    ];
  }
}

function renderEditor(editor: PromptEditor, width: number, theme: SebTheme): string[] {
  const before = editor.text().slice(0, editor.cursor());
  const after = editor.text().slice(editor.cursor());
  const cursorCharacter = [...after][0] ?? ' ';
  const remainder = after.slice(cursorCharacter.length);
  const cursor = theme.color ? `\x1b[7m${cursorCharacter}\x1b[0m` : `|${cursorCharacter}`;
  const lines = `${before}${cursor}${remainder}`.split('\n');
  return lines.flatMap((line) => visibleLength(line) > width ? wrapTerminalLine(line, width) : [line]);
}

function fit(value: string, width: number): string {
  if (visibleLength(value) <= width) return value;
  const plain = stripAnsi(value);
  return width <= 1 ? plain.slice(0, width) : `${plain.slice(0, width - 1)}…`;
}

function cycle(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (index + delta + length) % length;
}

function packRows(values: readonly string[], width: number): string[] {
  const rows: string[] = [];
  let row = '';
  for (const value of values) {
    if (row && row.length + value.length + 2 > width) {
      rows.push(row);
      row = value;
    } else {
      row = row ? `${row}  ${value}` : value;
    }
  }
  if (row) rows.push(row);
  return rows;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
