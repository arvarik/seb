import { isAbsolute } from 'node:path';

export type SettingGroup = 'Models' | 'Judgment' | 'Terminal' | 'Data' | 'Connectors';
export type HostedProvider = 'google' | 'anthropic' | 'openai';
export interface SettingDefinition {
  name: string;
  label: string;
  group: SettingGroup;
  secret?: boolean;
  defaultValue?: string;
  choices?: readonly string[];
  kind?: 'model' | 'boolean' | 'port' | 'uuid' | 'path' | 'ids' | 'connectors' | 'redis';
  provider?: HostedProvider;
  field?: 'model' | 'fallbackModel' | 'key';
}

/** Add supported persistent settings here. The editor and importer use this list. */
export const CONFIGURATION_SETTINGS: readonly SettingDefinition[] = [
  { name: 'SEB_MODEL_PROVIDER', label: 'Active model provider', group: 'Models', choices: ['google', 'anthropic', 'openai', 'openai-compatible'] },
  ...([
    ['google', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI', 'gemini-flash', 'gemini-flash-lite'],
    ['anthropic', 'ANTHROPIC_API_KEY', 'ANTHROPIC', 'claude-sonnet', 'claude-haiku'],
    ['openai', 'OPENAI_API_KEY', 'OPENAI', 'gpt-luna', 'gpt-mini'],
  ] as const).flatMap(([provider, key, prefix, model, fallback]): SettingDefinition[] => [
    { name: key, label: `${provider} API key`, group: 'Models', secret: true, provider, field: 'key' },
    { name: `${prefix}_MODEL`, label: `${provider} model`, group: 'Models', kind: 'model', defaultValue: model, provider, field: 'model' },
    { name: `${prefix}_FALLBACK_MODEL`, label: `${provider} fallback model`, group: 'Models', kind: 'model', defaultValue: fallback, provider, field: 'fallbackModel' },
  ]),
  { name: 'SEB_JUDGMENT_TRACING', label: 'Export prompts, answers, and tool data to Judgment', group: 'Judgment', kind: 'boolean', defaultValue: 'false' },
  { name: 'JUDGMENT_API_KEY', label: 'Judgment API key', group: 'Judgment', secret: true },
  { name: 'JUDGMENT_ORG_ID', label: 'Judgment organization ID', group: 'Judgment', kind: 'uuid' },
  { name: 'JUDGMENT_MONITORING', label: 'Allow Judgment monitoring when tracing is enabled', group: 'Judgment', kind: 'boolean', defaultValue: 'true' },
  { name: 'SEB_DEVTOOLS', label: 'Record full content locally with AI SDK DevTools', group: 'Terminal', kind: 'boolean', defaultValue: 'false' },
  { name: 'SEB_THEME', label: 'Terminal theme', group: 'Terminal', choices: ['default', 'high-contrast', 'compact'], defaultValue: 'default' },
  { name: 'SEB_ICONS', label: 'Terminal icons', group: 'Terminal', choices: ['unicode', 'ascii'], defaultValue: 'unicode' },
  { name: 'SEB_SESSIONS', label: 'Save resumable conversations', group: 'Terminal', kind: 'boolean', defaultValue: 'true' },
  { name: 'SEB_HISTORY', label: 'Save prompt history', group: 'Terminal', kind: 'boolean', defaultValue: 'true' },
  { name: 'SEB_HISTORY_FILE', label: 'Prompt history file (absolute path)', group: 'Terminal', kind: 'path' },
  { name: 'NWS_USER_AGENT', label: 'Weather request identification', group: 'Data' },
  { name: 'SEB_SLEEPER_USER', label: 'Default Sleeper username', group: 'Data' },
  { name: 'SEB_CONNECTORS', label: 'Enabled connectors (comma-separated)', group: 'Connectors', kind: 'connectors' },
  { name: 'SEB_BOT_NAME', label: 'Bot name', group: 'Connectors', defaultValue: 'seb' },
  { name: 'HOST', label: 'Connector listen address', group: 'Connectors', defaultValue: '0.0.0.0' },
  { name: 'PORT', label: 'Connector listen port', group: 'Connectors', kind: 'port', defaultValue: '3000' },
  { name: 'SLACK_BOT_TOKEN', label: 'Slack bot token', group: 'Connectors', secret: true },
  { name: 'SLACK_SIGNING_SECRET', label: 'Slack signing secret', group: 'Connectors', secret: true },
  { name: 'SLACK_APP_TOKEN', label: 'Slack app token', group: 'Connectors', secret: true },
  { name: 'SEB_SLACK_MODE', label: 'Slack connection mode', group: 'Connectors', choices: ['webhook', 'socket'], defaultValue: 'webhook' },
  { name: 'DISCORD_BOT_TOKEN', label: 'Discord bot token', group: 'Connectors', secret: true },
  { name: 'DISCORD_PUBLIC_KEY', label: 'Discord public key', group: 'Connectors' },
  { name: 'DISCORD_APPLICATION_ID', label: 'Discord application ID', group: 'Connectors' },
  { name: 'SEB_DISCORD_GATEWAY', label: 'Enable Discord gateway', group: 'Connectors', kind: 'boolean', defaultValue: 'true' },
  { name: 'TELEGRAM_BOT_TOKEN', label: 'Telegram bot token', group: 'Connectors', secret: true },
  { name: 'TELEGRAM_BOT_USERNAME', label: 'Telegram bot username', group: 'Connectors' },
  { name: 'TELEGRAM_WEBHOOK_SECRET_TOKEN', label: 'Telegram webhook secret', group: 'Connectors', secret: true },
  { name: 'SEB_TELEGRAM_MODE', label: 'Telegram connection mode', group: 'Connectors', choices: ['auto', 'polling', 'webhook'], defaultValue: 'auto' },
  { name: 'TELEGRAM_ALLOWED_USER_IDS', label: 'Allowed Telegram user IDs (comma-separated)', group: 'Connectors', kind: 'ids' },
  { name: 'REDIS_URL', label: 'Redis URL (can contain a password)', group: 'Connectors', kind: 'redis', secret: true },
];

const definitions = new Map(CONFIGURATION_SETTINGS.map((setting) => [setting.name, setting]));
const aliases: Readonly<Record<string, string>> = {
  GEMINI_API_KEY: 'GOOGLE_GENERATIVE_AI_API_KEY', SEB_PROVIDER: 'SEB_MODEL_PROVIDER',
};

export function settingDefinition(name: string): SettingDefinition | undefined {
  return definitions.get(aliases[name] ?? name);
}

export function validateSetting(setting: SettingDefinition, input: unknown): string {
  const fail = (): never => { throw new Error(`Invalid value for ${setting.name}.`); };
  if (typeof input !== 'string') return fail();
  const value = input.trim();
  if (!value || value.length > (setting.secret ? 16_384 : 2048) || /[\u0000-\u001f\u007f]/u.test(value)) return fail();
  if (setting.choices && !setting.choices.includes(value)) return fail();
  switch (setting.kind) {
    case 'boolean':
      if (!['true', 'false'].includes(value)) return fail();
      break;
    case 'model':
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/u.test(value)) return fail();
      break;
    case 'port':
      if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 65535) return fail();
      break;
    case 'uuid':
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)) return fail();
      break;
    case 'path': if (!isAbsolute(value)) return fail(); break;
    case 'ids': if (!/^\d+(?:\s*,\s*\d+)*$/u.test(value)) return fail(); break;
    case 'connectors':
      if (value.split(',').some((name) => !['slack', 'discord', 'telegram'].includes(name.trim()))) return fail();
      break;
    case 'redis':
      try { if (!['redis:', 'rediss:'].includes(new URL(value).protocol)) return fail(); }
      catch { return fail(); }
      break;
  }
  return value;
}

export function validateStoredEnvironment(value: unknown, secret: boolean): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved configuration.');
  const result: Record<string, string> = {};
  for (const [name, input] of Object.entries(value)) {
    const setting = settingDefinition(name);
    if (!setting || setting.name !== name || Boolean(setting.secret) !== secret || setting.provider || name === 'SEB_MODEL_PROVIDER') {
      throw new Error('The saved configuration contains an unsupported setting.');
    }
    result[name] = validateSetting(setting, input);
  }
  return result;
}
