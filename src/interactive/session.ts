import { getSkill } from './skills.js';

export type SessionSeasonType = 'post' | 'pre' | 'regular' | null;

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  totalTokens: number;
}

export interface SessionState {
  contextAfterMessageId: string | null;
  leagueId: string | null;
  leagueOptions: string[];
  rosterId: number | null;
  rosterOptions: number[];
  season: number;
  seasonType: SessionSeasonType;
  skillId: string;
  team: string | null;
  usage: SessionUsage;
  user: string | null;
  week: number | null;
}

export function createSessionState(now = new Date()): SessionState {
  return {
    contextAfterMessageId: null,
    leagueId: null,
    leagueOptions: [],
    rosterId: null,
    rosterOptions: [],
    season: nflSeason(now),
    seasonType: null,
    skillId: 'general',
    team: null,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 },
    user: null,
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
  return [
    `Active skill: ${skill.id} (${skill.title}).`,
    `Skill instructions: ${skill.instructions}`,
    `NFL season: ${state.season}.`,
    `NFL season type: ${state.seasonType ?? 'not set'}.`,
    `NFL week: ${state.week ?? 'not set'}.`,
    `Sleeper user: ${state.user ?? 'not set'}.`,
    `Sleeper league ID: ${state.leagueId ?? 'not set'}.`,
    `Sleeper roster ID: ${state.rosterId ?? 'not set'}.`,
    `NFL team: ${state.team ?? 'not set'}.`,
    '',
    'Use these values when the request does not give a different value.',
    `Useful next requests: ${getContextualSuggestions(state).join(' | ')}`,
  ].join('\n');
}

export function formatSessionStatus(state: SessionState): string {
  const skill = getSkill(state.skillId);
  return [
    '## Session status',
    '',
    `- Skill: \`${skill.id}\` (${skill.title})`,
    `- Season: ${state.season}`,
    `- Season type: ${state.seasonType ?? 'not set'}`,
    `- Week: ${state.week ?? 'not set'}`,
    `- Sleeper user: ${state.user ?? 'not set'}`,
    `- League ID: ${state.leagueId ?? 'not set'}`,
    `- Roster ID: ${state.rosterId ?? 'not set'}`,
    `- NFL team: ${state.team ?? 'not set'}`,
    `- Model requests: ${state.usage.requests}`,
    `- Tokens: ${state.usage.totalTokens.toLocaleString()}`,
  ].join('\n');
}

export function getContextualSuggestions(state: SessionState): string[] {
  const contextSuggestions: string[] = [];
  if (!state.week) {
    contextSuggestions.push('/week <number>');
  }
  if (!state.user) {
    contextSuggestions.push('/leagues <Sleeper user>');
  } else if (!state.leagueId) {
    contextSuggestions.push(`/leagues ${state.user}`);
  } else if (!state.rosterId) {
    contextSuggestions.push(`/rosters ${state.leagueId}`);
  }
  if (!state.team) {
    contextSuggestions.push('/team <NFL code>');
  }
  const skillSuggestions = getSkill(state.skillId).suggestions.map((suggestion) =>
    fillSuggestionContext(suggestion, state),
  );
  const suggestions = state.skillId === 'general'
    ? [...contextSuggestions, ...skillSuggestions]
    : [...skillSuggestions, ...contextSuggestions];
  return suggestions.slice(0, 4);
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
    .replaceAll('<NFL team>', state.team ?? '<NFL team>')
    .replaceAll('<number>', state.week === null ? '<number>' : String(state.week));
}

function nflSeason(now: Date): number {
  const month = now.getUTCMonth() + 1;
  return month <= 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
}
