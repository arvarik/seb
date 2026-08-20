import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';

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
import { formatDoctorReport, runDoctor, verifyGeminiApi } from './doctor.js';
import { getSharedSebDatabase } from './data/sqlite-store.js';
import {
  formatReplaySummary,
  runNflverseBaselineReplay,
  saveReplayReport,
} from './evaluation/nflverse-runner.js';
import { serializeReplayReport } from './evaluation/serialization.js';
import { generateShellCompletion } from './interactive/commands.js';
import { SebInteractiveTransport } from './interactive/transport.js';
import { runSebInteractiveTui } from './interactive/tui.js';
import {
  createSessionState,
  formatSessionContext,
  recordUsage,
} from './interactive/session.js';
import { isModelCapacityError } from './model-capacity-error.js';
import { NflverseClient } from './nflverse/client.js';
import { SleeperClient } from './sleeper/client.js';
import { SourceTracker, type DataSourceRecord } from './sources.js';
import { WeatherClient } from './weather/client.js';
import {
  FileSetupProfileStore,
  formatSetupProfile,
} from './setup/profile.js';
import { applySetupProfile, runFirstRunSetup } from './setup/wizard.js';

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
  nwsUserAgent: string | undefined;
  primaryModel: string;
}

interface AnswerResult {
  answer: string;
  fallbackUsed: boolean;
  finishReason: string;
  model: string;
  sources: DataSourceRecord[];
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
    case 'completion':
      streams.stdout.write(`${generateShellCompletion(command.shell)}\n`);
      return 0;
    case 'cache': {
      const database = getSharedSebDatabase();
      if (command.action === 'clear') {
        const removed = ['sleeper', 'nflverse', 'weather']
          .reduce((total, namespace) => total + database.deleteCache(namespace), 0);
        const result = { removed, snapshotsPreserved: database.status().snapshots };
        streams.stdout.write(command.json
          ? `${JSON.stringify(result)}\n`
          : `Seb removed ${removed} cache entries. It preserved ${result.snapshotsPreserved} snapshots.\n`);
      } else {
        const status = database.status();
        streams.stdout.write(command.json
          ? `${JSON.stringify(status)}\n`
          : formatCacheStatus(status));
      }
      return 0;
    }
    case 'snapshots': {
      const database = getSharedSebDatabase();
      if (command.id) {
        const snapshot = database.getSnapshot(command.id);
        if (!snapshot) {
          throw new CliUsageError(`Seb found no snapshot with ID ${command.id}.`);
        }
        const { payload: _payload, ...inspectable } = snapshot;
        streams.stdout.write(command.json
          ? `${JSON.stringify(inspectable)}\n`
          : formatSnapshotProvenance(inspectable));
        return 0;
      }
      const snapshots = database.listSnapshots({
        limit: command.limit,
        ...(command.kind ? { kind: command.kind } : {}),
        ...(command.entityKey ? { entityKey: command.entityKey } : {}),
      }).map(({ payload: _payload, provenance: _provenance, ...snapshot }) => snapshot);
      streams.stdout.write(command.json
        ? `${JSON.stringify(snapshots)}\n`
        : formatSnapshots(snapshots));
      return 0;
    }
    case 'replay': {
      const report = await runNflverseBaselineReplay({
        client: new NflverseClient(),
        season: command.season,
        throughWeek: command.throughWeek,
        ...(command.positions ? { positions: command.positions } : {}),
      });
      const saved = command.output
        ? await saveReplayReport(report, command.output)
        : null;
      streams.stdout.write(command.json
        ? serializeReplayReport(report, 0)
        : `${formatReplaySummary(report)}${saved ? `Saved report: ${saved}\n` : ''}`);
      return 0;
    }
    case 'setup':
      await runSetupCommand(streams, environment);
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

function formatSnapshotProvenance(snapshot: {
  asOf: string;
  entityKey: string;
  id: string;
  kind: string;
  provenance: unknown;
}): string {
  const record = snapshot.provenance && typeof snapshot.provenance === 'object'
    ? snapshot.provenance as Record<string, unknown>
    : {};
  const fields = record.fields && typeof record.fields === 'object'
    ? Object.keys(record.fields as Record<string, unknown>)
    : [];
  const freshness = record.freshness && typeof record.freshness === 'object'
    ? String((record.freshness as Record<string, unknown>).state ?? 'unknown')
    : 'unknown';
  return [
    `Snapshot: ${snapshot.id}`,
    `Kind: ${snapshot.kind}`,
    `Entity: ${snapshot.entityKey}`,
    `As of: ${snapshot.asOf}`,
    `Freshness: ${freshness}`,
    `Tracked field paths: ${fields.length}`,
    ...fields.slice(0, 20).map((field) => `  ${field || '<root>'}`),
    ...(fields.length > 20 ? [`  and ${fields.length - 20} more`] : []),
    '',
  ].join('\n');
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
  const sources = new SourceTracker();
  const clients = createDataClients(selection.nwsUserAgent, sources);
  const profileStore = new FileSetupProfileStore({ environment });
  let profile = await profileStore.load();
  if (!profile) {
    streams.stdout.write('Seb found no local profile. Creating a team-independent profile.\n');
    profile = await runSetupWizard(environment, clients.sleeperClient, profileStore);
  }
  const session = createSessionState();
  applySetupProfile(profile, session);
  const agent = createFantasyFootballAgent({
    apiKey: selection.apiKey,
    model: selection.primaryModel,
    ...clients,
    getRuntimeInstructions: () => formatSessionContext(session),
    onUsage: (usage) => recordUsage(session, usage),
  });
  await runSebInteractiveTui({
    transport: new SebInteractiveTransport({
      agent,
      environment,
      model: selection.primaryModel,
      nflverse: clients.nflverseClient,
      session,
      sleeper: clients.sleeperClient,
      sources,
      version: packageJson.version,
      weather: clients.weatherClient,
      profileStore,
    }),
    title: `Seb · ${selection.primaryModel}`,
    session,
    input: streams.stdin as NodeJS.ReadStream,
    output: streams.stdout as NodeJS.WriteStream,
  });
}

async function runSetupCommand(
  streams: CliStreams,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const store = new FileSetupProfileStore({ environment });
  const sleeper = new SleeperClient();
  const profile = await runSetupWizard(environment, sleeper, store);
  streams.stdout.write(`Seb saved the team-independent profile.\n\n${formatSetupProfile(profile, store.path)}\n`);
}

async function runSetupWizard(
  environment: NodeJS.ProcessEnv,
  sleeper: SleeperClient,
  store: FileSetupProfileStore,
) {
  const primaryModel = environment.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const fallbackModel = environment.GEMINI_FALLBACK_MODEL?.trim() ||
    DEFAULT_GEMINI_FALLBACK_MODEL;
  return runFirstRunSetup({
    environment,
    sleeper,
    store,
    verifyApiKey: async (apiKey) => {
      await verifyGeminiApi(apiKey, primaryModel, fallbackModel);
    },
  });
}

function formatCacheStatus(status: {
  cacheEntries: number;
  file: string;
  identities: number;
  identityLinks: number;
  schemaVersion: number;
  snapshots: number;
}): string {
  return [
    `Database: ${status.file}`,
    `Schema: ${status.schemaVersion}`,
    `Cache entries: ${status.cacheEntries}`,
    `Snapshots: ${status.snapshots}`,
    `Canonical identities: ${status.identities}`,
    `Identity source links: ${status.identityLinks}`,
    '',
  ].join('\n');
}

function formatSnapshots(
  snapshots: readonly {
    asOf: string;
    entityKey: string;
    id: string;
    kind: string;
    sourceTimestamp: string | null;
  }[],
): string {
  if (snapshots.length === 0) {
    return 'Seb found no matching snapshots.\n';
  }
  return `${snapshots.map((snapshot) =>
    `${snapshot.asOf}  ${snapshot.kind}  ${snapshot.entityKey}  ${snapshot.id}`,
  ).join('\n')}\n`;
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
  const sources = new SourceTracker();
  const clients = createDataClients(selection.nwsUserAgent, sources);
  const agent = createFantasyFootballAgent({
    apiKey: selection.apiKey,
    model,
    ...clients,
  });
  const result = await agent.generate({ prompt });
  return {
    answer: result.text,
    fallbackUsed,
    finishReason: result.finishReason,
    model,
    sources: sources.list(),
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
    const clients = createDataClients(
      selection.nwsUserAgent,
      new SourceTracker(),
    );
    const agent = createFantasyFootballAgent({
      apiKey: selection.apiKey,
      model,
      ...clients,
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
  return {
    apiKey,
    primaryModel,
    fallbackModel,
    nwsUserAgent: environment.NWS_USER_AGENT?.trim() || undefined,
  };
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
    getNflSchedule: 'Reading the nflverse schedule',
    getPlayerWeeklyStats: 'Reading nflverse weekly statistics',
    comparePlayerTrends: 'Comparing player usage trends',
    getTeamPerformance: 'Analyzing NFL team performance',
    getDefenseVsPosition: 'Measuring defense by position',
    getStadiumForecast: 'Reading the stadium forecast',
    getGameWeather: 'Assessing kickoff weather',
    getWeekWeather: 'Screening weekly weather risk',
    getGameEnvironment: 'Analyzing the game environment',
    getRosterPlayers: 'Reading roster players',
    getTrendingPlayers: 'Reading player trends',
    getUserLeagues: 'Reading the user leagues',
    predictMatchup: 'Estimating the matchup',
  };
  return descriptions[toolName] ?? `Running ${toolName}`;
}

function createDataClients(
  nwsUserAgent: string | undefined,
  sources: SourceTracker,
): {
  nflverseClient: NflverseClient;
  sleeperClient: SleeperClient;
  weatherClient: WeatherClient;
} {
  return {
    nflverseClient: new NflverseClient({ onSource: sources.record }),
    sleeperClient: new SleeperClient({ onSource: sources.record }),
    weatherClient: new WeatherClient({
      onSource: sources.record,
      ...(nwsUserAgent ? { userAgent: nwsUserAgent } : {}),
    }),
  };
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
