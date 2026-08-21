import {
  createMockAdapter,
  createMockState,
  createTestMessage,
} from '@chat-adapter/tests';
import { Chat } from 'chat';
import { describe, expect, it, vi } from 'vitest';

import {
  registerConnectorHandlers,
  ModelResponseError,
  withWebSources,
  type ConnectorRuntime,
} from '../src/connectors/bot.js';
import { readConnectorConfig } from '../src/connectors/config.js';
import { SourceTracker } from '../src/sources.js';
import {
  createConnectorApp,
  BackgroundTasks,
  type BackgroundTaskRegistry,
} from '../src/connectors/server.js';

describe('connector configuration', () => {
  it('detects complete connector credentials', () => {
    const config = readConnectorConfig({
      DISCORD_APPLICATION_ID: 'application',
      DISCORD_BOT_TOKEN: 'token',
      DISCORD_PUBLIC_KEY: 'public-key',
      TELEGRAM_BOT_TOKEN: 'telegram-token',
    });

    expect(config.enabled).toEqual(['discord', 'telegram']);
    expect(config.webhookConnectors).toEqual(['discord']);
    expect(config.discordGateway).toBe(true);
    expect(config.port).toBe(3000);
  });

  it('requires a secret for explicit Telegram webhook mode', () => {
    expect(() => readConnectorConfig({
      SEB_CONNECTORS: 'telegram',
      SEB_TELEGRAM_MODE: 'webhook',
      TELEGRAM_BOT_TOKEN: 'telegram-token',
    })).toThrow('TELEGRAM_WEBHOOK_SECRET_TOKEN');

    const config = readConnectorConfig({
      SEB_CONNECTORS: 'telegram',
      SEB_TELEGRAM_MODE: 'webhook',
      TELEGRAM_BOT_TOKEN: 'telegram-token',
      TELEGRAM_WEBHOOK_SECRET_TOKEN: 'secret',
    });
    expect(config.webhookConnectors).toEqual(['telegram']);
  });

  it('reports a missing explicit Slack credential', () => {
    expect(() =>
      readConnectorConfig({
        SEB_CONNECTORS: 'slack',
        SLACK_BOT_TOKEN: 'token',
      }),
    ).toThrow('SLACK_SIGNING_SECRET');
  });

  it('rejects an invalid connector name', () => {
    expect(() =>
      readConnectorConfig({ SEB_CONNECTORS: 'slack,carrier-pigeon' }),
    ).toThrow('carrier-pigeon');
  });
});

describe('connector handlers', () => {
  it('subscribes after a new mention and invokes the shared reply', async () => {
    const adapter = createMockAdapter('slack');
    const state = createMockState();
    const bot = new Chat({
      adapters: { slack: adapter },
      state,
      userName: 'seb',
    });
    const reply = vi.fn().mockResolvedValue(undefined);
    registerConnectorHandlers(bot, reply);
    await bot.initialize();

    const message = createTestMessage('message-1', '<@seb> rank my team', {
      isMention: true,
    });
    await bot.processMessage(adapter, message.threadId, message);

    expect(reply).toHaveBeenCalledOnce();
    expect(await state.isSubscribed(message.threadId)).toBe(true);
    await bot.shutdown();
  });

  it('routes direct messages through the shared reply', async () => {
    const adapter = createMockAdapter('slack');
    const state = createMockState();
    const bot = new Chat({
      adapters: { slack: adapter },
      state,
      userName: 'seb',
    });
    const reply = vi.fn().mockResolvedValue(undefined);
    registerConnectorHandlers(bot, reply);
    await bot.initialize();

    const message = createTestMessage('message-2', 'Show my matchups.', {
      isMention: false,
      threadId: 'slack:D123:1234.5678',
    });
    await bot.processMessage(adapter, message.threadId, message);

    expect(reply).toHaveBeenCalledOnce();
    await bot.shutdown();
  });
});

describe('connector web sources', () => {
  it('appends validated web sources after streamed text', async () => {
    const stream = (async function* () {
      yield { type: 'text-delta', text: 'Current news.' };
      yield {
        sourceType: 'url',
        title: 'NFL [News]',
        type: 'source',
        url: 'https://www.nfl.com/news/example',
      };
      yield {
        sourceType: 'url',
        title: 'Unsafe',
        type: 'source',
        url: 'file:///tmp/unsafe',
      };
    })();
    let output = '';

    for await (const part of withWebSources(stream)) {
      if (typeof part === 'string') output += part;
    }

    expect(output).toContain('Current news.');
    expect(output).toContain('**Web sources**');
    expect(output).toContain(
      '- [NFL News](<https://www.nfl.com/news/example>)',
    );
    expect(output).not.toContain('file:///tmp/unsafe');
  });

  it('appends direct data sources with freshness details', async () => {
    const direct = new SourceTracker();
    direct.record({
      cacheOutcome: 'cache-fresh',
      id: 'sleeper-state',
      label: 'Sleeper API',
      retrievedAt: '2026-08-20T12:00:00.000Z',
      url: 'https://api.sleeper.app/v1/state/nfl',
    });
    const stream = (async function* () {
      yield { type: 'text-delta', text: 'Current state.' };
    })();
    let output = '';

    for await (const part of withWebSources(stream, direct)) {
      if (typeof part === 'string') output += part;
    }

    expect(output).toContain('**Data sources**');
    expect(output).toContain('Sleeper API');
    expect(output).toContain('cache fresh');
  });

  it('marks a model error and records whether text already streamed', async () => {
    const stream = (async function* () {
      yield { type: 'text-delta', text: 'Partial answer.' };
      yield { type: 'error', error: { statusCode: 503 } };
    })();

    await expect(async () => {
      for await (const _part of withWebSources(stream)) {
        // Consume the wrapped response.
      }
    }).rejects.toMatchObject({
      emittedOutput: true,
      name: 'ModelResponseError',
    } satisfies Partial<ModelResponseError>);
  });
});

describe('connector HTTP service', () => {
  it('reports enabled connectors and routes their webhooks', async () => {
    const adapter = createMockAdapter('slack');
    const bot = new Chat({
      adapters: { slack: adapter },
      state: createMockState(),
      userName: 'seb',
    });
    const runtime: ConnectorRuntime = {
      bot,
      config: {
        botName: 'seb',
        discordGateway: false,
        enabled: ['slack'],
        host: '127.0.0.1',
        port: 3000,
        slackMode: 'webhook',
        telegramMode: 'auto',
        webhookConnectors: ['slack'],
      },
      stateKind: 'memory',
    };
    const background: BackgroundTaskRegistry = {
      add: vi.fn(),
      count: () => 0,
      drain: vi.fn().mockResolvedValue(true),
    };
    const app = createConnectorApp(runtime, background);

    const health = await app.request('/health');
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      connectors: ['slack'],
      status: 'ok',
    });

    const webhook = await app.request('/webhooks/slack', { method: 'POST' });
    expect(webhook.status).toBe(200);
    expect(adapter.handleWebhook).toHaveBeenCalledOnce();
    await bot.shutdown();
  });

  it('does not expose the Telegram webhook during polling', async () => {
    const adapter = createMockAdapter('telegram');
    const bot = new Chat({
      adapters: { telegram: adapter },
      state: createMockState(),
      userName: 'seb',
    });
    const runtime: ConnectorRuntime = {
      bot,
      config: {
        botName: 'seb',
        discordGateway: false,
        enabled: ['telegram'],
        host: '127.0.0.1',
        port: 3000,
        slackMode: 'webhook',
        telegramMode: 'polling',
        webhookConnectors: [],
      },
      stateKind: 'memory',
    };
    const app = createConnectorApp(runtime, {
      add: vi.fn(),
      count: () => 0,
      drain: vi.fn().mockResolvedValue(true),
    });

    const response = await app.request('/webhooks/telegram', { method: 'POST' });

    expect(response.status).toBe(404);
    expect(adapter.handleWebhook).not.toHaveBeenCalled();
  });
});

describe('connector background tasks', () => {
  it('waits for active tasks during shutdown', async () => {
    const background = new BackgroundTasks();
    let finish: (() => void) | undefined;
    background.add(new Promise<void>((resolve) => {
      finish = resolve;
    }));

    const drained = background.drain(1_000);
    expect(background.count()).toBe(1);
    finish?.();

    await expect(drained).resolves.toBe(true);
    expect(background.count()).toBe(0);
  });

  it('reports a shutdown deadline when a task does not finish', async () => {
    const background = new BackgroundTasks();
    background.add(new Promise(() => {}));

    await expect(background.drain(5)).resolves.toBe(false);
  });
});
