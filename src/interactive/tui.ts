import { SessionStore, sessionContext, sessionsEnabled } from './sessions.js';
import { randomUUID } from 'node:crypto';

import {
  getToolName,
  isToolUIPart,
  type ChatTransport,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';

import {
  classifyModelError,
  formatModelErrorForUser,
  type ModelErrorContext,
} from '../model-capacity-error.js';
import { SourceTracker } from '../sources.js';
import { FilePromptHistory, type PromptHistory } from './history.js';
import {
  SebTerminalRenderer,
  type SebRendererSessionOptions,
  type SebRendererStreamResult,
  type SebRendererToolApprovalRequest,
  type SebTerminalInput,
  type SebTerminalOutput,
} from './renderer.js';
import type { SessionState } from './session.js';
import { InteractiveUiState } from './ui-state.js';

interface PendingToolApproval extends SebRendererToolApprovalRequest {
  approvalId: string;
  messageId: string;
  partIndex: number;
  toolCallId: string;
}

export interface SebConversationRenderer {
  close?(): void;
  readPrompt(options?: SebRendererSessionOptions): Promise<string | undefined>;
  readToolApproval(
    request: SebRendererToolApprovalRequest,
  ): Promise<{ approved: boolean; reason?: string }>;
  renderStream(
    result: SebRendererStreamResult,
    options?: SebRendererSessionOptions,
  ): Promise<UIMessage | undefined>;
}

export interface SebConversationRunnerOptions {
  chatId?: string;
  initialMessages?: readonly UIMessage[];
  checkpoint?: (messages: readonly UIMessage[]) => Promise<void>;
  modelErrorContext?: () => ModelErrorContext;
  renderer: SebConversationRenderer;
  title: string;
  transport: ChatTransport<UIMessage>;
}

/**
 * Runs one terminal conversation through the public AI SDK transport contract.
 * Seb owns this loop so a package release cannot change the terminal interface.
 */
export class SebConversationRunner {
  private readonly chatId: string;
  private readonly initialMessages: readonly UIMessage[];
  private readonly checkpoint: ((messages: readonly UIMessage[]) => Promise<void>) | undefined;
  private readonly modelErrorContext: (() => ModelErrorContext) | undefined;
  private readonly renderer: SebConversationRenderer;
  private readonly title: string;
  private readonly transport: ChatTransport<UIMessage>;

  constructor(options: SebConversationRunnerOptions) {
    this.initialMessages = options.initialMessages ?? [];
    this.checkpoint = options.checkpoint;
    this.chatId = options.chatId ?? `seb-${randomUUID()}`;
    this.modelErrorContext = options.modelErrorContext;
    this.renderer = options.renderer;
    this.title = options.title;
    this.transport = options.transport;
  }

  async run(): Promise<void> {
    try {
      await this.runConversation();
    } finally {
      this.renderer.close?.();
    }
  }

  private async runConversation(): Promise<void> {
    const messages: UIMessage[] = structuredClone([...this.initialMessages]);
    if (this.checkpoint) await this.checkpoint(messages);
    let prompt: string | undefined;
    let streamWithoutPrompt = false;
    let turnStartIndex = 0;

    while (true) {
      if (!streamWithoutPrompt) {
        try {
          prompt = await this.renderer.readPrompt({ title: this.title });
        } catch (error) {
          if (isInterruptedError(error)) return;
          throw error;
        }
        if (prompt === undefined) return;
        turnStartIndex = messages.length;
        messages.push(createUserMessage(`message-${randomUUID()}`, prompt));
      }

      if (this.checkpoint) await this.checkpoint(messages);
      const abortController = new AbortController();
      const previousAssistant = lastAssistantMessage(messages);
      const uiMessageStream = pendingRequestStream(
        async () => {
          try {
            return await this.transport.sendMessages({
              abortSignal: abortController.signal,
              chatId: this.chatId,
              messageId: undefined,
              messages: [...messages],
              trigger: 'submit-message',
            });
          } catch (error) {
            return requestSetupErrorStream(error, this.modelErrorContext?.());
          }
        },
      );
      const result: SebRendererStreamResult = {
        abort: () => abortController.abort(),
        ...(previousAssistant ? { message: previousAssistant } : {}),
        uiMessageStream,
      };

      let response: UIMessage | undefined;
      try {
        response = await this.renderer.renderStream(result, {
          continueSession: true,
          ...(prompt === undefined ? {} : { submittedPrompt: prompt }),
          title: this.title,
        });
      } catch (error) {
        if (isInterruptedError(error)) return;
        throw error;
      }

      if (!response) {
        // Keep the user's request so "try again" still identifies the question.
        // Discard partial answers and approval state from the failed attempt.
        messages.splice(turnStartIndex + 1);
        if (this.checkpoint) await this.checkpoint(messages);
        streamWithoutPrompt = false;
        prompt = undefined;
        continue;
      }

      if (response && response.parts.length > 0) {
        const approvals = findPendingToolApprovalRequests(response);
        try {
          for (const approval of approvals) {
            const decision = await this.renderer.readToolApproval(approval);
            applyToolApprovalResponse(response, approval, decision);
          }
        } catch (error) {
          if (isInterruptedError(error)) return;
          throw error;
        }
        upsertAssistantMessage(messages, response, streamWithoutPrompt);
        if (approvals.length > 0) {
          streamWithoutPrompt = true;
          prompt = undefined;
          continue;
        }
      }

      if (this.checkpoint) await this.checkpoint(messages);
      streamWithoutPrompt = false;
      prompt = undefined;
    }
  }
}

export interface SebInteractiveTuiOptions {
  resumeId?: string;
  environment?: NodeJS.ProcessEnv;
  history?: PromptHistory;
  input?: SebTerminalInput;
  model?: string;
  output?: SebTerminalOutput;
  provider?: string;
  providerLabel?: string;
  session: SessionState;
  sources?: SourceTracker;
  title: string;
  transport: ChatTransport<UIMessage>;
  uiState?: InteractiveUiState;
  version?: string;
}

export async function runSebInteractiveTui(
  options: SebInteractiveTuiOptions,
): Promise<void> {
  const environment = options.environment ?? process.env;
  const history = options.history ?? await FilePromptHistory.load(environment);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const sources = options.sources ?? new SourceTracker();
  const uiState = options.uiState ?? new InteractiveUiState();
  const renderer = new SebTerminalRenderer({
    environment,
    history,
    input,
    model: options.model ?? options.title.replace(/^Seb · /u, ''),
    output,
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.providerLabel ? { providerLabel: options.providerLabel } : {}),
    session: options.session,
    sources,
    uiState,
    version: options.version ?? 'development',
  });
  const store = sessionsEnabled(environment) ? new SessionStore(environment) : null;
  if (options.resumeId && !store) throw new Error('Session saving is disabled. Enable SEB_SESSIONS and SEB_HISTORY to resume.');
  const chatId = options.resumeId ?? `seb-${randomUUID()}`;
  let locked = false;
  let saved = false;
  let warning = '';
  try {
    if (store) {
      try { await store.acquire(chatId); locked = true; }
      catch (error) { if (options.resumeId) throw error; warning = 'Seb cannot save this session. Check the session directory permissions.'; uiState.notification = warning; }
    }
    const previous = options.resumeId ? await store!.load(chatId) : null;
    if (previous) {
      if (previous.context.user !== options.session.user) throw new Error('This session belongs to a different Sleeper account. Connect that account before resuming.');
      Object.assign(options.session, previous.context);
      if (options.session.leagueId && !options.session.leagues.some(l => l.leagueId === options.session.leagueId)) {
        options.session.leagueId = null; options.session.rosterId = null;
        uiState.notification = 'The saved league is no longer available. Choose a current league.';
      }
      for (const evidence of previous.evidence) uiState.recordAnswerEvidence(evidence);
      const latest = [...previous.messages].reverse().find(m => m.role === 'assistant');
      uiState.latestAnswer = latest?.parts.filter(p => p.type === 'text').map(p => p.text).join('\n') ?? '';
      uiState.latestPrompt = [...previous.messages].reverse().find(m => m.role === 'user')?.parts.filter(p => p.type === 'text').map(p => p.text).join('\n') ?? '';
      renderer.restoreMessages(previous.messages);
      uiState.notification ||= `Resumed conversation · ${previous.messages.length} messages`;
      saved = true;
    }
    await new SebConversationRunner({
      chatId, initialMessages: previous?.messages ?? [],
      checkpoint: async messages => {
        if (!store || !locked) return;
        try {
          await store.save({ version: 1, id: chatId, updatedAt: new Date().toISOString(), messages: [...messages],
            context: sessionContext(options.session), evidence: uiState.savedEvidence() });
          saved = true;
          if (uiState.notification === warning) uiState.notification = '';
          warning = '';
        } catch { warning = 'Seb could not save the latest turn. The previous saved conversation remains available.'; uiState.notification = warning; }
      },

      modelErrorContext: () => ({
        providerLabel: uiState.activeModel?.providerLabel ?? 'model provider',
      }),
      renderer,
      title: options.title,
      transport: options.transport,
    }).run();
  } finally {
    renderer.close();
    if (locked) await store!.release(chatId);
    if (warning) output.write(`\n${warning}\n`);
    if (saved) output.write(`\nResume this session: seb resume ${chatId}\n`);
  }
}

function createUserMessage(id: string, text: string): UIMessage {
  return { id, parts: [{ text, type: 'text' }], role: 'user' };
}

function lastAssistantMessage(messages: readonly UIMessage[]): UIMessage | undefined {
  const message = messages.at(-1);
  return message?.role === 'assistant' ? message : undefined;
}

function upsertAssistantMessage(
  messages: UIMessage[],
  response: UIMessage,
  replaceLast: boolean,
): void {
  if (replaceLast && messages.at(-1)?.role === 'assistant') {
    messages[messages.length - 1] = response;
  } else {
    messages.push(response);
  }
}

function findPendingToolApprovalRequests(message: UIMessage): PendingToolApproval[] {
  const requests: PendingToolApproval[] = [];
  for (const [partIndex, part] of message.parts.entries()) {
    if (
      !isToolUIPart(part) ||
      part.state !== 'approval-requested' ||
      part.approval.isAutomatic === true
    ) {
      continue;
    }
    requests.push({
      approvalId: part.approval.id,
      input: part.input,
      messageId: message.id,
      partIndex,
      ...(part.title ? { title: part.title } : {}),
      toolCallId: part.toolCallId,
      toolName: getToolName(part),
    });
  }
  return requests;
}

function applyToolApprovalResponse(
  message: UIMessage,
  request: PendingToolApproval,
  response: { approved: boolean; reason?: string },
): void {
  const part = message.parts[request.partIndex];
  if (!part || !isToolUIPart(part) || part.toolCallId !== request.toolCallId) {
    throw new Error(`Seb could not find tool approval ${request.approvalId}.`);
  }
  part.state = 'approval-responded';
  part.approval = {
    approved: response.approved,
    id: request.approvalId,
    ...(response.reason ? { reason: response.reason } : {}),
  };
}

function isInterruptedError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Interrupted';
}

function requestSetupErrorStream(
  error: unknown,
  context?: ModelErrorContext,
): ReadableStream<UIMessageChunk> {
  const errorText = classifyModelError(error)
    ? formatModelErrorForUser(error, 'interactive', context)
    : 'Seb could not start this request. Retry the request.';
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.enqueue({ type: 'start' });
      controller.enqueue({ type: 'error', errorText });
      controller.enqueue({ type: 'finish', finishReason: 'error' });
      controller.close();
    },
  });
}

// Keep terminal input available while the transport starts the request.
function pendingRequestStream(
  start: () => Promise<ReadableStream<UIMessageChunk>>,
): ReadableStream<UIMessageChunk> {
  let cancelled = false;
  let reader: ReadableStreamDefaultReader<UIMessageChunk> | undefined;
  const ready = start().then((stream) => {
    if (cancelled) {
      void stream.cancel().catch(() => undefined);
    } else {
      reader = stream.getReader();
    }
  });
  return new ReadableStream({
    async pull(controller) {
      await ready;
      if (cancelled || !reader) return;
      const currentReader = reader;
      let next: ReadableStreamReadResult<UIMessageChunk>;
      try {
        next = await currentReader.read();
      } catch (error) {
        if (!cancelled) {
          currentReader.releaseLock();
          reader = undefined;
          throw error;
        }
        return;
      }
      if (cancelled) return;
      if (next.done) {
        reader.releaseLock();
        reader = undefined;
        controller.close();
      } else {
        controller.enqueue(next.value);
      }
    },
    cancel() {
      cancelled = true;
      if (reader) {
        const currentReader = reader;
        reader = undefined;
        void currentReader.cancel().catch(() => undefined).finally(() => currentReader.releaseLock());
      }
    },
  });
}
