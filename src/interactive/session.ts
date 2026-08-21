import { getSkill } from './skills.js';
import {
  compareFantasyLeagueActions,
  type FantasyLeagueAction,
  type FantasyLeagueActionCenter,
} from '../sleeper/action-center.js';

export type SessionSeasonType = 'post' | 'pre' | 'regular' | null;
export type SebExperienceMode = 'analyze' | 'explore' | 'fantasy';

export interface SessionLeagueContext {
  actionCenter?: FantasyLeagueActionCenter;
  deadlines: string[];
  leagueId: string;
  name: string;
  rosterIds: number[];
  status: string;
  warning: string | null;
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  totalTokens: number;
}

export type DecisionContextResolution = 'ambiguous' | 'resolved' | 'unset';

export interface DecisionContextField<T> {
  options: T[];
  resolution: DecisionContextResolution;
  value: T | null;
}

export interface ResolvedDecisionContext {
  league: DecisionContextField<string>;
  player: DecisionContextField<string>;
  roster: DecisionContextField<number>;
  season: DecisionContextField<number>;
  week: DecisionContextField<number>;
}

export interface SessionState {
  accountError: string | null;
  accountStatus: 'disconnected' | 'error' | 'ready';
  contextAfterMessageId: string | null;
  leagueId: string | null;
  leagueSeason: number;
  leagues: SessionLeagueContext[];
  leagueOptions: string[];
  mode: SebExperienceMode;
  player: string | null;
  rosterId: number | null;
  rosterOptions: number[];
  season: number;
  seasonType: SessionSeasonType;
  skillId: string;
  team: string | null;
  usage: SessionUsage;
  user: string | null;
  userId: string | null;
  week: number | null;
}

export function createSessionState(now = new Date()): SessionState {
  return {
    accountError: null,
    accountStatus: 'disconnected',
    contextAfterMessageId: null,
    leagueId: null,
    leagueSeason: nflSeason(now),
    leagues: [],
    leagueOptions: [],
    mode: 'explore',
    player: null,
    rosterId: null,
    rosterOptions: [],
    season: nflSeason(now),
    seasonType: null,
    skillId: 'general',
    team: null,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 },
    user: null,
    userId: null,
    week: null,
  };
}

export function recordUsage(
  state: SessionState,
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    totalTokens: number | undefined;
  },
): void {
  state.usage.inputTokens += usage.inputTokens ?? 0;
  state.usage.outputTokens += usage.outputTokens ?? 0;
  state.usage.totalTokens += usage.totalTokens ?? 0;
  state.usage.requests += 1;
}

export function formatSessionContext(state: SessionState): string {
  const skill = getSkill(state.skillId);
  const decision = resolveDecisionContext(state);
  return [
    `Experience: ${experienceTitle(state.mode)}.`,
    `Active skill: ${skill.id} (${skill.title}).`,
    `Skill instructions: ${skill.instructions}`,
    `NFL season: ${state.season}.`,
    `Sleeper league season: ${state.leagueSeason}.`,
    `NFL season type: ${state.seasonType ?? 'not set'}.`,
    `NFL week: ${state.week ?? 'not set'}.`,
    `Sleeper user: ${state.user ?? 'not set'}.`,
    `Sleeper user ID: ${state.userId ?? 'not set'}.`,
    `Sleeper account status: ${state.accountStatus}.`,
    `Sleeper refresh error: ${state.accountError ?? 'none'}.`,
    `Sleeper league ID: ${state.leagueId ?? 'not set'}.`,
    `Sleeper roster ID: ${state.rosterId ?? 'not set'}.`,
    `NFL player: ${state.player ?? 'not set'}.`,
    `NFL team: ${state.team ?? 'not set'}.`,
    `Discovered Sleeper leagues: ${formatLeagueContextForModel(state)}.`,
    '',
    'Resolved decision context:',
    ...formatDecisionContextFields(decision),
    '',
    'Use the NFL season and week as the automatic current Sleeper state.',
    'Retry getNflState when the NFL week is not set.',
    'Disclose the Sleeper refresh error when it prevents a requested fantasy answer.',
    'Do not ask the user to set a season or week unless the user requests another period.',
    'Use discovered league and roster values before asking for an ID.',
    'Ask which league only when several discovered leagues make the request ambiguous.',
    'Use these values when the request does not give a different value.',
    'Use the active NFL player for a follow-up request that omits the player name.',
    'Treat an ambiguous or unset field as unresolved.',
    'Resolve each field that affects a recommendation before you recommend an action.',
    'Ask one concise clarification question when a required field remains unresolved.',
    'Do not select a league, roster, player, season, or week only to avoid that question.',
    `Useful next requests: ${getContextualSuggestions(state).join(' | ')}`,
  ].join('\n');
}

export function formatSessionStatus(state: SessionState): string {
  const decision = resolveDecisionContext(state);
  return [
    '## Seb context',
    '',
    `- Experience: ${experienceTitle(state.mode)}`,
    `- NFL now: ${formatNflNow(state)}`,
    ...(state.leagueSeason !== state.season
      ? [`- Sleeper league season: ${state.leagueSeason}`]
      : []),
    `- Sleeper: ${state.user ? `@${state.user}` : 'not connected'}`,
    ...(state.accountError ? [`- Account refresh: ${state.accountError}`] : []),
    `- Fantasy leagues: ${state.leagues.length}`,
    `- Focused league: ${focusedLeagueName(state)}`,
    `- Looking at: ${state.player ?? state.team ?? 'no specific player or team'}`,
    '',
    '### Decision context',
    '',
    ...formatDecisionContextFields(decision).map((field) => `- ${field}`),
    ...(state.skillId !== 'general'
      ? [`- Advanced workflow: ${getSkill(state.skillId).title}`]
      : []),
    `- Model requests: ${state.usage.requests}`,
    `- Tokens: ${state.usage.totalTokens.toLocaleString()}`,
  ].join('\n');
}

export function resolveDecisionContext(
  state: SessionState,
): ResolvedDecisionContext {
  const leagueOptions = uniqueValues(state.leagues.map((league) => league.leagueId));
  const league = decisionField(
    state.leagueId,
    leagueOptions,
    state.leagueId === null && leagueOptions.length > 1,
  );
  const focusedLeague = state.leagueId
    ? state.leagues.find((candidate) => candidate.leagueId === state.leagueId)
    : undefined;
  const rosterOptions = uniqueValues(
    focusedLeague?.rosterIds ?? state.rosterOptions,
  );
  const roster = decisionField(
    state.rosterId,
    rosterOptions,
    state.rosterId === null && rosterOptions.length > 1,
  );
  return {
    league,
    player: decisionField(state.player, []),
    roster,
    season: decisionField(state.season, []),
    week: decisionField(state.week, []),
  };
}

export function getContextualSuggestions(state: SessionState): string[] {
  if (state.skillId !== 'general') {
    return getSkill(state.skillId).suggestions
      .map((suggestion) => fillSuggestionContext(suggestion, state))
      .slice(0, 4);
  }
  if (state.mode === 'fantasy') {
    return state.user
      ? [
          'Give me my fantasy dashboard across all leagues.',
          'Show urgent news for players on my fantasy rosters.',
          'What needs my attention before the next league deadline?',
        ]
      : [
          '/connect <Sleeper username>',
          'Look up an NFL player.',
          'Compare two players for fantasy football.',
        ];
  }
  if (state.mode === 'analyze') {
    return state.player
      ? [
          `Compare ${state.player} with another player.`,
          `Analyze ${state.player}'s matchup and upcoming weather.`,
          `Explain ${state.player}'s recent role and risk.`,
        ]
      : [
          'Compare two NFL players.',
          'Analyze a player matchup and upcoming weather.',
          'Review a fantasy football trade.',
        ];
  }
  if (state.player) {
    return [
      `Show ${state.player}'s season statistics.`,
      `Find the latest verified news about ${state.player}.`,
      `Analyze ${state.player} for fantasy football.`,
    ];
  }
  if (state.team) {
    return [
      `Show the ${state.team} team profile and recent results.`,
      `Find current verified news about ${state.team}.`,
      `Analyze the ${state.team} upcoming matchup.`,
    ];
  }
  return [
    'Look up an NFL player.',
    'Show an NFL team profile and current news.',
    state.user ? 'Open my fantasy dashboard.' : '/connect <Sleeper username>',
  ];
}

export function formatFantasyDashboard(state: SessionState): string {
  if (!state.user) {
    return [
      '## My Fantasy',
      '',
      'Connect one Sleeper username to discover leagues and owned rosters automatically.',
      '',
      'Run `/connect <Sleeper username>`.',
    ].join('\n');
  }
  const attention = fantasyAttentionItems(state);
  const visibleAttention = attention.slice(0, 6);
  return [
    '## My Fantasy',
    '',
    '### What needs attention',
    '',
    ...(state.accountError
      ? [
          `- **CHECK** · Account refresh · ${state.accountError}`,
          '  Next: Run `/refresh` before you make a final decision.',
        ]
      : []),
    ...visibleAttention.flatMap(({ action, league }) => [
      `- **${actionUrgencyLabel(action)}** · ${league.name}${action.rosterId === null ? '' : ` · Roster ${action.rosterId}`} · ${action.title}`,
      `  ${action.details} Next: ${action.nextStep}`,
    ]),
    ...(attention.length > visibleAttention.length
      ? [`- ${attention.length - visibleAttention.length} more action${attention.length - visibleAttention.length === 1 ? '' : 's'} across your leagues.`]
      : []),
    ...(attention.length === 0 && !state.accountError
      ? ['- No urgent lineup, player-status, or deadline actions.',
          '  Next: Recheck player statuses before the first relevant kickoff.']
      : []),
    '',
    '### Account',
    '',
    `- Sleeper: @${state.user}`,
    `- NFL now: ${formatNflNow(state)}`,
    `- Sleeper league season: ${state.leagueSeason}`,
    `- Leagues: ${state.leagues.length}`,
    '',
    ...(state.leagues.length > 0 ? ['### Leagues', ''] : []),
    ...(state.leagues.length > 0
      ? state.leagues.flatMap((league) => [
          `### ${league.name}`,
          '',
          `- Status: ${friendlyLeagueStatus(league.status)}`,
          `- My roster: ${league.rosterIds.length > 0 ? league.rosterIds.join(', ') : 'not found'}`,
          ...formatLeagueLineups(league.actionCenter),
          ...formatLeaguePlayerSignals(league.actionCenter),
          ...league.deadlines.map((deadline) => `- ${deadline}`),
          ...(league.warning ? [`- Refresh warning: ${league.warning}`] : []),
          '',
        ])
      : ['Seb found no NFL leagues for the current Sleeper league season.']),
    ...(state.leagues.length > 0
      ? ['', 'Sleeper supplies the exact live waiver countdown when a league uses a custom daily schedule.']
      : []),
  ].join('\n').trimEnd();
}

export function fantasyAttentionCount(state: SessionState): number {
  return fantasyAttentionItems(state).filter(({ action }) => action.urgency !== 'low').length;
}

export function experienceTitle(mode: SebExperienceMode): string {
  if (mode === 'fantasy') return 'My Fantasy';
  if (mode === 'analyze') return 'Analyze';
  return 'Explore';
}

export function inferPlayerNameFromPrompt(value: string): string | null {
  const player = normalizePlayerName(value, 2);
  if (!player) return null;
  const words = player.split(' ');
  const first = words[0]?.toLowerCase();
  if (!first || PLAYER_PROMPT_VERBS.has(first)) return null;
  return player;
}

export function recordUserConfirmedToolContext(
  state: SessionState,
  toolName: string,
  input: unknown,
  userPrompt?: string,
): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const values = input as Record<string, unknown>;
  const player = toolName === 'findPlayers'
    ? stringValue(values.query)
    : toolName === 'resolvePlayerIdentity'
      ? stringValue(values.name)
      : toolName === 'getPlayerWeeklyStats'
        ? stringValue(values.playerName)
        : toolName === 'comparePlayerTrends' && Array.isArray(values.playerNames) && values.playerNames.length === 1
          ? stringValue(values.playerNames[0])
          : null;
  if (player && promptContainsSubject(userPrompt, player)) state.player = player;
  const team = [
    'getGameEnvironment',
    'getGameWeather',
    'getNflSchedule',
    'getStadiumForecast',
    'getTeamPerformance',
    'getTeamPlayers',
  ].includes(toolName)
    ? teamValue(values.team)
    : null;
  if (team && promptContainsSubject(userPrompt, team)) state.team = team;
}

export function normalizeSessionSeasonType(
  value: string | undefined,
): SessionSeasonType {
  switch (value?.trim().toLowerCase()) {
    case 'pre':
    case 'preseason':
      return 'pre';
    case 'regular':
    case 'reg':
      return 'regular';
    case 'post':
    case 'postseason':
      return 'post';
    default:
      return null;
  }
}

function fillSuggestionContext(
  suggestion: string,
  state: SessionState,
): string {
  return suggestion
    .replaceAll('<Player>', state.player ?? '<Player>')
    .replaceAll('<NFL team>', state.team ?? '<NFL team>')
    .replaceAll('<number>', state.week === null ? '<number>' : String(state.week));
}

function decisionField<T>(
  value: T | null,
  options: T[],
  ambiguous = false,
): DecisionContextField<T> {
  return {
    options,
    resolution: value !== null ? 'resolved' : ambiguous ? 'ambiguous' : 'unset',
    value,
  };
}

function formatDecisionContextFields(context: ResolvedDecisionContext): string[] {
  return [
    formatDecisionField('League', context.league),
    formatDecisionField('Roster', context.roster),
    formatDecisionField('Player', context.player),
    formatDecisionField('Season', context.season),
    formatDecisionField('Week', context.week),
  ];
}

function formatDecisionField(
  label: string,
  field: DecisionContextField<number | string>,
): string {
  if (field.value !== null) return `${label}: ${field.value} (resolved).`;
  if (field.resolution === 'ambiguous') {
    return `${label}: ambiguous (${field.options.join(', ')}).`;
  }
  return `${label}: unset.`;
}

function promptContainsSubject(prompt: string | undefined, subject: string): boolean {
  if (!prompt) return false;
  const promptWords = searchableWords(prompt);
  const subjectWords = searchableWords(subject);
  if (subjectWords.length === 0 || subjectWords.length > promptWords.length) return false;
  return promptWords.some((_, index) =>
    subjectWords.every((word, offset) => promptWords[index + offset] === word),
  );
}

function searchableWords(value: string): string[] {
  return value.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? [];
}

function uniqueValues<T>(values: T[]): T[] {
  return [...new Set(values)];
}

const PLAYER_PROMPT_VERBS = new Set([
  'analyze',
  'compare',
  'explain',
  'find',
  'get',
  'give',
  'look',
  'show',
  'summarize',
  'tell',
  'what',
  'who',
]);

function formatNameWord(value: string): string {
  if (/[A-Z]/u.test(value)) return value;
  return value.replace(/(^|[-'\u2019])\p{L}/gu, (match) => match.toUpperCase());
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? normalizePlayerName(value, 1) : null;
}

function teamValue(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z]{2,3}$/u.test(value.trim())
    ? value.trim().toUpperCase()
    : null;
}

function normalizePlayerName(value: string, minimumWords: number): string | null {
  const candidate = value
    .trim()
    .replace(/[?!]+$/u, '')
    .replace(/\.$/u, '')
    .replace(/\s+/gu, ' ');
  if (candidate.length === 0 || candidate.length > 100) return null;
  const words = candidate.split(' ');
  if (words.length < minimumWords || words.length > 5) return null;
  if (!words.every((word) => /^[\p{L}][\p{L}.'\u2019-]*$/u.test(word))) return null;
  return words.map(formatNameWord).join(' ');
}

function focusedLeagueName(state: SessionState): string {
  if (!state.leagueId) return state.leagues.length > 1 ? 'all leagues' : 'automatic';
  return state.leagues.find((league) => league.leagueId === state.leagueId)?.name ?? state.leagueId;
}

function fantasyAttentionItems(state: SessionState): Array<{
  action: FantasyLeagueAction;
  league: SessionLeagueContext;
}> {
  return state.leagues.flatMap((league) =>
    (league.actionCenter?.actions ?? []).map((action) => ({ action, league })),
  ).sort((left, right) =>
    compareFantasyLeagueActions(left.action, right.action) ||
    left.league.name.localeCompare(right.league.name) ||
    left.league.leagueId.localeCompare(right.league.leagueId),
  );
}

function formatLeagueLineups(
  actionCenter: FantasyLeagueActionCenter | undefined,
): string[] {
  return (actionCenter?.lineups ?? []).flatMap((lineup) =>
    lineup.starterSlots > 0
      ? [`- Lineup ${lineup.rosterId}: ${lineup.filledSlots}/${lineup.starterSlots} starter slots filled`]
      : [],
  );
}

function formatLeaguePlayerSignals(
  actionCenter: FantasyLeagueActionCenter | undefined,
): string[] {
  const signals = actionCenter?.playerStatusSignals ?? [];
  if (signals.length === 0) return [];
  const starters = signals.filter((signal) => signal.starter).length;
  const rosterPlayers = signals.length - starters;
  const values = [
    starters > 0 ? `${starters} starter${starters === 1 ? '' : 's'}` : null,
    rosterPlayers > 0 ? `${rosterPlayers} bench or reserve` : null,
  ].filter((value): value is string => value !== null);
  return [`- Player status alerts: ${values.join(', ')}`];
}

function actionUrgencyLabel(action: FantasyLeagueAction): string {
  if (action.urgency === 'high') return 'NOW';
  if (action.urgency === 'medium') return 'SOON';
  return 'WATCH';
}

function formatLeagueContextForModel(state: SessionState): string {
  if (state.leagues.length === 0) return 'none';
  return state.leagues.map((league) => [
    `${league.name} (${league.leagueId})`,
    `status ${league.status}`,
    `owned rosters ${league.rosterIds.join(', ') || 'none'}`,
    league.deadlines.join('; ') || 'no deadline fields',
    league.warning ? `warning ${league.warning}` : 'no refresh warning',
  ].join(', ')).join(' | ');
}

function formatNflNow(state: SessionState): string {
  const phase = state.seasonType ?? 'unknown phase';
  return `${state.season} ${phase}${state.week ? `, Week ${state.week}` : ''}`;
}

function friendlyLeagueStatus(value: string): string {
  return value.replace(/_/gu, ' ').replace(/^\p{L}/u, (letter) => letter.toUpperCase());
}

function nflSeason(now: Date): number {
  const month = now.getUTCMonth() + 1;
  return month <= 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
}
