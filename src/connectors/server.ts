import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';

import { configureAiDevTools } from '../ai/devtools.js';
import {
  createConnectorRuntime,
  isConnectorName,
  type ConnectorRuntime,
} from './bot.js';

const DISCORD_GATEWAY_SESSION_MS = 10 * 60 * 1000;
const DISCORD_RETRY_MS = 5_000;

export interface BackgroundTaskRegistry {
  add(task: Promise<unknown>): void;
  count(): number;
}

export class BackgroundTasks implements BackgroundTaskRegistry {
  private readonly tasks = new Set<Promise<unknown>>();

  add(task: Promise<unknown>): void {
    let tracked: Promise<unknown>;
    tracked = task
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Seb background task failed: ${reason}\n`);
      })
      .finally(() => {
        this.tasks.delete(tracked);
      });
    this.tasks.add(tracked);
  }

  count(): number {
    return this.tasks.size;
  }
}

export function createConnectorApp(
  runtime: ConnectorRuntime,
  background: BackgroundTaskRegistry,
): Hono {
  const app = new Hono();

  app.get('/', (context) =>
    context.json({
      connectors: runtime.config.enabled,
      service: 'seb-connectors',
      webhookPattern: '/webhooks/{connector}',
    }),
  );

  app.get('/health', (context) =>
    context.json({
      backgroundTasks: background.count(),
      connectors: runtime.config.enabled,
      state: runtime.stateKind,
      status: 'ok',
    }),
  );

  app.post('/webhooks/:connector', async (context) => {
    const connector = context.req.param('connector');
    if (
      !isConnectorName(connector) ||
      !runtime.config.enabled.includes(connector)
    ) {
      return context.json({ error: 'Connector not enabled.' }, 404);
    }

    const handler = runtime.bot.webhooks[connector];
    if (!handler) {
      return context.json({ error: 'Connector route is unavailable.' }, 404);
    }
    return await handler(context.req.raw, {
      waitUntil: (task) => background.add(task),
    });
  });

  return app;
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  if (await configureAiDevTools()) {
    process.stderr.write(
      'Seb AI SDK DevTools is active. Local prompts and tool data are recorded in .devtools/.\n',
    );
  }

  const runtime = createConnectorRuntime();
  const background = new BackgroundTasks();
  const gatewayAbort = new AbortController();

  await runtime.bot.initialize();

  const app = createConnectorApp(runtime, background);
  const server = serve({
    fetch: app.fetch,
    hostname: runtime.config.host,
    port: runtime.config.port,
  });

  if (runtime.discord && runtime.config.discordGateway) {
    background.add(
      runDiscordGateway(runtime.discord, gatewayAbort.signal),
    );
  }

  process.stdout.write(
    `Seb connector service listens on http://${runtime.config.host}:${runtime.config.port}.\n`,
  );
  process.stdout.write(
    `Enabled connectors: ${runtime.config.enabled.join(', ')}. State: ${runtime.stateKind}.\n`,
  );
  if (runtime.stateKind === 'memory') {
    process.stderr.write(
      'Seb uses temporary memory state. Set REDIS_URL before a production deployment.\n',
    );
  }

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    process.stdout.write(`Seb received ${signal}. It will stop cleanly.\n`);
    gatewayAbort.abort();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await runtime.bot.shutdown();
  };

  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
}

async function runDiscordGateway(
  discord: NonNullable<ConnectorRuntime['discord']>,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      let listener: Promise<unknown> | undefined;
      const response = await discord.startGatewayListener(
        {
          waitUntil: (task) => {
            listener = task;
          },
        },
        DISCORD_GATEWAY_SESSION_MS,
        signal,
      );
      if (!response.ok || !listener) {
        throw new Error(
          `Discord rejected the Gateway listener with status ${response.status}.`,
        );
      }
      await listener;
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `Discord Gateway failed. Seb will retry in five seconds. ${reason}\n`,
      );
      await waitForRetry(signal);
    }
  }
}

async function waitForRetry(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, DISCORD_RETRY_MS);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function loadLocalEnvironment(): void {
  try {
    loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Seb connector service failed: ${message}\n`);
    process.exitCode = 1;
  });
}
