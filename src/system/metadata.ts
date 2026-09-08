import { SEB_VERSION } from '../version.js';

export const SYSTEM_TOPICS = [
  'overview',
  'architecture',
  'projections',
  'sources',
  'storage',
  'learning',
  'models',
  'connectors',
  'cli',
] as const;

export type SystemTopic = (typeof SYSTEM_TOPICS)[number];

export interface SystemTopicDetail {
  content: string;
  documentation: string;
  keyPrinciples: readonly string[];
  subsystemsOrFiles: readonly string[];
  summary: string;
  title: string;
  topic: SystemTopic;
}

export interface SystemMetadataResult {
  availableTopics: readonly SystemTopic[];
  detail: SystemTopicDetail | null;
  mission: string;
  name: string;
  summary: string;
  topic: string;
  version: string;
}

const TOPIC_DETAILS: Readonly<Record<SystemTopic, SystemTopicDetail>> = {
  overview: {
    topic: 'overview',
    title: 'Seb System Overview',
    summary:
      'Seb (Sports Evidence Bot) is a source-grounded NFL and fantasy football AI assistant built in TypeScript on Node.js 22+ and the Vercel AI SDK. It replaces LLM hallucinations with deterministic projection math, live Sleeper league synchronization, nflverse statistics, National Weather Service kickoff forecasts, and 44+ verified beat newsrooms.',
    keyPrinciples: [
      'Deterministic math over LLM guesswork for projections, waivers, and trades',
      'Grounding evidence required before actions are recommended (Decision Gate)',
      'Privacy-first architecture: keys and data remain local, telemetry never records prompts',
      'Three integrated presentation experiences: Explore, My Fantasy, and Analyze',
    ],
    subsystemsOrFiles: [
      'src/agent.ts',
      'src/cli.ts',
      'src/interactive/',
      'src/projection/',
      'src/sleeper/',
      'src/nflverse/',
      'src/weather/',
      'src/news/',
    ],
    documentation: 'docs/ARCHITECTURE.md',
    content: [
      '# Seb: Source-Grounded NFL & Fantasy AI Agent',
      '',
      'Seb unifies live Sleeper leagues, nflverse play-by-play statistics, National Weather Service forecasts,',
      'and 44+ curated NFL newsrooms into a conversational assistant.',
      '',
      'Unlike generic chatbots, Seb uses deterministic algorithms to calculate player projections and evaluate trades.',
      'A strict Decision Gate withholds recommendations if they are not backed by verified tool evidence.',
    ].join('\n'),
  },

  architecture: {
    topic: 'architecture',
    title: 'Agent Loop & System Architecture',
    summary:
      'Seb coordinates requests through a 23-step pipeline using the Vercel AI SDK ToolLoopAgent with a 12-step execution budget. Dynamic Zod validation safeguards all tool inputs, while message pruning strips raw reasoning and stale tool records to preserve context.',
    keyPrinciples: [
      'ToolLoopAgent bounded to 12 maximum steps with step 11 disabling tools to force synthesis',
      'Zod-enforced schemas validating seasons, weeks, players, and IDs before execution',
      'Strict context boundaries (32k max prompt, 120k max session characters)',
      'Decision gate enforces prerequisite evidence before start/sit, trade, or waiver recommendations',
      'Universal AbortSignal propagation across AI SDK calls, SQLite locks, and network fetches',
    ],
    subsystemsOrFiles: [
      'src/agent.ts',
      'src/interactive/transport.ts',
      'src/analysis/recommendation-eligibility.ts',
      'src/ai/stream-completion.ts',
    ],
    documentation: 'docs/ARCHITECTURE.md',
    content: [
      '# Architecture & Agent Loop',
      '',
      '1. Command-line parser evaluates inputs and provider/model overrides.',
      '2. Loads local credentials and model settings from ~/.config/seb/.',
      '3. Synchronizes Sleeper NFL state, leagues, and owned rosters.',
      '4. Transport routes query to Explore, My Fantasy, or Analyze experience.',
      '5. ToolLoopAgent executes with tools bound to dynamic request AbortSignals.',
      '6. Message pruning discards intermediate reasoning traces to preserve token limits.',
      '7. Decision Gate verifies that recommendations are backed by returned tool evidence.',
      '8. Terminal renderer outputs responsive markdown tables, badges, and sparklines.',
    ].join('\n'),
  },

  projections: {
    topic: 'projections',
    title: 'Deterministic Projection Engine',
    summary:
      'Deterministic player projections calculate expected fantasy points based on exact Sleeper league scoring, volume weighting, recency decay, defensive matchups, and kickoff weather risk.',
    keyPrinciples: [
      'Scoring-aware calculation (PPR, half-PPR, standard, custom bonuses, TE premium, turnover deductions)',
      'Exponential recency decay weighting recent performances over early-season games',
      'Opportunity metrics: target share, air yards, rush attempts, snap rates, and red-zone looks',
      'Opponent defense-vs-position adjustment using nflverse historical allowances',
      'Weather damping: wind speed (>15mph), cold temperature (<32°F), and precipitation factors',
      'Outputs expected points, 10th-90th percentile confidence ranges, and recommendation eligibility flags',
    ],
    subsystemsOrFiles: [
      'src/projection/',
      'src/analysis/lineup.ts',
      'src/analysis/recommendation-eligibility.ts',
      'src/analysis/playoffs.ts',
    ],
    documentation: 'docs/ANALYSIS.md',
    content: [
      '# Deterministic Projections',
      '',
      'Seb does not ask the LLM to invent projected fantasy points.',
      'Instead, projectPlayer and compareStartSit evaluate:',
      '- Exact Sleeper league scoring rules (passing/rushing/receiving yardage ratios, reception points, TD values)',
      '- Recency-weighted player usage (target share, air yards, carry share)',
      '- Defense-vs-position matchup ratings from nflverse',
      '- Stadium weather conditions from National Weather Service',
    ].join('\n'),
  },

  sources: {
    topic: 'sources',
    title: 'Grounding Data Sources',
    summary:
      'Seb grounds all decisions in real-time and historical sources: Sleeper API for leagues, nflverse for deep statistics, National Weather Service for stadium forecasts, and 44+ curated newsrooms.',
    keyPrinciples: [
      'Sleeper API: Live league rosters, matchups, transactions, and add/drop trends with tiered TTL caching',
      'nflverse: Official schedules, play-by-play data, weekly player statistics, and defensive rankings',
      'National Weather Service: Kickoff weather, wind, temperature, precipitation, and active alerts',
      '44+ verified beat newsrooms: All 32 NFL team beats, official NFL feeds, and trusted fantasy analysts',
      'Cryptographic SHA-256 provenance tracking for source snapshots',
    ],
    subsystemsOrFiles: [
      'src/sleeper/client.ts',
      'src/nflverse/client.ts',
      'src/weather/client.ts',
      'src/news/client.ts',
      'src/sources.ts',
    ],
    documentation: 'docs/DATA_SOURCES.md',
    content: [
      '# Grounding Data Sources',
      '',
      '- Sleeper: League rosters, match scores, waivers, standings, and global add/drop trends.',
      '- nflverse: Schedules, weekly box scores, advanced rushing/receiving metrics, defense vs position.',
      '- National Weather Service (NWS): Live hourly weather forecasts for all NFL stadiums and alert zones.',
      '- News Network: Official NFL and team beat reporters with sitemaps and structured article feeds.',
    ].join('\n'),
  },

  storage: {
    topic: 'storage',
    title: 'Storage, SQLite Cache & Privacy',
    summary:
      'Local embedded SQLite database (.cache/seb.sqlite) stores normalized source caches, snapshots, canonical player identities, and usage telemetry. User credentials and settings stay isolated under ~/.config/seb/.',
    keyPrinciples: [
      'SQLite database schema 6 with WAL mode, foreign keys, and normal synchronous writes',
      'Directory permissions 0700 and file permissions 0600 restricting access to current OS user',
      'Eight core tables: cache_entries, snapshots, identities, identity_links, cache_generations, usage_runs, usage_steps, usage_tool_calls',
      'Configuration stored in ~/.config/seb/ (profile.json, credentials.json, model-settings.json, history.json)',
      'Strict privacy: no user prompts, answers, raw tool payloads, or keys are stored in telemetry',
    ],
    subsystemsOrFiles: [
      'src/data/sqlite-store.ts',
      'src/setup/profile.ts',
      'src/setup/credentials.ts',
      'src/ai/model-settings.ts',
      'src/interactive/history.ts',
    ],
    documentation: 'docs/STORAGE.md',
    content: [
      '# Storage & Privacy Architecture',
      '',
      '- SQLite Database: `.cache/seb.sqlite` under the working directory.',
      '- Security: Files written with mode 0600, directories created with mode 0700.',
      '- Privacy Guarantee: Prompt texts, answers, and secret API keys are never recorded to the usage database.',
      '- Config Directory: `~/.config/seb/` holds credentials, model settings, and prompt history.',
    ].join('\n'),
  },

  learning: {
    topic: 'learning',
    title: 'Weekly Forecast Learning Engine',
    summary:
      'Adaptive weekly forecast learning engine that tunes projection parameters against completed NFL weeks without altering model weights.',
    keyPrinciples: [
      'Post-week evaluation against actual player stats and game logs',
      'Bayesian parameter tuning for volume weighting, recency decay, and defense adjustments per scoring profile',
      'Validated revisions stored in .cache/learning/ with rollback protection',
      'Separate from LLM weights: purely mathematical parameter refinement',
    ],
    subsystemsOrFiles: [
      'src/learning/service.ts',
      'src/learning/engine.ts',
      'src/learning/store.ts',
      'src/learning/tools.ts',
    ],
    documentation: 'docs/ANALYSIS.md#storage-and-privacy',
    content: [
      '# Weekly Forecast Learning',
      '',
      'Seb can inspect historical forecast accuracy and tune projection parameters via /learn or inspectLearning.',
      'Revisions are checked against validation test sets and saved to .cache/learning/.',
      'This parameter learning is purely algorithmic and independent of model weights.',
    ].join('\n'),
  },

  models: {
    topic: 'models',
    title: 'Multi-Provider Model Support',
    summary:
      'Multi-provider AI architecture supporting Google Gemini, Anthropic Claude, OpenAI, and OpenAI-compatible endpoints with dynamic family resolution and capacity fallback.',
    keyPrinciples: [
      'Bring Your Own Key (BYOK) stored locally in private credentials.json',
      'Model families (gemini-flash, claude-sonnet, gpt-luna) auto-discover newest stable versions from provider APIs',
      'Automated capacity fallback protects against rate limits without interrupting conversations',
      'OpenAI-compatible support allows local models via Ollama, vLLM, LM Studio',
    ],
    subsystemsOrFiles: [
      'src/ai/model-provider.ts',
      'src/ai/model-families.ts',
      'src/ai/model-configuration.ts',
      'src/ai/model-settings.ts',
      'src/model-capacity-error.ts',
    ],
    documentation: 'docs/MODELS.md',
    content: [
      '# Multi-Provider AI Support',
      '',
      '- Supported Providers: Google Gemini, Anthropic Claude, OpenAI, OpenAI-compatible.',
      '- Dynamic Discovery: `gemini-flash` dynamically discovers the latest stable Gemini Flash version at startup.',
      '- Resilient Fallbacks: Automatically steps down to fallback models (e.g. gemini-flash-lite) if capacity is exceeded.',
    ].join('\n'),
  },

  connectors: {
    topic: 'connectors',
    title: 'Chat Bot Connectors',
    summary:
      'Bot connectors for Discord, Slack, and Telegram built on Hono and Chat SDK (@chat-adapter/*), enabling multi-platform team league intelligence.',
    keyPrinciples: [
      'Discord, Slack (Socket Mode & Webhook), and Telegram adapters',
      'Multi-channel isolation and state persistence via memory or Redis',
      'Bounded 2-minute deadline per reply with graceful cancellation',
    ],
    subsystemsOrFiles: [
      'src/connectors/server.ts',
      'src/connectors/bot.ts',
      'src/connectors/config.ts',
    ],
    documentation: 'docs/CONNECTORS.md',
    content: [
      '# Bot Connectors',
      '',
      'Seb can be deployed as a multi-tenant chat bot across Discord, Slack, and Telegram.',
      'Powered by Hono HTTP server and Chat SDK, it provides direct league and matchup analysis inside team chats.',
    ].join('\n'),
  },

  cli: {
    topic: 'cli',
    title: 'Terminal Interface & CLI',
    summary:
      'Full-featured interactive Terminal User Interface (TUI) featuring custom ANSI rendering, scrollback, themes, keyboard navigation, slash commands, and diagnostic tools.',
    keyPrinciples: [
      'Custom ANSI/Unicode rendering engine with responsive tables, sparklines, and progress bars',
      'Keyboard shortcuts: Ctrl+G (Context), Ctrl+K (Commands), ? / /help (Full Guide), PgUp/PgDn (Scrollback)',
      'Diagnostic commands: `seb doctor` (health checks), `seb stats` and `seb usage` (telemetry & cost)',
      'Slash command suite for fast navigation and state switching',
    ],
    subsystemsOrFiles: [
      'src/interactive/tui.ts',
      'src/interactive/renderer.ts',
      'src/interactive/commands.ts',
      'src/interactive/transport.ts',
      'src/doctor.ts',
    ],
    documentation: 'docs/CLI.md',
    content: [
      '# Terminal UI & Commands',
      '',
      '- Interactive TUI: Complete terminal environment with scrollback and custom color themes.',
      '- Slash Commands: /explore, /fantasy, /analyze, /connect, /leagues, /matchup, /about, /doctor, /usage.',
      '- Quick Keys: Ctrl+G inspects session context; Ctrl+K opens the command catalog.',
    ].join('\n'),
  },
};

export function isSystemTopic(value: unknown): value is SystemTopic {
  return typeof value === 'string' && (SYSTEM_TOPICS as readonly string[]).includes(value);
}

export function getSystemMetadata(requestedTopic?: string): SystemMetadataResult {
  const normalized = requestedTopic?.trim().toLowerCase();
  const topicKey = normalized && isSystemTopic(normalized) ? normalized : null;
  const detail = topicKey ? TOPIC_DETAILS[topicKey] : null;

  return {
    name: 'Seb',
    version: SEB_VERSION,
    mission: 'Source-grounded NFL and fantasy football research assistant',
    topic: topicKey ?? 'overview',
    availableTopics: SYSTEM_TOPICS,
    detail,
    summary: detail ? detail.summary : TOPIC_DETAILS.overview.summary,
  };
}

export function formatSystemMetadata(requestedTopic?: string): string {
  const normalized = requestedTopic?.trim().toLowerCase();
  if (normalized && isSystemTopic(normalized)) {
    const detail = TOPIC_DETAILS[normalized];
    return [
      `## ${detail.title} (Seb v${SEB_VERSION})`,
      '',
      detail.summary,
      '',
      '### Key Principles',
      ...detail.keyPrinciples.map((principle) => `- ${principle}`),
      '',
      '### Core Files & Subsystems',
      ...detail.subsystemsOrFiles.map((file) => `- \`${file}\``),
      '',
      `- Documentation: \`${detail.documentation}\``,
    ].join('\n');
  }

  const overview = TOPIC_DETAILS.overview;
  return [
    `## Seb v${SEB_VERSION}: System Architecture & Capabilities`,
    '',
    overview.summary,
    '',
    '### Architecture & Design Topics',
    ...SYSTEM_TOPICS.map((topic) => {
      const item = TOPIC_DETAILS[topic];
      return `- **/about ${topic}**: ${item.title} — ${item.summary.slice(0, 100)}...`;
    }),
    '',
    'Run `/about TOPIC` (e.g. `/about projections` or `/about storage`) to inspect any subsystem.',
  ].join('\n');
}
