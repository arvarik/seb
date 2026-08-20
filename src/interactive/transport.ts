import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  createUIMessageStream,
  DirectChatTransport,
  type ChatTransport,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';

import type { createFantasyFootballAgent } from '../agent.js';
import { getSharedSebDatabase } from '../data/sqlite-store.js';
import { formatDoctorReport, runDoctor } from '../doctor.js';
import {
  formatReplaySummary,
  runNflverseBaselineReplay,
} from '../evaluation/nflverse-runner.js';
import { TeamIdentityRegistry } from '../identity/teams.js';
import { NflverseClient } from '../nflverse/client.js';
import { SleeperClient } from '../sleeper/client.js';
import { SourceTracker, type DataSourceRecord } from '../sources.js';
import { WeatherClient } from '../weather/client.js';
import {
  FileSetupProfileStore,
  formatSetupProfile,
  type SetupProfileStore,
} from '../setup/profile.js';
import {
  applySetupProfile,
  buildSetupProfile,
  checkGeminiApiKey,
} from '../setup/wizard.js';
import {
  completeInteractiveInput,
  formatCommandCatalog,
  formatCompletions,
  generateShellCompletion,
  type CompletionShell,
} from './commands.js';
import {
  formatSessionStatus,
  getContextualSuggestions,
  type SessionState,
} from './session.js';
import { findSkill, formatSkillList, getSkill } from './skills.js';

type SebAgent = ReturnType<typeof createFantasyFootballAgent>;

export interface SebInteractiveTransportOptions {
  agent: SebAgent;
  environment: NodeJS.ProcessEnv;
  model: string;
  nflverse: NflverseClient;
  session: SessionState;
  sleeper: SleeperClient;
  sources: SourceTracker;
  profileStore?: SetupProfileStore;
  version: string;
  weather: WeatherClient;
}

export class SebInteractiveTransport implements ChatTransport<UIMessage> {
  private readonly commandMessageIds = new Set<string>();
  private readonly delegate: ChatTransport<UIMessage>;
  private readonly options: SebInteractiveTransportOptions;
  private readonly profileStore: SetupProfileStore;

  constructor(options: SebInteractiveTransportOptions) {
    this.options = options;
    this.profileStore = options.profileStore ?? new FileSetupProfileStore({
      environment: options.environment,
    });
    this.delegate = new DirectChatTransport({
      agent: options.agent,
    }) as unknown as ChatTransport<UIMessage>;
  }

  async sendMessages(
    options: Parameters<ChatTransport<UIMessage>['sendMessages']>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    const lastMessage = options.messages.at(-1);
    const text = lastMessage?.role === 'user' ? messageText(lastMessage).trim() : '';
    if (lastMessage?.role === 'user' && text.startsWith('/')) {
      this.commandMessageIds.add(lastMessage.id);
      let response: string;
      try {
        response = await this.runCommand(text, options.messages, lastMessage.id);
      } catch (error) {
        response = `Command error: ${errorMessage(error)}`;
      }
      return localTextStream(withSuggestions(response, this.options.session));
    }

    const stream = await this.delegate.sendMessages({
      ...options,
      messages: this.modelMessages(options.messages),
    });
    return appendContextualSuggestions(stream, this.options.session);
  }

  reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return Promise.resolve(null);
  }

  private modelMessages(messages: UIMessage[]): UIMessage[] {
    const marker = this.options.session.contextAfterMessageId;
    const markerIndex = marker
      ? messages.findIndex((message) => message.id === marker)
      : -1;
    const active = markerIndex >= 0 ? messages.slice(markerIndex + 1) : messages;
    const filtered: UIMessage[] = [];
    let skipNextAssistant = false;
    for (const message of active) {
      if (this.commandMessageIds.has(message.id)) {
        skipNextAssistant = true;
        continue;
      }
      if (skipNextAssistant && message.role === 'assistant') {
        skipNextAssistant = false;
        continue;
      }
      skipNextAssistant = false;
      filtered.push(message);
    }
    return filtered;
  }

  private async runCommand(
    input: string,
    messages: UIMessage[],
    messageId: string,
  ): Promise<string> {
    const [rawName, ...arguments_] = input.slice(1).trim().split(/\s+/);
    const name = rawName?.toLowerCase() ?? '';
    const state = this.options.session;

    switch (name) {
      case 'help':
      case '?':
        return INTERACTIVE_HELP;
      case 'commands':
        return formatCommandCatalog(arguments_.join(' '));
      case 'complete':
        return formatCompletions(
          completeInteractiveInput(arguments_.join(' '), state),
        );
      case 'status':
      case 'context':
        return formatSessionStatus(state);
      case 'skills':
        return `## Skills\n\n${formatSkillList()}`;
      case 'skill': {
        const value = arguments_.join(' ');
        if (!value || value === 'list') {
          return `## Skills\n\n${formatSkillList()}`;
        }
        const skill = findSkill(value);
        if (!skill) {
          throw new Error(`Unknown skill: ${value}. Run /skills.`);
        }
        state.skillId = skill.id;
        return `The active skill is now \`${skill.id}\`. ${skill.description}`;
      }
      case 'season': {
        const value = arguments_[0];
        const season = value === 'current'
          ? (await this.options.sleeper.getNflState()).season
          : value;
        state.season = validInteger(season, 1999, 2100, 'season');
        return `The active NFL season is now ${state.season}.`;
      }
      case 'week': {
        const value = arguments_[0];
        if (value === 'clear') {
          state.week = null;
          return 'The active NFL week is now unset.';
        }
        if (value === 'current') {
          const nfl = await this.options.sleeper.getNflState();
          state.season = validInteger(nfl.season, 1999, 2100, 'season');
          state.week = validInteger(nfl.week, 1, 22, 'week');
        } else {
          state.week = validInteger(value, 1, 22, 'week');
        }
        return `The active NFL week is now ${state.week}.`;
      }
      case 'league':
        state.leagueId = optionalIdentifier(arguments_[0], /^\d+$/, 'Sleeper league ID');
        return `The active Sleeper league ID is now ${state.leagueId ?? 'unset'}.`;
      case 'roster': {
        const value = arguments_[0];
        state.rosterId = value === 'clear' ? null : validInteger(value, 1, 1_000_000, 'roster ID');
        return `The active Sleeper roster ID is now ${state.rosterId ?? 'unset'}.`;
      }
      case 'user':
        state.user = optionalIdentifier(arguments_.join(' '), /^[A-Za-z0-9_.-]{1,100}$/, 'Sleeper user');
        return `The active Sleeper user is now ${state.user ?? 'unset'}.`;
      case 'team':
        state.team = resolveTeam(arguments_.join(' '));
        return `The active NFL team is now ${state.team ?? 'unset'}.`;
      case 'setup':
        return this.runSetupCommand(arguments_);
      case 'profile':
        return this.runProfileCommand(arguments_[0]);
      case 'sources': {
        const sources = this.options.sources.list();
        if (sources.length === 0) {
          return 'No data source has answered a request in this session.';
        }
        return [
          '## Recent data sources',
          '',
          ...sources.map(
            (source) => formatSourceRecord(source),
          ),
        ].join('\n');
      }
      case 'cache': {
        const status = getSharedSebDatabase().status();
        return [
          '## Local data store',
          '',
          `- Database: \`${status.file}\``,
          `- Schema: ${status.schemaVersion}`,
          `- Cache entries: ${status.cacheEntries}`,
          `- Snapshots: ${status.snapshots}`,
          `- Canonical identities: ${status.identities}`,
          `- Identity source links: ${status.identityLinks}`,
        ].join('\n');
      }
      case 'snapshots': {
        const kind = arguments_[0];
        const snapshots = getSharedSebDatabase().listSnapshots({
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
        this.options.sources.clear();
        return 'Seb started a new model context. The terminal keeps the visible transcript.';
      case 'save':
      case 'export': {
        const saved = await saveTranscript(messages, arguments_[0], arguments_[1]);
        return `Seb saved the transcript to \`${saved}\`.`;
      }
      case 'doctor': {
        const report = await runDoctor({
          environment: this.options.environment,
          offline: arguments_[0] === 'offline' || arguments_[0] === '--offline',
        });
        return `\`\`\`text\n${formatDoctorReport(report)}\n\`\`\``;
      }
      case 'cost':
        return [
          '## Session usage',
          '',
          `- Model requests: ${state.usage.requests}`,
          `- Input tokens: ${state.usage.inputTokens.toLocaleString()}`,
          `- Output tokens: ${state.usage.outputTokens.toLocaleString()}`,
          `- Total tokens: ${state.usage.totalTokens.toLocaleString()}`,
          '- Seb does not estimate currency cost because model prices can change.',
        ].join('\n');
      case 'suggest':
      case 'suggestions':
        return ['## Suggested next actions', '', ...getContextualSuggestions(state).map((item) => `- ${item}`)].join('\n');
      case 'version':
        return `Seb ${this.options.version} uses ${this.options.model}.`;
      case 'completion': {
        const shell = arguments_[0]?.toLowerCase();
        if (!isCompletionShell(shell)) {
          throw new Error('Use /completion bash, /completion fish, or /completion zsh.');
        }
        return [
          `## ${shell} completion`,
          '',
          'Copy this script into the completion file for your shell.',
          '',
          `\`\`\`${shell}`,
          generateShellCompletion(shell),
          '\`\`\`',
        ].join('\n');
      }
      case '':
        throw new Error('Add a command after the slash. Run /help.');
      default:
        throw new Error(unknownCommandMessage(name));
    }
  }

  private async runSetupCommand(arguments_: string[]): Promise<string> {
    if (arguments_.length > 3) {
      throw new Error('Use /setup <Sleeper user> [league ID] [roster ID].');
    }
    const key = checkGeminiApiKey(this.options.environment);
    const username = arguments_[0];
    if (!username) {
      const existing = await this.profileStore.load();
      return [
        '## First-run setup',
        '',
        `- ${key.message}`,
        `- Profile file: \`${this.profileStore.path}\``,
        ...(existing ? ['', formatSetupProfile(existing)] : []),
        '',
        'Run `/setup <Sleeper user>` to discover leagues.',
        'Seb then gives the exact command for the league or roster choice.',
      ].join('\n');
    }
    if (!key.present) {
      throw new Error(key.message);
    }

    const leagueId = arguments_[1];
    if (leagueId && !/^\d+$/.test(leagueId)) {
      throw new Error('The Sleeper league ID must contain only numbers.');
    }
    const rosterId = arguments_[2] === undefined
      ? undefined
      : validInteger(arguments_[2], 1, 1_000_000, 'roster ID');
    const result = await buildSetupProfile({
      sleeper: this.options.sleeper,
      username,
      season: this.options.session.season,
      ...(leagueId ? { leagueId } : {}),
      ...(rosterId ? { rosterId } : {}),
    });

    if (!result.selectedLeague) {
      if (result.leagues.length === 0) {
        throw new Error(`Sleeper found no NFL league for ${result.account.season}.`);
      }
      return [
        `## Leagues for ${result.account.user.username ?? username}`,
        '',
        ...result.leagues.map(
          (league) => `- ${league.name}: \`${league.league_id}\` (${league.total_rosters} rosters)`,
        ),
        '',
        `Continue with \`/setup ${username} <league ID>\`.`,
      ].join('\n');
    }
    if (result.ownedRosters.length === 0) {
      throw new Error(
        `The Sleeper user does not own a roster in \`${result.selectedLeague.name}\`.`,
      );
    }
    if (!result.profile) {
      return [
        `## Rosters in ${result.selectedLeague.name}`,
        '',
        ...result.ownedRosters.map(
          (roster) => `- Roster \`${roster.roster_id}\`: ${roster.players?.length ?? 0} players`,
        ),
        '',
        `Continue with \`/setup ${username} ${result.selectedLeague.league_id} <roster ID>\`.`,
      ].join('\n');
    }

    await this.profileStore.save(result.profile);
    applySetupProfile(result.profile, this.options.session);
    return [
      'Seb saved and activated the setup profile.',
      '',
      formatSetupProfile(result.profile, this.profileStore.path),
    ].join('\n');
  }

  private async runProfileCommand(action = 'show'): Promise<string> {
    if (!['show', 'load', 'clear'].includes(action)) {
      throw new Error('Use /profile show, /profile load, or /profile clear.');
    }
    if (action === 'clear') {
      const removed = await this.profileStore.remove();
      return removed
        ? `Seb removed the local profile at \`${this.profileStore.path}\`.`
        : 'Seb found no local setup profile.';
    }
    const profile = await this.profileStore.load();
    if (!profile) {
      return 'Seb found no local setup profile. Run `/setup` for instructions.';
    }
    if (action === 'load') {
      applySetupProfile(profile, this.options.session);
      return `Seb loaded the profile.\n\n${formatSetupProfile(profile, this.profileStore.path)}`;
    }
    return formatSetupProfile(profile, this.profileStore.path);
  }
}

export const INTERACTIVE_HELP = `${formatCommandCatalog()}

Press Escape or Ctrl+C to exit.`;

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

function appendContextualSuggestions(
  stream: ReadableStream<UIMessageChunk>,
  state: SessionState,
): ReadableStream<UIMessageChunk> {
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === 'finish') {
          const id = `suggestion-${crypto.randomUUID()}`;
          const suggestions = getContextualSuggestions(state).slice(0, 3);
          controller.enqueue({ type: 'start-step' });
          controller.enqueue({ type: 'text-start', id });
          controller.enqueue({
            type: 'text-delta',
            id,
            delta: `\n\nTry next: ${suggestions.join(' · ')}`,
          });
          controller.enqueue({ type: 'text-end', id });
          controller.enqueue({ type: 'finish-step' });
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

function withSuggestions(text: string, state: SessionState): string {
  if (text.includes('## Suggested next actions')) {
    return text;
  }
  const suggestions = getContextualSuggestions(state);
  return `${text}\n\nTry next: ${suggestions.join(' · ')}`;
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<UIMessage['parts'][number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function formatSourceRecord(source: DataSourceRecord): string {
  const cache = source.cacheOutcome
    ? source.cacheOutcome.replace(/-/g, ' ')
    : 'source access';
  const retrieved = source.retrievedAt ?? source.accessedAt;
  const warning = source.cacheOutcome === 'stale-if-error'
    ? ` Warning: Seb used stale data because the refresh failed${source.error ? ` (${source.error})` : ''}.`
    : '';
  return `- [${source.label}](${source.url}) · ${cache} · retrieved ${retrieved}.${warning}`;
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
  if (value === 'clear') {
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
