export const CONNECTOR_NAMES = ['slack', 'discord', 'telegram'] as const;

export type ConnectorName = (typeof CONNECTOR_NAMES)[number];

export interface ConnectorConfig {
  botName: string;
  discordGateway: boolean;
  enabled: ConnectorName[];
  host: string;
  port: number;
  slackMode: 'socket' | 'webhook';
  telegramMode: 'auto' | 'polling' | 'webhook';
}

export type Environment = NodeJS.ProcessEnv;

export function readConnectorConfig(
  environment: Environment = process.env,
): ConnectorConfig {
  const enabled = readEnabledConnectors(environment);

  if (enabled.length === 0) {
    throw new Error(
      'Configure at least one connector. Set SEB_CONNECTORS or add complete platform credentials.',
    );
  }

  const slackMode = readChoice(
    environment.SEB_SLACK_MODE,
    ['webhook', 'socket'] as const,
    'webhook',
    'SEB_SLACK_MODE',
  );
  const telegramMode = readChoice(
    environment.SEB_TELEGRAM_MODE,
    ['auto', 'webhook', 'polling'] as const,
    'auto',
    'SEB_TELEGRAM_MODE',
  );

  validateCredentials(enabled, slackMode, environment);

  return {
    botName: environment.SEB_BOT_NAME?.trim() || 'seb',
    discordGateway: readBoolean(
      environment.SEB_DISCORD_GATEWAY,
      true,
      'SEB_DISCORD_GATEWAY',
    ),
    enabled,
    host: environment.HOST?.trim() || '0.0.0.0',
    port: readPort(environment.PORT),
    slackMode,
    telegramMode,
  };
}

function readEnabledConnectors(environment: Environment): ConnectorName[] {
  const explicit = environment.SEB_CONNECTORS?.trim();
  if (explicit) {
    const names = explicit
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const invalid = names.filter(
      (name) => !CONNECTOR_NAMES.includes(name as ConnectorName),
    );
    if (invalid.length > 0) {
      throw new Error(
        `SEB_CONNECTORS contains unsupported values: ${invalid.join(', ')}.`,
      );
    }
    return [...new Set(names as ConnectorName[])];
  }

  const enabled: ConnectorName[] = [];
  if (
    hasValue(environment.SLACK_BOT_TOKEN) &&
    (hasValue(environment.SLACK_SIGNING_SECRET) ||
      hasValue(environment.SLACK_APP_TOKEN))
  ) {
    enabled.push('slack');
  }
  if (
    hasValue(environment.DISCORD_BOT_TOKEN) &&
    hasValue(environment.DISCORD_PUBLIC_KEY) &&
    hasValue(environment.DISCORD_APPLICATION_ID)
  ) {
    enabled.push('discord');
  }
  if (hasValue(environment.TELEGRAM_BOT_TOKEN)) {
    enabled.push('telegram');
  }
  return enabled;
}

function validateCredentials(
  enabled: ConnectorName[],
  slackMode: ConnectorConfig['slackMode'],
  environment: Environment,
): void {
  if (enabled.includes('slack')) {
    requireValues(environment, ['SLACK_BOT_TOKEN']);
    requireValues(
      environment,
      slackMode === 'socket'
        ? ['SLACK_APP_TOKEN']
        : ['SLACK_SIGNING_SECRET'],
    );
  }
  if (enabled.includes('discord')) {
    requireValues(environment, [
      'DISCORD_BOT_TOKEN',
      'DISCORD_PUBLIC_KEY',
      'DISCORD_APPLICATION_ID',
    ]);
  }
  if (enabled.includes('telegram')) {
    requireValues(environment, ['TELEGRAM_BOT_TOKEN']);
  }
}

function requireValues(
  environment: Environment,
  names: readonly string[],
): void {
  const missing = names.filter((name) => !hasValue(environment[name]));
  if (missing.length > 0) {
    throw new Error(`Set these connector variables: ${missing.join(', ')}.`);
  }
}

function hasValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function readPort(value: string | undefined): number {
  if (!value?.trim()) {
    return 3000;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must contain an integer from 1 through 65535.');
  }
  return port;
}

function readBoolean(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (!value?.trim()) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  throw new Error(`${name} must equal true or false.`);
}

function readChoice<const T extends readonly string[]>(
  value: string | undefined,
  choices: T,
  fallback: T[number],
  name: string,
): T[number] {
  if (!value?.trim()) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (!choices.includes(normalized)) {
    throw new Error(`${name} must equal ${choices.join(' or ')}.`);
  }
  return normalized;
}
