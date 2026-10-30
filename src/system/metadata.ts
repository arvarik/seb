import { MODEL_FAMILIES, type ModelProviderId } from '../ai/model-provider.js';
import { CLI_HELP } from '../cli-options.js';
import { CONNECTOR_NAMES } from '../connectors/config.js';
import { INTERACTIVE_COMMANDS } from '../interactive/commands.js';
import { SEB_SKILLS } from '../interactive/skills.js';
import { FIRST_CLASS_NEWS_SOURCES } from '../news/sources.js';
import { SEB_VERSION } from '../version.js';
import { isSystemTopic, SYSTEM_TOPICS, type SystemTopic } from './topics.js';

export { isSystemTopic, SYSTEM_TOPICS, type SystemTopic } from './topics.js';

export interface SystemTopicDetail {
  content: string;
  documentation: string;
  keyPrinciples: readonly string[];
  listTitle?: string;
  subsystemsOrFiles: readonly string[];
  summary: string;
  title: string;
  topic: SystemTopic;
}

export interface SystemMetadataResult {
  activeModel?: string;
  availableTopics: readonly SystemTopic[];
  detail: SystemTopicDetail | null;
  mission: string;
  name: string;
  summary: string;
  topic: string;
  version: string;
}

/** Live facts that only the running agent knows. */
export interface SystemMetadataContext {
  activeModel?: string | undefined;
  // AI SDK tools can compute a description from call context, so only a fixed string is read.
  tools?: Readonly<Record<string, { description?: unknown }>> | undefined;
}

type StaticTopic = Exclude<SystemTopic, 'capabilities' | 'commands' | 'skills' | 'tools'>;

const NEWS_TIERS = [1, 2, 3]
  .map((tier) => [tier, FIRST_CLASS_NEWS_SOURCES.filter((source) => source.tier === tier).length] as const)
  .filter(([, count]) => count > 0)
  .map(([tier, count]) => `${count} tier ${tier}`)
  .join(', ');
const NEWS_SUMMARY = `${FIRST_CLASS_NEWS_SOURCES.length} first-class news sources (${NEWS_TIERS}), including all 32 NFL team newsrooms`;
const MODEL_PROVIDERS = (Object.entries(MODEL_FAMILIES) as Array<[ModelProviderId, readonly string[]]>)
  .map(([provider, families]) =>
    families.length > 0 ? `${provider} (${families.join(', ')})` : `${provider} (any compatible model ID)`)
  .join('; ');

const LIMITS = [
  'Seb is read-only. It never submits lineups, waiver claims, trades, or commissioner changes.',
  'The Decision Gate withholds a start/sit, lineup, waiver, or trade recommendation when tool evidence is missing or stale.',
  'Projections and probabilities are estimates, not facts or betting advice.',
  'Seb has no licensed publisher feed. Current news comes from first-class public sources, and from Google Search when Gemini is the active provider.',
];

const TOPIC_DETAILS: Readonly<Record<StaticTopic, SystemTopicDetail>> = {
  overview: {
    topic: 'overview',
    title: 'Seb System Overview',
    summary:
      `Seb is a source-grounded NFL and fantasy football AI assistant built in TypeScript on Node.js 22+ and the Vercel AI SDK. It replaces LLM guesswork with deterministic projection math, live Sleeper league synchronization, nflverse statistics, National Weather Service kickoff forecasts, and ${NEWS_SUMMARY}.`,
    keyPrinciples: [
      'Deterministic math over LLM guesswork for projections, waivers, and trades',
      'Grounding evidence required before actions are recommended (Decision Gate)',
      'Local usage records exclude prompts. Optional Judgment tracing exports conversation content only when explicitly enabled.',
      'Three integrated presentation experiences: Explore, My Fantasy, and Analyze',
      'Run `/about capabilities` for the live list of tools, commands, skills, and limits.',
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
      'Seb unifies live Sleeper leagues, nflverse statistics, National Weather Service forecasts,',
      `and ${NEWS_SUMMARY} into a conversational assistant.`,
      '',
      'Seb uses deterministic algorithms to calculate player projections and evaluate trades.',
      'A strict Decision Gate withholds recommendations if they are not backed by verified tool evidence.',
    ].join('\n'),
  },

  memory: {
    topic: 'memory',
    title: 'Session Memory & Saved Notes',
    summary:
      'Seb keeps working memory inside one session and saved notes across sessions. It saves a note for future sessions only when the user confirms it with /remember.',
    keyPrinciples: [
      'Working memory records floor or ceiling preferences, the FAAB approach, avoided game types, league facts, tracked players, and Recommendation lines from answers.',
      'A newer preference replaces an older one with the same key (risk, faab, or avoid:<topic>). Text that mixes several facts gets no key, so no replacement can delete it.',
      'Each decision keeps its NFL season, week, and league. Only decisions for the current week and focused league reach the model.',
      'Saved notes live in ~/.config/seb/memory.json, with at most 30 notes of 200 characters per account. Seb rejects API keys and tokens.',
      'The latest message overrides working memory, and working memory overrides a saved note with the same key.',
      'Commands: /memory shows both memories, /memory clear resets working memory, /remember [NOTE] saves notes, and /forget NUMBER|all deletes them.',
      'Connectors keep saved notes per platform user and read them only in direct messages. seb ask also reads the saved notes.',
    ],
    subsystemsOrFiles: [
      'src/interactive/session.ts',
      'src/interactive/memory.ts',
      'src/interactive/transport.ts',
      'src/connectors/bot.ts',
    ],
    documentation: 'docs/INTERACTIVE.md',
    content: [
      '# Session Memory & Saved Notes',
      '',
      'Working memory survives turn compaction and `seb resume`. Saved notes survive new sessions.',
      'Seb notes a preference, asks the user to run /remember, and saves nothing without that step.',
    ].join('\n'),
  },

  architecture: {
    topic: 'architecture',
    title: 'Agent Loop & System Architecture',
    summary:
      'Seb coordinates requests using the Vercel AI SDK ToolLoopAgent with a 16-step execution budget. Dynamic Zod validation safeguards all tool inputs, while message pruning removes older history and preserves all active-turn research and provider signatures.',
    keyPrinciples: [
      'ToolLoopAgent allows 16 model steps and reserves the final step for an answer without tool calls',
      'Zod-enforced schemas validating seasons, weeks, players, and IDs before execution',
      'Strict context boundaries (32k max prompt, 120k max session characters)',
      'Decision gate enforces prerequisite evidence before start/sit, trade, or waiver recommendations (with one automatic recovery pass when live context is missing or stale)',
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
      '2. Loads local settings, credentials, and model settings from ~/.config/seb/.',
      '3. Synchronizes Sleeper NFL state, leagues, and owned rosters.',
      '4. Transport routes query to Explore, My Fantasy, or Analyze experience.',
      '5. ToolLoopAgent executes with tools bound to dynamic request AbortSignals.',
      '6. Message pruning preserves active-turn research, compacted tool receipts, and provider signatures.',
      '7. Decision Gate verifies that recommendations are backed by returned tool evidence (running one automatic recovery pass before withholding).',
      '8. Terminal renderer outputs responsive markdown tables, badges, and sparklines.',
    ].join('\n'),
  },

  projections: {
    topic: 'projections',
    title: 'Deterministic Projection Engine',
    summary:
      'Deterministic player projections calculate expected fantasy points based on exact Sleeper league scoring, volume weighting, recency decay, defensive matchups, kickoff weather risk, correlated stack variance, and full-roster lineup optimization (optimizeRosterLineup).',
    keyPrinciples: [
      'Scoring-aware calculation (PPR, half-PPR, standard, custom bonuses, TE premium, turnover deductions)',
      'Exponential recency decay weighting recent performances over early-season games',
      'Separate D/ST forecasts blend team and opponent outcomes with NFL averages and a stronger rare-touchdown prior',
      'Opponent defense-vs-position adjustment using nflverse historical allowances',
      'Kickoff weather risk: wind of 15 mph or more, a precipitation chance of 35% or more, or 30°F or colder is medium risk. Wind of 25 mph or more, 75% precipitation, 15°F or colder, or a severe alert is high risk. Medium risk scales QB, WR, TE, and K projections by 0.97 and other positions by 0.99. High risk scales them by 0.92 and 0.97. Indoor games get no adjustment.',
      'Correlated stack and matchup variance modeling across same-game QB, skill, and D/ST pairings, plus combinatorial lineup solving via optimizeRosterLineup',
      'Outputs expected points, forecast ranges with explicit calibration limits, and recommendation eligibility flags',
    ],
    subsystemsOrFiles: [
      'src/projection/',
      'src/analysis/lineup.ts',
      'src/analysis/recommendation-eligibility.ts',
      'src/analysis/playoffs.ts',
      'src/weather/game-weather.ts',
    ],
    documentation: 'docs/ANALYSIS.md',
    content: [
      '# Deterministic Projections',
      '',
      'Seb does not ask the LLM to invent projected fantasy points.',
      'Instead, projectPlayer, compareStartSit, and optimizeRosterLineup evaluate:',
      '- Exact Sleeper league scoring rules (passing/rushing/receiving yardage ratios, reception points, TD values)',
      '- Recency-weighted player usage (target share, air yards, carry share)',
      '- Defense-vs-position matchup ratings from nflverse',
      '- Stadium weather conditions from National Weather Service',
      '- Intra-game stack and matchup covariance for joint lineup and head-to-head probabilities',
    ].join('\n'),
  },

  sources: {
    topic: 'sources',
    title: 'Grounding Data Sources',
    summary:
      `Seb grounds all decisions in real-time and historical sources: Sleeper API for leagues, nflverse for deep statistics, National Weather Service for stadium forecasts, and ${NEWS_SUMMARY}, with cross-source event corroboration.`,
    keyPrinciples: [
      'Sleeper API: Live league rosters, matchups, transactions, and add/drop trends with tiered TTL caching',
      'nflverse: Official schedules, play-by-play data, weekly player statistics, and defensive rankings',
      'National Weather Service: Kickoff weather, wind, temperature, precipitation, and active alerts',
      `News: ${NEWS_SUMMARY}, with multi-publisher story clustering (corroboratedBy)`,
      'Cryptographic SHA-256 provenance tracking for source snapshots',
    ],
    subsystemsOrFiles: [
      'src/sleeper/client.ts',
      'src/nflverse/client.ts',
      'src/weather/client.ts',
      'src/news/client.ts',
      'src/news/sources.ts',
      'src/sources.ts',
    ],
    documentation: 'docs/DATA_SOURCES.md',
    content: [
      '# Grounding Data Sources',
      '',
      '- Sleeper: League rosters, match scores, waivers, standings, and global add/drop trends.',
      '- nflverse: Schedules, weekly box scores, advanced rushing/receiving metrics, defense vs position.',
      '- National Weather Service (NWS): Live hourly weather forecasts for all NFL stadiums and alert zones.',
      '- News Network: Official NFL and team beat reporters with sitemaps, structured article feeds, and cross-publisher event corroboration (corroboratedBy).',
    ].join('\n'),
  },

  storage: {
    topic: 'storage',
    title: 'Storage, SQLite Cache & Privacy',
    summary:
      'Local embedded SQLite database (.cache/seb.sqlite) stores normalized source caches, snapshots, canonical player identities, SQLite FTS5 BM25 news indexing, and usage telemetry. User credentials and settings stay isolated under ~/.config/seb/.',
    keyPrinciples: [
      'SQLite database schema 6 with WAL mode, foreign keys, and normal synchronous writes',
      'Directory permissions 0700 and file permissions 0600 restricting access to current OS user',
      'Core tables (cache_entries, snapshots, identities, identity_links, cache_generations, usage_runs, usage_steps, usage_tool_calls) plus SQLite FTS5 BM25 full-text news indexing (news_articles_fts)',
      'Configuration stored in ~/.config/seb/ (settings.json, profile.json, credentials.json, model-settings.json, history.json, memory.json, sessions/)',
      'Local usage records exclude prompts, answers, raw tool payloads, and keys. Judgment tracing is optional and off by default.',
    ],
    subsystemsOrFiles: [
      'src/data/sqlite-store.ts',
      'src/setup/profile.ts',
      'src/setup/credentials.ts',
      'src/ai/model-settings.ts',
      'src/interactive/history.ts',
      'src/interactive/memory.ts',
      'src/interactive/sessions.ts',
    ],
    documentation: 'docs/STORAGE.md',
    content: [
      '# Storage & Privacy Architecture',
      '',
      '- SQLite Database: `.cache/seb.sqlite` under the working directory, including FTS5 BM25 full-text news search (`news_articles_fts`).',
      '- Security: Files written with mode 0600, directories created with mode 0700.',
      '- Privacy Guarantee: Prompt texts, answers, and secret API keys are never recorded to the usage database.',
      '- Config Directory: `~/.config/seb/` holds credentials, model settings, prompt history, saved notes, and private resumable conversations.',
    ].join('\n'),
  },

  learning: {
    topic: 'learning',
    title: 'Weekly Forecast Learning Engine',
    summary:
      'A weekly forecast learning engine tunes projection parameters against completed NFL weeks. It changes no model weights and no prompts.',
    keyPrinciples: [
      'Replays completed regular-season weeks in order, so each forecast uses only earlier weeks.',
      'Tests a small grid of recency weights (0, 0.25, 0.5) and prior strengths (0, 0.5, 2 games) against the current defaults, per league scoring profile.',
      'Holds out the last three completed weeks for validation. A candidate needs at least 100 training and 100 validation samples.',
      'Promotes a candidate only when validation MAE improves by more than 1% and RMSE does not increase. Otherwise it keeps the defaults.',
      'Saves each revision with a SHA-256 checksum in .cache/learning/ and keeps four corrections per completed week. overrides.json can disable learning or pin parameters.',
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
      'Seb can inspect forecast accuracy and update learned parameters with `seb learn`, `/skill weekly-learning`, or `inspectLearning`.',
      'Each revision passes validation gates before Seb uses it, and it is saved to .cache/learning/.',
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
      `Model families resolve to the newest model ID from each provider's model list: ${MODEL_PROVIDERS}`,
      'A rate-limit or capacity error before visible output retries once with the configured fallback model',
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
      '- Dynamic Discovery: a family such as `gemini-flash` or `claude-sonnet` resolves to the newest matching model at startup.',
      '- Resilient Fallbacks: Seb retries once with the fallback model when the primary model is at capacity.',
    ].join('\n'),
  },

  connectors: {
    topic: 'connectors',
    title: 'Chat Bot Connectors',
    summary:
      `Bot connectors for ${CONNECTOR_NAMES.join(', ')}, built on Hono and Chat SDK, answer mentions, direct messages, and subscribed threads.`,
    keyPrinciples: [
      'Discord, Slack (Socket Mode & Webhook), Telegram, and GroupMe adapters',
      'Outbound weekly brief push delivery (`seb brief --post slack|discord|telegram|groupme`)',
      'Thread subscriptions and queues persist in memory, or in Redis when REDIS_URL is set',
      'Bounded 2-minute deadline per reply with graceful cancellation',
      'Saved notes per platform user in direct messages: /remember NOTE, /memory, and /forget NUMBER|all run without a model call. Shared threads never read saved notes.',
    ],
    subsystemsOrFiles: [
      'src/connectors/server.ts',
      'src/connectors/bot.ts',
      'src/connectors/config.ts',
      'src/connectors/groupme.ts',
    ],
    documentation: 'docs/CONNECTORS.md',
    content: [
      '# Bot Connectors',
      '',
      'Seb can run as a chat bot in Discord, Slack, Telegram, and GroupMe.',
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
      'Run `/about commands` for every slash command and CLI command.',
    ],
    subsystemsOrFiles: [
      'src/interactive/tui.ts',
      'src/interactive/renderer.ts',
      'src/interactive/commands.ts',
      'src/interactive/transport.ts',
      'src/cli-options.ts',
      'src/doctor.ts',
    ],
    documentation: 'docs/CLI.md',
    content: [
      '# Terminal UI & Commands',
      '',
      '- Interactive TUI: Complete terminal environment with scrollback, resumable sessions (`seb resume`, `seb sessions`), working memory, and saved notes (`/memory`, `/remember`, `/forget`).',
      '- Weekly Autopilot Brief: `seb brief` or `/brief` fans out across active Sleeper leagues for lineup swaps, matchup odds, FAAB/waiver targets, and verified news.',
      '- Quick Keys: Ctrl+G inspects session context; Ctrl+K opens the command catalog.',
    ].join('\n'),
  },
};

export function getSystemMetadata(
  requestedTopic?: string,
  context: SystemMetadataContext = {},
): SystemMetadataResult {
  const normalized = requestedTopic?.trim().toLowerCase();
  const topicKey = normalized && isSystemTopic(normalized) ? normalized : null;
  const detail = topicKey ? topicDetail(topicKey, context) : null;

  return {
    name: 'Seb',
    version: SEB_VERSION,
    ...(context.activeModel ? { activeModel: context.activeModel } : {}),
    mission: 'Source-grounded NFL and fantasy football research assistant',
    topic: topicKey ?? 'overview',
    availableTopics: SYSTEM_TOPICS,
    detail,
    summary: detail ? detail.summary : TOPIC_DETAILS.overview.summary,
  };
}

export function formatSystemMetadata(
  requestedTopic?: string,
  context: SystemMetadataContext = {},
): string {
  const normalized = requestedTopic?.trim().toLowerCase();
  if (normalized && isSystemTopic(normalized)) {
    const detail = topicDetail(normalized, context);
    return [
      `## ${detail.title} (Seb v${SEB_VERSION})`,
      '',
      detail.summary,
      '',
      `### ${detail.listTitle ?? 'Key Principles'}`,
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
      const item = topicDetail(topic, context);
      return `- **/about ${topic}**: ${item.title} — ${item.summary.slice(0, 100)}...`;
    }),
    '',
    'Run `/about TOPIC` (e.g. `/about capabilities` or `/about storage`) to inspect any subsystem.',
    'Run `/about QUESTION` (e.g. `/about cache TTL`) to search the documentation.',
  ].join('\n');
}

// Lists that drift come from the registries at call time, so they always match the running code.
function topicDetail(topic: SystemTopic, context: SystemMetadataContext): SystemTopicDetail {
  switch (topic) {
    case 'capabilities': {
      const tools = Object.keys(context.tools ?? {});
      return {
        topic,
        title: 'What Seb Can Do',
        listTitle: 'Capabilities',
        summary:
          "Seb answers NFL and fantasy football questions with live league, statistics, weather, and news tools, and it explains its own design. Seb builds this list from its own code, so it matches the installed version.",
        keyPrinciples: [
          `Version: Seb ${SEB_VERSION}${context.activeModel ? `, running ${context.activeModel}` : ''}.`,
          'Surfaces: interactive terminal chat (`seb`, `seb resume`), one-shot answers (`seb ask`, with `--json`), the weekly autopilot brief (`seb brief`, `/brief`), and chat connectors.',
          'Experiences: Explore (NFL facts and news), My Fantasy (the connected Sleeper account), and Analyze (comparisons and decisions).',
          ...(tools.length > 0 ? [`${tools.length} agent tools: ${tools.join(', ')}.`] : []),
          `${INTERACTIVE_COMMANDS.length} slash commands: ${INTERACTIVE_COMMANDS.map((command) => `/${command.name}`).join(', ')}.`,
          `${SEB_SKILLS.length} skills (run /skill NAME [QUESTION]): ${SEB_SKILLS.map((skill) => skill.id).join(', ')}.`,
          `Connectors: ${CONNECTOR_NAMES.join(', ')}.`,
          `Model providers: ${MODEL_PROVIDERS}.`,
          `News: ${NEWS_SUMMARY}.`,
          'Memory: session working memory, and saved notes that the user confirms with /remember.',
          ...LIMITS.map((limit) => `Limit: ${limit}`),
        ],
        subsystemsOrFiles: [
          'src/agent.ts',
          'src/interactive/commands.ts',
          'src/interactive/skills.ts',
          'src/cli-options.ts',
          'src/system/metadata.ts',
        ],
        documentation: 'README.md',
        content: 'Ask about any capability. Use the commands, tools, or skills topic for full descriptions.',
      };
    }
    case 'commands':
      return {
        topic,
        title: 'Slash Commands & CLI Commands',
        listTitle: 'Commands',
        summary:
          'Slash commands run inside the interactive terminal, and most run locally without a model call. CLI commands run from the shell.',
        keyPrinciples: [
          ...INTERACTIVE_COMMANDS.map((command) =>
            `\`${command.usage}\` (${command.category}${command.aliases?.length ? `, aliases ${command.aliases.map((alias) => `/${alias}`).join(' ')}` : ''}): ${command.description}`),
          ...cliCommands().map(([name, description]) => `\`seb ${name}\` (CLI): ${description}`),
        ],
        subsystemsOrFiles: ['src/interactive/commands.ts', 'src/interactive/transport.ts', 'src/cli-options.ts'],
        documentation: 'docs/CLI.md',
        content: CLI_HELP,
      };
    case 'tools': {
      const tools = Object.entries(context.tools ?? {});
      return {
        topic,
        title: 'Agent Tools',
        listTitle: 'Tools',
        summary:
          'The model calls these tools to read live data and run deterministic analysis. Every tool is read-only against external platforms.',
        keyPrinciples: tools.length > 0
          ? tools.map(([name, value]) => `${name}: ${firstSentence(value.description) || 'A provider-hosted tool.'}`)
          : ['The tool list comes from the running agent. Ask Seb which tools it has.'],
        subsystemsOrFiles: ['src/agent.ts', 'src/sleeper/tools.ts', 'src/projection/tools.ts', 'src/news/tools.ts'],
        documentation: 'docs/ARCHITECTURE.md',
        content: 'This list is the tool set of the running agent.',
      };
    }
    case 'skills':
      return {
        topic,
        title: 'Guided Skills',
        listTitle: 'Skills',
        summary: 'A skill adds focused instructions for one workflow. Run /skill NAME [QUESTION] to select a skill.',
        keyPrinciples: SEB_SKILLS.map((skill) =>
          `${skill.id} (${skill.title}, ${skill.category}): ${skill.description}`),
        subsystemsOrFiles: ['src/interactive/skills.ts'],
        documentation: 'docs/SKILLS.md',
        content: SEB_SKILLS.map((skill) => `- ${skill.id}: ${skill.instructions}`).join('\n'),
      };
    default:
      return TOPIC_DETAILS[topic];
  }
}

function cliCommands(): Array<[string, string]> {
  const block = CLI_HELP.split('\nCommands:\n')[1]?.split('\n\n')[0] ?? '';
  const commands: Array<[string, string]> = [];
  for (const line of block.split('\n')) {
    const match = /^ {2}(\S+)\s+(.+)$/u.exec(line);
    if (match?.[1] && match[2]) commands.push([match[1], match[2].trim()]);
    else if (commands.length > 0 && line.trim()) commands.at(-1)![1] += ` ${line.trim()}`;
  }
  return commands;
}

function firstSentence(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  const end = text.search(/[.!?](?:\s|$)/u);
  return end < 0 ? text.slice(0, 220) : text.slice(0, Math.min(end + 1, 220));
}
