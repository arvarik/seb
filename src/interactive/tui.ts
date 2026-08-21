import { randomUUID } from 'node:crypto';

import {
  getToolName,
  isToolUIPart,
  type ChatTransport,
  type UIMessage,
} from 'ai';

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
  private readonly renderer: SebConversationRenderer;
  private readonly title: string;
  private readonly transport: ChatTransport<UIMessage>;

  constructor(options: SebConversationRunnerOptions) {
    this.chatId = options.chatId ?? `seb-${randomUUID()}`;
    this.renderer = options.renderer;
    this.title = options.title;
    this.transport = options.transport;
  }

  async run(): Promise<void> {
    const messages: UIMessage[] = [];
    let nextMessageIndex = 0;
    let prompt: string | undefined;
    let streamWithoutPrompt = false;

    while (true) {
      if (!streamWithoutPrompt) {
        try {
          prompt = await this.renderer.readPrompt({ title: this.title });
        } catch (error) {
          if (isInterruptedError(error)) return;
          throw error;
        }
        if (prompt === undefined) return;
        messages.push(createUserMessage(`message-${++nextMessageIndex}`, prompt));
      }

      const abortController = new AbortController();
      const previousAssistant = lastAssistantMessage(messages);
      const result: SebRendererStreamResult = {
        abort: () => abortController.abort(),
        ...(previousAssistant ? { message: previousAssistant } : {}),
        uiMessageStream: await this.transport.sendMessages({
          abortSignal: abortController.signal,
          chatId: this.chatId,
          messageId: undefined,
          messages: [...messages],
          trigger: 'submit-message',
        }),
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

      streamWithoutPrompt = false;
      prompt = undefined;
    }
  }
}

export interface SebInteractiveTuiOptions {
  environment?: NodeJS.ProcessEnv;
  history?: PromptHistory;
  input?: SebTerminalInput;
  model?: string;
  output?: SebTerminalOutput;
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
    session: options.session,
    sources,
    uiState,
    version: options.version ?? 'development',
  });
  await new SebConversationRunner({
    renderer,
    title: options.title,
    transport: options.transport,
  }).run();
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
