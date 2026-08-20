import { getSkill } from './skills.js';

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
  const suggestions: string[] = [];
  if (!state.week) {
    suggestions.push(`/week <number>`);
  }
  if (!state.user) {
    suggestions.push('/leagues <Sleeper user>');
  } else if (!state.leagueId) {
    suggestions.push(`/leagues ${state.user}`);
  } else if (!state.rosterId) {
    suggestions.push(`/rosters ${state.leagueId}`);
  }
  if (!state.team) {
    suggestions.push(`/team <NFL code>`);
  }
  suggestions.push(...getSkill(state.skillId).suggestions);
  return suggestions.slice(0, 4);
}

function nflSeason(now: Date): number {
  const month = now.getUTCMonth() + 1;
  return month <= 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
}
