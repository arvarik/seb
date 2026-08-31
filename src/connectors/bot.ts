import { createDiscordAdapter } from '@chat-adapter/discord';
import { createSlackAdapter } from '@chat-adapter/slack';
import { createMemoryState } from '@chat-adapter/state-memory';
import { createRedisState } from '@chat-adapter/state-redis';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  Chat,
  fromFullStream,
  type Adapter,
  type Message,
  type MessageContext,
  type Thread,
} from 'chat';
import { toAiMessages } from 'chat/ai';

import {
  createFantasyFootballAgent,
  DEFAULT_GEMINI_FALLBACK_MODEL,
  DEFAULT_GEMINI_MODEL,
} from '../agent.js';
import {
  buildFreeformRecommendationEvidence,
  enforceFreeformRecommendation,
  questionRequestsRecommendation,
  recommendationContextQuestion,
  type RecommendationToolResult,
} from '../analysis/recommendation-eligibility.js';
import { isModelCapacityError } from '../model-capacity-error.js';
import { NflverseClient } from '../nflverse/client.js';
import { NewsClient } from '../news/client.js';
import { SleeperClient } from '../sleeper/client.js';
import { WeatherClient } from '../weather/client.js';
import {
  formatEvidenceMarkdown,
  normalizeWebUrl,
  SourceTracker,
  type SourceObserver,
} from '../sources.js';
import {
  CONNECTOR_NAMES,
  readConnectorConfig,
  type ConnectorConfig,
  type ConnectorName,
  type Environment,
} from './config.js';

const HISTORY_LIMIT = 20;
const CONNECTOR_FAILURE_TIMEOUT_MS = 5_000;
const CONNECTOR_REPLY_TIMEOUT_MS = 120_000;
const FAILURE_MESSAGE =
  'Seb could not answer this request. Check the connector service logs, then retry.';
const NEVER_ABORT_SIGNAL = new AbortController().signal;

export class ModelResponseError extends Error {
  readonly emittedOutput: boolean;
  override readonly cause: unknown;

  constructor(cause: unknown, emittedOutput: boolean) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ModelResponseError';
    this.cause = cause;
    this.emittedOutput = emittedOutput;
  }
}

class ConnectorShutdownError extends Error {
  constructor() {
    super('The connector service is stopping.');
    this.name = 'ConnectorShutdownError';
  }
}

export interface ConnectorRuntime {
  abortReplies(): void;
  bot: Chat<Record<string, Adapter>>;
  config: ConnectorConfig;
  discord?: ReturnType<typeof createDiscordAdapter>;
  stateKind: 'memory' | 'redis';
}

export type ConnectorReply = (
  thread: Thread,
  message: Message,
  context: MessageContext | undefined,
  signal: AbortSignal,
) => Promise<void>;

export function createConnectorRuntime(
  environment: Environment = process.env,
): ConnectorRuntime {
  const config = readConnectorConfig(environment);
  const adapters: Record<string, Adapter> = {};
  let discord: ReturnType<typeof createDiscordAdapter> | undefined;

  for (const name of config.enabled) {
    if (name === 'slack') {
      adapters.slack = createSlack(config, environment) as unknown as Adapter;
    }
    if (name === 'discord') {
      discord = createDiscordAdapter({
        applicationId: requireEnvironment(
          environment,
          'DISCORD_APPLICATION_ID',
        ),
        botToken: requireEnvironment(environment, 'DISCORD_BOT_TOKEN'),
        publicKey: requireEnvironment(environment, 'DISCORD_PUBLIC_KEY'),
      });
      adapters.discord = discord as unknown as Adapter;
    }
    if (name === 'telegram') {
      adapters.telegram = createTelegramAdapter({
        botToken: requireEnvironment(environment, 'TELEGRAM_BOT_TOKEN'),
        mode: config.telegramMode,
        ...(environment.TELEGRAM_BOT_USERNAME?.trim()
          ? { userName: environment.TELEGRAM_BOT_USERNAME.trim() }
          : {}),
        ...(environment.TELEGRAM_WEBHOOK_SECRET_TOKEN?.trim()
          ? {
              secretToken:
                environment.TELEGRAM_WEBHOOK_SECRET_TOKEN.trim(),
            }
          : {}),
      }) as unknown as Adapter;
    }
  }

  const redisUrl = environment.REDIS_URL?.trim();
  const state = redisUrl
    ? createRedisState({ keyPrefix: 'seb', url: redisUrl })
    : createMemoryState();
  const bot = new Chat({
    adapters,
    concurrency: {
      maxQueueSize: 10,
      onQueueFull: 'drop-oldest',
      queueEntryTtlMs: 90_000,
      strategy: 'queue',
    },
    state,
    userName: config.botName,
  });
  const replyAbort = new AbortController();

  registerConnectorHandlers(
    bot,
    createAgentReply(environment),
    replyAbort.signal,
  );

  return {
    abortReplies: () => replyAbort.abort(new ConnectorShutdownError()),
    bot,
    config,
    ...(discord ? { discord } : {}),
    stateKind: redisUrl ? 'redis' : 'memory',
  };
}

export function registerConnectorHandlers(
  bot: Chat<Record<string, Adapter>>,
  reply: ConnectorReply,
  shutdownSignal = NEVER_ABORT_SIGNAL,
): void {
  bot.onNewMention(async (thread, message, context) => {
    await runReply(
      reply,
      thread,
      message,
      context,
      connectorReplySignal(shutdownSignal),
      true,
    );
  });

  bot.onDirectMessage(async (thread, message, _channel, context) => {
    await runReply(
      reply,
      thread,
      message,
      context,
      connectorReplySignal(shutdownSignal),
    );
  });

  bot.onSubscribedMessage(async (thread, message, context) => {
    await runReply(
      reply,
      thread,
      message,
      context,
      connectorReplySignal(shutdownSignal),
    );
  });
}

function createAgentReply(environment: Environment): ConnectorReply {
  const apiKey = requireEnvironment(
    environment,
    'GOOGLE_GENERATIVE_AI_API_KEY',
  );
  const primaryModel =
    environment.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const fallbackModel =
    environment.GEMINI_FALLBACK_MODEL?.trim() ||
    DEFAULT_GEMINI_FALLBACK_MODEL;
  const sourceContext = new AsyncLocalStorage<SourceTracker>();
  const onSource: SourceObserver = (source) => sourceContext.getStore()?.record(source);
  const sleeperClient = new SleeperClient({ onSource });
  const nflverseClient = new NflverseClient({ onSource });
  const newsClient = new NewsClient({ onSource });
  const weatherClient = new WeatherClient({
    onSource,
    ...(environment.NWS_USER_AGENT?.trim()
      ? { userAgent: environment.NWS_USER_AGENT.trim() }
      : {}),
  });
  const clients = { sleeperClient, nflverseClient, newsClient, weatherClient };
  const primaryAgent = createFantasyFootballAgent({
    apiKey,
    model: primaryModel,
    ...clients,
  });
  const fallbackAgent =
    fallbackModel === primaryModel
      ? primaryAgent
      : createFantasyFootballAgent({
          apiKey,
          model: fallbackModel,
          ...clients,
        });

  return async (thread, message, context, requestSignal) => {
    requestSignal.throwIfAborted();
    await sourceContext.run(new SourceTracker(), async () => {
      const sources = sourceContext.getStore() as SourceTracker;
      const prompt = await waitForSignal(
        buildPrompt(thread, message, context),
        requestSignal,
      );
      try {
        await postAgentResponse(
          thread,
          primaryAgent,
          prompt,
          sources,
          requestSignal,
        );
      } catch (error) {
        if (
          !(error instanceof ModelResponseError) ||
          error.emittedOutput ||
          !isModelCapacityError(error.cause) ||
          fallbackAgent === primaryAgent
        ) {
          throw error;
        }
        sources.clear();
        await postAgentResponse(
          thread,
          fallbackAgent,
          prompt,
          sources,
          requestSignal,
        );
      }
    });
  };
}

async function postAgentResponse(
  thread: Thread,
  agent: ReturnType<typeof createFantasyFootballAgent>,
  prompt: Awaited<ReturnType<typeof buildPrompt>>,
  directSources: SourceTracker,
  signal: AbortSignal,
): Promise<void> {
  let result: Awaited<ReturnType<typeof agent.stream>>;
  try {
    result = await agent.stream({ abortSignal: signal, prompt });
  } catch (error) {
    throw new ModelResponseError(error, false);
  }
  await waitForSignal(
    thread.post(withWebSources(
      result.fullStream,
      directSources,
      latestRecommendationQuestion(prompt),
      signal,
    )),
    signal,
  );
}

export function withWebSources(
  stream: AsyncIterable<unknown>,
  directSources?: SourceTracker,
  question = '',
  abortSignal?: AbortSignal,
) {
  if (questionRequestsRecommendation(question)) {
    return guardedRecommendationStream(
      stream,
      directSources ?? new SourceTracker(),
      question,
      abortSignal,
    );
  }
  const answerSources = directSources ?? new SourceTracker();
  let emittedOutput = false;
  const monitored = (async function* () {
    try {
      for await (const part of stream) {
        if (isErrorPart(part)) throw new ModelResponseError(part.error, emittedOutput);
        if (isAbortPart(part)) {
          throw new ModelResponseError(
            abortSignal?.reason ??
              new DOMException('The model stream stopped.', 'AbortError'),
            emittedOutput,
          );
        }
        if (isUserVisibleOutputPart(part)) emittedOutput = true;
        if (isUrlSourcePart(part)) {
          const url = normalizeWebUrl(part.url);
          if (url) {
            answerSources.recordUrlSource({
              id: sourcePartId(part),
              ...(part.title ? { title: part.title } : {}),
              url,
            });
          }
        }
        yield part;
      }
    } catch (error) {
      if (error instanceof ModelResponseError) throw error;
      throw new ModelResponseError(error, emittedOutput);
    }
  })();
  const text = fromFullStream(monitored);
  return (async function* () {
    for await (const part of text) yield part;
    yield sourceAppendix(answerSources);
  })();
}

function guardedRecommendationStream(
  stream: AsyncIterable<unknown>,
  directSources: SourceTracker,
  question: string,
  abortSignal?: AbortSignal,
) {
  return (async function* () {
    let answer = '';
    const toolCalls = new Map<string, { input: unknown; toolName: string }>();
    const toolResults: RecommendationToolResult[] = [];
    try {
      for await (const part of stream) {
        if (isErrorPart(part)) throw new ModelResponseError(part.error, false);
        if (isAbortPart(part)) {
          throw new ModelResponseError(
            abortSignal?.reason ??
              new DOMException('The model stream stopped.', 'AbortError'),
            answer.length > 0,
          );
        }
        if (isTextDeltaPart(part)) answer += part.text;
        recordRecommendationToolCall(part, toolCalls);
        if (isUrlSourcePart(part)) {
          const url = normalizeWebUrl(part.url);
          if (url) {
            directSources.recordUrlSource({
              id: sourcePartId(part),
              ...(part.title ? { title: part.title } : {}),
              url,
            });
          }
        }
        const toolResult = recommendationToolResult(part, toolCalls);
        if (toolResult) toolResults.push(toolResult);
      }
    } catch (error) {
      if (error instanceof ModelResponseError) throw error;
      throw new ModelResponseError(error, false);
    }
    const guarded = enforceFreeformRecommendation(
      answer,
      buildFreeformRecommendationEvidence({
        question,
        sources: directSources.list(),
        toolResults,
      }),
    );
    yield guarded.answer;
    yield sourceAppendix(directSources);
  })();
}

function sourceAppendix(sources: SourceTracker): string {
  const evidence = formatEvidenceMarkdown(sources.list());
  return evidence ? `\n\n${evidence}` : '';
}

function recordRecommendationToolCall(
  value: unknown,
  toolCalls: Map<string, { input: unknown; toolName: string }>,
): void {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (
    record.type === 'tool-call' &&
    typeof record.toolCallId === 'string' &&
    typeof record.toolName === 'string'
  ) {
    toolCalls.set(record.toolCallId, {
      input: record.input,
      toolName: record.toolName,
    });
  }
}

function recommendationToolResult(
  value: unknown,
  toolCalls: Map<string, { input: unknown; toolName: string }>,
): RecommendationToolResult | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    record.type !== 'tool-result' ||
    typeof record.toolName !== 'string' ||
    !('output' in record)
  ) return null;
  const call = typeof record.toolCallId === 'string'
    ? toolCalls.get(record.toolCallId)
    : undefined;
  if (typeof record.toolCallId === 'string') toolCalls.delete(record.toolCallId);
  return {
    ...(call ? { input: call.input } : {}),
    output: record.output,
    toolName: record.toolName,
  };
}

function sourcePartId(value: unknown): string {
  if (!value || typeof value !== 'object') return crypto.randomUUID();
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'string' ? id : crypto.randomUUID();
}

function latestRecommendationQuestion(prompt: unknown): string {
  const prompts = userPrompts(prompt);
  return recommendationContextQuestion(prompts.at(-1) ?? '', prompts.at(-2));
}

function userPrompts(prompt: unknown): string[] {
  if (!Array.isArray(prompt)) return [];
  const prompts: string[] = [];
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    const message = prompt[index];
    if (!message || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    if (record.role !== 'user') continue;
    if (typeof record.content === 'string') {
      prompts.unshift(record.content);
      if (prompts.length === 2) break;
      continue;
    }
    if (!Array.isArray(record.content)) continue;
    const text = record.content.flatMap((part) => {
      if (!part || typeof part !== 'object') return [];
      const partRecord = part as Record<string, unknown>;
      return partRecord.type === 'text' && typeof partRecord.text === 'string'
        ? [partRecord.text]
        : [];
    }).join('\n');
    if (text) prompts.unshift(text);
    if (prompts.length === 2) break;
  }
  return prompts;
}

function isTextDeltaPart(value: unknown): value is { text: string; type: 'text-delta' } {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'text-delta' &&
    typeof (value as { text?: unknown }).text === 'string',
  );
}

function isUserVisibleOutputPart(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  if (isTextDeltaPart(value)) return value.text.length > 0;
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return type === 'markdown_text' || type === 'task_update' || type === 'plan_update';
}

function isErrorPart(value: unknown): value is { error: unknown; type: 'error' } {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'error' &&
    'error' in value,
  );
}

function isAbortPart(value: unknown): value is { type: 'abort' } {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'abort',
  );
}

function isUrlSourcePart(value: unknown): value is {
  sourceType: 'url';
  title?: string;
  type: 'source';
  url: string;
} {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (
    record.type !== 'source' ||
    record.sourceType !== 'url' ||
    typeof record.url !== 'string'
  ) {
    return false;
  }
  return normalizeWebUrl(record.url) !== null;
}

async function buildPrompt(
  thread: Thread,
  message: Message,
  context?: MessageContext,
) {
  const incoming = [...(context?.skipped ?? []), message];
  try {
    const result = await thread.adapter.fetchMessages(thread.id, {
      limit: HISTORY_LIMIT,
    });
    const knownIds = new Set(result.messages.map((item) => item.id));
    const combined = [
      ...result.messages,
      ...incoming.filter((item) => !knownIds.has(item.id)),
    ];
    return await toAiMessages(combined, { includeNames: !thread.isDM });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Seb could not read connector history. It will use the current turn. ${reason}\n`,
    );
    return await toAiMessages(incoming, { includeNames: !thread.isDM });
  }
}

async function runReply(
  reply: ConnectorReply,
  thread: Thread,
  message: Message,
  context: MessageContext | undefined,
  signal: AbortSignal,
  subscribe = false,
): Promise<void> {
  try {
    signal.throwIfAborted();
    if (subscribe) {
      await waitForSignal(thread.subscribe(), signal);
    }
    await reply(thread, message, context, signal);
  } catch (error) {
    if (connectorShutdown(error)) return;
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Seb connector reply failed: ${reason}\n`);
    await postFailureMessage(thread);
  }
}

function connectorReplySignal(shutdownSignal: AbortSignal): AbortSignal {
  return AbortSignal.any([
    shutdownSignal,
    AbortSignal.timeout(CONNECTOR_REPLY_TIMEOUT_MS),
  ]);
}

function connectorShutdown(error: unknown): boolean {
  return error instanceof ConnectorShutdownError ||
    (error instanceof ModelResponseError &&
      error.cause instanceof ConnectorShutdownError);
}

export function waitForSignal<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    }).catch(() => undefined);
  });
}

async function postFailureMessage(target: Thread): Promise<void> {
  const signal = AbortSignal.timeout(CONNECTOR_FAILURE_TIMEOUT_MS);
  try {
    await waitForSignal(target.post(FAILURE_MESSAGE), signal);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Seb could not post the failure message: ${reason}\n`);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function createSlack(
  config: ConnectorConfig,
  environment: Environment,
): ReturnType<typeof createSlackAdapter> {
  const botToken = requireEnvironment(environment, 'SLACK_BOT_TOKEN');
  if (config.slackMode === 'socket') {
    return createSlackAdapter({
      appToken: requireEnvironment(environment, 'SLACK_APP_TOKEN'),
      botToken,
      mode: 'socket',
    });
  }
  return createSlackAdapter({
    botToken,
    mode: 'webhook',
    signingSecret: requireEnvironment(environment, 'SLACK_SIGNING_SECRET'),
  });
}

function requireEnvironment(
  environment: Environment,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`Set ${name} before you start the connector service.`);
  }
  return value;
}

export function isConnectorName(value: string): value is ConnectorName {
  return CONNECTOR_NAMES.includes(value as ConnectorName);
}
