import { resolveModelFamilies } from '../ai/model-families.js';
import { createDiscordAdapter } from '@chat-adapter/discord';
import { createSlackAdapter } from '@chat-adapter/slack';
import { createMemoryState } from '@chat-adapter/state-memory';
import { createRedisState } from '@chat-adapter/state-redis';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  Chat,
  fromFullStream,
  type Adapter,
  type Message,
  type MessageContext,
  type Thread,
} from 'chat';
import { toAiMessages } from 'chat/ai';

import { createFantasyFootballAgent } from '../agent.js';
import { appendJudgmentOutput, judgmentTelemetry, traceJudgmentOperation } from '../ai/judgment.js';
import { observeCompletedModelStream } from '../ai/stream-completion.js';
import {
  resolveModelProvider,
  type ModelProviderId,
  type ResolvedModelProvider,
} from '../ai/model-provider.js';
import {
  buildFreeformRecommendationEvidence,
  buildRecommendationRecoveryPrompt,
  enforceFreeformRecommendation,
  questionRequestsRecommendation,
  recommendationContextQuestion,
  type RecommendationEvidence,
  type RecommendationToolResult,
} from '../analysis/recommendation-eligibility.js';
import { getSharedSebDatabase } from '../data/sqlite-store.js';
import {
  formatModelErrorForUser,
  isModelCapacityError,
  type ModelErrorContext,
} from '../model-capacity-error.js';
import { NflverseClient } from '../nflverse/client.js';
import { NewsClient } from '../news/client.js';
import { SleeperClient } from '../sleeper/client.js';
import { WeatherClient } from '../weather/client.js';
import {
  createSessionState,
  formatSessionData,
  formatSessionInstructions,
} from '../interactive/session.js';
import { FileSetupProfileStore } from '../setup/profile.js';
import { applySetupProfile, refreshAutomaticSession } from '../setup/wizard.js';
import {
  formatEvidenceMarkdown,
  normalizeWebUrl,
  SourceTracker,
  type SourceObserver,
} from '../sources.js';
import { SebUsageTelemetry } from '../usage/telemetry.js';
import {
  connectorChunkLimit,
  CONNECTOR_NAMES,
  readConnectorConfig,
  readTelegramAllowedUserIds,
  type ConnectorConfig,
  type ConnectorName,
  type Environment,
} from './config.js';
import { createGroupMeAdapter } from './groupme.js';

const HISTORY_LIMIT = 40;
const MAX_HISTORY_CHARS = 12_000;
const CONNECTOR_CONTEXT_TTL_MS = 5 * 60_000;
const CONNECTOR_FAILURE_TIMEOUT_MS = 5_000;
const CONNECTOR_REPLY_TIMEOUT_MS = 120_000;
const FAILURE_MESSAGE =
  'Seb could not answer this request. Check the connector service logs, then retry.';
const NEVER_ABORT_SIGNAL = new AbortController().signal;
const CONNECTOR_MODEL_ERROR_CONTEXTS: Readonly<
  Record<Exclude<ModelProviderId, 'openai-compatible'>, ModelErrorContext>
> = {
  anthropic: {
    credentialName: 'ANTHROPIC_API_KEY',
    providerLabel: 'Anthropic',
  },
  google: {
    credentialName: 'GOOGLE_GENERATIVE_AI_API_KEY',
    providerLabel: 'Gemini',
  },
  openai: {
    credentialName: 'OPENAI_API_KEY',
    providerLabel: 'OpenAI',
  },
};

export class ModelResponseError extends Error {
  readonly emittedOutput: boolean;
  override readonly cause: unknown;

  constructor(
    cause: unknown,
    emittedOutput: boolean,
    context?: ModelErrorContext,
  ) {
    super(
      context
        ? formatModelErrorForUser(cause, 'connector', context)
        : formatModelErrorForUser(cause, 'connector'),
      { cause },
    );
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
      const allowedUserIds = readTelegramAllowedUserIds(environment);
      adapters.telegram = createTelegramAdapter({
        botToken: requireEnvironment(environment, 'TELEGRAM_BOT_TOKEN'),
        mentionOnReply:
          environment.TELEGRAM_MENTION_ON_REPLY?.trim().toLowerCase() !== 'false',
        mode: config.telegramMode,
        ...(allowedUserIds ? { allowedUserIds } : {}),
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
    if (name === 'groupme') {
      adapters.groupme = createGroupMeAdapter({
        botId: requireEnvironment(environment, 'GROUPME_BOT_ID'),
        botName: config.botName,
        secretToken: requireEnvironment(environment, 'GROUPME_WEBHOOK_SECRET'),
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

export function resolveConnectorModelProvider(
  environment: Environment = process.env,
): ResolvedModelProvider {
  return resolveModelProvider({ environment });
}

function connectorModelErrorContext(
  selection: ResolvedModelProvider,
): ModelErrorContext {
  if (selection.provider !== 'openai-compatible') {
    return CONNECTOR_MODEL_ERROR_CONTEXTS[selection.provider];
  }
  return {
    ...(selection.apiKey
      ? { credentialName: 'OPENAI_COMPATIBLE_API_KEY' }
      : {}),
    providerLabel: 'OpenAI-compatible endpoint',
  };
}

function createAgentReply(environment: Environment): ConnectorReply {
  const configured = resolveConnectorModelProvider(environment);
  const modelErrorContext = connectorModelErrorContext(configured);
  const sourceContext = new AsyncLocalStorage<SourceTracker>();
  const onSource: SourceObserver = (source) => sourceContext.getStore()?.record(source);
  const sleeperClient = new SleeperClient({ onSource });
  const contextSleeperClient = new SleeperClient();
  const nflverseClient = new NflverseClient({ onSource });
  const newsClient = new NewsClient({ onSource });
  const weatherClient = new WeatherClient({
    onSource,
    ...(environment.NWS_USER_AGENT?.trim()
      ? { userAgent: environment.NWS_USER_AGENT.trim() }
      : {}),
  });
  const clients = { sleeperClient, nflverseClient, newsClient, weatherClient };
  const database = getSharedSebDatabase();
  let cachedSelection: ResolvedModelProvider | undefined;
  let cachedContext: { data: string; expiresAt: number; instructions: string } | undefined;

  const getRuntimeContextSnapshot = async () => {
    if (cachedContext && Date.now() < cachedContext.expiresAt) return cachedContext;
    const session = createSessionState();
    const preferredUser = environment.SEB_SLEEPER_USER?.trim();
    try {
      const profile = await new FileSetupProfileStore({ environment }).load();
      if (profile) applySetupProfile(profile, session);
    } catch {
      // Ignore optional profile errors in connector mode.
    }
    try {
      await refreshAutomaticSession(
        contextSleeperClient,
        session,
        preferredUser || session.user || undefined,
      );
    } catch {
      // Degrade gracefully when Sleeper is unreachable.
    }
    cachedContext = {
      data: formatSessionData(session),
      expiresAt: Date.now() + CONNECTOR_CONTEXT_TTL_MS,
      instructions: formatSessionInstructions(session),
    };
    return cachedContext;
  };

  return async (thread, message, context, requestSignal) => {
    requestSignal.throwIfAborted();
    const [selection, runtimeContext] = await Promise.all([
      cachedSelection
        ? Promise.resolve(cachedSelection)
        : resolveModelFamilies(configured, { signal: requestSignal }).then((resolved) => {
            cachedSelection = resolved;
            return resolved;
          }),
      getRuntimeContextSnapshot(),
    ]);
    const primaryModel = selection.model;
    const fallbackModel = selection.fallbackModel;
    const usageSessionId = randomUUID();
    const primaryUsageTelemetry = new SebUsageTelemetry({
      agentKind: 'research',
      database,
      sessionId: usageSessionId,
      surface: 'connector',
    });
    const primaryAgent = createFantasyFootballAgent({
      ...connectorAgentModel(selection, primaryModel),
      ...clients,
      getRuntimeContext: () => runtimeContext.data,
      getRuntimeInstructions: () => runtimeContext.instructions,
      telemetryFunctionId: 'seb.connector.research',
      telemetryIntegrations: [primaryUsageTelemetry],
    });
    const fallbackUsageTelemetry = fallbackModel === primaryModel
      ? primaryUsageTelemetry
      : new SebUsageTelemetry({
          agentKind: 'research',
          database,
          sessionId: usageSessionId,
          surface: 'connector',
        });
    const fallbackAgent = fallbackModel === primaryModel
      ? primaryAgent
      : createFantasyFootballAgent({
          ...connectorAgentModel(selection, fallbackModel),
          ...clients,
          getRuntimeContext: () => runtimeContext.data,
          getRuntimeInstructions: () => runtimeContext.instructions,
          telemetryFunctionId: 'seb.connector.research',
          telemetryIntegrations: [fallbackUsageTelemetry],
        });
    await sourceContext.run(new SourceTracker(), async () => {
      const sources = sourceContext.getStore() as SourceTracker;
      const prompt = await waitForSignal(
        buildPrompt(thread, message, context),
        requestSignal,
      );
      if (prompt.length === 0) return;
      await traceJudgmentOperation({
        name: 'seb.connector.reply',
        sessionId: thread.id,
        input: [{ role: 'user', content: message.text }],
      }, async () => {
        const clearStaleCaches = async () => {
          clients.newsClient.clearCache();
          database.deleteCache('news');
          await Promise.all([
            clients.sleeperClient.clearCache(),
            clients.nflverseClient.clearCache(),
            clients.weatherClient.clearCache(),
          ]);
        };
        try {
          await postAgentResponse(
            thread,
            primaryAgent,
            prompt,
            sources,
            requestSignal,
            primaryUsageTelemetry,
            modelErrorContext,
            clearStaleCaches,
          );
        } catch (error) {
          if (
            requestSignal.aborted ||
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
            fallbackUsageTelemetry,
            modelErrorContext,
            clearStaleCaches,
          );
        }
      });
    });
  };
}

async function postAgentResponse(
  thread: Thread,
  agent: ReturnType<typeof createFantasyFootballAgent>,
  prompt: Awaited<ReturnType<typeof buildPrompt>>,
  directSources: SourceTracker,
  signal: AbortSignal,
  usageTelemetry: SebUsageTelemetry,
  modelErrorContext: ModelErrorContext,
  clearStaleCaches?: () => Promise<void>,
): Promise<void> {
  let result: Awaited<ReturnType<typeof agent.stream>>;
  try {
    result = await agent.stream({ abortSignal: signal, prompt });
  } catch (error) {
    throw new ModelResponseError(error, false, modelErrorContext);
  }
  const question = latestRecommendationQuestion(prompt);
  await waitForSignal(
    postConnectorResponse(thread, withWebSources(
      result.fullStream,
      directSources,
      question,
      signal,
      () => usageTelemetry.abortUnfinished(
        signal.reason ??
          new DOMException('The connector stopped reading the response.', 'AbortError'),
      ),
      (error) => usageTelemetry.closeUnfinished(error),
      modelErrorContext,
      async (recoveryContext) => {
        if (signal.aborted) return null;
        if (recoveryContext.evidence.currentEvidence === 'stale') {
          await clearStaleCaches?.();
          directSources.clear();
        }
        const draft = recoveryContext.blockedAnswer.trim().slice(0, 1_200);
        const recoveryPrompt = [
          ...prompt,
          ...(draft ? [{ role: 'assistant' as const, content: draft }] : []),
          {
            role: 'user' as const,
            content: buildRecommendationRecoveryPrompt({
              blockedAnswer: recoveryContext.blockedAnswer,
              question,
              reasons: recoveryContext.reasons,
            }),
          },
        ];
        const recovered = await agent.stream({
          abortSignal: signal,
          prompt: recoveryPrompt,
        });
        return recovered.fullStream;
      },
    ), signal),
    signal,
  );
}

type ConnectorDecisionRecovery = (context: {
  blockedAnswer: string;
  evidence: RecommendationEvidence;
  reasons: readonly string[];
}) => Promise<AsyncIterable<unknown> | null>;

export function withWebSources(
  stream: AsyncIterable<unknown>,
  directSources?: SourceTracker,
  question = '',
  abortSignal?: AbortSignal,
  onConsumerCancel?: () => void,
  onStreamError?: (error: unknown) => void,
  modelErrorContext?: ModelErrorContext,
  recoverBlockedDecision?: ConnectorDecisionRecovery,
) {
  if (questionRequestsRecommendation(question)) {
    return observeConsumerCancellation(
      guardedRecommendationStream(
        stream,
        directSources ?? new SourceTracker(),
        question,
        abortSignal,
        modelErrorContext,
        recoverBlockedDecision,
      ),
      onConsumerCancel,
      onStreamError,
    );
  }
  const answerSources = directSources ?? new SourceTracker();
  let emittedOutput = false;
  const monitored = (async function* () {
    try {
      for await (const part of observeCompletedModelStream(stream, abortSignal)) {
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
      throw new ModelResponseError(error, emittedOutput, modelErrorContext);
    }
  })();
  const text = fromFullStream(monitored);
  const response = (async function* () {
    for await (const part of text) yield part;
    yield sourceAppendix(answerSources);
  })();
  return observeConsumerCancellation(response, onConsumerCancel, onStreamError);
}

function observeConsumerCancellation<T>(
  stream: AsyncIterable<T>,
  onConsumerCancel?: () => void,
  onStreamError?: (error: unknown) => void,
): AsyncIterable<T> {
  if (!onConsumerCancel && !onStreamError) return stream;
  return (async function* () {
    let consumerCancelled = true;
    try {
      for await (const part of stream) yield part;
      consumerCancelled = false;
    } catch (error) {
      consumerCancelled = false;
      try {
        onStreamError?.(error);
      } catch {
        // Preserve the stream error when telemetry fails.
      }
      throw error;
    } finally {
      if (consumerCancelled) onConsumerCancel?.();
    }
  })();
}

function guardedRecommendationStream(
  stream: AsyncIterable<unknown>,
  directSources: SourceTracker,
  question: string,
  abortSignal?: AbortSignal,
  modelErrorContext?: ModelErrorContext,
  recoverBlockedDecision?: ConnectorDecisionRecovery,
) {
  return (async function* () {
    const toolResults: RecommendationToolResult[] = [];
    const consumePass = async (passStream: AsyncIterable<unknown>): Promise<string> => {
      let passAnswer = '';
      const toolCalls = new Map<string, { input: unknown; toolName: string }>();
      for await (const part of observeCompletedModelStream(passStream, abortSignal)) {
        if (isTextDeltaPart(part)) passAnswer += part.text;
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
      return passAnswer;
    };

    let answer: string;
    try {
      answer = await consumePass(stream);
    } catch (error) {
      if (error instanceof ModelResponseError) throw error;
      throw new ModelResponseError(error, false, modelErrorContext);
    }
    const initialEvidence = buildFreeformRecommendationEvidence({
      question,
      sources: directSources.list(),
      toolResults,
    });
    let guarded = enforceFreeformRecommendation(answer, initialEvidence);
    if (guarded.eligibility.outcome === 'blocked' && recoverBlockedDecision) {
      try {
        if (initialEvidence.currentEvidence === 'stale') toolResults.length = 0;
        const recoveryStream = await recoverBlockedDecision({
          blockedAnswer: answer,
          evidence: initialEvidence,
          reasons: guarded.eligibility.reasons,
        });
        if (recoveryStream) {
          const recoveredAnswer = await consumePass(recoveryStream);
          if (recoveredAnswer.trim()) {
            guarded = enforceFreeformRecommendation(
              recoveredAnswer,
              buildFreeformRecommendationEvidence({
                question,
                sources: directSources.list(),
                toolResults,
              }),
            );
          }
        }
      } catch (recoveryError) {
        if (abortSignal?.aborted) {
          if (recoveryError instanceof ModelResponseError) throw recoveryError;
          throw new ModelResponseError(recoveryError, false, modelErrorContext);
        }
      }
    }
    yield guarded.answer;
    yield sourceAppendix(directSources);
  })();
}

function sourceAppendix(sources: SourceTracker): string {
  const evidence = formatEvidenceMarkdown(sources.list(), { surface: 'connector' });
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

export async function buildPrompt(
  thread: Thread,
  message: Message,
  context?: MessageContext,
) {
  const options = { includeNames: !thread.isDM };
  const incoming = [...(context?.skipped ?? []), message];
  const incomingAi = await toAiMessages(incoming, options);
  if (incomingAi.length === 0) return [];
  const incomingIds = new Set(incoming.map((item) => item.id));
  try {
    const result = await thread.adapter.fetchMessages(thread.id, {
      limit: HISTORY_LIMIT,
    });
    const prior = result.messages.filter((item) => !incomingIds.has(item.id));
    const priorAi = await toAiMessages(prior, options);
    return compactConnectorHistory([...priorAi, ...incomingAi]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Seb could not read connector history. It will use the current turn. ${reason}\n`,
    );
    return compactConnectorHistory(incomingAi);
  }
}

export function compactConnectorHistory<
  T extends { content: unknown; role: string },
>(messages: readonly T[], maxChars = MAX_HISTORY_CHARS): T[] {
  if (messages.length === 0) return [];
  const coalesce = (items: readonly T[]): T[] => {
    const out: T[] = [];
    for (const msg of items) {
      if (typeof msg.content === 'string' && msg.content.trim().length === 0) {
        continue;
      }
      const prev = out.at(-1);
      if (
        prev &&
        prev.role === msg.role &&
        typeof prev.content === 'string' &&
        typeof msg.content === 'string'
      ) {
        out[out.length - 1] = { ...prev, content: `${prev.content}\n\n${msg.content}` };
      } else {
        out.push(msg);
      }
    }
    return out;
  };
  const cleaned = coalesce(
    coalesce(messages).flatMap((msg): T[] => {
      if (msg.role !== 'assistant') {
        return Array.isArray(msg.content) && msg.content.length === 0 ? [] : [msg];
      }
      if (typeof msg.content === 'string') {
        const content = stripEvidenceAppendix(msg.content);
        return content.trim().length > 0 ? [{ ...msg, content }] : [];
      }
      if (!Array.isArray(msg.content)) return [msg];
      const content = msg.content.flatMap((part) => {
        if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
          const text = stripEvidenceAppendix((part as { text: string }).text);
          return text.trim().length > 0 ? [{ ...part, text }] : [];
        }
        return [part];
      });
      return content.length > 0 ? [{ ...msg, content }] : [];
    }),
  );
  while (cleaned.length > 0 && cleaned.at(-1)?.role !== 'user') {
    cleaned.pop();
  }
  if (cleaned.length === 0) return [];
  const kept: T[] = [cleaned[cleaned.length - 1] as T];
  let budget = maxChars;
  for (let i = cleaned.length - 2; i >= 0; i -= 1) {
    const item = cleaned[i] as T;
    const size = typeof item.content === 'string'
      ? item.content.length
      : JSON.stringify(item.content).length;
    if (size > budget) break;
    budget -= size;
    kept.unshift(item);
  }
  while (kept.length > 1 && kept[0]?.role !== 'user') {
    kept.shift();
  }
  return kept;
}

function stripEvidenceAppendix(text: string): string {
  return text.replace(/(?:^|\r?\n)##\s+Evidence\r?\n[\s\S]*$/u, '').trimEnd();
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
    await postFailureMessage(thread, error);
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

async function postFailureMessage(target: Thread, error: unknown): Promise<void> {
  const signal = AbortSignal.timeout(CONNECTOR_FAILURE_TIMEOUT_MS);
  try {
    await waitForSignal(target.post(error instanceof ModelResponseError ? error.message : FAILURE_MESSAGE), signal);
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

function connectorAgentModel(
  selection: ResolvedModelProvider,
  model: string,
) {
  if (selection.provider === 'google') {
    const apiKey = selection.apiKey;
    if (!apiKey) {
      throw new Error(
        'Google Gemini needs GOOGLE_GENERATIVE_AI_API_KEY.',
      );
    }
    return {
      apiKey,
      model,
    };
  }
  return {
    modelProvider: {
      ...selection,
      model,
    },
  };
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

/** Split by UTF-16 length without separating a surrogate pair or markdown link. Preserve all text. */
export function splitConnectorMessage(text: string, limit: number): string[] {
  if (!Number.isSafeInteger(limit) || limit < 2) throw new RangeError('The message limit must be at least 2.');
  const chunks: string[] = [];
  const half = Math.floor(limit / 2);
  while (text.length > limit) {
    let end = limit;
    const window = text.slice(0, Math.min(text.length, limit + 512));
    for (const match of window.matchAll(/\[[^\]]*\]\([^)\n]*\)/gu)) {
      const start = match.index ?? 0;
      if (start >= half && start < end && start + match[0].length > end) {
        end = start;
        break;
      }
    }
    if (end === limit) {
      const newline = text.lastIndexOf('\n', end - 1);
      const space = text.lastIndexOf(' ', end - 1);
      const boundary = Math.max(newline, space);
      if (boundary >= half) end = boundary + 1;
    }
    const code = text.charCodeAt(end - 1);
    if (code >= 0xD800 && code <= 0xDBFF) end -= 1;
    chunks.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text) chunks.push(text);
  return chunks;
}

/** Use raw messages so platform formatting cannot expand a chunk past its limit. */
export async function postConnectorResponse(
  thread: Thread,
  response: AsyncIterable<string | import('chat').StreamChunk>,
  signal: AbortSignal,
): Promise<void> {
  if (judgmentTelemetry().length > 0) response = recordJudgmentResponse(response);
  const limit = connectorChunkLimit(thread.adapter.name);
  if (!limit) {
    await waitForSignal(thread.post(response), signal);
    return;
  }
  if (typeof thread.startTyping === 'function') {
    void Promise.resolve(thread.startTyping()).catch(() => undefined);
  }
  let text = '';
  for await (const part of response) {
    signal.throwIfAborted();
    if (typeof part === 'string') text += part;
    else if (part.type === 'markdown_text') text += part.text;
  }
  for (const chunk of splitConnectorMessage(text, limit)) {
    signal.throwIfAborted();
    await waitForSignal(thread.post({ raw: chunk }), signal);
  }
}

async function* recordJudgmentResponse(
  response: AsyncIterable<string | import('chat').StreamChunk>,
): AsyncGenerator<string | import('chat').StreamChunk> {
  for await (const part of response) {
    if (typeof part === 'string') appendJudgmentOutput(part);
    else if (part.type === 'markdown_text') appendJudgmentOutput(part.text);
    yield part;
  }
}
