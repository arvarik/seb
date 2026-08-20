import {
  createMockAdapter,
  createMockState,
  createTestMessage,
} from '@chat-adapter/tests';
import { Chat } from 'chat';
import { describe, expect, it, vi } from 'vitest';

import {
  registerConnectorHandlers,
  type ConnectorRuntime,
} from '../src/connectors/bot.js';
import { readConnectorConfig } from '../src/connectors/config.js';
import {
  createConnectorApp,
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
    expect(config.discordGateway).toBe(true);
    expect(config.port).toBe(3000);
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
      },
      stateKind: 'memory',
    };
    const background: BackgroundTaskRegistry = {
      add: vi.fn(),
      count: () => 0,
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
});
