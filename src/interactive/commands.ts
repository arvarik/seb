import { findSkill, SEB_SKILLS } from './skills.js';

export type CompletionShell = 'bash' | 'fish' | 'zsh';

export type InteractiveCommandCategory =
  | 'Essentials'
  | 'Context'
  | 'Analysis'
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

export interface CompletionContext {
  leagueId?: string | null;
  leagueOptions?: readonly string[];
  rosterId?: number | null;
  rosterOptions?: readonly number[];
  season?: number;
  skillId?: string;
  team?: string | null;
  user?: string | null;
  week?: number | null;
  recentCommands?: readonly string[];
}

const NFL_TEAMS = [
  'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE',
  'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAX', 'KC',
  'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG',
  'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS',
] as const;

const DEFAULT_COMMAND_ORDER = [
  'context',
  'skill',
  'week',
  'team',
  'league',
  'next',
  'help',
  'exit',
] as const;

const COMMAND_CATEGORY_ORDER: readonly InteractiveCommandCategory[] = [
  'Essentials',
  'Context',
  'Analysis',
  'Sources',
  'Conversation',
  'Preferences',
  'Diagnostics',
];

export const INTERACTIVE_COMMANDS: readonly InteractiveCommand[] = [
  command('help', '/help', 'Show every interactive command.', 'Essentials', 'Print the complete command guide.', ['?']),
  command('commands', '/commands [SEARCH]', 'Search the command catalog.', 'Essentials', 'Search command names and descriptions.'),
  command('complete', '/complete INPUT', 'Show completions for partial input.', 'Essentials', 'Print matching command completions.'),
  command('shortcuts', '/shortcuts', 'Show the keyboard guide.', 'Essentials', 'Open the keyboard shortcut guide.'),
  command('context', '/context', 'Show the active season, league, team, and skill.', 'Context', 'Print every active context value.', ['status']),
  command('season', '/season YEAR|current', 'Set the NFL season.', 'Context', 'Change the season for later requests.', undefined, ['current']),
  command('week', '/week NUMBER|current|clear', 'Set or clear the NFL week.', 'Context', 'Change the week for later requests.', undefined, ['current', 'clear']),
  command('user', '/user NAME|clear', 'Set or clear the Sleeper user.', 'Context', 'Change the Sleeper user for discovery.', undefined, ['clear']),
  command('leagues', '/leagues [SLEEPER_USER]', 'Discover Sleeper leagues for the active season.', 'Context', 'Read the user leagues from Sleeper.'),
  command('league', '/league ID|clear', 'Set or clear the Sleeper league.', 'Context', 'Change the active Sleeper league.', undefined, ['clear']),
  command('rosters', '/rosters [LEAGUE_ID]', 'List every roster in a Sleeper league.', 'Context', 'Read the league rosters from Sleeper.'),
  command('roster', '/roster ID|clear', 'Set or clear the Sleeper roster.', 'Context', 'Change the active fantasy roster.', undefined, ['clear']),
  command('team', '/team CODE|clear', 'Set or clear the NFL team.', 'Context', 'Change the active NFL team.', undefined, [...NFL_TEAMS, 'clear']),
  command('skills', '/skills', 'List all analysis skills.', 'Analysis', 'Print every focused analysis skill.'),
  command(
    'skill',
    '/skill NAME|list',
    'Select one analysis skill.',
    'Analysis',
    'Change the instructions for later analysis.',
    undefined,
    [...SEB_SKILLS.map((skill) => skill.id), 'list'],
    undefined,
    1,
  ),
  command('retry', '/retry', 'Run the last question again.', 'Conversation', 'Submit the last non-command prompt again.'),
  command('edit', '/edit', 'Edit the last question.', 'Conversation', 'Place the last prompt in the editor.'),
  command('setup', '/setup', 'Save team-independent defaults for interactive sessions.', 'Context', 'Save a local team-independent profile.'),
  command('profile', '/profile [show|load|clear]', 'Show, load, or clear the local setup profile.', 'Context', 'Read or change the local setup profile.', undefined, ['show', 'load', 'clear']),
  command('sources', '/sources', 'Show sources used in this session.', 'Sources', 'Print recent source links and freshness.'),
  command('source', '/source INDEX', 'Show one numbered source link.', 'Sources', 'Print one validated source as a clickable link.', ['open']),
  command('cache', '/cache', 'Show the local data cache status.', 'Sources', 'Print local cache and snapshot counts.'),
  command('snapshots', '/snapshots [KIND]', 'List recent source snapshots.', 'Sources', 'Read recent immutable source snapshots.'),
  command('provenance', '/provenance SNAPSHOT_ID', 'Inspect one snapshot source trail.', 'Sources', 'Print the source lineage for one snapshot.'),
  command('replay', '/replay [SEASON] [THROUGH_WEEK]', 'Run the nflverse baseline replay.', 'Analysis', 'Measure the baseline against past results.'),
  command('refresh', '/refresh [all|sleeper|nflverse|weather]', 'Refresh source data on the next read.', 'Sources', 'Delete selected cache entries before the next read.', undefined, ['all', 'sleeper', 'nflverse', 'weather'], true),
  command('new', '/new', 'Start a new conversation context.', 'Conversation', 'Exclude earlier messages from the next model call.', ['clear'], undefined, true),
  command('history', '/history [clear]', 'Show or clear question history.', 'Conversation', 'Read or delete the private prompt history.', undefined, ['clear']),
  command('copy', '/copy', 'Copy the latest Seb answer.', 'Conversation', 'Send the latest answer to the terminal clipboard.'),
  command('export', '/export [NAME] [md|json]', 'Export the conversation under exports/.', 'Conversation', 'Create a transcript file under exports/.', ['save'], ['md', 'json']),
  command('theme', '/theme default|high-contrast|compact', 'Select the terminal theme.', 'Preferences', 'Change colors and terminal spacing.', undefined, ['default', 'high-contrast', 'compact']),
  command('icons', '/icons unicode|ascii', 'Select Unicode or ASCII symbols.', 'Preferences', 'Change terminal symbols for this session.', undefined, ['unicode', 'ascii']),
  command('doctor', '/doctor [offline]', 'Check the local setup and connected services.', 'Diagnostics', 'Run local and optional network checks.', undefined, ['offline', '--offline']),
  command('devtools', '/devtools', 'Show local AI SDK DevTools status.', 'Diagnostics', 'Print local AI SDK trace settings.'),
  command('usage', '/usage', 'Show model token use for this session.', 'Diagnostics', 'Print the session token counters.', ['cost']),
  command('next', '/next', 'Show useful next actions.', 'Essentials', 'Print useful actions for the active context.', ['suggest', 'suggestions']),
  command('shell-completion', '/shell-completion bash|fish|zsh', 'Print a shell completion script.', 'Preferences', 'Print a completion script for the selected shell.', ['completion'], ['bash', 'fish', 'zsh']),
  command('version', '/version', 'Show the Seb and Gemini model versions.', 'Diagnostics', 'Print the active Seb and model versions.'),
  command('exit', '/exit', 'Exit interactive mode.', 'Essentials', 'Close Seb and restore the terminal.', ['quit', 'q']),
] as const;

export function findInteractiveCommand(name: string): InteractiveCommand | null {
  const normalized = name.trim().toLowerCase().replace(/^\//, '');
  return INTERACTIVE_COMMANDS.find(
    (candidate) => candidate.name === normalized || candidate.aliases?.includes(normalized),
  ) ?? null;
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
  const values = argumentSuggestions(candidate, context);
  if (completionIsFinished(candidate, argumentInput, values)) {
    return [];
  }
  const argumentPrefix = argumentInput.split(/\s+/).at(-1)?.toLowerCase() ?? '';
  return rankValues(values, argumentPrefix, limit).map((value) => ({
    value: `/${candidate.name} ${replaceLastArgument(argumentInput, value)}`.trimEnd(),
    description: argumentCompletionDescription(candidate, value),
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
    ...(maxArguments ? { maxArguments } : {}),
  };
}

function completionIsFinished(
  candidate: InteractiveCommand,
  argumentInput: string,
  values: readonly string[],
): boolean {
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
  const lastArgument = arguments_.at(-1)?.toLowerCase() ?? '';
  const exactValue = values.some((value) => value.toLowerCase() === lastArgument);
  return /\s$/.test(argumentInput) || exactValue;
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
    case 'season': return context.season ? String(context.season) : null;
    case 'week': return context.week ? String(context.week) : 'unset';
    case 'user': return context.user ?? 'unset';
    case 'league': return context.leagueId ?? 'unset';
    case 'roster': return context.rosterId ? String(context.rosterId) : 'unset';
    case 'team': return context.team ?? 'unset';
    case 'skill': return context.skillId ?? 'general';
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
): string[] {
  const values = [...(candidate.argumentValues ?? [])];
  switch (candidate.name) {
    case 'season':
      if (context.season) values.unshift(String(context.season));
      break;
    case 'week':
      if (context.week) values.unshift(String(context.week));
      break;
    case 'user':
      if (context.user) values.unshift(context.user);
      break;
    case 'leagues':
      if (context.user) values.unshift(context.user);
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

function bashCompletion(): string {
  return `# Seb completion for Bash
_seb_completion() {
  local current previous
  COMPREPLY=()
  current="\${COMP_WORDS[COMP_CWORD]}"
  previous="\${COMP_WORDS[COMP_CWORD-1]}"
  if [[ "\${COMP_CWORD}" -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "chat ask doctor setup cache snapshots replay completion help version" -- "\${current}") )
    return
  fi
  case "\${COMP_WORDS[1]}" in
    chat) COMPREPLY=( $(compgen -W "--model --help" -- "\${current}") ) ;;
    ask) COMPREPLY=( $(compgen -W "--json --model --no-progress --help" -- "\${current}") ) ;;
    doctor) COMPREPLY=( $(compgen -W "--offline --json --help" -- "\${current}") ) ;;
    cache) COMPREPLY=( $(compgen -W "status clear --json --help" -- "\${current}") ) ;;
    snapshots) COMPREPLY=( $(compgen -W "--kind --entity --id --limit --json --help" -- "\${current}") ) ;;
    replay) COMPREPLY=( $(compgen -W "--season --through-week --position --output --json --help" -- "\${current}") ) ;;
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
complete -c seb -n '__fish_use_subcommand' -a setup -d 'Configure a Sleeper profile'
complete -c seb -n '__fish_use_subcommand' -a cache -d 'Inspect or clear the SQLite cache'
complete -c seb -n '__fish_use_subcommand' -a snapshots -d 'List source snapshots'
complete -c seb -n '__fish_use_subcommand' -a replay -d 'Measure historical baseline accuracy'
complete -c seb -n '__fish_use_subcommand' -a completion -d 'Print shell completion'
complete -c seb -n '__fish_use_subcommand' -a help -d 'Show help'
complete -c seb -n '__fish_use_subcommand' -a version -d 'Show the version'
complete -c seb -n '__fish_seen_subcommand_from chat ask' -l model -r -d 'Select a Gemini model'
complete -c seb -n '__fish_seen_subcommand_from ask doctor' -l json -d 'Print JSON'
complete -c seb -n '__fish_seen_subcommand_from ask' -l no-progress -d 'Hide tool activity'
complete -c seb -n '__fish_seen_subcommand_from doctor' -l offline -d 'Skip network checks'
complete -c seb -n '__fish_seen_subcommand_from cache' -a 'status clear'
complete -c seb -n '__fish_seen_subcommand_from cache snapshots replay' -l json -d 'Print JSON'
complete -c seb -n '__fish_seen_subcommand_from snapshots' -l kind -r -d 'Filter snapshot kind'
complete -c seb -n '__fish_seen_subcommand_from snapshots' -l entity -r -d 'Filter entity key'
complete -c seb -n '__fish_seen_subcommand_from snapshots' -l id -r -d 'Inspect snapshot provenance'
complete -c seb -n '__fish_seen_subcommand_from snapshots' -l limit -r -d 'Limit results'
complete -c seb -n '__fish_seen_subcommand_from replay' -l season -r -d 'Select the season'
complete -c seb -n '__fish_seen_subcommand_from replay' -l through-week -r -d 'Select the final week'
complete -c seb -n '__fish_seen_subcommand_from replay' -l position -r -d 'Filter positions'
complete -c seb -n '__fish_seen_subcommand_from replay' -l output -r -d 'Save the report'
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
    'setup:Configure a Sleeper profile'
    'cache:Inspect or clear the SQLite cache'
    'snapshots:List source snapshots'
    'replay:Measure historical baseline accuracy'
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
        chat) _arguments '--model[Select a Gemini model]:model:' '--help[Show help]' ;;
        ask) _arguments '--json[Print JSON]' '--model[Select a Gemini model]:model:' '--no-progress[Hide tool activity]' '--help[Show help]' '*:question:' ;;
        doctor) _arguments '--offline[Skip network checks]' '--json[Print JSON]' '--help[Show help]' ;;
        cache) _arguments '1:action:(status clear)' '--json[Print JSON]' '--help[Show help]' ;;
        snapshots) _arguments '--kind[Filter snapshot kind]:kind:' '--entity[Filter entity key]:key:' '--id[Inspect snapshot provenance]:id:' '--limit[Limit results]:number:' '--json[Print JSON]' '--help[Show help]' ;;
        replay) _arguments '--season[Select the season]:year:' '--through-week[Select the final week]:week:' '--position[Filter positions]:positions:' '--output[Save the report]:file:_files' '--json[Print JSON]' '--help[Show help]' ;;
        completion) _arguments '1:shell:(bash fish zsh)' ;;
      esac
      ;;
  esac
}
_seb "$@"`;
}
