import { createDiscordAdapter } from '@chat-adapter/discord';
import { createSlackAdapter } from '@chat-adapter/slack';
import { createMemoryState } from '@chat-adapter/state-memory';
import { createRedisState } from '@chat-adapter/state-redis';
import { createTelegramAdapter } from '@chat-adapter/telegram';
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
import { isModelCapacityError } from '../model-capacity-error.js';
import { NflverseClient } from '../nflverse/client.js';
import { SleeperClient } from '../sleeper/client.js';
import { WeatherClient } from '../weather/client.js';
import { normalizeSourceLabel, normalizeWebUrl } from '../sources.js';
import {
  CONNECTOR_NAMES,
  readConnectorConfig,
  type ConnectorConfig,
  type ConnectorName,
  type Environment,
} from './config.js';

const HISTORY_LIMIT = 20;
const FAILURE_MESSAGE =
  'Seb could not answer this request. Check the connector service logs, then retry.';

export interface ConnectorRuntime {
  bot: Chat<Record<string, Adapter>>;
  config: ConnectorConfig;
  discord?: ReturnType<typeof createDiscordAdapter>;
  stateKind: 'memory' | 'redis';
}

export type ConnectorReply = (
  thread: Thread,
  message: Message,
  context?: MessageContext,
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

  registerConnectorHandlers(bot, createAgentReply(environment));

  return {
    bot,
    config,
    ...(discord ? { discord } : {}),
    stateKind: redisUrl ? 'redis' : 'memory',
  };
}

export function registerConnectorHandlers(
  bot: Chat<Record<string, Adapter>>,
  reply: ConnectorReply,
): void {
  bot.onNewMention(async (thread, message, context) => {
    await thread.subscribe();
    await runReply(reply, thread, message, context);
  });

  bot.onDirectMessage(async (thread, message, _channel, context) => {
    await runReply(reply, thread, message, context);
  });

  bot.onSubscribedMessage(async (thread, message, context) => {
    await runReply(reply, thread, message, context);
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
  const sleeperClient = new SleeperClient();
  const nflverseClient = new NflverseClient();
  const weatherClient = new WeatherClient({
    ...(environment.NWS_USER_AGENT?.trim()
      ? { userAgent: environment.NWS_USER_AGENT.trim() }
      : {}),
  });
  const clients = { sleeperClient, nflverseClient, weatherClient };
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

  return async (thread, message, context) => {
    const prompt = await buildPrompt(thread, message, context);
    try {
      const result = await primaryAgent.stream({ prompt });
      await thread.post(withWebSources(result.fullStream));
    } catch (error) {
      if (!isModelCapacityError(error) || fallbackAgent === primaryAgent) {
        throw error;
      }
      const result = await fallbackAgent.stream({ prompt });
      await thread.post(withWebSources(result.fullStream));
    }
  };
}

export function withWebSources(stream: AsyncIterable<unknown>) {
  const sources = new Map<string, string>();
  const monitored = (async function* () {
    for await (const part of stream) {
      if (isUrlSourcePart(part)) {
        const url = normalizeWebUrl(part.url);
        if (url) {
          sources.set(
            url,
            normalizeSourceLabel(part.title, new URL(url).hostname),
          );
        }
      }
      yield part;
    }
  })();
  const text = fromFullStream(monitored);
  return (async function* () {
    for await (const part of text) yield part;
    if (sources.size > 0) {
      yield `\n\n**Web sources**\n\n${[...sources]
        .map(([url, title]) => `- [${safeMarkdownLabel(title)}](<${url}>)`)
        .join('\n')}`;
    }
  })();
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

function safeMarkdownLabel(value: string): string {
  return value.replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim();
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
  context?: MessageContext,
): Promise<void> {
  try {
    await reply(thread, message, context);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Seb connector reply failed: ${reason}\n`);
    await postFailureMessage(thread);
  }
}

async function postFailureMessage(target: Thread): Promise<void> {
  try {
    await target.post(FAILURE_MESSAGE);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Seb could not post the failure message: ${reason}\n`);
  }
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
