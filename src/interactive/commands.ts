import { MODEL_FAMILIES, type ModelProviderId } from '../ai/model-provider.js';
import { findSkill, SEB_SKILLS } from './skills.js';

export type CompletionShell = 'bash' | 'fish' | 'zsh';

export type InteractiveCommandCategory =
  | 'Essentials'
  | 'Explore'
  | 'My Fantasy'
  | 'Analyze'
  | 'Advanced'
  | 'Sources'
  | 'Conversation'
  | 'Preferences'
  | 'Diagnostics';

export interface InteractiveCommand {
  aliases?: readonly string[];
  argumentValues?: readonly string[];
  category: InteractiveCommandCategory;
  danger?: boolean;
  description: string;
  maxArguments?: number;
  name: string;
  preview: string;
  usage: string;
}

export interface InteractiveCompletion {
  description: string;
  value: string;
}

export interface ParsedInteractiveCommandInput {
  argumentText: string;
  arguments: string[];
  command: InteractiveCommand | null;
  name: string;
}

export interface CompletionContext {
  leagueId?: string | null;
  leagueSeason?: number;
  leagues?: readonly { leagueId: string; name: string }[];
  leagueOptions?: readonly string[];
  mode?: 'analyze' | 'explore' | 'fantasy';
  model?: string;
  provider?: string;
  rosterId?: number | null;
  rosterOptions?: readonly number[];
  season?: number;
  skillId?: string;
  team?: string | null;
  user?: string | null;
  week?: number | null;
  recentCommands?: readonly string[];
}

export const NFL_TEAM_CODES = [
  'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE',
  'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAX', 'KC',
  'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG',
  'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS',
] as const;

export const MODEL_PROVIDER_VALUES = [
  'google',
  'anthropic',
  'openai',
  'openai-compatible',
] as const;

const MODEL_PROVIDER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI-compatible endpoint',
};

const DEFAULT_COMMAND_ORDER = [
  'explore',
  'fantasy',
  'analyze',
  'connect',
  'account',
  'next',
  'help',
  'exit',
] as const;

const COMMAND_CATEGORY_ORDER: readonly InteractiveCommandCategory[] = [
  'Essentials',
  'Explore',
  'My Fantasy',
  'Analyze',
  'Sources',
  'Conversation',
  'Preferences',
  'Advanced',
  'Diagnostics',
];

export const INTERACTIVE_COMMANDS: readonly InteractiveCommand[] = [
  command('help', '/help', 'Show every interactive command.', 'Essentials', 'Print the complete command guide.', ['?'], undefined, undefined, 0),
  command('explore', '/explore [QUESTION]', 'Find player, team, league, statistic, and news information.', 'Explore', 'Open Explore or ask one Explore question.'),
  command('fantasy', '/fantasy [QUESTION]', 'Use connected Sleeper leagues, rosters, deadlines, and player news.', 'My Fantasy', 'Open My Fantasy or ask one account-aware question.', ['my']),
  command('analyze', '/analyze [QUESTION]', 'Compare players and add matchup, weather, usage, or roster context.', 'Analyze', 'Open Analyze or ask one analysis question.'),
  command('connect', '/connect SLEEPER_USERNAME', 'Connect one Sleeper account and discover its fantasy context.', 'My Fantasy', 'Save the username and refresh leagues and owned rosters.', undefined, undefined, undefined, 1),
  command('account', '/account', 'Show the connected Sleeper account and discovered leagues.', 'My Fantasy', 'Open the automatic fantasy dashboard.', undefined, undefined, undefined, 0),
  command('disconnect', '/disconnect', 'Disconnect the saved Sleeper username.', 'My Fantasy', 'Remove the username and return to Explore.', undefined, undefined, true, 0),
  command('commands', '/commands [SEARCH]', 'Search the command catalog.', 'Essentials', 'Search command names and descriptions.'),
  command('complete', '/complete INPUT', 'Show completions for partial input.', 'Essentials', 'Print matching command completions.'),
  command('shortcuts', '/shortcuts', 'Show the keyboard guide.', 'Essentials', 'Open the keyboard shortcut guide.', undefined, undefined, undefined, 0),
  command('context', '/context', 'Show the context that Seb selected automatically.', 'Advanced', 'Print current NFL, Sleeper, and subject context.', ['status'], undefined, undefined, 0),
  command('season', '/season YEAR|current', 'Override the automatic NFL season.', 'Advanced', 'Change the season for later requests.', undefined, ['current'], undefined, 1),
  command('week', '/week NUMBER|current|clear', 'Override the automatic NFL week.', 'Advanced', 'Change the week for later requests.', undefined, ['current', 'clear'], undefined, 1),
  command('user', '/user NAME|clear', 'Legacy account connection command.', 'Advanced', 'Connect or disconnect a Sleeper account.', undefined, ['clear'], undefined, 1),
  command('leagues', '/leagues [SLEEPER_USER] [YEAR]', 'Read current or historical leagues for one Sleeper user.', 'Advanced', 'Refresh the connected user and optionally select a league season.', undefined, undefined, undefined, 2),
  command('league', '/league ID|all', 'Focus My Fantasy on one discovered league.', 'My Fantasy', 'Focus one league or return to all leagues.', undefined, ['all', 'clear'], undefined, 1),
  command('rosters', '/rosters [LEAGUE_ID]', 'List rosters for one league.', 'Advanced', 'Read the league rosters from Sleeper.', undefined, undefined, undefined, 1),
  command('roster', '/roster ID|clear', 'Override the automatic owned roster.', 'Advanced', 'Change the focused fantasy roster.', undefined, ['clear'], undefined, 1),
  command('team', '/team CODE|clear', 'Focus Explore on one NFL team.', 'Advanced', 'Change the current NFL team subject.', undefined, [...NFL_TEAM_CODES, 'clear']),
  command('skills', '/skills', 'List advanced analysis workflows.', 'Advanced', 'Print every focused analysis workflow.', undefined, undefined, undefined, 0),
  command(
    'skill',
    '/skill NAME [QUESTION]',
    'Select one analysis skill, or run it with a question.',
    'Advanced',
    'Change the active instructions and optionally run one question.',
    undefined,
    [...SEB_SKILLS.map((skill) => skill.id), 'list'],
  ),
  command('retry', '/retry', 'Run the last question again.', 'Conversation', 'Submit the last non-command prompt again.', undefined, undefined, undefined, 0),
  command('edit', '/edit', 'Edit the last question.', 'Conversation', 'Place the last prompt in the editor.', undefined, undefined, undefined, 0),
  command('setup', '/setup [SLEEPER_USERNAME]', 'Save the local account profile.', 'Advanced', 'Save the current or supplied Sleeper username.', undefined, undefined, undefined, 1),
  command('profile', '/profile [show|load|clear]', 'Inspect the local account profile file.', 'Advanced', 'Read or change the local profile file.', undefined, ['show', 'load', 'clear'], undefined, 1),
  command('sources', '/sources', 'Show evidence for the latest answer.', 'Sources', 'Print the latest answer source links and freshness.', undefined, undefined, undefined, 0),
  command('source', '/source INDEX', 'Show one numbered source link.', 'Sources', 'Print one validated source as a clickable link.', ['open'], undefined, undefined, 1),
  command('cache', '/cache', 'Show the local data cache status.', 'Sources', 'Print local cache and snapshot counts.', undefined, undefined, undefined, 0),
  command('snapshots', '/snapshots [KIND]', 'List recent source snapshots.', 'Sources', 'Read recent immutable source snapshots.', undefined, undefined, undefined, 1),
  command('provenance', '/provenance SNAPSHOT_ID', 'Inspect one snapshot source trail.', 'Sources', 'Print the source lineage for one snapshot.', undefined, undefined, undefined, 1),
  command('replay', '/replay [SEASON] [THROUGH_WEEK]', 'Run the nflverse baseline replay.', 'Analyze', 'Measure the baseline against past results.', undefined, undefined, undefined, 2),
  command('refresh', '/refresh [all|sleeper|nflverse|weather]', 'Refresh source data on the next read.', 'Sources', 'Delete selected cache entries before the next read.', undefined, ['all', 'sleeper', 'nflverse', 'weather'], true, 1),
  command('new', '/new', 'Start a new conversation context.', 'Conversation', 'Exclude earlier messages from the next model call.', ['clear'], undefined, true, 0),
  command('history', '/history [clear]', 'Show or clear question history.', 'Conversation', 'Read or delete the private prompt history.', undefined, ['clear'], undefined, 1),
  command('copy', '/copy [all]', 'Copy the latest answer or full conversation.', 'Conversation', 'Send the latest answer or full conversation to the clipboard.', undefined, ['all'], undefined, 1),
  command('select', '/select', 'Select the full conversation in terminal scrollback.', 'Conversation', 'Print the conversation for native selection. Press Escape to return.', ['copy-mode'], undefined, undefined, 0),
  command('export', '/export [NAME] [md|json]', 'Export the conversation under exports/.', 'Conversation', 'Create a transcript file under exports/.', ['save'], ['md', 'json'], undefined, 2),
  command('theme', '/theme default|high-contrast|compact', 'Select the terminal theme.', 'Preferences', 'Change colors and terminal spacing.', undefined, ['default', 'high-contrast', 'compact'], undefined, 1),
  command('icons', '/icons unicode|ascii', 'Select Unicode or ASCII symbols.', 'Preferences', 'Change terminal symbols for this session.', undefined, ['unicode', 'ascii'], undefined, 1),
  command('provider', '/provider [NAME]', 'Show or switch the active configured model provider.', 'Preferences', 'Switch the provider and start a fresh model context.', undefined, MODEL_PROVIDER_VALUES, undefined, 1),
  command('model', '/model [MODEL]', 'Show or switch the active model family or exact ID.', 'Preferences', 'Resolve and verify a model, then start a fresh model context.', undefined, undefined, undefined, 1),
  command('doctor', '/doctor [offline]', 'Check the local setup and connected services.', 'Diagnostics', 'Run local and optional network checks.', undefined, ['offline', '--offline'], undefined, 1),
  command('devtools', '/devtools', 'Show local AI SDK DevTools status.', 'Diagnostics', 'Print local AI SDK trace settings.', undefined, undefined, undefined, 0),
  command(
    'usage',
    '/usage [session|today|7d|30d|all]',
    'Show concise, locally observed model API usage.',
    'Diagnostics',
    'Print model calls, token classes, coverage, and local tool activity.',
    ['cost'],
    ['session', 'today', '7d', '30d', 'all'],
    undefined,
    1,
  ),
  command(
    'stats',
    '/stats [session|today|7d|30d|all]',
    'Show detailed token, latency, model, and tool-call analytics.',
    'Diagnostics',
    'Analyze locally recorded model and tool activity for one time range.',
    undefined,
    ['session', 'today', '7d', '30d', 'all'],
    undefined,
    1,
  ),
  command('next', '/next', 'Show useful next actions.', 'Essentials', 'Print useful actions for the active context.', ['suggest', 'suggestions'], undefined, undefined, 0),
  command('shell-completion', '/shell-completion bash|fish|zsh', 'Print a shell completion script.', 'Preferences', 'Print a completion script for the selected shell.', ['completion'], ['bash', 'fish', 'zsh'], undefined, 1),
  command('version', '/version', 'Show the Seb version and active model.', 'Diagnostics', 'Print the active Seb, provider, and model.', undefined, undefined, undefined, 0),
  command('exit', '/exit', 'Exit interactive mode.', 'Essentials', 'Close Seb and restore the terminal.', ['quit', 'q'], undefined, undefined, 0),
] as const;

export function findInteractiveCommand(name: string): InteractiveCommand | null {
  const normalized = name.trim().toLowerCase().replace(/^\//, '');
  return INTERACTIVE_COMMANDS.find(
    (candidate) => candidate.name === normalized || candidate.aliases?.includes(normalized),
  ) ?? null;
}

export function parseInteractiveCommandInput(
  input: string,
): ParsedInteractiveCommandInput | null {
  const normalized = input.trim();
  if (!normalized.startsWith('/')) {
    return null;
  }
  const body = normalized.slice(1).trim();
  const separator = body.search(/\s/u);
  const name = (separator < 0 ? body : body.slice(0, separator)).toLowerCase();
  const argumentText = separator < 0 ? '' : body.slice(separator).trim();
  return {
    argumentText,
    arguments: argumentText ? argumentText.split(/\s+/u) : [],
    command: findInteractiveCommand(name),
    name,
  };
}

export function interactiveCommandArgumentError(
  parsed: ParsedInteractiveCommandInput,
): string | null {
  if (parsed.command?.name === 'copy' && parsed.arguments.length > 0 &&
    (parsed.arguments.length !== 1 || parsed.arguments[0]?.toLowerCase() !== 'all')) {
    return 'Use /copy [all].';
  }
  const maximum = parsed.command?.maxArguments;
  if (maximum === undefined || parsed.arguments.length <= maximum) {
    return null;
  }
  return `Use ${parsed.command?.usage ?? `/${parsed.name}`}.`;
}

export function interactiveCommandPrivacyError(
  parsed: ParsedInteractiveCommandInput,
): string | null {
  if (
    (parsed.command?.name === 'model' || parsed.command?.name === 'provider') &&
    (
      parsed.arguments.some(isLikelyApiKey) ||
      /^bearer\s+\S+/iu.test(parsed.argumentText)
    )
  ) {
    return 'Seb does not accept API keys in slash commands. Run `seb configure`.';
  }
  return null;
}

export function searchInteractiveCommands(
  query: string,
  limit = 8,
  recentCommands: readonly string[] = [],
): InteractiveCommand[] {
  const normalized = normalizeSearch(query.replace(/^\//, ''));
  return INTERACTIVE_COMMANDS
    .map((candidate, index) => {
      const matchScore = commandScore(candidate, normalized);
      return {
        candidate,
        index,
        matchScore,
        score:
          matchScore +
          recentScore(candidate, recentCommands) +
          (normalized.length === 0 ? defaultCommandScore(candidate.name) : 0),
      };
    })
    .filter((result) => result.matchScore > 0 || normalized.length === 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(0, limit))
    .map((result) => result.candidate);
}

export function completeInteractiveInput(
  input: string,
  context: CompletionContext = {},
  limit = 8,
): InteractiveCompletion[] {
  const normalizedInput = input.trimStart();
  const withoutSlash = normalizedInput.startsWith('/')
    ? normalizedInput.slice(1)
    : normalizedInput;
  const firstWhitespace = withoutSlash.search(/\s/);
  if (firstWhitespace < 0) {
    return searchInteractiveCommands(withoutSlash, limit, context.recentCommands).map((candidate) => ({
      value: `/${candidate.name}`,
      description: completionDescription(candidate, context),
    }));
  }

  const name = withoutSlash.slice(0, firstWhitespace);
  const candidate = findInteractiveCommand(name);
  if (!candidate) {
    return searchInteractiveCommands(name, limit, context.recentCommands).map((match) => ({
      value: `/${match.name}`,
      description: completionDescription(match, context),
    }));
  }

  const argumentInput = withoutSlash.slice(firstWhitespace).trimStart();
  const values = argumentSuggestions(candidate, context, argumentInput);
  if (completionIsFinished(candidate, argumentInput, values)) {
    return [];
  }
  const argumentPrefix = argumentInput.split(/\s+/).at(-1)?.toLowerCase() ?? '';
  return rankValues(values, argumentPrefix, limit).map((value) => ({
    value: `/${candidate.name} ${replaceLastArgument(argumentInput, value)}`.trimEnd(),
    description: argumentCompletionDescription(candidate, value, context),
  }));
}

export function formatCommandCatalog(query = ''): string {
  const commands = searchInteractiveCommands(query, INTERACTIVE_COMMANDS.length);
  if (commands.length === 0) {
    return `No interactive command matches \`${query}\`.`;
  }
  const title = query ? `## Commands matching \`${query}\`` : '## Interactive commands';
  const rows = COMMAND_CATEGORY_ORDER.flatMap((category) => {
    const matches = commands.filter((candidate) => candidate.category === category);
    if (matches.length === 0) return [];
    return [
      `### ${category}`,
      '',
      ...matches.map((candidate) => `- \`${candidate.usage}\`: ${candidate.description}`),
      '',
    ];
  });
  return [
    title,
    '',
    ...rows,
    'Run `/complete <partial input>` for command and argument suggestions.',
  ].join('\n');
}

function argumentCompletionDescription(
  candidate: InteractiveCommand,
  value: string,
  context: CompletionContext,
): string {
  if (candidate.name === 'skill') {
    const skill = findSkill(value);
    if (skill) {
      return `${skill.title} · ${skill.description}`;
    }
  }
  if (candidate.name === 'team') {
    return value === 'clear' ? 'Clear the active NFL team.' : `Set the NFL team to ${value}.`;
  }
  if (candidate.name === 'league') {
    if (['all', 'clear'].includes(value)) return 'Use every discovered fantasy league.';
    const league = context.leagues?.find((candidate) => candidate.leagueId === value);
    return league
      ? `Focus My Fantasy on ${league.name}.`
      : `Focus My Fantasy on league ${value}.`;
  }
  if (candidate.name === 'provider') {
    return `Switch to ${MODEL_PROVIDER_DISPLAY_NAMES[value] ?? value}.`;
  }
  return `Complete ${candidate.usage}.`;
}

function defaultCommandScore(name: string): number {
  const index = DEFAULT_COMMAND_ORDER.indexOf(
    name as (typeof DEFAULT_COMMAND_ORDER)[number],
  );
  return index < 0 ? 0 : (DEFAULT_COMMAND_ORDER.length - index) * 10;
}

export function formatCompletions(completions: readonly InteractiveCompletion[]): string {
  if (completions.length === 0) {
    return 'Seb found no completion. Run `/commands` to search all commands.';
  }
  return [
    '## Completions',
    '',
    ...completions.map((completion) => `- \`${completion.value}\`: ${completion.description}`),
  ].join('\n');
}

export function generateShellCompletion(shell: CompletionShell): string {
  switch (shell) {
    case 'bash':
      return bashCompletion();
    case 'fish':
      return fishCompletion();
    case 'zsh':
      return zshCompletion();
  }
}

function command(
  name: string,
  usage: string,
  description: string,
  category: InteractiveCommandCategory,
  preview: string,
  aliases?: readonly string[],
  argumentValues?: readonly string[],
  danger?: boolean,
  maxArguments?: number,
): InteractiveCommand {
  return {
    name,
    usage,
    description,
    category,
    preview,
    ...(aliases ? { aliases } : {}),
    ...(argumentValues ? { argumentValues } : {}),
    ...(danger ? { danger } : {}),
    ...(maxArguments !== undefined ? { maxArguments } : {}),
  };
}

function completionIsFinished(
  candidate: InteractiveCommand,
  argumentInput: string,
  values: readonly string[],
): boolean {
  if (candidate.name === 'skill' && hasSkillPrefix(argumentInput)) {
    return true;
  }
  if (candidate.name === 'team') {
    const arguments_ = argumentInput.trim().split(/\s+/u).filter(Boolean);
    const exactTeam = values.some(
      (value) => value.toLowerCase() === arguments_[0]?.toLowerCase(),
    );
    if (exactTeam && (arguments_.length > 1 || /\s$/u.test(argumentInput))) {
      return true;
    }
  }
  if (candidate.maxArguments === undefined) {
    return false;
  }
  const arguments_ = argumentInput.trim()
    ? argumentInput.trim().split(/\s+/)
    : [];
  if (arguments_.length > candidate.maxArguments) {
    return true;
  }
  if (arguments_.length < candidate.maxArguments) {
    return false;
  }
  return /\s$/.test(argumentInput);
}

function hasSkillPrefix(value: string): boolean {
  const parts = value.trim().split(/\s+/u).filter(Boolean);
  for (let length = parts.length; length > 0; length -= 1) {
    if (findSkill(parts.slice(0, length).join(' '))) {
      return true;
    }
  }
  return false;
}

function recentScore(
  candidate: InteractiveCommand,
  recentCommands: readonly string[],
): number {
  const index = recentCommands.findIndex((name) => name === candidate.name);
  return index < 0 ? 0 : Math.max(1, 100 - index);
}

function completionDescription(
  candidate: InteractiveCommand,
  context: CompletionContext,
): string {
  const active = activeCommandValue(candidate.name, context);
  return `${candidate.category} · ${candidate.description}${active ? ` · active: ${active}` : ''}`;
}

function activeCommandValue(
  name: string,
  context: CompletionContext,
): string | null {
  switch (name) {
    case 'explore': return context.mode === 'explore' ? 'selected' : null;
    case 'fantasy': return context.mode === 'fantasy' ? 'selected' : null;
    case 'analyze': return context.mode === 'analyze' ? 'selected' : null;
    case 'connect':
    case 'account':
    case 'disconnect': return context.user ? `@${context.user}` : 'not connected';
    case 'season': return context.season ? String(context.season) : null;
    case 'week': return context.week ? String(context.week) : 'unset';
    case 'user': return context.user ?? 'unset';
    case 'league': return context.leagueId ?? 'unset';
    case 'roster': return context.rosterId ? String(context.rosterId) : 'unset';
    case 'team': return context.team ?? 'unset';
    case 'skill': return context.skillId ?? 'general';
    case 'provider': return context.provider ?? 'unset';
    case 'model': return context.model ?? 'unset';
    default: return null;
  }
}

function commandScore(candidate: InteractiveCommand, query: string): number {
  if (!query) {
    return 1;
  }
  const names = [candidate.name, ...(candidate.aliases ?? [])];
  let score = Math.max(...names.map((name) => fuzzyScore(normalizeSearch(name), query)));
  score = Math.max(score, Math.floor(fuzzyScore(normalizeSearch(candidate.description), query) / 2));
  return score;
}

function fuzzyScore(value: string, query: string): number {
  if (value === query) {
    return 1_000;
  }
  if (value.startsWith(query)) {
    return 800 - (value.length - query.length);
  }
  const contained = value.indexOf(query);
  if (contained >= 0) {
    return 600 - contained;
  }

  let queryIndex = 0;
  let gapCount = 0;
  for (let valueIndex = 0; valueIndex < value.length && queryIndex < query.length; valueIndex += 1) {
    if (value[valueIndex] === query[queryIndex]) {
      queryIndex += 1;
    } else if (queryIndex > 0) {
      gapCount += 1;
    }
  }
  return queryIndex === query.length ? Math.max(1, 300 - gapCount) : 0;
}

function argumentSuggestions(
  candidate: InteractiveCommand,
  context: CompletionContext,
  argumentInput: string,
): string[] {
  const values = [...(candidate.argumentValues ?? [])];
  switch (candidate.name) {
    case 'export': {
      const arguments_ = argumentInput.trim().split(/\s+/u).filter(Boolean);
      return arguments_.length > 1 || (arguments_.length === 1 && /\s$/u.test(argumentInput))
        ? values
        : [];
    }
    case 'season':
      if (context.season) values.unshift(String(context.season));
      break;
    case 'week':
      if (context.week) values.unshift(String(context.week));
      break;
    case 'user':
    case 'connect':
    case 'setup':
      if (context.user) values.unshift(context.user);
      break;
    case 'leagues':
      if (/\s$/u.test(argumentInput) || argumentInput.trim().split(/\s+/u).length > 1) {
        if (context.leagueSeason) values.unshift(String(context.leagueSeason));
      } else if (context.user) {
        values.unshift(context.user);
      }
      break;
    case 'league':
      values.unshift(...(context.leagueOptions ?? []));
      if (context.leagueId) values.unshift(context.leagueId);
      break;
    case 'rosters':
      if (context.leagueId) values.unshift(context.leagueId);
      break;
    case 'roster':
      values.unshift(...(context.rosterOptions ?? []).map(String));
      if (context.rosterId) values.unshift(String(context.rosterId));
      break;
    case 'team':
      if (context.team) values.unshift(context.team);
      break;
    case 'provider':
      if (context.provider) values.unshift(context.provider);
      break;
    case 'model':
      values.push(...(MODEL_FAMILIES[context.provider as ModelProviderId] ?? []));
      if (context.model) values.unshift(context.model);
      break;
  }
  return [...new Set(values)];
}

function rankValues(values: readonly string[], query: string, limit: number): string[] {
  if (!query) {
    return values.slice(0, Math.max(0, limit));
  }
  return values
    .map((value, index) => ({ index, score: fuzzyScore(value.toLowerCase(), query), value }))
    .filter((result) => result.score > 0 || query.length === 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(0, limit))
    .map((result) => result.value);
}

function replaceLastArgument(input: string, replacement: string): string {
  if (!input || /\s$/.test(input)) {
    return `${input}${replacement}`;
  }
  const parts = input.split(/\s+/);
  parts[parts.length - 1] = replacement;
  return parts.join(' ');
}

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function isLikelyApiKey(value: string): boolean {
  const normalized = value.trim();
  return /^AIza[A-Za-z0-9_-]{20,}$/u.test(normalized) ||
    /^sk-(?:ant-|proj-)?[A-Za-z0-9_.-]{16,}$/u.test(normalized) ||
    /^(?:hf_|github_pat_|gh[pousr]_|glpat-|nvapi-|xox[baprs]-)[A-Za-z0-9_.-]{16,}$/u
      .test(normalized) ||
    /^ya29\.[A-Za-z0-9_-]{16,}$/u.test(normalized) ||
    /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?$/u
      .test(normalized) ||
    /^[A-Fa-f0-9]{32,}$/u.test(normalized) ||
    (
      normalized.length >= 24 &&
      /(?:^|[-_.:/+@])(?:api[-_]?key|bearer|credential|password|secret|token)(?:$|[-_.:=/+@])/iu
        .test(normalized)
    );
}

function bashCompletion(): string {
  return `# Seb completion for Bash
_seb_completion() {
  local action current previous range word
  COMPREPLY=()
  current="\${COMP_WORDS[COMP_CWORD]}"
  previous="\${COMP_WORDS[COMP_CWORD-1]}"
  if [[ "\${COMP_CWORD}" -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "chat ask doctor configure setup cache snapshots replay evaluate learn usage stats completion help version" -- "\${current}") )
    return
  fi
  if [[ "\${previous}" == "--provider" || "\${previous}" == "-p" ]]; then
    COMPREPLY=( $(compgen -W "google anthropic openai openai-compatible" -- "\${current}") )
    return
  fi
  range=""
  for word in "\${COMP_WORDS[@]:2:COMP_CWORD-2}"; do
    case "\${word}" in
      today|7d|30d|all) range="\${word}" ;;
    esac
  done
  case "\${COMP_WORDS[1]}" in
    chat) COMPREPLY=( $(compgen -W "--provider --model --help" -- "\${current}") ) ;;
    ask) COMPREPLY=( $(compgen -W "--json --provider --model --no-progress --help" -- "\${current}") ) ;;
    doctor) COMPREPLY=( $(compgen -W "--offline --json --help" -- "\${current}") ) ;;
    cache) COMPREPLY=( $(compgen -W "status clear prune --max-size-mb --max-age-days --retain --json --help" -- "\${current}") ) ;;
    snapshots) COMPREPLY=( $(compgen -W "--kind --entity --id --limit --json --help" -- "\${current}") ) ;;
    learn) COMPREPLY=( $(compgen -W "status update --season --through-week --league --json --help" -- "\${current}") ) ;;
    replay|evaluate) COMPREPLY=( $(compgen -W "--season --through-week --position --output --json --help" -- "\${current}") ) ;;
    usage)
      if [[ -n "\${range}" ]]; then
        COMPREPLY=( $(compgen -W "--json --help" -- "\${current}") )
      else
        COMPREPLY=( $(compgen -W "today 7d 30d all --json --help" -- "\${current}") )
      fi
      ;;
    stats)
      action="\${COMP_WORDS[2]}"
      if [[ -n "\${range}" ]]; then
        COMPREPLY=( $(compgen -W "--json --help" -- "\${current}") )
        return
      fi
      case "\${action}" in
        clear) COMPREPLY=( $(compgen -W "--include-unfinished --json --help" -- "\${current}") ) ;;
        prune) COMPREPLY=( $(compgen -W "--retain-days --include-unfinished --json --help" -- "\${current}") ) ;;
        --*) COMPREPLY=( $(compgen -W "today 7d 30d all --json --help" -- "\${current}") ) ;;
        *) COMPREPLY=( $(compgen -W "today 7d 30d all clear prune --json --help" -- "\${current}") ) ;;
      esac
      ;;
    completion) COMPREPLY=( $(compgen -W "bash fish zsh" -- "\${current}") ) ;;
  esac
}
complete -F _seb_completion seb`;
}

function fishCompletion(): string {
  return `# Seb completion for Fish
complete -c seb -f
complete -c seb -n '__fish_use_subcommand' -a chat -d 'Start an interactive terminal session'
complete -c seb -n '__fish_use_subcommand' -a ask -d 'Ask one question'
complete -c seb -n '__fish_use_subcommand' -a doctor -d 'Check the local setup'
complete -c seb -n '__fish_use_subcommand' -a configure -d 'Configure a model provider privately'
complete -c seb -n '__fish_use_subcommand' -a setup -d 'Configure a Sleeper profile'
complete -c seb -n '__fish_use_subcommand' -a cache -d 'Inspect or clear the SQLite cache'
complete -c seb -n '__fish_use_subcommand' -a snapshots -d 'List source snapshots'
complete -c seb -n '__fish_use_subcommand' -a replay -d 'Measure historical baseline accuracy'
complete -c seb -n '__fish_use_subcommand' -a evaluate -d 'Compare forecast models'
complete -c seb -n '__fish_use_subcommand' -a learn -d 'Inspect or update forecast learning'
complete -c seb -n '__fish_seen_subcommand_from learn' -a 'status update'
complete -c seb -n '__fish_seen_subcommand_from learn' -l league -r -d 'Use league scoring'
complete -c seb -n '__fish_use_subcommand' -a usage -d 'Show local model API usage'
complete -c seb -n '__fish_use_subcommand' -a stats -d 'Show detailed model and tool analytics'
complete -c seb -n '__fish_use_subcommand' -a completion -d 'Print shell completion'
complete -c seb -n '__fish_use_subcommand' -a help -d 'Show help'
complete -c seb -n '__fish_use_subcommand' -a version -d 'Show the version'
complete -c seb -n '__fish_seen_subcommand_from chat ask' -l provider -s p -r -a 'google anthropic openai openai-compatible' -d 'Select a model provider'
complete -c seb -n '__fish_seen_subcommand_from chat ask' -l model -r -d 'Select a model'
complete -c seb -n '__fish_seen_subcommand_from ask doctor' -l json -d 'Print JSON'
complete -c seb -n '__fish_seen_subcommand_from ask' -l no-progress -d 'Hide tool activity'
complete -c seb -n '__fish_seen_subcommand_from doctor' -l offline -d 'Skip network checks'
complete -c seb -n '__fish_seen_subcommand_from cache' -a 'status clear prune'
complete -c seb -n '__fish_seen_subcommand_from cache' -l max-size-mb -r -d 'Set the snapshot size limit'
complete -c seb -n '__fish_seen_subcommand_from cache' -l max-age-days -r -d 'Delete older snapshots'
complete -c seb -n '__fish_seen_subcommand_from cache' -l retain -r -d 'Retain snapshots per source key'
complete -c seb -n '__fish_seen_subcommand_from cache snapshots replay evaluate learn usage stats' -l json -d 'Print JSON'
complete -c seb -n '__fish_seen_subcommand_from usage; and not __fish_seen_subcommand_from today 7d 30d all' -a 'today 7d 30d all'
complete -c seb -n '__fish_seen_subcommand_from stats; and not __fish_seen_subcommand_from today 7d 30d all clear prune' -a 'today 7d 30d all'
complete -c seb -n '__fish_seen_subcommand_from stats; and not __fish_seen_subcommand_from today 7d 30d all clear prune; and test (count (commandline -opc)) -eq 2' -a 'clear prune'
complete -c seb -n '__fish_seen_subcommand_from stats; and __fish_seen_subcommand_from prune' -l retain-days -r -d 'Retain recent usage days'
complete -c seb -n '__fish_seen_subcommand_from stats; and __fish_seen_subcommand_from clear prune' -l include-unfinished -d 'Also remove unfinished usage runs'
complete -c seb -n '__fish_seen_subcommand_from snapshots' -l kind -r -d 'Filter snapshot kind'
complete -c seb -n '__fish_seen_subcommand_from snapshots' -l entity -r -d 'Filter entity key'
complete -c seb -n '__fish_seen_subcommand_from snapshots' -l id -r -d 'Inspect snapshot provenance'
complete -c seb -n '__fish_seen_subcommand_from snapshots' -l limit -r -d 'Limit results'
complete -c seb -n '__fish_seen_subcommand_from replay evaluate learn' -l season -r -d 'Select the season'
complete -c seb -n '__fish_seen_subcommand_from replay evaluate learn' -l through-week -r -d 'Select the final week'
complete -c seb -n '__fish_seen_subcommand_from replay evaluate' -l position -r -d 'Filter positions'
complete -c seb -n '__fish_seen_subcommand_from replay evaluate' -l output -r -d 'Save the report'
complete -c seb -n '__fish_seen_subcommand_from completion' -a 'bash fish zsh'`;
}

function zshCompletion(): string {
  return `#compdef seb
_seb() {
  local -a commands
  commands=(
    'chat:Start an interactive terminal session'
    'ask:Ask one question'
    'doctor:Check the local setup'
    'configure:Configure a model provider privately'
    'setup:Configure a Sleeper profile'
    'cache:Inspect or clear the SQLite cache'
    'snapshots:List source snapshots'
    'replay:Measure historical baseline accuracy'
    'evaluate:Compare forecast models'
    'learn:Inspect or update forecast learning'
    'usage:Show local model API usage'
    'stats:Show detailed model and tool analytics'
    'completion:Print shell completion'
    'help:Show help'
    'version:Show the version'
  )
  _arguments -C \\
    '1:command:->command' \\
    '*::argument:->arguments'
  case "$state" in
    command) _describe 'command' commands ;;
    arguments)
      case "$words[2]" in
        chat) _arguments '--provider[Select a model provider]:provider:(google anthropic openai openai-compatible)' '--model[Select a model]:model:' '--help[Show help]' ;;
        ask) _arguments '--json[Print JSON]' '--provider[Select a model provider]:provider:(google anthropic openai openai-compatible)' '--model[Select a model]:model:' '--no-progress[Hide tool activity]' '--help[Show help]' '*:question:' ;;
        doctor) _arguments '--offline[Skip network checks]' '--json[Print JSON]' '--help[Show help]' ;;
        cache) _arguments '1:action:(status clear prune)' '--max-size-mb[Set the snapshot size limit]:megabytes:' '--max-age-days[Delete older snapshots]:days:' '--retain[Retain snapshots per source key]:count:' '--json[Print JSON]' '--help[Show help]' ;;
        snapshots) _arguments '--kind[Filter snapshot kind]:kind:' '--entity[Filter entity key]:key:' '--id[Inspect snapshot provenance]:id:' '--limit[Limit results]:number:' '--json[Print JSON]' '--help[Show help]' ;;
        learn) _arguments '1:action:(status update)' '--season[Select the season]:year:' '--through-week[Select the final week]:week:' '--league[Use league scoring]:league:' '--json[Print JSON]' '--help[Show help]' ;;
        replay|evaluate) _arguments '--season[Select the season]:year:' '--through-week[Select the final week]:week:' '--position[Filter positions]:positions:' '--output[Save the report]:file:_files' '--json[Print JSON]' '--help[Show help]' ;;
        usage) _arguments '1:range:(today 7d 30d all)' '--json[Print JSON]' '--help[Show help]' ;;
        stats)
          case "$words[3]" in
            clear) _arguments '--include-unfinished[Also remove unfinished usage runs]' '--json[Print JSON]' '--help[Show help]' ;;
            prune) _arguments '--retain-days[Retain recent usage days]:days:' '--include-unfinished[Also remove unfinished usage runs]' '--json[Print JSON]' '--help[Show help]' ;;
            today|7d|30d|all) _arguments '--json[Print JSON]' '--help[Show help]' ;;
            --*) _arguments '1:range:(today 7d 30d all)' '--json[Print JSON]' '--help[Show help]' ;;
            *) _arguments '1:range or action:(today 7d 30d all clear prune)' '--json[Print JSON]' '--help[Show help]' ;;
          esac
          ;;
        completion) _arguments '1:shell:(bash fish zsh)' ;;
      esac
      ;;
  esac
}
_seb "$@"`;
}
