export type CliCommand =
  | { name: 'help' }
  | { name: 'version' }
  | { name: 'chat'; model?: string }
  | {
      name: 'ask';
      json: boolean;
      model?: string;
      progress: boolean;
      prompt?: string;
    }
  | { name: 'doctor'; json: boolean; offline: boolean };

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export const CLI_HELP = `Seb reads Sleeper data and answers fantasy football questions.

Usage:
  seb
  seb chat [--model MODEL]
  seb ask [OPTIONS] [QUESTION]
  seb doctor [--offline] [--json]

Commands:
  chat       Start an interactive terminal session. This is the default.
  ask        Ask one question. Seb also reads the question from standard input.
  doctor     Verify Node.js, the Gemini key, Gemini, and Sleeper.
  help       Show this help.
  version    Show the Seb version.

Ask options:
  --json           Print one JSON object for a script.
  --model MODEL    Use one Gemini model for this request.
  --no-progress    Hide tool activity from the terminal.

Doctor options:
  --offline        Check local configuration without network requests.
  --json           Print one JSON object.

Examples:
  seb
  seb ask "Show the current NFL state."
  printf 'Show trending adds' | seb ask
  seb ask --json "Analyze league 123456789."
  seb doctor

Run without npm link:
  npm run seb
  npm run ask -- "Show the current NFL state."

Interactive controls:
  Enter sends a question. Arrow keys scroll. Escape or Ctrl+C exits.
`;

export function parseCliArguments(arguments_: readonly string[]): CliCommand {
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
    default:
      if (first?.startsWith('-')) {
        throw new CliUsageError(`Unknown option: ${first}`);
      }
      return parseAskArguments(arguments_);
  }
}

function parseChatArguments(arguments_: readonly string[]): CliCommand {
  let model: string | undefined;

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
    throw new CliUsageError(`Unknown chat option: ${argument}`);
  }

  return model ? { name: 'chat', model } : { name: 'chat' };
}

function parseAskArguments(arguments_: readonly string[]): CliCommand {
  let json = false;
  let model: string | undefined;
  let progress = true;
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
    ...(prompt ? { prompt } : {}),
  };
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
