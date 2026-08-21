import type {
  SleeperLeague,
  SleeperPlayer,
  SleeperPlayerMap,
  SleeperRoster,
} from './types.js';

export type FantasyActionKind = 'deadline' | 'lineup' | 'player-status';
export type FantasyActionUrgency = 'high' | 'medium' | 'low';

export interface FantasyLeagueAction {
  details: string;
  id: string;
  kind: FantasyActionKind;
  nextStep: string;
  playerId: string | null;
  rosterId: number | null;
  title: string;
  urgency: FantasyActionUrgency;
}

export interface FantasyLineupSummary {
  filledSlots: number;
  openSlots: number;
  rosterId: number;
  starterSlots: number;
}

export interface FantasyPlayerStatusSignal {
  label: string;
  name: string;
  playerId: string;
  position: string | null;
  rosterId: number;
  starter: boolean;
  team: string | null;
  urgency: Exclude<FantasyActionUrgency, 'low'>;
}

export interface FantasyLeagueActionCenter {
  actions: FantasyLeagueAction[];
  lineups: FantasyLineupSummary[];
  playerStatusSignals: FantasyPlayerStatusSignal[];
}

export interface BuildFantasyLeagueActionCenterOptions {
  league: SleeperLeague;
  players: SleeperPlayerMap;
  rosters: SleeperRoster[];
  week: number | null;
}

const NON_STARTER_SLOTS = new Set(['BN', 'BENCH', 'IR', 'RESERVE', 'TAXI']);
const URGENCY_ORDER: Record<FantasyActionUrgency, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Build stable weekly actions from one league snapshot.
 * This function does not estimate player performance or invent a kickoff time.
 */
export function buildFantasyLeagueActionCenter(
  options: BuildFantasyLeagueActionCenterOptions,
): FantasyLeagueActionCenter {
  const lineups = buildLineupSummaries(options.league, options.rosters);
  const playerStatusSignals = buildPlayerStatusSignals(
    options.league,
    options.rosters,
    options.players,
  );
  const actions = [
    ...lineupActions(options.league, lineups),
    ...playerStatusActions(options.league, options.rosters, playerStatusSignals),
    ...deadlineActions(options.league, options.week),
  ].sort(compareActions);

  return { actions, lineups, playerStatusSignals };
}

export function compareFantasyLeagueActions(
  left: FantasyLeagueAction,
  right: FantasyLeagueAction,
): number {
  return compareActions(left, right);
}

function buildLineupSummaries(
  league: SleeperLeague,
  rosters: SleeperRoster[],
): FantasyLineupSummary[] {
  const starterSlots = league.roster_positions.filter(
    (slot) => !NON_STARTER_SLOTS.has(slot.toUpperCase()),
  ).length;
  return rosters.map((roster) => {
    const filledSlots = Math.min(
      starterSlots,
      (roster.starters ?? []).filter(validStarterId).length,
    );
    return {
      filledSlots,
      openSlots: Math.max(0, starterSlots - filledSlots),
      rosterId: roster.roster_id,
      starterSlots,
    };
  }).sort((left, right) => left.rosterId - right.rosterId);
}

function buildPlayerStatusSignals(
  league: SleeperLeague,
  rosters: SleeperRoster[],
  players: SleeperPlayerMap,
): FantasyPlayerStatusSignal[] {
  if (league.status !== 'in_season') return [];
  return rosters.flatMap((roster) => {
    const starters = new Set((roster.starters ?? []).filter(validStarterId));
    return [...new Set(roster.players ?? [])].flatMap((playerId) => {
      const player = players[playerId];
      if (!player) return [];
      const status = concerningStatus(player);
      if (!status) return [];
      return [{
        label: status.label,
        name: playerName(player),
        playerId,
        position: cleanValue(player.position),
        rosterId: roster.roster_id,
        starter: starters.has(playerId),
        team: cleanValue(player.team),
        urgency: status.urgency,
      }];
    });
  }).sort(compareStatusSignals);
}

function lineupActions(
  league: SleeperLeague,
  lineups: FantasyLineupSummary[],
): FantasyLeagueAction[] {
  if (league.status !== 'in_season') return [];
  return lineups.flatMap((lineup) => {
    if (lineup.openSlots === 0) return [];
    const noun = lineup.openSlots === 1 ? 'slot is' : 'slots are';
    return [{
      details: `${lineup.openSlots} of ${lineup.starterSlots} starter ${noun} empty.`,
      id: `${league.league_id}:roster-${lineup.rosterId}:lineup`,
      kind: 'lineup',
      nextStep: 'Fill every open starter slot before the first relevant kickoff.',
      playerId: null,
      rosterId: lineup.rosterId,
      title: `${lineup.openSlots} open starter ${lineup.openSlots === 1 ? 'slot' : 'slots'}`,
      urgency: 'high',
    }];
  });
}

function playerStatusActions(
  league: SleeperLeague,
  rosters: SleeperRoster[],
  signals: FantasyPlayerStatusSignal[],
): FantasyLeagueAction[] {
  const reserveByRoster = new Map(
    rosters.map((roster) => [roster.roster_id, new Set(roster.reserve ?? [])]),
  );
  const hasReserveSlot = league.roster_positions.some((slot) => {
    const value = slot.toUpperCase();
    return value === 'IR' || value === 'RESERVE';
  });
  return signals.flatMap((signal) => {
    if (signal.starter) {
      return [{
        details: `${signal.name} has a ${signal.label} status${playerContext(signal)}.`,
        id: `${league.league_id}:roster-${signal.rosterId}:player-${signal.playerId}`,
        kind: 'player-status' as const,
        nextStep: signal.urgency === 'high'
          ? 'Check the latest report and choose a healthy replacement before kickoff.'
          : 'Check the final game status before kickoff and prepare a replacement.',
        playerId: signal.playerId,
        rosterId: signal.rosterId,
        title: `${signal.name} needs a lineup check`,
        urgency: signal.urgency,
      }];
    }
    if (
      signal.urgency === 'high' &&
      hasReserveSlot &&
      !reserveByRoster.get(signal.rosterId)?.has(signal.playerId)
    ) {
      return [{
        details: `${signal.name} has a ${signal.label} status${playerContext(signal)}.`,
        id: `${league.league_id}:roster-${signal.rosterId}:reserve-${signal.playerId}`,
        kind: 'player-status' as const,
        nextStep: 'Check reserve eligibility and open a bench spot if the league permits it.',
        playerId: signal.playerId,
        rosterId: signal.rosterId,
        title: `${signal.name} could need a reserve move`,
        urgency: 'medium' as const,
      }];
    }
    return [];
  });
}

function deadlineActions(
  league: SleeperLeague,
  week: number | null,
): FantasyLeagueAction[] {
  if (league.status !== 'in_season' || week === null) return [];
  const actions: FantasyLeagueAction[] = [];
  const tradeDeadline = settingInteger(league.settings.trade_deadline, 1, 18);
  if (tradeDeadline === week || tradeDeadline === week + 1) {
    const isThisWeek = tradeDeadline === week;
    actions.push({
      details: `The league trade deadline is the end of NFL Week ${tradeDeadline}.`,
      id: `${league.league_id}:trade-deadline:${tradeDeadline}`,
      kind: 'deadline',
      nextStep: isThisWeek
        ? 'Review and submit any final trade before the league deadline.'
        : 'Review roster needs and start trade talks this week.',
      playerId: null,
      rosterId: null,
      title: isThisWeek ? 'Trade deadline is this week' : 'Trade deadline is next week',
      urgency: isThisWeek ? 'high' : 'medium',
    });
  }
  const playoffStart = settingInteger(league.settings.playoff_week_start, 1, 18);
  if (playoffStart === week || playoffStart === week + 1) {
    const isThisWeek = playoffStart === week;
    actions.push({
      details: `The fantasy playoffs start in Week ${playoffStart}.`,
      id: `${league.league_id}:playoff-start:${playoffStart}`,
      kind: 'deadline',
      nextStep: 'Check lineup depth and the upcoming schedule before lineups lock.',
      playerId: null,
      rosterId: null,
      title: isThisWeek ? 'Fantasy playoffs start this week' : 'Fantasy playoffs start next week',
      urgency: isThisWeek ? 'medium' : 'low',
    });
  }
  return actions;
}

function concerningStatus(player: SleeperPlayer): {
  label: string;
  urgency: Exclude<FantasyActionUrgency, 'low'>;
} | null {
  const injury = cleanValue(player.injury_status);
  const status = cleanValue(player.status);
  const practice = cleanValue(player.practice_participation);
  const combined = [injury, status, practice].filter(Boolean).join(' ').toLowerCase();
  if (/\b(out|doubtful|inactive|injured reserve|ir|suspended|pup|physically unable|non-football injury|nfi)\b/u.test(combined)) {
    return { label: injury ?? nonActiveStatus(status) ?? practice ?? 'unavailable', urgency: 'high' };
  }
  if (/\b(questionable|game[- ]time decision|limited|did not participate|dnp)\b/u.test(combined)) {
    return { label: injury ?? practice ?? nonActiveStatus(status) ?? 'questionable', urgency: 'medium' };
  }
  return null;
}

function nonActiveStatus(value: string | null): string | null {
  return value?.toLowerCase() === 'active' ? null : value;
}

function playerName(player: SleeperPlayer): string {
  return cleanValue(player.full_name) ?? (
    [cleanValue(player.first_name), cleanValue(player.last_name)].filter(Boolean).join(' ') ||
    player.player_id
  );
}

function playerContext(signal: FantasyPlayerStatusSignal): string {
  const values = [signal.team, signal.position].filter(Boolean);
  return values.length > 0 ? ` (${values.join(' ')})` : '';
}

function cleanValue(value: string | null | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

function validStarterId(value: string): boolean {
  const normalized = value.trim();
  return normalized.length > 0 && normalized !== '0';
}

function compareActions(
  left: FantasyLeagueAction,
  right: FantasyLeagueAction,
): number {
  return URGENCY_ORDER[left.urgency] - URGENCY_ORDER[right.urgency] ||
    actionKindOrder(left.kind) - actionKindOrder(right.kind) ||
    (left.rosterId ?? 0) - (right.rosterId ?? 0) ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id);
}

function compareStatusSignals(
  left: FantasyPlayerStatusSignal,
  right: FantasyPlayerStatusSignal,
): number {
  return Number(right.starter) - Number(left.starter) ||
    URGENCY_ORDER[left.urgency] - URGENCY_ORDER[right.urgency] ||
    left.rosterId - right.rosterId ||
    left.name.localeCompare(right.name) ||
    left.playerId.localeCompare(right.playerId);
}

function actionKindOrder(kind: FantasyActionKind): number {
  if (kind === 'lineup') return 0;
  if (kind === 'player-status') return 1;
  return 2;
}

function settingInteger(
  value: string | number | boolean | null | undefined,
  minimum: number,
  maximum: number,
): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum
    ? number
    : null;
}
