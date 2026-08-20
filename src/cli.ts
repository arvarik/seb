import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';

import { runAgentTUI, type AgentTUIAgent } from '@ai-sdk/tui';

import {
  createFantasyFootballAgent,
  DEFAULT_GEMINI_FALLBACK_MODEL,
  DEFAULT_GEMINI_MODEL,
} from './agent.js';
import {
  CLI_HELP,
  CliUsageError,
  parseCliArguments,
  type CliCommand,
} from './cli-options.js';
import { formatDoctorReport, runDoctor } from './doctor.js';
import { isModelCapacityError } from './model-capacity-error.js';

const MAX_STDIN_BYTES = 128 * 1024;
const packageJson = createRequire(import.meta.url)('../package.json') as {
  version: string;
};

interface CliInput extends AsyncIterable<string | Buffer | Uint8Array> {
  isTTY?: boolean;
}

interface CliOutput {
  isTTY?: boolean;
  write(text: string): unknown;
}

export interface CliStreams {
  stderr: CliOutput;
  stdin: CliInput;
  stdout: CliOutput;
}

interface ModelSelection {
  apiKey: string;
  fallbackModel: string;
  primaryModel: string;
}

interface AnswerResult {
  answer: string;
  fallbackUsed: boolean;
  finishReason: string;
  model: string;
  toolCalls: string[];
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
  };
}

export async function runCli(
  arguments_: readonly string[],
  streams: CliStreams = process,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const command = parseCliArguments(arguments_);

  switch (command.name) {
    case 'help':
      streams.stdout.write(CLI_HELP);
      return 0;
    case 'version':
      streams.stdout.write(`seb ${packageJson.version}\n`);
      return 0;
    case 'doctor': {
      const report = await runDoctor({
        environment,
        offline: command.offline,
      });
      streams.stdout.write(
        command.json
          ? `${JSON.stringify(report)}\n`
          : `${formatDoctorReport(report)}\n`,
      );
      return report.ok ? 0 : 1;
    }
    case 'chat':
      await startInteractiveChat(command, streams, environment);
      return 0;
    case 'ask':
      await answerOneQuestion(command, streams, environment);
      return 0;
  }
}

async function startInteractiveChat(
  command: Extract<CliCommand, { name: 'chat' }>,
  streams: CliStreams,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  if (streams.stdin.isTTY !== true || streams.stdout.isTTY !== true) {
    throw new CliUsageError(
      'Interactive chat needs a terminal. Use the ask command for a pipe or script.',
    );
  }

  const selection = selectModels(environment, command.model);
  const agent = createFantasyFootballAgent({
    apiKey: selection.apiKey,
    model: selection.primaryModel,
  });
  await runAgentTUI({
    agent: agent as unknown as AgentTUIAgent,
    title: `Seb · ${selection.primaryModel}`,
    tools: 'auto-collapsed',
    reasoning: 'collapsed',
    responseStatistics: 'outputTokensPerSecond',
  });
}

async function answerOneQuestion(
  command: Extract<CliCommand, { name: 'ask' }>,
  streams: CliStreams,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const prompt = command.prompt ?? (await readPrompt(streams.stdin));
  if (!prompt) {
    throw new CliUsageError(
      'Add a question, pipe a question to standard input, or start interactive chat.',
    );
  }

  const selection = selectModels(environment, command.model);
  if (command.json) {
    const result = await generateAnswer(selection, prompt, streams.stderr);
    streams.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  await streamAnswer(selection, prompt, streams, command.progress);
}

async function generateAnswer(
  selection: ModelSelection,
  prompt: string,
  stderr: CliOutput,
): Promise<AnswerResult> {
  try {
    return await generateWithModel(selection, selection.primaryModel, prompt, false);
  } catch (error) {
    if (
      !isModelCapacityError(error) ||
      selection.fallbackModel === selection.primaryModel
    ) {
      throw error;
    }
    writeFallbackNotice(stderr, selection);
    return generateWithModel(selection, selection.fallbackModel, prompt, true);
  }
}

async function generateWithModel(
  selection: ModelSelection,
  model: string,
  prompt: string,
  fallbackUsed: boolean,
): Promise<AnswerResult> {
  const agent = createFantasyFootballAgent({
    apiKey: selection.apiKey,
    model,
  });
  const result = await agent.generate({ prompt });
  return {
    answer: result.text,
    fallbackUsed,
    finishReason: result.finishReason,
    model,
    toolCalls: [...new Set(result.toolCalls.map((call) => call.toolName))],
    usage: {
      inputTokens: result.usage.inputTokens ?? null,
      outputTokens: result.usage.outputTokens ?? null,
    },
  };
}

async function streamAnswer(
  selection: ModelSelection,
  prompt: string,
  streams: CliStreams,
  progressEnabled: boolean,
): Promise<void> {
  let wroteText = false;

  const run = async (model: string): Promise<void> => {
    const agent = createFantasyFootballAgent({
      apiKey: selection.apiKey,
      model,
    });
    const result = await agent.stream({ prompt });

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        streams.stdout.write(part.text);
        wroteText = true;
      } else if (
        part.type === 'tool-call' &&
        progressEnabled &&
        streams.stderr.isTTY === true
      ) {
        streams.stderr.write(`• ${describeTool(part.toolName)}\n`);
      } else if (part.type === 'error') {
        throw part.error;
      }
    }
  };

  try {
    await run(selection.primaryModel);
  } catch (error) {
    if (
      wroteText ||
      !isModelCapacityError(error) ||
      selection.fallbackModel === selection.primaryModel
    ) {
      throw error;
    }
    writeFallbackNotice(streams.stderr, selection);
    await run(selection.fallbackModel);
  }

  if (!wroteText) {
    throw new Error('Gemini returned an empty answer. Try the request again.');
  }
  streams.stdout.write('\n');
}

function selectModels(
  environment: NodeJS.ProcessEnv,
  modelOverride?: string,
): ModelSelection {
  const apiKey = environment.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'The Gemini key is empty. Add GOOGLE_GENERATIVE_AI_API_KEY to .env, then run npm run doctor.',
    );
  }
  const primaryModel =
    modelOverride ?? environment.GEMINI_MODEL?.trim() ?? DEFAULT_GEMINI_MODEL;
  const fallbackModel = modelOverride
    ? modelOverride
    : (environment.GEMINI_FALLBACK_MODEL?.trim() ??
      DEFAULT_GEMINI_FALLBACK_MODEL);
  return { apiKey, primaryModel, fallbackModel };
}

async function readPrompt(stdin: CliInput): Promise<string> {
  if (stdin.isTTY === true) {
    return '';
  }

  const chunks: Buffer[] = [];
  let byteCount = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteCount += buffer.byteLength;
    if (byteCount > MAX_STDIN_BYTES) {
      throw new CliUsageError('The question from standard input exceeds 128 KiB.');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function writeFallbackNotice(
  stderr: CliOutput,
  selection: ModelSelection,
): void {
  stderr.write(
    `${selection.primaryModel} has no available capacity. Retrying with ${selection.fallbackModel}.\n`,
  );
}

function describeTool(toolName: string): string {
  const descriptions: Record<string, string> = {
    analyzeLeague: 'Analyzing the league',
    findPlayers: 'Finding Sleeper players',
    getLeagueMatchups: 'Reading league matchups',
    getLeagueOverview: 'Reading the league',
    getLeagueTransactions: 'Reading league transactions',
    getNflState: 'Reading the current NFL state',
    getRosterPlayers: 'Reading roster players',
    getTrendingPlayers: 'Reading player trends',
    getUserLeagues: 'Reading the user leagues',
    predictMatchup: 'Estimating the matchup',
  };
  return descriptions[toolName] ?? `Running ${toolName}`;
}

export function loadLocalEnvironment(): void {
  try {
    loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  return (
    entryPath !== undefined &&
    pathToFileURL(resolve(entryPath)).href === import.meta.url
  );
}

function installBrokenPipeExit(stream: NodeJS.WriteStream): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') {
      process.exit(0);
    }
  });
}

export async function launchCli(
  arguments_: readonly string[] = process.argv.slice(2),
): Promise<void> {
  installBrokenPipeExit(process.stdout);
  installBrokenPipeExit(process.stderr);
  try {
    loadLocalEnvironment();
    process.exitCode = await runCli(arguments_);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const prefix = error instanceof CliUsageError ? 'Seb' : 'Seb failed';
    process.stderr.write(`${prefix}: ${message}\n`);
    if (error instanceof CliUsageError) {
      process.stderr.write(
        'Run seb --help or npm run seb -- --help for usage.\n',
      );
    }
    process.exitCode = error instanceof CliUsageError ? 2 : 1;
  }
}

if (isMainModule()) {
  void launchCli();
}
