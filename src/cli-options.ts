export type CliCommand =
  | { name: 'learn'; action: 'status' | 'update'; season: number; throughWeek?: number; leagueId?: string; json: boolean }
  | { name: 'help' }
  | { name: 'version' }
  | { name: 'configure' }
  | { name: 'setup'; username?: string }
  | { name: 'completion'; shell: 'bash' | 'fish' | 'zsh' }
  | {
      name: 'cache';
      action: 'clear' | 'prune' | 'status';
      json: boolean;
      maxBytes?: number;
      snapshotMaxAgeDays?: number;
      snapshotRetention?: number;
    }
  | {
      name: 'snapshots';
      entityKey?: string;
      id?: string;
      json: boolean;
      kind?: string;
      limit: number;
    }
  | {
      name: 'replay' | 'evaluate';
      json: boolean;
      output?: string;
      positions?: string[];
      season: number;
      throughWeek: number;
    }
  | {
      name: 'usage';
      json: boolean;
      scope: 'today' | '7d' | '30d' | 'all';
    }
  | {
      action: 'clear' | 'prune' | 'report';
      includeUnfinished?: boolean;
      json: boolean;
      name: 'stats';
      retainDays?: number;
      scope: 'today' | '7d' | '30d' | 'all';
    }
  | { name: 'chat'; model?: string; provider?: ModelProviderOption }
  | {
      name: 'ask';
      json: boolean;
      model?: string;
      progress: boolean;
      prompt?: string;
      provider?: ModelProviderOption;
    }
  | { name: 'doctor'; json: boolean; offline: boolean };

export type ModelProviderOption =
  | 'anthropic'
  | 'google'
  | 'openai'
  | 'openai-compatible';

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export const CLI_HELP = `Seb reads Sleeper, nflverse, weather, and grounded news for fantasy football.

Usage:
  seb
  seb chat [--provider NAME] [--model MODEL]
  seb ask [OPTIONS] [QUESTION]
  seb doctor [--offline] [--json]
  seb configure
  seb setup [SLEEPER_USERNAME]
  seb completion bash|fish|zsh
  seb cache [status|clear|prune] [--max-size-mb N] [--max-age-days N] [--retain N] [--json]
  seb snapshots [--kind KIND] [--entity KEY] [--id ID] [--limit N] [--json]
  seb learn status|update --season YEAR [--through-week N] [--league ID] [--json]
  seb evaluate --season YEAR [--through-week N] [--position POSITIONS] [--output FILE] [--json]
  seb replay --season YEAR [--through-week N] [--position POSITIONS] [--output FILE] [--json]
  seb usage [today|7d|30d|all] [--json]
  seb stats [today|7d|30d|all] [--json]
  seb stats clear [--include-unfinished] [--json]
  seb stats prune [--retain-days N] [--include-unfinished] [--json]

Commands:
  chat       Start an interactive terminal session. This is the default.
  ask        Ask one question. Seb also reads the question from standard input.
  doctor     Verify the active model provider, local data, and public data APIs.
  configure  Enter a provider key, endpoint, and model through a private prompt.
  setup      Save one optional Sleeper username.
  completion Print a shell completion script.
  cache      Inspect or clear the local SQLite cache.
  snapshots  List versioned source snapshots.
  learn      Inspect or update local forecast learning from completed weeks.
  evaluate   Compare legacy, ensemble, and weekly adaptive forecasts.
  replay     Measure historical nflverse baseline accuracy without future leakage.
  usage      Show concise, locally observed model API usage.
  stats      Show detailed token, latency, model, and tool analytics.
  help       Show this help.
  version    Show the Seb version.

Chat and ask model options:
  --provider NAME  Use google, anthropic, openai, or openai-compatible.
  --model MODEL    Use one model and disable fallback for this request.

Ask output options:
  --json           Print one validated analysis object for a script.
  --no-progress    Hide tool activity from the terminal.

Doctor options:
  --offline        Check local configuration without network requests.
  --json           Print one JSON object.

Examples:
  seb
  seb configure
  seb ask "Show the current NFL state."
  seb ask --provider anthropic --model claude-sonnet-5 "Compare two players."
  printf 'Show trending adds' | seb ask
  seb ask --json "Analyze league 123456789."
  seb doctor
  seb usage
  seb stats 30d --json

Run without npm link:
  npm run seb
  npm run ask -- "Show the current NFL state."

Interactive controls:
  Type / to open commands. Arrow keys select. Tab or Right Arrow fills.
  Enter sends. Escape closes the menu. Escape again or Ctrl+C exits.
  Run /help for Explore, My Fantasy, Analyze, source, and advanced commands.
`;

export function parseCliArguments(arguments_: readonly string[]): CliCommand {
  const valueOptions = new Set(['--model', '--provider', '--season', '--through-week', '--position',
    '--output', '--league', '--max-size-mb', '--max-age-days', '--retain', '--kind', '--entity', '--id', '--limit', '--retain-days']);
  let literal = false;
  arguments_ = arguments_.flatMap((argument) => {
    if (argument === '--') literal = true;
    const equals = argument.indexOf('=');
    if (!literal && equals > 0 && valueOptions.has(argument.slice(0, equals))) {
      return [argument.slice(0, equals), argument.slice(equals + 1)];
    }
    return [argument];
  });
  if (arguments_.length === 0) {
    return { name: 'chat' };
  }

  const [first, ...rest] = arguments_;
  switch (first) {
    case '--help':
    case '-h':
    case 'help':
      requireNoArguments(rest, first);
      return { name: 'help' };
    case '--version':
    case '-V':
    case 'version':
      requireNoArguments(rest, first);
      return { name: 'version' };
    case 'chat':
      return parseChatArguments(rest);
    case 'ask':
      return parseAskArguments(rest);
    case 'doctor':
      return parseDoctorArguments(rest);
    case 'configure':
      requireNoArguments(rest, first);
      return { name: 'configure' };
    case 'setup':
      if (rest[0] === '--help' || rest[0] === '-h') {
        return { name: 'help' };
      }
      if (rest.length > 1) {
        throw new CliUsageError('Use seb setup [SLEEPER_USERNAME].');
      }
      return rest[0] ? { name: 'setup', username: rest[0] } : { name: 'setup' };
    case 'completion':
      return parseCompletionArguments(rest);
    case 'cache':
      return parseCacheArguments(rest);
    case 'snapshots':
      return parseSnapshotArguments(rest);
    case 'learn':
      return parseLearningArguments(rest);
    case 'evaluate': {
      const parsed = parseReplayArguments(rest);
      return parsed.name === 'replay' ? { ...parsed, name: 'evaluate' } : parsed;
    }
    case 'replay':
      return parseReplayArguments(rest);
    case 'usage':
    case 'stats':
      return parseUsageArguments(first, rest);
    default:
      return parseAskArguments(arguments_);
  }
}

function parseUsageArguments(
  name: 'usage' | 'stats',
  arguments_: readonly string[],
): CliCommand {
  if (name === 'stats' && arguments_[0] === 'clear') {
    const rest = arguments_.slice(1);
    if (rest.includes('--help') || rest.includes('-h')) return { name: 'help' };
    if (rest.some((argument) =>
      argument !== '--json' && argument !== '--include-unfinished')) {
      throw new CliUsageError(
        'Use seb stats clear [--include-unfinished] [--json].',
      );
    }
    return {
      action: 'clear',
      includeUnfinished: rest.includes('--include-unfinished'),
      json: rest.includes('--json'),
      name,
      scope: 'all',
    };
  }
  if (name === 'stats' && arguments_[0] === 'prune') {
    if (arguments_.includes('--help') || arguments_.includes('-h')) {
      return { name: 'help' };
    }
    let includeUnfinished = false;
    let json = false;
    let retainDays = 90;
    for (let index = 1; index < arguments_.length; index += 1) {
      const argument = arguments_[index];
      if (argument === '--json') {
        json = true;
        continue;
      }
      if (argument === '--include-unfinished') {
        includeUnfinished = true;
        continue;
      }
      if (argument === '--retain-days') {
        retainDays = Number(readOptionValue(arguments_, index, argument));
        index += 1;
        if (!Number.isSafeInteger(retainDays) || retainDays < 1 || retainDays > 36_500) {
          throw new CliUsageError('--retain-days must be an integer from 1 through 36500.');
        }
        continue;
      }
      throw new CliUsageError(
        'Use seb stats prune [--retain-days N] [--include-unfinished] [--json].',
      );
    }
    return {
      action: 'prune',
      includeUnfinished,
      json,
      name,
      retainDays,
      scope: 'all',
    };
  }
  let json = false;
  let scope: 'today' | '7d' | '30d' | 'all' = name === 'usage' ? 'today' : '7d';
  let scopeWasSet = false;
  for (const argument of arguments_) {
    if (argument === '--help' || argument === '-h') {
      return { name: 'help' };
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (['today', '7d', '30d', 'all'].includes(argument)) {
      if (scopeWasSet) {
        throw new CliUsageError(`Use only one ${name} time range.`);
      }
      scope = argument as typeof scope;
      scopeWasSet = true;
      continue;
    }
    throw new CliUsageError(
      `Use seb ${name} [today|7d|30d|all] [--json].`,
    );
  }
  return name === 'stats'
    ? { action: 'report', name, json, scope }
    : { name, json, scope };
}

function parseReplayArguments(arguments_: readonly string[]): CliCommand {
  let json = false;
  let output: string | undefined;
  let positions: string[] | undefined;
  let season: number | undefined;
  let throughWeek = 18;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--help' || argument === '-h') return { name: 'help' };
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (['--season', '--through-week', '--position', '--output'].includes(argument ?? '')) {
      const value = readOptionValue(arguments_, index, argument ?? '');
      index += 1;
      if (argument === '--season') season = Number(value);
      if (argument === '--through-week') throughWeek = Number(value);
      if (argument === '--position') {
        positions = value.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
      }
      if (argument === '--output') output = value;
      continue;
    }
    throw new CliUsageError(`Unknown replay option: ${argument}`);
  }
  if (season === undefined || !Number.isInteger(season) || season < 1999 || season > 2100) {
    throw new CliUsageError('--season must be an integer from 1999 through 2100.');
  }
  if (!Number.isInteger(throughWeek) || throughWeek < 2 || throughWeek > 18) {
    throw new CliUsageError('--through-week must be an integer from 2 through 18.');
  }
  if (positions && (positions.length === 0 || positions.some((item) => !['QB', 'RB', 'WR', 'TE', 'K'].includes(item)))) {
    throw new CliUsageError('--position accepts QB, RB, WR, TE, and K as a comma-separated list.');
  }
  return {
    name: 'replay',
    json,
    season,
    throughWeek,
    ...(output ? { output } : {}),
    ...(positions ? { positions } : {}),
  };
}

function parseCompletionArguments(arguments_: readonly string[]): CliCommand {
  if (arguments_[0] === '--help' || arguments_[0] === '-h') {
    return { name: 'help' };
  }
  const shell = arguments_[0];
  if (arguments_.length !== 1 || !['bash', 'fish', 'zsh'].includes(shell ?? '')) {
    throw new CliUsageError('Use seb completion bash, fish, or zsh.');
  }
  return { name: 'completion', shell: shell as 'bash' | 'fish' | 'zsh' };
}

function parseCacheArguments(arguments_: readonly string[]): CliCommand {
  let action: 'clear' | 'prune' | 'status' = 'status';
  let actionWasSet = false;
  let json = false;
  let maxBytes: number | undefined;
  let snapshotMaxAgeDays: number | undefined;
  let snapshotRetention: number | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--json') {
      json = true;
    } else if (argument === 'status' || argument === 'clear' || argument === 'prune') {
      if (actionWasSet) {
        throw new CliUsageError('Use only one cache action: status, clear, or prune.');
      }
      action = argument;
      actionWasSet = true;
    } else if (['--max-size-mb', '--max-age-days', '--retain'].includes(argument ?? '')) {
      const value = Number(readOptionValue(arguments_, index, argument ?? ''));
      index += 1;
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new CliUsageError(`${argument} must contain a positive integer.`);
      }
      if (argument === '--max-size-mb') maxBytes = value * 1024 * 1024;
      if (argument === '--max-age-days') snapshotMaxAgeDays = value;
      if (argument === '--retain') snapshotRetention = value;
    } else if (argument === '--help' || argument === '-h') {
      return { name: 'help' };
    } else {
      throw new CliUsageError(`Unknown cache option: ${argument}`);
    }
  }
  if (action !== 'prune' && [maxBytes, snapshotMaxAgeDays, snapshotRetention].some((value) => value !== undefined)) {
    throw new CliUsageError('Cache pruning options require `seb cache prune`.');
  }
  return {
    name: 'cache',
    action,
    json,
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(snapshotMaxAgeDays === undefined ? {} : { snapshotMaxAgeDays }),
    ...(snapshotRetention === undefined ? {} : { snapshotRetention }),
  };
}

function parseSnapshotArguments(arguments_: readonly string[]): CliCommand {
  let entityKey: string | undefined;
  let json = false;
  let kind: string | undefined;
  let id: string | undefined;
  let limit = 20;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--help' || argument === '-h') return { name: 'help' };
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--kind' || argument === '--entity' || argument === '--id' || argument === '--limit') {
      const value = readOptionValue(arguments_, index, argument);
      index += 1;
      if (argument === '--kind') kind = value;
      if (argument === '--entity') entityKey = value;
      if (argument === '--id') id = value;
      if (argument === '--limit') {
        limit = Number(value);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
          throw new CliUsageError('--limit must be an integer from 1 through 1000.');
        }
      }
      continue;
    }
    throw new CliUsageError(`Unknown snapshots option: ${argument}`);
  }
  return {
    name: 'snapshots',
    json,
    limit,
    ...(kind ? { kind } : {}),
    ...(entityKey ? { entityKey } : {}),
    ...(id ? { id } : {}),
  };
}

function parseChatArguments(arguments_: readonly string[]): CliCommand {
  let model: string | undefined;
  let provider: ModelProviderOption | undefined;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--help' || argument === '-h') {
      return { name: 'help' };
    }
    if (argument === '--model' || argument === '-m') {
      model = readOptionValue(arguments_, index, argument);
      index += 1;
      continue;
    }
    if (argument?.startsWith('--model=')) {
      model = readInlineOptionValue(argument, '--model');
      continue;
    }
    if (argument === '--provider' || argument === '-p') {
      provider = readProviderOption(readOptionValue(arguments_, index, argument));
      index += 1;
      continue;
    }
    if (argument?.startsWith('--provider=')) {
      provider = readProviderOption(readInlineOptionValue(argument, '--provider'));
      continue;
    }
    throw new CliUsageError(`Unknown chat option: ${argument}`);
  }

  return {
    name: 'chat',
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
  };
}

function parseAskArguments(arguments_: readonly string[]): CliCommand {
  let json = false;
  let model: string | undefined;
  let progress = true;
  let provider: ModelProviderOption | undefined;
  const promptParts: string[] = [];
  let optionsEnded = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (optionsEnded) {
      promptParts.push(argument ?? '');
      continue;
    }
    if (argument === '--') {
      optionsEnded = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      return { name: 'help' };
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--no-progress') {
      progress = false;
      continue;
    }
    if (argument === '--model' || argument === '-m') {
      model = readOptionValue(arguments_, index, argument);
      index += 1;
      continue;
    }
    if (argument?.startsWith('--model=')) {
      model = readInlineOptionValue(argument, '--model');
      continue;
    }
    if (argument === '--provider' || argument === '-p') {
      provider = readProviderOption(readOptionValue(arguments_, index, argument));
      index += 1;
      continue;
    }
    if (argument?.startsWith('--provider=')) {
      provider = readProviderOption(readInlineOptionValue(argument, '--provider'));
      continue;
    }
    if (argument?.startsWith('-')) {
      throw new CliUsageError(`Unknown ask option: ${argument}`);
    }
    promptParts.push(argument ?? '');
  }

  const prompt = promptParts.join(' ').trim();
  return {
    name: 'ask',
    json,
    progress,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

function readProviderOption(value: string): ModelProviderOption {
  if (
    value === 'google' ||
    value === 'anthropic' ||
    value === 'openai' ||
    value === 'openai-compatible'
  ) {
    return value;
  }
  throw new CliUsageError(
    '--provider must equal google, anthropic, openai, or openai-compatible.',
  );
}

function parseDoctorArguments(arguments_: readonly string[]): CliCommand {
  let json = false;
  let offline = false;

  for (const argument of arguments_) {
    if (argument === '--help' || argument === '-h') {
      return { name: 'help' };
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--offline') {
      offline = true;
      continue;
    }
    throw new CliUsageError(`Unknown doctor option: ${argument}`);
  }

  return { name: 'doctor', json, offline };
}

function readInlineOptionValue(argument: string, option: string): string {
  const value = argument.slice(option.length + 1).trim();
  if (!value) {
    throw new CliUsageError(`${option} needs a value.`);
  }
  return value;
}

function readOptionValue(
  arguments_: readonly string[],
  index: number,
  option: string,
): string {
  const value = arguments_[index + 1]?.trim();
  if (!value || value.startsWith('-')) {
    throw new CliUsageError(`${option} needs a value.`);
  }
  return value;
}

function requireNoArguments(arguments_: readonly string[], command: string): void {
  if (arguments_.length > 0) {
    throw new CliUsageError(`${command} does not accept more arguments.`);
  }
}

function parseLearningArguments(args: readonly string[]): CliCommand {
  if (args.includes('--help') || args.includes('-h')) return { name: 'help' };
  const action = args[0];
  if (action !== 'status' && action !== 'update') throw new CliUsageError('Use seb learn status|update --season YEAR.');
  let season: number | undefined;
  let throughWeek: number | undefined;
  let leagueId: string | undefined;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') { json = true; continue; }
    if (arg === '--season' || arg === '--through-week' || arg === '--league') {
      const value = readOptionValue(args, index, arg); index += 1;
      if (arg === '--season') season = Number(value);
      else if (arg === '--through-week') throughWeek = Number(value);
      else leagueId = value;
    } else throw new CliUsageError(`Unknown learning option: ${arg}`);
  }
  if (!Number.isInteger(season) || season! < 1999 || season! > 2100 ||
    (throughWeek !== undefined && (!Number.isInteger(throughWeek) || throughWeek < 1 || throughWeek > 18)) ||
    (leagueId !== undefined && !/^\d+$/.test(leagueId))) throw new CliUsageError('Learning requires a season, an optional week from 1 through 18, and a numeric league ID.');
  return { name: 'learn', action, season: season!, json,
    ...(throughWeek === undefined ? {} : { throughWeek }), ...(leagueId ? { leagueId } : {}) };
}
