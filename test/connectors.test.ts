import {
  createMockAdapter,
  createMockState,
  createTestMessage,
} from '@chat-adapter/tests';
import { Chat } from 'chat';
import { describe, expect, it, vi } from 'vitest';

import {
  resolveConnectorModelProvider,
  registerConnectorHandlers,
  ModelResponseError,
  waitForSignal,
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

describe('connector model errors', () => {
  it('formats a plain provider object without exposing its message', () => {
    const error = new ModelResponseError({
      code: 'invalid_request',
      message: 'Request contains private prompt data.',
    }, false);

    expect(error.message).toContain('rejected the request as invalid');
    expect(error.message).not.toContain('private prompt data');
    expect(error.message).not.toContain('[object Object]');
  });

  it('hides an unclassified model error message', () => {
    const error = new ModelResponseError(
      new Error('private prompt token'),
      false,
    );

    expect(error.message).toContain('connector service logs');
    expect(error.message).not.toContain('private prompt token');
  });

  it.each([
    ['Anthropic', 'ANTHROPIC_API_KEY'],
    ['OpenAI', 'OPENAI_API_KEY'],
    ['OpenAI-compatible endpoint', 'OPENAI_COMPATIBLE_API_KEY'],
  ] as const)(
    'uses the %s provider context without exposing raw errors',
    (providerLabel, credentialName) => {
      const error = new ModelResponseError(
        {
          message: 'private-key at https://private.endpoint.test/v1',
          status: 401,
        },
        false,
        { credentialName, providerLabel },
      );

      expect(error.message).toContain(`${providerLabel} rejected ${credentialName}`);
      expect(error.message).not.toContain('private-key');
      expect(error.message).not.toContain('private.endpoint.test');
      expect(error.message).not.toContain('Gemini');
    },
  );
});

describe('connector model provider selection', () => {
  it.each([
    {
      environment: {
        GOOGLE_GENERATIVE_AI_API_KEY: 'google-key',
        GEMINI_FALLBACK_MODEL: 'gemini-fallback',
        GEMINI_MODEL: 'gemini-primary',
        SEB_PROVIDER: 'google',
      },
      expected: {
        fallbackModel: 'gemini-fallback',
        model: 'gemini-primary',
        provider: 'google',
      },
    },
    {
      environment: {
        ANTHROPIC_API_KEY: 'anthropic-key',
        ANTHROPIC_MODEL: 'claude-primary',
        SEB_PROVIDER: 'anthropic',
      },
      expected: {
        model: 'claude-primary',
        provider: 'anthropic',
      },
    },
    {
      environment: {
        OPENAI_API_KEY: 'openai-key',
        OPENAI_MODEL: 'gpt-primary',
        SEB_PROVIDER: 'openai',
      },
      expected: {
        model: 'gpt-primary',
        provider: 'openai',
      },
    },
    {
      environment: {
        OPENAI_COMPATIBLE_BASE_URL: 'http://localhost:11434/v1',
        OPENAI_COMPATIBLE_MODEL: 'local-primary',
        SEB_PROVIDER: 'openai-compatible',
      },
      expected: {
        baseURL: 'http://localhost:11434/v1',
        fallbackModel: 'local-primary',
        model: 'local-primary',
        provider: 'openai-compatible',
      },
    },
  ])(
    'selects $expected.provider synchronously from the environment',
    ({ environment, expected }) => {
      const selection = resolveConnectorModelProvider(environment);

      expect(selection).toMatchObject(expected);
      expect(selection).not.toBeInstanceOf(Promise);
    },
  );

  it('uses Google model families by default', () => {
    expect(resolveConnectorModelProvider({
      GOOGLE_GENERATIVE_AI_API_KEY: 'google-key',
    })).toMatchObject({
      fallbackModel: 'gemini-flash-lite',
      model: 'gemini-flash',
      provider: 'google',
    });
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

  it('bounds a pending new-mention subscription with the reply deadline', async () => {
    const replyAbort = new AbortController();
    const failureAbort = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) =>
      delay === 120_000 ? replyAbort.signal : failureAbort.signal
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const adapter = createMockAdapter('slack', { postMessage });
    const state = createMockState();
    vi.spyOn(state, 'subscribe').mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    const bot = new Chat({
      adapters: { slack: adapter },
      state,
      userName: 'seb',
    });
    const reply = vi.fn().mockResolvedValue(undefined);
    registerConnectorHandlers(bot, reply);
    await bot.initialize();

    try {
      const message = createTestMessage('message-subscribe', '<@seb> rank my team', {
        isMention: true,
      });
      const pending = bot.processMessage(adapter, message.threadId, message);
      await vi.waitFor(() => expect(state.subscribe).toHaveBeenCalledOnce());

      replyAbort.abort(
        new DOMException('The reply deadline expired.', 'TimeoutError'),
      );

      await expect(pending).resolves.toBeUndefined();
      expect(reply).not.toHaveBeenCalled();
      expect(postMessage).toHaveBeenCalledOnce();
      expect(timeout).toHaveBeenCalledWith(120_000);
    } finally {
      await bot.shutdown();
      timeout.mockRestore();
      stderr.mockRestore();
    }
  });

  it('does not subscribe a queued mention after reply shutdown', async () => {
    const adapter = createMockAdapter('slack');
    const state = createMockState();
    const subscribe = vi.spyOn(state, 'subscribe');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const bot = new Chat({
      adapters: { slack: adapter },
      state,
      userName: 'seb',
    });
    const reply = vi.fn().mockResolvedValue(undefined);
    const shutdown = new AbortController();
    shutdown.abort(new DOMException('The service stopped.', 'AbortError'));
    registerConnectorHandlers(bot, reply, shutdown.signal);
    await bot.initialize();

    try {
      const message = createTestMessage('message-after-stop', '<@seb> rank my team', {
        isMention: true,
      });

      await bot.processMessage(adapter, message.threadId, message);

      expect(subscribe).not.toHaveBeenCalled();
      expect(reply).not.toHaveBeenCalled();
    } finally {
      await bot.shutdown();
      stderr.mockRestore();
    }
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

  it('bounds a failure post with an independent deadline', async () => {
    const failureAbort = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout')
      .mockReturnValue(failureAbort.signal);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const postMessage = vi.fn(() => new Promise<never>(() => {}));
    const adapter = createMockAdapter('slack', { postMessage });
    const bot = new Chat({
      adapters: { slack: adapter },
      state: createMockState(),
      userName: 'seb',
    });
    const reply = vi.fn().mockRejectedValue(new Error('The model failed.'));
    registerConnectorHandlers(bot, reply);
    await bot.initialize();

    try {
      const message = createTestMessage('message-3', 'Show my matchups.', {
        isMention: false,
        threadId: 'slack:D123:1234.5678',
      });
      const pending = bot.processMessage(adapter, message.threadId, message);
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());

      expect(timeout).toHaveBeenCalledWith(5_000);
      failureAbort.abort(
        new DOMException('The failure post deadline expired.', 'TimeoutError'),
      );
      await expect(pending).resolves.toBeUndefined();
    } finally {
      await bot.shutdown();
      timeout.mockRestore();
      stderr.mockRestore();
    }
  });

  it('observes pending work when the signal already aborted', async () => {
    const controller = new AbortController();
    const reason = new DOMException('The reply stopped.', 'AbortError');
    controller.abort(reason);
    const pending = Promise.reject(new Error('The pending task failed later.'));
    const observe = vi.spyOn(pending, 'catch');

    const result = waitForSignal(pending, controller.signal);

    expect(observe).toHaveBeenCalledOnce();
    await expect(result).rejects.toBe(reason);
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
      yield { type: 'finish', finishReason: 'stop' };
    })();
    let output = '';

    for await (const part of withWebSources(stream)) {
      if (typeof part === 'string') output += part;
    }

    expect(output).toContain('Current news.');
    expect(output).toContain('## Evidence');
    expect(output).toContain(
      '1. [NFL News](<https://www.nfl.com/news/example>) · **LIVE**',
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
      yield { type: 'finish', finishReason: 'stop' };
    })();
    let output = '';

    for await (const part of withWebSources(stream, direct)) {
      if (typeof part === 'string') output += part;
    }

    expect(output).toContain('## Evidence');
    expect(output).toContain('Sleeper API');
    expect(output).toContain('**CACHED');
    expect(output).toContain('cache fresh');
  });

  it.each(['length', 'content-filter', 'tool-calls', undefined])(
    'rejects a connector recommendation without a successful finish: %s', async (finishReason) => {
      const stream = (async function* () {
        yield { type: 'text-delta', text: 'Start Example Player.' };
        if (finishReason) yield { type: 'finish', finishReason };
      })();
      const output: unknown[] = [];
      await expect(async () => {
        for await (const part of withWebSources(stream, new SourceTracker(), 'Should I start Example Player?')) output.push(part);
      }).rejects.toMatchObject({ name: 'ModelResponseError', emittedOutput: false });
      expect(output).toEqual([]);
    },
  );

  it('reports an incomplete ordinary connector answer after partial output', async () => {
    const stream = (async function* () {
      yield { type: 'text-delta', text: 'Partial news.' };
      yield { type: 'finish', finishReason: 'length' };
    })();
    await expect(async () => {
      for await (const _part of withWebSources(stream)) { /* Consume the response. */ }
    }).rejects.toMatchObject({ name: 'ModelResponseError', emittedOutput: true });
  });

  it('withholds an unsupported connector decision before posting it', async () => {
    const stream = (async function* () {
      yield { type: 'text-delta', text: 'Start Example Player with high confidence.' };
      yield { type: 'finish', finishReason: 'stop' };
    })();
    let output = '';

    for await (const part of withWebSources(
      stream,
      new SourceTracker(),
      'Should I start Example Player?',
    )) {
      if (typeof part === 'string') output += part;
    }

    expect(output).toContain('Decision unavailable');
    expect(output).not.toContain('Start Example Player with high confidence');
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

  it('does not count hidden tool activity as posted connector output', async () => {
    const capacityError = { message: 'The model has no capacity.', statusCode: 503 };
    const stream = (async function* () {
      yield { type: 'reasoning-delta', text: 'I should inspect the current state.' };
      yield { type: 'tool-call', toolName: 'getNflState' };
      yield { type: 'tool-result', toolName: 'getNflState', output: { week: 2 } };
      yield { type: 'error', error: capacityError };
    })();

    await expect(async () => {
      for await (const _part of withWebSources(stream)) {
        // Consume the wrapped response.
      }
    }).rejects.toMatchObject({
      cause: capacityError,
      emittedOutput: false,
      name: 'ModelResponseError',
    } satisfies Partial<ModelResponseError>);
  });

  it('keeps the selected provider name on streamed model errors', async () => {
    const stream = (async function* () {
      yield { type: 'error', error: { status: 401 } };
    })();

    await expect(async () => {
      for await (const _part of withWebSources(
        stream,
        undefined,
        '',
        undefined,
        undefined,
        undefined,
        {
          credentialName: 'ANTHROPIC_API_KEY',
          providerLabel: 'Anthropic',
        },
      )) {
        // Consume the wrapped response.
      }
    }).rejects.toMatchObject({
      message: expect.stringContaining(
        'Anthropic rejected ANTHROPIC_API_KEY',
      ),
      name: 'ModelResponseError',
    } satisfies Partial<ModelResponseError>);
  });

  it.each([
    { emittedOutput: false, includeText: false },
    { emittedOutput: true, includeText: true },
  ])(
    'rejects an aborted model stream when emittedOutput is $emittedOutput',
    async ({ emittedOutput, includeText }) => {
      const controller = new AbortController();
      const reason = new DOMException('The reply deadline expired.', 'TimeoutError');
      controller.abort(reason);
      const stream = (async function* () {
        if (includeText) yield { type: 'text-delta', text: 'Partial answer.' };
        yield { type: 'abort' };
      })();

      await expect(async () => {
        for await (const _part of withWebSources(
          stream,
          undefined,
          '',
          controller.signal,
        )) {
          // Consume the wrapped response.
        }
      }).rejects.toMatchObject({
        cause: reason,
        emittedOutput,
        name: 'ModelResponseError',
      } satisfies Partial<ModelResponseError>);
    },
  );

  it('rejects an aborted guarded recommendation stream', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('The reply stopped.', 'AbortError'));
    const stream = (async function* () {
      yield { type: 'abort' };
    })();

    await expect(async () => {
      for await (const _part of withWebSources(
        stream,
        new SourceTracker(),
        'Should I start Example Player?',
        controller.signal,
      )) {
        // Consume the wrapped response.
      }
    }).rejects.toMatchObject({
      emittedOutput: false,
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
      abortReplies: vi.fn(),
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
      abortReplies: vi.fn(),
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
