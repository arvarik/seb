import { SEB_SKILLS } from './skills.js';

export type CompletionShell = 'bash' | 'fish' | 'zsh';

export interface InteractiveCommand {
  aliases?: readonly string[];
  argumentValues?: readonly string[];
  description: string;
  name: string;
  usage: string;
}

export interface InteractiveCompletion {
  description: string;
  value: string;
}

export interface CompletionContext {
  leagueId?: string | null;
  rosterId?: number | null;
  season?: number;
  team?: string | null;
  user?: string | null;
  week?: number | null;
}

const NFL_TEAMS = [
  'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE',
  'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAX', 'KC',
  'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG',
  'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS',
] as const;

export const INTERACTIVE_COMMANDS: readonly InteractiveCommand[] = [
  command('help', '/help', 'Show every interactive command.', ['?']),
  command('commands', '/commands [SEARCH]', 'Search the interactive command catalog.'),
  command('complete', '/complete INPUT', 'Suggest commands and arguments for partial input.'),
  command('status', '/status', 'Show the active session values.', ['context']),
  command('season', '/season YEAR|current', 'Set the NFL season.', undefined, ['current']),
  command('week', '/week NUMBER|current|clear', 'Set or clear the NFL week.', undefined, ['current', 'clear']),
  command('user', '/user NAME|clear', 'Set or clear the Sleeper user.', undefined, ['clear']),
  command('league', '/league ID|clear', 'Set or clear the Sleeper league.', undefined, ['clear']),
  command('roster', '/roster ID|clear', 'Set or clear the Sleeper roster.', undefined, ['clear']),
  command('team', '/team CODE|clear', 'Set or clear the NFL team.', undefined, [...NFL_TEAMS, 'clear']),
  command('skills', '/skills', 'List all analysis skills.'),
  command('skill', '/skill NAME|list', 'Select one analysis skill.', undefined, [
    ...SEB_SKILLS.map((skill) => skill.id),
    'list',
  ]),
  command('setup', '/setup [SLEEPER_USER] [LEAGUE_ID] [ROSTER_ID]', 'Discover and save the default Sleeper context.'),
  command('profile', '/profile [show|load|clear]', 'Show, load, or clear the local setup profile.', undefined, ['show', 'load', 'clear']),
  command('sources', '/sources', 'Show sources used in this session.'),
  command('cache', '/cache', 'Show the SQLite cache and snapshot status.'),
  command('snapshots', '/snapshots [KIND]', 'List recent source snapshots.'),
  command('provenance', '/provenance SNAPSHOT_ID', 'Inspect field lineage for one snapshot.'),
  command('replay', '/replay [SEASON] [THROUGH_WEEK]', 'Run the nflverse baseline replay.'),
  command('refresh', '/refresh [all|sleeper|nflverse|weather]', 'Clear safe local data caches.', undefined, ['all', 'sleeper', 'nflverse', 'weather']),
  command('new', '/new', 'Start a new model context.', ['clear']),
  command('save', '/save [NAME] [md|json]', 'Save the transcript under exports/.', ['export'], ['md', 'json']),
  command('doctor', '/doctor [offline]', 'Check the local setup and connected services.', undefined, ['offline', '--offline']),
  command('cost', '/cost', 'Show model token use for this session.'),
  command('suggest', '/suggest', 'Show contextual next actions.', ['suggestions']),
  command('completion', '/completion bash|fish|zsh', 'Print a shell completion script.', undefined, ['bash', 'fish', 'zsh']),
  command('version', '/version', 'Show the Seb and Gemini model versions.'),
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
): InteractiveCommand[] {
  const normalized = normalizeSearch(query.replace(/^\//, ''));
  return INTERACTIVE_COMMANDS
    .map((candidate, index) => ({
      candidate,
      index,
      score: commandScore(candidate, normalized),
    }))
    .filter((result) => result.score > 0 || normalized.length === 0)
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
    return searchInteractiveCommands(withoutSlash, limit).map((candidate) => ({
      value: `/${candidate.name}`,
      description: candidate.description,
    }));
  }

  const name = withoutSlash.slice(0, firstWhitespace);
  const candidate = findInteractiveCommand(name);
  if (!candidate) {
    return searchInteractiveCommands(name, limit).map((match) => ({
      value: `/${match.name}`,
      description: match.description,
    }));
  }

  const argumentInput = withoutSlash.slice(firstWhitespace).trimStart();
  const argumentPrefix = argumentInput.split(/\s+/).at(-1)?.toLowerCase() ?? '';
  const values = argumentSuggestions(candidate, context);
  return rankValues(values, argumentPrefix, limit).map((value) => ({
    value: `/${candidate.name} ${replaceLastArgument(argumentInput, value)}`.trimEnd(),
    description: `Complete ${candidate.usage}.`,
  }));
}

export function formatCommandCatalog(query = ''): string {
  const commands = searchInteractiveCommands(query, INTERACTIVE_COMMANDS.length);
  if (commands.length === 0) {
    return `No interactive command matches \`${query}\`.`;
  }
  const title = query ? `## Commands matching \`${query}\`` : '## Interactive commands';
  return [
    title,
    '',
    ...commands.map((candidate) => `- \`${candidate.usage}\`: ${candidate.description}`),
    '',
    'Run `/complete <partial input>` for command and argument suggestions.',
  ].join('\n');
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
  aliases?: readonly string[],
  argumentValues?: readonly string[],
): InteractiveCommand {
  return {
    name,
    usage,
    description,
    ...(aliases ? { aliases } : {}),
    ...(argumentValues ? { argumentValues } : {}),
  };
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
    case 'league':
      if (context.leagueId) values.unshift(context.leagueId);
      break;
    case 'roster':
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
