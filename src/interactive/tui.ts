import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ChatTransport, UIMessage } from 'ai';

import { SourceTracker } from '../sources.js';
import { FilePromptHistory, type PromptHistory } from './history.js';
import {
  SebTerminalRenderer,
  type SebTerminalInput,
  type SebTerminalOutput,
} from './renderer.js';
import type { SessionState } from './session.js';
import { InteractiveUiState } from './ui-state.js';

const SUPPORTED_TUI_VERSION = '1.0.72';

interface InternalAgentTUIRunner {
  run(): Promise<void>;
}

type InternalAgentTUIRunnerConstructor = new (options: {
  reasoning: 'collapsed';
  renderer: SebTerminalRenderer;
  responseStatistics: 'outputTokensPerSecond';
  screen: SebTerminalOutput;
  title: string;
  tools: 'auto-collapsed';
  transport: ChatTransport<UIMessage>;
  userInput: SebTerminalInput;
}) => InternalAgentTUIRunner;

export interface SebInteractiveTuiOptions {
  environment?: NodeJS.ProcessEnv;
  history?: PromptHistory;
  input?: SebTerminalInput;
  model?: string;
  output?: SebTerminalOutput;
  session: SessionState;
  sources?: SourceTracker;
  title: string;
  transport: ChatTransport<UIMessage>;
  uiState?: InteractiveUiState;
  version?: string;
}

export async function runSebInteractiveTui(
  options: SebInteractiveTuiOptions,
): Promise<void> {
  const environment = options.environment ?? process.env;
  const history = options.history ?? await FilePromptHistory.load(environment);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const sources = options.sources ?? new SourceTracker();
  const uiState = options.uiState ?? new InteractiveUiState();
  const renderer = new SebTerminalRenderer({
    environment,
    history,
    input,
    model: options.model ?? options.title.replace(/^Seb · /u, ''),
    output,
    session: options.session,
    sources,
    uiState,
    version: options.version ?? 'development',
  });
  const AgentTUIRunner = await loadAgentTUIRunner();
  await new AgentTUIRunner({
    reasoning: 'collapsed',
    renderer,
    responseStatistics: 'outputTokensPerSecond',
    screen: output,
    title: options.title,
    tools: 'auto-collapsed',
    transport: options.transport,
    userInput: input,
  }).run();
}

async function loadAgentTUIRunner(): Promise<InternalAgentTUIRunnerConstructor> {
  const require = createRequire(import.meta.url);
  const packageFile = require.resolve('@ai-sdk/tui/package.json');
  const packageData = require(packageFile) as { version?: string };
  if (packageData.version !== SUPPORTED_TUI_VERSION) {
    throw new Error(
      `Seb supports @ai-sdk/tui ${SUPPORTED_TUI_VERSION}, but version ${packageData.version ?? 'unknown'} is installed.`,
    );
  }
  // The public TUI runner has no renderer hook. The exact dependency pin
  // protects this small runner adapter. Seb owns all terminal rendering.
  const runnerFile = resolve(dirname(packageFile), 'src/agent-tui-runner.ts');
  const module = await import(pathToFileURL(runnerFile).href) as {
    AgentTUIRunner?: InternalAgentTUIRunnerConstructor;
  };
  if (!module.AgentTUIRunner) {
    throw new Error('The installed AI SDK TUI does not expose its internal runner source.');
  }
  return module.AgentTUIRunner;
}
