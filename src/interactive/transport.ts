import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  createUIMessageStream,
  DirectChatTransport,
  getToolName,
  isToolUIPart,
  type ChatTransport,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';

import type { createFantasyFootballAgent } from '../agent.js';
import {
  runWithRequestSignal,
  throwIfRequestAborted,
} from '../ai/request-signal.js';
import {
  buildFreeformRecommendationEvidence,
  enforceFreeformRecommendation,
  questionRequestsRecommendation,
  recommendationContextQuestion,
  type RecommendationToolResult,
} from '../analysis/recommendation-eligibility.js';
import {
  getSharedSebDatabase,
  type SebDatabase,
} from '../data/sqlite-store.js';
import {
  formatDoctorReport,
  runDoctor,
  type DoctorReport,
  type GeminiVerificationTelemetryOptions,
} from '../doctor.js';
import { formatModelErrorForUser } from '../model-capacity-error.js';
import {
  formatReplaySummary,
  runNflverseBaselineReplay,
} from '../evaluation/nflverse-runner.js';
import { TeamIdentityRegistry } from '../identity/teams.js';
import { NflverseClient } from '../nflverse/client.js';
import { SleeperClient } from '../sleeper/client.js';
import {
  formatEvidenceMarkdown,
  normalizeWebUrl,
  sourceRetrievalDetail,
  SourceTracker,
  type DataSourceRecord,
} from '../sources.js';
import { WeatherClient } from '../weather/client.js';
import {
  analyzeUsage,
  formatStatsReport,
  formatUsageReport,
  usageQuery,
  usageWindow,
  type UsageScope,
} from '../usage/analytics.js';
import type { SebUsageTelemetry } from '../usage/telemetry.js';
import {
  FileSetupProfileStore,
  formatSetupProfile,
  type SetupProfileStore,
} from '../setup/profile.js';
import {
  applySetupProfile,
  connectSleeperSession,
  createSetupProfile,
  disconnectSleeperSession,
  focusSessionLeague,
  refreshAutomaticSession,
  resolveCurrentNflWeek,
} from '../setup/wizard.js';
import {
  completeInteractiveInput,
  findInteractiveCommand,
  formatCommandCatalog,
  formatCompletions,
  generateShellCompletion,
  interactiveCommandArgumentError,
  interactiveCommandPrivacyError,
  MODEL_PROVIDER_VALUES,
  parseInteractiveCommandInput,
  type CompletionShell,
} from './commands.js';
import {
  formatFantasyDashboard,
  formatSessionStatus,
  getContextualSuggestions,
  normalizeSessionSeasonType,
  resolveUserConfirmedToolContext,
  resolveUserRequestedToolContext,
  type SessionState,
} from './session.js';
import { formatSkillList, parseSkillInvocation } from './skills.js';
import { sourceBadge } from './presentation.js';
import {
  InteractiveUiState,
  type InteractiveModelState,
} from './ui-state.js';

type SebAgent = ReturnType<typeof createFantasyFootballAgent>;

const VISIBLE_WEB_SOURCE_LIMIT = 3;
const INTERACTIVE_PROMPT_CHARACTER_LIMIT = 32_000;
const MODEL_CONTEXT_CHARACTER_LIMIT = 120_000;
const MODEL_MESSAGE_LIMIT = 24;
const TRACKED_MESSAGE_LIMIT = 96;

type RecommendationStreamToolState = {
  input: unknown;
  toolCallId: string;
  toolName: string;
} & (
  | { state: 'pending' }
  | { output: unknown; state: 'completed' }
);

export interface SebInteractiveTransportOptions {
  agent: SebAgent;
  doctor?: (offline: boolean) => Promise<DoctorReport>;
  environment: NodeJS.ProcessEnv;
  model: string;
  provider?: string;
  providerLabel?: string;
  nflverse: NflverseClient;
  session: SessionState;
  sleeper: SleeperClient;
  sources: SourceTracker;
  profileStore?: SetupProfileStore;
  version: string;
  weather: WeatherClient;
  uiState?: InteractiveUiState;
  usageDatabase?: Pick<SebDatabase, 'readUsageDataset'>;
  usageNow?: () => Date;
  usageSessionId?: string;
  usageTelemetry?: Pick<SebUsageTelemetry, 'abortUnfinished' | 'closeUnfinished'>;
  usageTelemetryDatabase?: GeminiVerificationTelemetryOptions['database'];
  switchModel?: InteractiveModelSwitcher;
}

export interface InteractiveModelSwitchRequest {
  model?: string;
  provider?: string;
}

export interface InteractiveModelSwitchResult extends InteractiveModelState {
  agent: SebAgent;
  onActivated?: () => void;
}

export type InteractiveModelSwitcher = (
  request: InteractiveModelSwitchRequest,
) => Promise<InteractiveModelSwitchResult>;

function cloneSessionState(state: SessionState): SessionState {
  return {
    ...state,
    leagues: [...state.leagues],
    leagueOptions: [...state.leagueOptions],
    rosterOptions: [...state.rosterOptions],
    usage: state.usage,
  };
}

export class SebInteractiveTransport implements ChatTransport<UIMessage> {
  private readonly localOnlyMessageIds = new Set<string>();
  private delegate: ChatTransport<UIMessage>;
  private readonly options: SebInteractiveTransportOptions;
  private readonly profileStore: SetupProfileStore;
  private readonly skillPromptByMessageId = new Map<string, string>();
  private readonly uiState: InteractiveUiState;

  constructor(options: SebInteractiveTransportOptions) {
    this.options = options;
    this.uiState = options.uiState ?? new InteractiveUiState();
    if (!this.uiState.activeModel) {
      this.uiState.setActiveModel({
        model: options.model,
        provider: options.provider ?? 'configured',
        providerLabel: options.providerLabel ?? options.provider ?? 'Configured provider',
      });
    }
    this.profileStore = options.profileStore ?? new FileSetupProfileStore({
      environment: options.environment,
    });
    this.delegate = this.createDelegate(options.agent);
  }

  private createDelegate(agent: SebAgent): ChatTransport<UIMessage> {
    return new DirectChatTransport({
      agent,
      onError: (error) => formatModelErrorForUser(
        error,
        'interactive',
        {
          providerLabel: this.uiState.activeModel?.providerLabel ??
            'The model provider',
        },
      ),
      sendSources: true,
    }) as unknown as ChatTransport<UIMessage>;
  }

  async sendMessages(
    options: Parameters<ChatTransport<UIMessage>['sendMessages']>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    const usageTelemetry = this.options.usageTelemetry;
    if (usageTelemetry && options.abortSignal) {
      const abortUsage = () => {
        usageTelemetry.abortUnfinished(options.abortSignal?.reason);
      };
      if (options.abortSignal.aborted) abortUsage();
      else options.abortSignal.addEventListener('abort', abortUsage, { once: true });
    }
    const lastMessage = options.messages.at(-1);
    const rawText = lastMessage?.role === 'user' ? messageText(lastMessage) : '';
    if (rawText.length > INTERACTIVE_PROMPT_CHARACTER_LIMIT) {
      if (lastMessage) this.markLocalOnlyMessage(lastMessage.id);
      return localTextStream(
        `Input error: The prompt exceeds ${INTERACTIVE_PROMPT_CHARACTER_LIMIT.toLocaleString('en-US')} characters. Shorten it, then retry.`,
      );
    }
    const approvalContinuation = lastMessage?.role === 'assistant' &&
      hasRespondedApproval(lastMessage);
    const latestUser = latestUserMessage(options.messages);
    if (
      approvalContinuation &&
      estimateMessages(currentConversationTurn(options.messages)) >
        MODEL_CONTEXT_CHARACTER_LIMIT
    ) {
      if (latestUser) this.markLocalOnlyMessage(latestUser.id);
      if (lastMessage) this.markLocalOnlyMessage(lastMessage.id);
      return localTextStream(
        'Context error: The approval turn is too large to continue safely. Start a shorter request.',
      );
    }
    const text = lastMessage?.role === 'user'
      ? rawText.trim()
      : approvalContinuation && latestUser
      ? this.skillPromptByMessageId.get(latestUser.id) ??
        messageText(latestUser).trim()
      : '';
    const parsed = parseInteractiveCommandInput(text);
    if (lastMessage?.role === 'user' && parsed?.command?.name === 'skill') {
      const invocation = parseSkillInvocation(parsed.argumentText);
      if (invocation?.prompt) {
        this.options.sources.clear();
        this.options.session.skillId = invocation.skill.id;
        this.uiState.latestPrompt = invocation.prompt;
        this.uiState.recordCommand('skill');
        this.skillPromptByMessageId.set(lastMessage.id, invocation.prompt);
        const stream = await this.delegate.sendMessages({
          ...options,
          messages: this.modelMessages(options.messages),
        });
        return decorateResponseStream(
          stream,
          this.options.session,
          this.options.sources,
          this.uiState,
          invocation.prompt,
          recommendationContextQuestion(
            invocation.prompt,
            previousUserPrompt(options.messages),
          ),
          (error) => usageTelemetry?.closeUnfinished(error),
          (reason) => usageTelemetry?.abortUnfinished(reason),
        );
      }
    }
    const selectedMode = parsed?.command ? experienceModeForCommand(parsed.command.name) : null;
    if (lastMessage?.role === 'user' && selectedMode && parsed?.argumentText) {
      this.options.sources.clear();
      this.options.session.mode = selectedMode;
      this.options.session.skillId = 'general';
      this.uiState.latestPrompt = parsed.argumentText;
      this.uiState.recordCommand(parsed.command?.name ?? selectedMode);
      this.skillPromptByMessageId.set(lastMessage.id, parsed.argumentText);
      const stream = await this.delegate.sendMessages({
        ...options,
        messages: this.modelMessages(options.messages),
      });
      return decorateResponseStream(
        stream,
        this.options.session,
        this.options.sources,
        this.uiState,
        parsed.argumentText,
        recommendationContextQuestion(
          parsed.argumentText,
          previousUserPrompt(options.messages),
        ),
        (error) => usageTelemetry?.closeUnfinished(error),
        (reason) => usageTelemetry?.abortUnfinished(reason),
      );
    }
    if (lastMessage?.role === 'user' && parsed) {
      this.markLocalOnlyMessage(lastMessage.id);
      let response: string;
      try {
        response = await runWithRequestSignal(
          options.abortSignal,
          () => this.runCommand(text, options.messages, lastMessage.id),
        );
      } catch (error) {
        response = `Command error: ${errorMessage(error)}`;
      }
      return localTextStream(recordSuggestions(response, this.options.session, this.uiState));
    }

    if (!approvalContinuation) this.options.sources.clear();
    const stream = await this.delegate.sendMessages({
      ...options,
      messages: this.modelMessages(options.messages),
    });
    return decorateResponseStream(
      stream,
      this.options.session,
      this.options.sources,
      this.uiState,
      text,
      recommendationContextQuestion(text, previousUserPrompt(options.messages)),
      (error) => usageTelemetry?.closeUnfinished(error),
      (reason) => usageTelemetry?.abortUnfinished(reason),
      approvalContinuation
        ? recommendationToolState(options.messages)
        : [],
    );
  }

  reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return Promise.resolve(null);
  }

  private markLocalOnlyMessage(messageId: string): void {
    this.localOnlyMessageIds.delete(messageId);
    this.localOnlyMessageIds.add(messageId);
    while (this.localOnlyMessageIds.size > TRACKED_MESSAGE_LIMIT) {
      const oldestMessageId = this.localOnlyMessageIds.keys().next().value;
      if (typeof oldestMessageId !== 'string') break;
      this.localOnlyMessageIds.delete(oldestMessageId);
    }
  }

  private modelMessages(messages: UIMessage[]): UIMessage[] {
    const marker = this.options.session.contextAfterMessageId;
    const markerIndex = marker
      ? messages.findIndex((message) => message.id === marker)
      : -1;
    const active = markerIndex >= 0 ? messages.slice(markerIndex) : messages;
    const filtered: UIMessage[] = [];
    let skipNextAssistant = false;
    for (const message of active) {
      if (this.localOnlyMessageIds.has(message.id)) {
        skipNextAssistant = true;
        continue;
      }
      if (skipNextAssistant && message.role === 'assistant') {
        skipNextAssistant = false;
        continue;
      }
      skipNextAssistant = false;
      const skillPrompt = this.skillPromptByMessageId.get(message.id);
      const modelMessage = skillPrompt ? replaceMessageText(message, skillPrompt) : message;
      if (modelMessage.parts.length > 0) filtered.push(modelMessage);
    }
    const retainedIds = new Set(
      messages.slice(-TRACKED_MESSAGE_LIMIT).map((message) => message.id),
    );
    for (const messageId of this.localOnlyMessageIds) {
      if (!retainedIds.has(messageId)) this.localOnlyMessageIds.delete(messageId);
    }
    for (const messageId of this.skillPromptByMessageId.keys()) {
      if (!retainedIds.has(messageId)) this.skillPromptByMessageId.delete(messageId);
    }
    const countBounded = filtered.slice(-MODEL_MESSAGE_LIMIT);
    const firstUserIndex = countBounded.findIndex(
      (message) => message.role === 'user',
    );
    const normalized = firstUserIndex < 0
      ? []
      : countBounded.slice(firstUserIndex);
    const turns: UIMessage[][] = [];
    for (const message of normalized) {
      if (message.role === 'user' || turns.length === 0) turns.push([message]);
      else turns.at(-1)?.push(message);
    }
    const selected: UIMessage[][] = [];
    let remaining = MODEL_CONTEXT_CHARACTER_LIMIT;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index] ?? [];
      const size = estimateMessages(turn, remaining + 1);
      if (size > remaining) break;
      selected.unshift(turn);
      remaining -= size;
    }
    return selected.flat();
  }

  private async runCommand(
    input: string,
    messages: UIMessage[],
    messageId: string,
  ): Promise<string> {
    const parsed = parseInteractiveCommandInput(input);
    if (!parsed) {
      throw new Error('Add a command after the slash. Run /help.');
    }
    const privacyError = interactiveCommandPrivacyError(parsed);
    if (privacyError) {
      throw new Error(privacyError);
    }
    const argumentError = interactiveCommandArgumentError(parsed);
    if (argumentError) {
      throw new Error(argumentError);
    }
    const arguments_ = parsed.arguments;
    const name = parsed.command?.name ?? parsed.name;
    const state = this.options.session;
    if (name) {
      this.uiState.recordCommand(findInteractiveCommand(name)?.name ?? name);
    }

    switch (name) {
      case 'explore':
      case 'analyze':
      case 'fantasy': {
        const mode = experienceModeForCommand(name);
        if (!mode) throw new Error('Seb could not select that experience.');
        state.mode = mode;
        state.skillId = 'general';
        return mode === 'fantasy'
          ? formatFantasyDashboard(state)
          : `Seb is ready to ${mode}. Ask a question in plain language.`;
      }
      case 'connect': {
        const username = arguments_[0];
        if (!username) throw new Error('Use /connect <Sleeper username>.');
        const staged = cloneSessionState(state);
        await refreshAutomaticSession(this.options.sleeper, staged, username);
        throwIfRequestAborted();
        const profile = createSetupProfile(staged.user);
        await this.profileStore.save(profile);
        Object.assign(state, staged);
        return `${formatFantasyDashboard(state)}\n\nSeb saved this username for future sessions.`;
      }
      case 'disconnect': {
        await this.profileStore.save(createSetupProfile());
        disconnectSleeperSession(state);
        return 'Seb disconnected the Sleeper account. Explore and Analyze remain available.';
      }
      case 'account':
        state.mode = 'fantasy';
        return formatFantasyDashboard(state);
      case 'help':
      case '?':
        return INTERACTIVE_HELP;
      case 'shortcuts':
        return SHORTCUT_HELP;
      case 'commands':
        return formatCommandCatalog(arguments_.join(' '));
      case 'complete':
        return formatCompletions(
          completeInteractiveInput(arguments_.join(' '), state),
        );
      case 'context':
      case 'status':
        return formatSessionStatus(state);
      case 'skills':
        return `## Skills\n\n${formatSkillList()}`;
      case 'skill': {
        const value = parsed.argumentText;
        if (!value || value.toLowerCase() === 'list') {
          return `## Skills\n\n${formatSkillList()}`;
        }
        const invocation = parseSkillInvocation(value);
        if (!invocation || invocation.prompt) {
          throw new Error(`Unknown skill: ${value}. Run /skills.`);
        }
        const skill = invocation.skill;
        state.skillId = skill.id;
        return `The active skill is now \`${skill.id}\`. ${skill.description}`;
      }
      case 'retry':
        return 'The Seb terminal runs `/retry` immediately. Use the latest prompt again in connectors.';
      case 'edit':
        return 'The Seb terminal places the latest model prompt in the editor.';
      case 'season': {
        const value = arguments_[0];
        const nfl = value?.toLowerCase() === 'current'
          ? await this.options.sleeper.getNflState()
          : null;
        const season = nfl?.season ?? value;
        state.season = validInteger(season, 1999, 2100, 'season');
        if (nfl) {
          state.leagueSeason = validInteger(
            nfl.league_season ?? nfl.season,
            1999,
            2100,
            'league season',
          );
        }
        state.seasonType = nfl
          ? normalizeSessionSeasonType(nfl.season_type)
          : null;
        return `The active NFL season is now ${state.season}.`;
      }
      case 'week': {
        const value = arguments_[0];
        const keyword = value?.toLowerCase();
        if (keyword === 'clear') {
          state.week = null;
          return 'The active NFL week is now unset.';
        }
        if (keyword === 'current') {
          const nfl = await this.options.sleeper.getNflState();
          state.season = validInteger(nfl.season, 1999, 2100, 'season');
          state.leagueSeason = validInteger(
            nfl.league_season ?? nfl.season,
            1999,
            2100,
            'league season',
          );
          state.seasonType = normalizeSessionSeasonType(nfl.season_type);
          state.week = resolveCurrentNflWeek(nfl);
        } else {
          state.seasonType = null;
          state.week = validInteger(value, 1, 22, 'week');
        }
        return `The active NFL week is now ${state.week ?? 'unset'}.`;
      }
      case 'leagues': {
        const username = arguments_[0] || state.user;
        if (!username) {
          throw new Error('Use /connect <Sleeper username>.');
        }
        const staged = cloneSessionState(state);
        if (arguments_[1]) {
          staged.leagueSeason = validInteger(
            arguments_[1],
            1999,
            2100,
            'league season',
          );
        }
        await connectSleeperSession(this.options.sleeper, staged, username);
        throwIfRequestAborted();
        await this.profileStore.save(createSetupProfile(staged.user));
        Object.assign(state, staged);
        return formatFantasyDashboard(state);
      }
      case 'rosters': {
        const leagueId = optionalIdentifier(
          arguments_[0] ?? state.leagueId ?? undefined,
          /^\d+$/,
          'Sleeper league ID',
        );
        if (!leagueId) {
          throw new Error('Use /rosters <Sleeper league ID> or set /league first.');
        }
        const staged = cloneSessionState(state);
        const rosters = await this.options.sleeper.getLeagueRosters(leagueId);
        throwIfRequestAborted();
        staged.mode = 'fantasy';
        staged.leagueId = leagueId;
        staged.rosterOptions = rosters.map((roster) => roster.roster_id);
        if (
          staged.rosterId !== null &&
          !staged.rosterOptions.includes(staged.rosterId)
        ) {
          staged.rosterId = null;
        }
        Object.assign(state, staged);
        if (rosters.length === 0) {
          return `Sleeper found no rosters in league ${leagueId}.`;
        }
        return [
          `## Sleeper rosters in ${leagueId}`,
          '',
          ...rosters.map((roster) =>
            `- Roster \`${roster.roster_id}\`: ${roster.players?.length ?? 0} players${roster.owner_id ? ` · owner \`${roster.owner_id}\`` : ''}`,
          ),
          '',
          'Select one with `/roster <roster ID>`.',
        ].join('\n');
      }
      case 'league': {
        state.mode = 'fantasy';
        const value = arguments_[0];
        if (!value) return formatFantasyDashboard(state);
        const leagueId = value?.toLowerCase() === 'clear' || value?.toLowerCase() === 'all'
          ? null
          : optionalIdentifier(value, /^\d+$/, 'Sleeper league ID');
        if (
          leagueId &&
          state.leagueOptions.length > 0 &&
          !state.leagueOptions.includes(leagueId)
        ) {
          throw new Error(`League ${leagueId} is not one of the discovered leagues.`);
        }
        focusSessionLeague(state, leagueId);
        const label = leagueId
          ? state.leagues.find((league) => league.leagueId === leagueId)?.name ?? leagueId
          : 'all discovered leagues';
        return `Seb will use ${label} as the fantasy focus.`;
      }
      case 'roster': {
        state.mode = 'fantasy';
        const value = arguments_[0];
        const rosterId = value?.toLowerCase() === 'clear'
          ? null
          : validInteger(value, 1, 1_000_000, 'roster ID');
        if (
          rosterId !== null &&
          state.rosterOptions.length > 0 &&
          !state.rosterOptions.includes(rosterId)
        ) {
          const leagueLabel = state.leagueId ? ` in league ${state.leagueId}` : '';
          throw new Error(
            `Roster ${rosterId} is not one of the discovered roster options${leagueLabel}.`,
          );
        }
        state.rosterId = rosterId;
        return `The active Sleeper roster ID is now ${state.rosterId ?? 'unset'}.`;
      }
      case 'user': {
        const username = arguments_[0];
        if (username?.toLowerCase() === 'clear') {
          const staged = cloneSessionState(state);
          disconnectSleeperSession(staged);
          await this.profileStore.save(createSetupProfile());
          Object.assign(state, staged);
          return 'Seb disconnected the Sleeper account.';
        }
        if (!username) throw new Error('Use /connect <Sleeper username>.');
        const staged = cloneSessionState(state);
        await refreshAutomaticSession(this.options.sleeper, staged, username);
        throwIfRequestAborted();
        await this.profileStore.save(createSetupProfile(staged.user));
        Object.assign(state, staged);
        return formatFantasyDashboard(state);
      }
      case 'team':
        state.mode = 'explore';
        state.team = resolveTeam(arguments_.join(' '));
        return `The active NFL team is now ${state.team ?? 'unset'}.`;
      case 'provider': {
        const provider = arguments_[0]?.toLowerCase();
        if (!provider) return this.formatModelStatus();
        if (!MODEL_PROVIDER_VALUES.includes(
          provider as (typeof MODEL_PROVIDER_VALUES)[number],
        )) {
          throw new Error(
            'Use /provider google, /provider anthropic, /provider openai, or /provider openai-compatible.',
          );
        }
        return this.switchActiveModel({ provider }, messageId);
      }
      case 'model': {
        const model = arguments_[0];
        return model
          ? this.switchActiveModel({
              model,
              ...(this.uiState.activeModel?.provider
                ? { provider: this.uiState.activeModel.provider }
                : {}),
            }, messageId)
          : this.formatModelStatus();
      }
      case 'setup':
        return this.runSetupCommand(arguments_);
      case 'profile':
        return this.runProfileCommand(arguments_[0]);
      case 'sources': {
        const evidence = this.uiState.latestEvidence();
        const sources = evidence?.sources ?? this.options.sources.list();
        if (sources.length === 0) {
          return 'The latest answer has no recorded evidence.';
        }
        return [
          evidence
            ? '## Evidence for the latest answer'
            : '## Sources not attached to a completed answer',
          '',
          ...(evidence ? [`Answer: \`${evidence.answerId}\` · captured ${evidence.capturedAt}`, ''] : []),
          ...sources.map(
            (source, index) => formatSourceRecord(source, index + 1),
          ),
        ].join('\n');
      }
      case 'source':
      case 'open': {
        const index = validInteger(arguments_[0], 1, 1_000, 'source number');
        const source = (this.uiState.latestEvidence()?.sources ?? this.options.sources.list())[index - 1];
        if (!source) throw new Error(`Seb found no source ${index}. Run /sources.`);
        return `Source ${index}: [${source.label}](${source.url}) · ${sourceBadge(source)} · ${sourceRetrievalDetail(source)}`;
      }
      case 'devtools': {
        const enabled = ['1', 'true'].includes(
          this.options.environment.SEB_DEVTOOLS?.trim().toLowerCase() ?? '',
        );
        return [
          '## AI SDK DevTools',
          '',
          `- Recording: ${enabled ? 'enabled' : 'disabled'}`,
          '- Viewer: `npm run devtools`',
          '- Local data: `.devtools/`',
          '- Production use: prohibited',
          '',
          enabled
            ? 'DevTools records prompts, model responses, and tool data in this local process.'
            : 'Set `SEB_DEVTOOLS=true`, then restart Seb to record local agent runs.',
        ].join('\n');
      }
      case 'cache': {
        const status = getSharedSebDatabase().status();
        return [
          '## Local data store',
          '',
          `- Database: \`${status.file}\``,
          `- Schema: ${status.schemaVersion}`,
          `- Database size: ${formatStorageBytes(status.fileBytes)}`,
          `- Cache entries: ${status.cacheEntries}`,
          `- Cache values: ${formatStorageBytes(status.cacheValueBytes)}`,
          `- Snapshots: ${status.snapshots}`,
          `- Snapshot payloads: ${formatStorageBytes(status.snapshotPayloadBytes)}`,
          `- Snapshot provenance: ${formatStorageBytes(status.snapshotProvenanceBytes)}`,
          `- Canonical identities: ${status.identities}`,
          `- Identity source links: ${status.identityLinks}`,
          `- Usage runs: ${status.usageRuns}`,
          `- Model calls: ${status.usageSteps}`,
          `- Tool calls: ${status.usageToolCalls}`,
        ].join('\n');
      }
      case 'snapshots': {
        const kind = arguments_[0];
        const snapshots = getSharedSebDatabase().listSnapshotMetadata({
          limit: 20,
          ...(kind ? { kind } : {}),
        });
        if (snapshots.length === 0) {
          return 'Seb found no matching snapshots.';
        }
        return [
          '## Recent snapshots',
          '',
          ...snapshots.map((snapshot) =>
            `- ${snapshot.asOf}: \`${snapshot.kind}\` · \`${snapshot.entityKey}\` · \`${snapshot.id}\``,
          ),
        ].join('\n');
      }
      case 'provenance': {
        const id = arguments_[0];
        if (!id) throw new Error('Use /provenance <snapshot ID>.');
        const snapshot = getSharedSebDatabase().getSnapshot(id);
        if (!snapshot) throw new Error(`Seb found no snapshot with ID ${id}.`);
        return formatProvenance(snapshot.provenance, snapshot.id);
      }
      case 'replay': {
        const season = arguments_[0]
          ? validInteger(arguments_[0], 1999, 2100, 'season')
          : state.season - 1;
        const throughWeek = arguments_[1]
          ? validInteger(arguments_[1], 2, 18, 'through week')
          : 18;
        const report = await runNflverseBaselineReplay({
          client: this.options.nflverse,
          season,
          throughWeek,
        });
        return `\`\`\`text\n${formatReplaySummary(report)}\`\`\``;
      }
      case 'refresh': {
        const target = arguments_[0]?.toLowerCase() ?? 'all';
        if (!['all', 'sleeper', 'nflverse', 'weather'].includes(target)) {
          throw new Error('Use /refresh all, /refresh sleeper, /refresh nflverse, or /refresh weather.');
        }
        await Promise.all([
          target === 'all' || target === 'sleeper'
            ? this.options.sleeper.clearCache()
            : Promise.resolve(),
          target === 'all' || target === 'nflverse'
            ? this.options.nflverse.clearCache()
            : Promise.resolve(),
          target === 'all' || target === 'weather'
            ? this.options.weather.clearCache()
            : Promise.resolve(),
        ]);
        this.options.sources.clear();
        return `Seb cleared the ${target} cache. The next request downloads fresh data.`;
      }
      case 'new':
      case 'clear':
        state.contextAfterMessageId = messageId;
        state.mode = 'explore';
        state.player = null;
        state.skillId = 'general';
        state.team = null;
        this.options.sources.clear();
        this.uiState.clearAnswerEvidence();
        this.uiState.showSuggestions = true;
        return 'Seb started a new Explore context. It kept the automatic NFL state and Sleeper account.';
      case 'history':
        return arguments_[0]?.toLowerCase() === 'clear'
          ? 'Run `/history clear` in the Seb terminal to delete its private prompt history.'
          : 'Run `/history` in the Seb terminal to view its private prompt history.';
      case 'copy':
        return 'Run `/copy` in the Seb terminal to copy the latest answer with OSC 52.';
      case 'select':
        return 'Run `/select` in the Seb terminal to select and copy visible text with the terminal clipboard.';
      case 'theme':
        return 'Use `/theme default`, `/theme high-contrast`, or `/theme compact` in the Seb terminal.';
      case 'icons':
        return 'Use `/icons unicode` or `/icons ascii` in the Seb terminal.';
      case 'save':
      case 'export': {
        const saved = await saveTranscript(messages, arguments_[0], arguments_[1]);
        return `Seb saved the transcript to \`${saved}\`.`;
      }
      case 'doctor': {
        const option = arguments_[0]?.toLowerCase();
        if (option && !['offline', '--offline'].includes(option)) {
          throw new Error('Use /doctor or /doctor offline.');
        }
        const offline = option !== undefined;
        const report = this.options.doctor
          ? await this.options.doctor(offline)
          : await runDoctor({
              environment: this.options.environment,
              geminiTelemetry: {
                agentKind: 'doctor',
                database: this.options.usageTelemetryDatabase ??
                  getSharedSebDatabase(),
                ...(this.options.usageSessionId === undefined
                  ? {}
                  : { sessionId: this.options.usageSessionId }),
                sessionUsage: state.usage,
                surface: 'interactive',
              },
              offline,
            });
        return `\`\`\`text\n${formatDoctorReport(report)}\n\`\`\``;
      }
      case 'usage':
      case 'cost':
      case 'stats': {
        const scope = parseUsageScope(arguments_[0], 'session');
        const window = usageWindow(
          scope,
          this.options.usageNow?.() ?? new Date(),
          this.options.usageSessionId ?? 'untracked-session',
        );
        const database = this.options.usageDatabase ?? getSharedSebDatabase();
        const report = analyzeUsage(
          database.readUsageDataset(usageQuery(window)),
          window,
        );
        const output = name === 'stats'
          ? formatStatsReport(report)
          : formatUsageReport(report);
        return state.usage.storageWarning
          ? `${output.trimEnd()}\n\nWarning: ${state.usage.storageWarning}`
          : output.trimEnd();
      }
      case 'next':
      case 'suggest':
      case 'suggestions':
        return ['## Suggested next actions', '', ...getContextualSuggestions(state).map((item) => `- ${item}`)].join('\n');
      case 'version':
        return this.formatVersion();
      case 'shell-completion':
      case 'completion': {
        const shell = arguments_[0]?.toLowerCase();
        if (!isCompletionShell(shell)) {
          throw new Error('Use /shell-completion bash, fish, or zsh.');
        }
        return [
          `## ${shell} completion`,
          '',
          'Copy this script into the completion file for your shell.',
          '',
          '```' + shell,
          generateShellCompletion(shell),
          '```',
        ].join('\n');
      }
      case 'exit':
      case 'quit':
      case 'q':
        if (arguments_.length > 0) {
          throw new Error('Use /exit without arguments.');
        }
        return 'Run `/exit` in the Seb terminal to close interactive mode.';
      case '':
        throw new Error('Add a command after the slash. Run /help.');
      default:
        throw new Error(unknownCommandMessage(name));
    }
  }

  private async runSetupCommand(arguments_: string[]): Promise<string> {
    if (arguments_.length > 1) throw new Error('Use /setup [Sleeper username].');
    const staged = cloneSessionState(this.options.session);
    if (arguments_[0]) {
      await refreshAutomaticSession(
        this.options.sleeper,
        staged,
        arguments_[0],
      );
      throwIfRequestAborted();
    }
    const profile = createSetupProfile(staged.user);
    await this.profileStore.save(profile);
    Object.assign(this.options.session, staged);
    return [
      'Seb saved the account preference.',
      '',
      formatSetupProfile(profile, this.profileStore.path),
    ].join('\n');
  }

  private formatModelStatus(): string {
    const active = this.uiState.activeModel;
    if (!active) {
      return [
        '## Active model',
        '',
        'Seb has no active model information.',
        '',
        'Run `seb configure` to add a provider, endpoint, model, or private API key.',
      ].join('\n');
    }
    return [
      '## Active model',
      '',
      `- Provider: ${active.providerLabel} (\`${active.provider}\`)`,
      `- Model: \`${active.model}\``,
      '',
      'Run `/provider NAME` to use another configured provider.',
      'Run `/model MODEL` to use another model from the active provider.',
      'Run `seb configure` to add an endpoint or private API key.',
      'Seb never accepts API keys in slash commands.',
    ].join('\n');
  }

  private formatVersion(): string {
    const active = this.uiState.activeModel;
    return active
      ? `Seb ${this.options.version} uses ${active.providerLabel} · ${active.model}.`
      : `Seb ${this.options.version} uses ${this.options.model}.`;
  }

  private async switchActiveModel(
    request: InteractiveModelSwitchRequest,
    messageId: string,
  ): Promise<string> {
    if (!this.options.switchModel) {
      throw new Error(
        'Interactive model switching is unavailable. Run `seb configure`, then restart Seb.',
      );
    }
    const switched = await this.options.switchModel(request);
    throwIfRequestAborted();
    const active = validateInteractiveModelSwitchResult(switched);
    const delegate = this.createDelegate(switched.agent);

    this.delegate = delegate;
    this.uiState.setActiveModel(active);
    this.options.session.contextAfterMessageId = messageId;
    this.options.sources.clear();
    this.uiState.clearAnswerEvidence();
    switched.onActivated?.();
    return [
      `Seb now uses ${active.providerLabel} · ${active.model}.`,
      'Seb started a fresh model context and kept the visible transcript.',
    ].join(' ');
  }

  private async runProfileCommand(action = 'show'): Promise<string> {
    const normalizedAction = action.toLowerCase();
    if (!['show', 'load', 'clear'].includes(normalizedAction)) {
      throw new Error('Use /profile show, /profile load, or /profile clear.');
    }
    if (normalizedAction === 'clear') {
      const removed = await this.profileStore.remove();
      return removed
        ? `Seb removed the local profile at \`${this.profileStore.path}\`.`
        : 'Seb found no local preferences file.';
    }
    const profile = await this.profileStore.load();
    if (!profile) {
      return 'Seb found no local preferences file. Run `/setup` to create one.';
    }
    if (normalizedAction === 'load') {
      const staged = cloneSessionState(this.options.session);
      applySetupProfile(profile, staged);
      if (profile.sleeper) {
        await refreshAutomaticSession(
          this.options.sleeper,
          staged,
          profile.sleeper.username,
        );
      }
      throwIfRequestAborted();
      Object.assign(this.options.session, staged);
      return `Seb loaded the profile.\n\n${formatSetupProfile(profile, this.profileStore.path)}`;
    }
    return formatSetupProfile(profile, this.profileStore.path);
  }
}

export const INTERACTIVE_HELP = `## Use Seb

Ask a player, team, statistic, schedule, or news question in plain language.

- \`/explore [QUESTION]\`: Find NFL information.
- \`/fantasy [QUESTION]\`: Use the connected Sleeper account.
- \`/analyze [QUESTION]\`: Compare choices and add decision context.
- \`/connect USERNAME\`: Save one optional Sleeper username.
- \`/provider [NAME]\`: Show or switch the configured model provider.
- \`/model [MODEL]\`: Show or switch the active model.

Run \`seb configure\` to add a provider endpoint or private API key.
Seb never accepts API keys in slash commands.

${formatCommandCatalog()}

Press Escape or Ctrl+C to exit.`;

export const SHORTCUT_HELP = `## Keyboard shortcuts

- \`Ctrl+K\`: Open the command palette.
- \`?\`: Open the shortcut guide from an empty prompt.
- \`Tab\`: Fill the selected command.
- \`1\`, \`2\`, or \`3\`: Select a contextual suggestion.
- \`Left\` and \`Right\`: Move the cursor.
- \`Option+Left\` and \`Option+Right\`: Move by one word.
- \`Ctrl+A\` and \`Ctrl+E\`: Move to the start or end.
- \`Ctrl+W\`: Delete the prior word.
- \`Ctrl+U\`: Delete to the start.
- \`Alt+Enter\`: Insert a new line.
- \`Up\` and \`Down\`: Read prompt history.
- \`Ctrl+R\`: Search prompt history.
- \`Page Up\` and \`Page Down\`: Scroll the transcript.
- \`Mouse wheel\`: Scroll the transcript.
- \`Escape\`: Close a panel or stop the current request.
- \`Ctrl+C\`: Exit Seb.`;

function localTextStream(text: string): ReadableStream<UIMessageChunk> {
  const textId = `local-${crypto.randomUUID()}`;
  return createUIMessageStream<UIMessage>({
    execute: ({ writer }) => {
      writer.write({ type: 'start' });
      writer.write({ type: 'start-step' });
      writer.write({ type: 'text-start', id: textId });
      writer.write({ type: 'text-delta', id: textId, delta: text });
      writer.write({ type: 'text-end', id: textId });
      writer.write({ type: 'finish-step' });
      writer.write({ type: 'finish', finishReason: 'stop' });
    },
    onError: errorMessage,
  });
}

export function decorateResponseStream(
  stream: ReadableStream<UIMessageChunk>,
  state: SessionState,
  sources: SourceTracker,
  uiState: InteractiveUiState,
  userPrompt: string,
  recommendationQuestion = userPrompt,
  onStreamError?: (error: unknown) => void,
  onConsumerCancel?: (reason: unknown) => void,
  initialToolState: readonly RecommendationStreamToolState[] = [],
): ReadableStream<UIMessageChunk> {
  const decisionRequested = questionRequestsRecommendation(recommendationQuestion);
  const pendingApprovals = new Map<string, string>();
  const toolCalls = new Map<string, { input: unknown; toolName: string }>();
  const toolResults: RecommendationToolResult[] = [];
  const initialPlayer = state.player;
  const initialTeam = state.team;
  const playerCandidates = new Set<string>();
  const requestedPlayers = new Set<string>();
  const teamCandidates = new Set<string>();
  const requestedTeams = new Set<string>();
  const completedToolCallIds = new Set<string>();
  for (const item of initialToolState) {
    const requested = resolveUserRequestedToolContext(
      item.toolName,
      item.input,
      userPrompt,
    );
    addStreamSubject(requested.player, requestedPlayers);
    addStreamSubject(requested.team, requestedTeams);
    if (item.state === 'pending') {
      toolCalls.set(item.toolCallId, {
        input: item.input,
        toolName: item.toolName,
      });
      continue;
    }
    completedToolCallIds.add(item.toolCallId);
    toolResults.push({
      input: item.input,
      output: item.output,
      toolName: item.toolName,
    });
    const confirmed = resolveUserConfirmedToolContext(
      item.toolName,
      item.input,
      item.output,
      userPrompt,
    );
    addStreamSubject(confirmed.player, playerCandidates);
    addStreamSubject(confirmed.team, teamCandidates);
  }
  let bufferedText = '';
  let answerId = `answer-${crypto.randomUUID()}`;
  let consumerCancelRecorded = false;
  let streamFailed = false;
  let streamErrorRecorded = false;
  const recordConsumerCancel = (reason: unknown): void => {
    if (consumerCancelRecorded) return;
    consumerCancelRecorded = true;
    try {
      onConsumerCancel?.(reason);
    } catch {
      // Preserve stream cancellation when telemetry fails.
    }
  };
  const recordStreamError = (error: unknown): void => {
    if (streamErrorRecorded) return;
    streamErrorRecorded = true;
    try {
      onStreamError?.(error);
    } catch {
      // Preserve the model stream error when telemetry fails.
    }
  };
  const decorated = stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === 'error') {
          streamFailed = true;
          recordStreamError(new Error(chunk.errorText));
        }
        if (chunk.type === 'start' && chunk.messageId) answerId = chunk.messageId;
        if (chunk.type === 'tool-input-available') {
          if (!completedToolCallIds.has(chunk.toolCallId)) {
            toolCalls.set(chunk.toolCallId, {
              input: chunk.input,
              toolName: chunk.toolName,
            });
          }
          const requested = resolveUserRequestedToolContext(
            chunk.toolName,
            chunk.input,
            userPrompt,
          );
          addStreamSubject(requested.player, requestedPlayers);
          addStreamSubject(requested.team, requestedTeams);
        }
        if (chunk.type === 'tool-approval-request') {
          pendingApprovals.set(chunk.approvalId, chunk.toolCallId);
        }
        if (chunk.type === 'tool-approval-response') {
          pendingApprovals.delete(chunk.approvalId);
        }
        if (chunk.type === 'tool-output-available') {
          deletePendingApproval(pendingApprovals, chunk.toolCallId);
          const toolCall = completedToolCallIds.has(chunk.toolCallId)
            ? undefined
            : toolCalls.get(chunk.toolCallId);
          if (toolCall) {
            completedToolCallIds.add(chunk.toolCallId);
            toolResults.push({
              input: toolCall.input,
              output: chunk.output,
              toolName: toolCall.toolName,
            });
            const confirmed = resolveUserConfirmedToolContext(
              toolCall.toolName,
              toolCall.input,
              chunk.output,
              userPrompt,
            );
            addStreamSubject(confirmed.player, playerCandidates);
            addStreamSubject(confirmed.team, teamCandidates);
            toolCalls.delete(chunk.toolCallId);
          }
        }
        if (chunk.type === 'tool-output-error') {
          deletePendingApproval(pendingApprovals, chunk.toolCallId);
          toolCalls.delete(chunk.toolCallId);
        }
        if (chunk.type === 'source-url') {
          const url = normalizeWebUrl(chunk.url);
          const source = {
            id: chunk.sourceId,
            ...(chunk.title ? { title: chunk.title } : {}),
            url: chunk.url,
          };
          if (url) sources.recordUrlSource(source);
        }
        if (chunk.type === 'finish') {
          const awaitsApproval = chunk.finishReason === 'tool-calls' &&
            pendingApprovals.size > 0;
          if (!streamFailed && chunk.finishReason !== 'stop' && !awaitsApproval) {
            streamFailed = true;
            controller.enqueue({
              type: 'error',
              errorText: incompleteFinishMessage(chunk.finishReason),
            });
          }
          const completed = !streamFailed && chunk.finishReason === 'stop';
          const evidence = completed ? sources.snapshot(answerId) : undefined;
          if (completed && evidence) {
            commitStreamSubject(
              state,
              playerCandidates,
              requestedPlayers,
              initialPlayer,
              'player',
            );
            commitStreamSubject(
              state,
              teamCandidates,
              requestedTeams,
              initialTeam,
              'team',
            );
            uiState.recordAnswerEvidence(evidence);
          }
          if (
            decisionRequested &&
            (completed || chunk.finishReason !== 'tool-calls')
          ) {
            const answer = completed
              ? enforceFreeformRecommendation(
                bufferedText,
                buildFreeformRecommendationEvidence({
                  question: recommendationQuestion,
                  sources: evidence?.sources ?? [],
                  toolResults,
                }),
              ).answer
              : incompleteRecommendationMessage();
            const decisionId = `decision-${crypto.randomUUID()}`;
            controller.enqueue({ type: 'start-step' });
            controller.enqueue({ type: 'text-start', id: decisionId });
            controller.enqueue({
              type: 'text-delta',
              id: decisionId,
              delta: answer,
            });
            controller.enqueue({ type: 'text-end', id: decisionId });
            controller.enqueue({ type: 'finish-step' });
          }
          const evidenceText = evidence
            ? formatEvidenceMarkdown(evidence.sources, {
              limit: VISIBLE_WEB_SOURCE_LIMIT,
            })
            : '';
          if (evidenceText) {
            const sourceId = `sources-${crypto.randomUUID()}`;
            controller.enqueue({ type: 'start-step' });
            controller.enqueue({ type: 'text-start', id: sourceId });
            controller.enqueue({
              type: 'text-delta',
              id: sourceId,
              delta: `\n\n${evidenceText}`,
            });
            controller.enqueue({ type: 'text-end', id: sourceId });
            controller.enqueue({ type: 'finish-step' });
          }
          if (completed) {
            const suggestions = getContextualSuggestions(state).slice(0, 3);
            uiState.suggestions = suggestions;
          }
        }
        if (
          decisionRequested &&
          (chunk.type === 'text-start' || chunk.type === 'text-delta' || chunk.type === 'text-end')
        ) {
          if (chunk.type === 'text-delta') bufferedText += chunk.delta;
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return observeReadableStreamLifecycle(
    decorated,
    recordStreamError,
    recordConsumerCancel,
  );
}

function observeReadableStreamLifecycle<T>(
  stream: ReadableStream<T>,
  onStreamError: (error: unknown) => void,
  onConsumerCancel: (reason: unknown) => void,
): ReadableStream<T> {
  const reader = stream.getReader();
  return new ReadableStream<T>({
    async cancel(reason) {
      onConsumerCancel(reason);
      try {
        await reader.cancel(reason);
      } catch (error) {
        onStreamError(error);
        throw error;
      }
    },
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        onStreamError(error);
        controller.error(error);
      }
    },
  });
}

function addStreamSubject(
  candidate: string | null,
  candidates: Set<string>,
): void {
  if (candidate) candidates.add(candidate);
}

function commitStreamSubject(
  state: SessionState,
  confirmedCandidates: Set<string>,
  requestedCandidates: Set<string>,
  initialValue: string | null,
  field: 'player' | 'team',
): void {
  const confirmed = confirmedCandidates.values().next().value;
  state[field] = confirmedCandidates.size === 1 &&
    requestedCandidates.size === 1 &&
    confirmed !== undefined &&
    requestedCandidates.has(confirmed)
    ? confirmed
    : initialValue;
}

function incompleteRecommendationMessage(): string {
  return [
    '## Decision unavailable',
    '',
    'Seb withheld the recommendation because the model did not complete the response.',
    '',
    'Run the request again.',
  ].join('\n');
}

function previousUserPrompt(messages: readonly UIMessage[]): string | undefined {
  let skippedCurrent = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    if (!skippedCurrent) {
      skippedCurrent = true;
      continue;
    }
    return messageText(message).trim() || undefined;
  }
  return undefined;
}

function latestUserMessage(messages: readonly UIMessage[]): UIMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return message;
  }
  return undefined;
}

function hasRespondedApproval(message: UIMessage): boolean {
  return message.parts.some(
    (part) => isToolUIPart(part) && part.state === 'approval-responded',
  );
}

function recommendationToolState(
  messages: readonly UIMessage[],
): RecommendationStreamToolState[] {
  const latestUserIndex = messages.findLastIndex(
    (message) => message.role === 'user',
  );
  const records = new Map<string, RecommendationStreamToolState>();
  for (const message of messages.slice(latestUserIndex + 1)) {
    if (message.role !== 'assistant') continue;
    for (const part of message.parts) {
      if (!isToolUIPart(part) || !('input' in part)) continue;
      const toolName = getToolName(part);
      if (part.state === 'output-available') {
        records.set(part.toolCallId, {
          input: part.input,
          output: part.output,
          state: 'completed',
          toolCallId: part.toolCallId,
          toolName,
        });
      } else if (
        part.state === 'input-available' ||
        part.state === 'approval-requested' ||
        part.state === 'approval-responded'
      ) {
        if (records.get(part.toolCallId)?.state === 'completed') continue;
        records.set(part.toolCallId, {
          input: part.input,
          state: 'pending',
          toolCallId: part.toolCallId,
          toolName,
        });
      }
    }
  }
  return [...records.values()];
}

function currentConversationTurn(messages: readonly UIMessage[]): UIMessage[] {
  const latestUserIndex = messages.findLastIndex(
    (message) => message.role === 'user',
  );
  return latestUserIndex < 0 ? [] : messages.slice(latestUserIndex);
}

function estimateMessages(
  messages: readonly UIMessage[],
  limit = MODEL_CONTEXT_CHARACTER_LIMIT + 1,
): number {
  return estimateValueCharacters(messages, limit, new WeakSet(), 0);
}

function estimateValueCharacters(
  value: unknown,
  limit: number,
  seen: WeakSet<object>,
  depth: number,
): number {
  if (limit <= 0) return 1;
  if (typeof value === 'string') return Math.min(limit, value.length + 2);
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'bigint'
  ) return Math.min(limit, String(value).length);
  if (typeof value !== 'object' || depth >= 24) return 1;
  if (seen.has(value)) return 1;
  seen.add(value);
  let total = 2;
  if (Array.isArray(value)) {
    for (const item of value) {
      total += 1;
      if (total >= limit) break;
      total += estimateValueCharacters(
        item,
        limit - total,
        seen,
        depth + 1,
      );
      if (total >= limit) break;
    }
  } else {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      total += key.length + 3;
      if (total >= limit) break;
      total += estimateValueCharacters(
        (value as Record<string, unknown>)[key],
        limit - total,
        seen,
        depth + 1,
      );
      if (total >= limit) break;
    }
  }
  return Math.min(total, limit);
}

function recordSuggestions(
  text: string,
  state: SessionState,
  uiState: InteractiveUiState,
): string {
  const suggestions = getContextualSuggestions(state);
  uiState.suggestions = suggestions.slice(0, 3);
  return text;
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<UIMessage['parts'][number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function replaceMessageText(message: UIMessage, text: string): UIMessage {
  return {
    ...message,
    parts: [
      { type: 'text', text },
      ...message.parts.filter((part) => part.type !== 'text'),
    ],
  };
}

function experienceModeForCommand(
  name: string,
): 'analyze' | 'explore' | 'fantasy' | null {
  if (name === 'analyze') return 'analyze';
  if (name === 'explore') return 'explore';
  if (name === 'fantasy') return 'fantasy';
  return null;
}

function formatSourceRecord(source: DataSourceRecord, index: number): string {
  const retrieved = source.retrievedAt ?? source.accessedAt;
  const warning = source.cacheOutcome === 'stale-if-error'
    ? ` Warning: Seb used stale data because the refresh failed${source.error ? ` (${source.error})` : ''}.`
    : '';
  const storageWarning = source.warnings?.length
    ? ` Storage warning: ${source.warnings.join(' ')}`
    : '';
  return `${index}. [${source.label}](${source.url}) · **${sourceBadge(source)}** · ${sourceRetrievalDetail(source)} · timestamp ${retrieved}.${warning}${storageWarning}`;
}

function formatStorageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatProvenance(value: unknown, snapshotId: string): string {
  const provenance = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  const fields = provenance.fields && typeof provenance.fields === 'object'
    ? Object.entries(provenance.fields as Record<string, unknown>)
    : [];
  const freshness = provenance.freshness && typeof provenance.freshness === 'object'
    ? String((provenance.freshness as Record<string, unknown>).state ?? 'unknown')
    : 'unknown';
  return [
    `## Provenance for \`${snapshotId}\``,
    '',
    `- Freshness: ${freshness}`,
    `- Tracked field paths: ${fields.length}`,
    '',
    ...fields.slice(0, 50).map(([path, lineage]) => {
      const sourceIds = lineage && typeof lineage === 'object' &&
        Array.isArray((lineage as Record<string, unknown>).sourceIds)
        ? ((lineage as Record<string, unknown>).sourceIds as unknown[]).join(', ')
        : 'unknown';
      return `- \`${path || '<root>'}\`: ${sourceIds}`;
    }),
    ...(fields.length > 50 ? [`- ${fields.length - 50} additional paths are hidden.`] : []),
  ].join('\n');
}

function resolveTeam(value: string): string | null {
  if (value.trim().toLowerCase() === 'clear') {
    return null;
  }
  const resolution = new TeamIdentityRegistry().resolve(value);
  if (resolution.status === 'resolved') {
    return resolution.identity.code;
  }
  throw new Error(resolution.reason);
}

function optionalIdentifier(
  value: string | undefined,
  pattern: RegExp,
  label: string,
): string | null {
  if (value?.toLowerCase() === 'clear') {
    return null;
  }
  if (!value || !pattern.test(value)) {
    throw new Error(`Add a valid ${label}, or use clear.`);
  }
  return value;
}

function validInteger(
  value: string | number | undefined,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`The ${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return number;
}

async function saveTranscript(
  messages: readonly UIMessage[],
  requestedName: string | undefined,
  requestedFormat: string | undefined,
): Promise<string> {
  const nameParts = requestedName?.split('.') ?? [];
  const extension = nameParts.at(-1)?.toLowerCase();
  const format = (requestedFormat ?? (extension === 'json' ? 'json' : 'md')).toLowerCase();
  if (format !== 'md' && format !== 'json') {
    throw new Error('The transcript format must be md or json.');
  }
  const automaticName = `seb-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const rawName = requestedName
    ? extension === 'md' || extension === 'json'
      ? nameParts.slice(0, -1).join('.')
      : requestedName
    : automaticName;
  const safeName = rawName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
  if (!safeName) {
    throw new Error('The transcript name needs a letter or number.');
  }
  const directory = resolve(process.cwd(), 'exports');
  const file = resolve(directory, `${safeName}.${format}`);
  await mkdir(directory, { recursive: true });
  const content = format === 'json'
    ? `${JSON.stringify({ exportedAt: new Date().toISOString(), messages }, null, 2)}\n`
    : markdownTranscript(messages);
  await writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
  return file;
}

function markdownTranscript(messages: readonly UIMessage[]): string {
  const sections = messages
    .map((message) => {
      const text = messageText(message).trim();
      if (!text) {
        return null;
      }
      const role = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Seb' : message.role;
      return `## ${role}\n\n${text}`;
    })
    .filter((value): value is string => value !== null);
  return `# Seb transcript\n\nExported ${new Date().toISOString()}\n\n${sections.join('\n\n')}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateInteractiveModelSwitchResult(
  result: InteractiveModelSwitchResult,
): InteractiveModelState {
  return {
    model: safeModelDisplayValue(result.model, 'model'),
    provider: safeModelDisplayValue(result.provider, 'provider'),
    providerLabel: safeModelDisplayValue(
      result.providerLabel || result.provider,
      'provider label',
    ),
  };
}

function safeModelDisplayValue(value: string, label: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 256 ||
    /[\u0000-\u001F\u007F]/u.test(normalized)
  ) {
    throw new Error(`The model switch returned an invalid ${label}.`);
  }
  return normalized;
}

function incompleteFinishMessage(finishReason: string | undefined): string {
  if (finishReason === 'length') {
    return 'The model reached the output limit before it completed the answer. Ask a narrower question, then retry.';
  }
  if (finishReason === 'content-filter') {
    return 'The model stopped the answer because a safety filter blocked the response.';
  }
  return 'The model stopped before it completed the answer. Run `/doctor` and `/stats session`, then retry.';
}

function deletePendingApproval(
  approvals: Map<string, string>,
  toolCallId: string,
): void {
  for (const [approvalId, pendingToolCallId] of approvals) {
    if (pendingToolCallId === toolCallId) approvals.delete(approvalId);
  }
}

function parseUsageScope(
  value: string | undefined,
  defaultScope: UsageScope,
): UsageScope {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return defaultScope;
  if (
    normalized === 'session' ||
    normalized === 'today' ||
    normalized === '7d' ||
    normalized === '30d' ||
    normalized === 'all'
  ) return normalized;
  throw new Error('Use session, today, 7d, 30d, or all.');
}

function isCompletionShell(value: string | undefined): value is CompletionShell {
  return value === 'bash' || value === 'fish' || value === 'zsh';
}

function unknownCommandMessage(name: string): string {
  const suggestions = completeInteractiveInput(`/${name}`, {}, 3);
  const suffix = suggestions.length > 0
    ? ` Did you mean ${suggestions.map((suggestion) => `\`${suggestion.value}\``).join(', ')}?`
    : ' Run /help.';
  return `Unknown command: /${name}.${suffix}`;
}
