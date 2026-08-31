import { normalizePlayerName } from '../identity/normalize.js';
import type { NflversePlayerWeek } from '../nflverse/types.js';
import { scorePlayerWeek } from '../projection/player-projection.js';
import type {
  SleeperLeague,
  SleeperPlayer,
  SleeperPlayerMap,
  SleeperRoster,
  SleeperTrendingPlayer,
} from '../sleeper/types.js';

export type WaiverRiskLevel = 'low' | 'medium' | 'high';
export type WaiverNeedLevel = 'critical' | 'high' | 'medium' | 'depth';

export interface WaiverProduction {
  analysisSeason: number;
  games: number;
  latestWeek: number;
  recentAverage: number;
  seasonAverage: number;
  trend: 'rising' | 'steady' | 'falling';
  weeklyPoints: Array<{ points: number; week: number }>;
}

export interface WaiverRosterNeed {
  directStarterSlots: number;
  flexibleStarterSlots: number;
  injuredAtPosition: number;
  level: WaiverNeedLevel;
  reason: string;
  rosteredAtPosition: number;
  score: number;
  viableAtPosition: number;
}

export interface WaiverDemand {
  adds: number;
  lookbackHours: number;
  score: number;
  sourceScope: 'Sleeper platform';
}

export interface WaiverRisk {
  level: WaiverRiskLevel;
  reasons: string[];
  score: number;
}

export interface FaabRange {
  budget: number;
  lower: number;
  lowerPercent: number;
  minimumBid: number;
  rationale: string;
  remaining: number;
  upper: number;
  upperPercent: number;
  used: number;
}

export interface RankedWaiverCandidate {
  demand: WaiverDemand;
  faab: FaabRange | null;
  player: {
    active: boolean | null;
    injuryStatus: string | null;
    name: string;
    playerId: string;
    position: string;
    status: string | null;
    team: string | null;
  };
  production: WaiverProduction | null;
  productionScore: number;
  rank: number;
  rankScore: number;
  rosterNeed: WaiverRosterNeed;
  risk: WaiverRisk;
}

export interface WaiverAssistantResult {
  analysisSeason: number;
  candidatePool: {
    ranked: number;
    requestedTrendingAdds: number;
    skippedInactive: number;
    skippedRostered: number;
    skippedUnsupportedPosition: number;
  };
  faab: {
    budget: number | null;
    minimumBid: number;
    mode: 'faab' | 'priority' | 'unknown';
    remaining: number | null;
    used: number | null;
  };
  league: {
    leagueId: string;
    name: string;
  };
  limitations: string[];
  methodology: {
    candidatePool: string;
    demand: string;
    faab: string;
    production: string;
    rankFormula: string;
    rosterNeed: string;
    scoringKeysIgnored: string[];
    scoringKeysUsed: string[];
  };
  rosterId: number;
  targets: RankedWaiverCandidate[];
  throughWeek: number;
}

export interface RankWaiverTargetsInput {
  analysisSeason: number;
  league: SleeperLeague;
  lookbackHours: number;
  nflverseRows: readonly NflversePlayerWeek[];
  players: SleeperPlayerMap;
  resultLimit: number;
  rosters: readonly SleeperRoster[];
  selectedRoster: SleeperRoster;
  throughWeek: number;
  trendingAdds: readonly SleeperTrendingPlayer[];
}

interface PreparedCandidate {
  demand: WaiverDemand;
  player: SleeperPlayer;
  production: WaiverProduction | null;
  productionScore: number;
  rosterNeed: WaiverRosterNeed;
  risk: WaiverRisk;
}

const ACTIVE_PLAYER_POSITIONS = new Set([
  'QB',
  'RB',
  'WR',
  'TE',
  'K',
  'DEF',
  'DL',
  'LB',
  'DB',
]);
const NON_STARTER_SLOTS = new Set(['BN', 'BENCH', 'IR', 'RESERVE', 'TAXI']);
const SUPPORTED_SCORING_KEYS = new Set([
  'pass_yd',
  'pass_td',
  'pass_int',
  'rush_yd',
  'rush_td',
  'rec',
  'rec_yd',
  'rec_td',
  'bonus_pass_yd_300',
  'bonus_pass_yd_400',
  'bonus_rush_yd_100',
  'bonus_rush_yd_200',
  'bonus_rec_yd_100',
  'bonus_rec_yd_200',
]);
const PRODUCTION_REFERENCE_POINTS = new Map([
  ['QB', 24],
  ['RB', 16],
  ['WR', 16],
  ['TE', 12],
  ['K', 10],
  ['DEF', 10],
  ['DL', 10],
  ['LB', 10],
  ['DB', 10],
]);
const DEMAND_REFERENCE_ADDS = 1_000;

/** Rank read-only waiver candidates from one league snapshot. */
export function rankWaiverTargets(
  input: RankWaiverTargetsInput,
): WaiverAssistantResult {
  const ownedPlayerIds = collectOwnedPlayerIds(input.rosters);
  const eligiblePositions = collectEligiblePositions(input.league.roster_positions);
  const rosterPlayers = collectRosterPlayers(input.selectedRoster, input.players);
  const rowsByPlayer = resolveNflverseRows(input.trendingAdds, input.players, input.nflverseRows);
  let skippedInactive = 0;
  let skippedRostered = 0;
  let skippedUnsupportedPosition = 0;

  const prepared = input.trendingAdds.flatMap((trend): PreparedCandidate[] => {
    if (ownedPlayerIds.has(trend.player_id)) {
      skippedRostered += 1;
      return [];
    }
    const player = input.players[trend.player_id];
    if (!player || player.active === false) {
      skippedInactive += 1;
      return [];
    }
    const position = playerPosition(player);
    if (!position || !eligiblePositions.has(position)) {
      skippedUnsupportedPosition += 1;
      return [];
    }
    const rows = rowsByPlayer.get(player.player_id) ?? [];
    const production = summarizeProduction(
      rows,
      input.league,
      input.analysisSeason,
      input.throughWeek,
    );
    const rosterNeed = calculateRosterNeed(
      position,
      input.league.roster_positions,
      rosterPlayers,
    );
    const risk = calculateRisk(player, production);
    return [{
      demand: {
        adds: trend.count,
        lookbackHours: input.lookbackHours,
        score: demandScore(trend.count),
        sourceScope: 'Sleeper platform',
      },
      player,
      production,
      productionScore: 0,
      rosterNeed,
      risk,
    }];
  });

  assignProductionScores(prepared);
  const faab = leagueFaab(input.league, input.selectedRoster);
  const targets = prepared
    .map((candidate) => finalizeCandidate(candidate, faab))
    .sort(compareCandidates)
    .slice(0, input.resultLimit)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  const scoring = inspectScoring(input.league);
  const missingProduction = targets.filter((target) => target.production === null).length;
  const limitations = [
    'Sleeper add counts cover the complete Sleeper platform. They do not show demand inside this league.',
    'Sleeper player status fields are profile data. They are not an official NFL injury report.',
    ...(missingProduction > 0
      ? [`nflverse has no resolved recent production for ${missingProduction} ranked target${missingProduction === 1 ? '' : 's'}.`]
      : []),
    ...(scoring.ignored.length > 0
      ? [`The production calculation cannot apply these scoring settings: ${scoring.ignored.join(', ')}.`]
      : []),
  ];

  return {
    analysisSeason: input.analysisSeason,
    candidatePool: {
      ranked: targets.length,
      requestedTrendingAdds: input.trendingAdds.length,
      skippedInactive,
      skippedRostered,
      skippedUnsupportedPosition,
    },
    faab: {
      budget: faab?.budget ?? null,
      minimumBid: faab?.minimumBid ?? 0,
      mode: waiverMode(input.league, faab),
      remaining: faab?.remaining ?? null,
      used: faab?.used ?? null,
    },
    league: {
      leagueId: input.league.league_id,
      name: input.league.name,
    },
    limitations,
    methodology: {
      candidatePool: 'The pool starts with Sleeper trending adds. It removes every player found on any league roster.',
      demand: 'Demand uses an absolute logarithmic scale. One add scores near 10 and 1,000 adds scores 100.',
      faab: 'Each score tier maps to a percentage of the original league budget. Each range stops at the selected roster remaining budget.',
      production: 'Recent production uses the last three resolved nflverse games and the selected league scoring settings.',
      rankFormula: '45% recent production + 30% roster need + 25% Sleeper demand - 20% risk.',
      rosterNeed: 'Need compares viable players at the candidate position with direct and flexible starter slots.',
      scoringKeysIgnored: scoring.ignored,
      scoringKeysUsed: scoring.used,
    },
    rosterId: input.selectedRoster.roster_id,
    targets,
    throughWeek: input.throughWeek,
  };
}

function resolveNflverseRows(
  trendingAdds: readonly SleeperTrendingPlayer[],
  players: SleeperPlayerMap,
  rows: readonly NflversePlayerWeek[],
): Map<string, NflversePlayerWeek[]> {
  const groups = new Map<string, NflversePlayerWeek[]>();
  for (const trend of trendingAdds) {
    const player = players[trend.player_id];
    if (!player) continue;
    const name = normalizePlayerName(playerName(player));
    const position = playerPosition(player);
    const matches = rows.filter((row) =>
      normalizePlayerName(row.playerDisplayName) === name &&
      (!position || row.position.toUpperCase() === position),
    );
    const byId = groupRowsById(matches);
    const sameTeam = byId.filter((group) => {
      const latest = group.at(-1);
      return latest && player.team && latest.team === player.team.toUpperCase();
    });
    const selected = sameTeam.length === 1
      ? sameTeam[0]
      : byId.length === 1 ? byId[0] : null;
    if (selected) groups.set(player.player_id, selected);
  }
  return groups;
}

function groupRowsById(rows: readonly NflversePlayerWeek[]): NflversePlayerWeek[][] {
  const groups = new Map<string, NflversePlayerWeek[]>();
  for (const row of rows) {
    const group = groups.get(row.playerId) ?? [];
    group.push(row);
    groups.set(row.playerId, group);
  }
  return [...groups.values()].map((group) =>
    group.sort((left, right) => left.week - right.week),
  );
}

function summarizeProduction(
  rows: readonly NflversePlayerWeek[],
  league: SleeperLeague,
  analysisSeason: number,
  throughWeek: number,
): WaiverProduction | null {
  const selected = rows
    .filter((row) =>
      row.season === analysisSeason &&
      row.seasonType === 'REG' &&
      row.week <= throughWeek,
    )
    .sort((left, right) => left.week - right.week);
  const latest = selected.at(-1);
  if (!latest) return null;
  const weeklyPoints = selected.map((row) => ({
    points: scorePlayerWeek(row, league.scoring_settings),
    week: row.week,
  }));
  const recent = weeklyPoints.slice(-3);
  const seasonAverage = average(weeklyPoints.map((item) => item.points));
  const recentAverage = average(recent.map((item) => item.points));
  const change = recentAverage - seasonAverage;
  const steadyThreshold = Math.max(1, Math.abs(seasonAverage) * 0.1);
  return {
    analysisSeason,
    games: weeklyPoints.length,
    latestWeek: latest.week,
    recentAverage,
    seasonAverage,
    trend: change > steadyThreshold
      ? 'rising'
      : change < -steadyThreshold ? 'falling' : 'steady',
    weeklyPoints,
  };
}

function calculateRosterNeed(
  position: string,
  rosterSlots: readonly string[],
  rosterPlayers: readonly SleeperPlayer[],
): WaiverRosterNeed {
  const directStarterSlots = rosterSlots.filter(
    (slot) => slot.toUpperCase() === position,
  ).length;
  const flexibleStarterSlots = rosterSlots.filter((slot) =>
    flexibleSlotPositions(slot).has(position),
  ).length;
  const atPosition = rosterPlayers.filter((player) => playerPosition(player) === position);
  const injuredAtPosition = atPosition.filter(hasAvailabilityConcern).length;
  const viableAtPosition = atPosition.filter((player) => !isUnavailable(player)).length;
  let level: WaiverNeedLevel;
  let score: number;
  let reason: string;
  if (viableAtPosition < directStarterSlots) {
    level = 'critical';
    score = 95;
    reason = `The roster has ${viableAtPosition} viable ${position} players for ${directStarterSlots} direct starter slots.`;
  } else if (
    viableAtPosition <= directStarterSlots && flexibleStarterSlots > 0
  ) {
    level = 'high';
    score = 78;
    reason = `The roster covers its direct ${position} slots but has no ${position} depth for ${flexibleStarterSlots} flexible slots.`;
  } else if (injuredAtPosition > 0 || viableAtPosition < directStarterSlots + 2) {
    level = 'medium';
    score = injuredAtPosition > 0 ? 62 : 48;
    reason = injuredAtPosition > 0
      ? `${injuredAtPosition} rostered ${position} player${injuredAtPosition === 1 ? ' has' : 's have'} a status concern.`
      : `The roster has ${viableAtPosition} viable ${position} players and limited depth.`;
  } else {
    level = 'depth';
    score = 22;
    reason = `The roster has ${viableAtPosition} viable ${position} players for ${directStarterSlots} direct slots.`;
  }
  return {
    directStarterSlots,
    flexibleStarterSlots,
    injuredAtPosition,
    level,
    reason,
    rosteredAtPosition: atPosition.length,
    score,
    viableAtPosition,
  };
}

function calculateRisk(
  player: SleeperPlayer,
  production: WaiverProduction | null,
): WaiverRisk {
  const reasons: string[] = [];
  let score = 8;
  if (isUnavailable(player)) {
    reasons.push('The Sleeper profile marks the player as unavailable.');
    score = 100;
  } else if (hasAvailabilityConcern(player)) {
    reasons.push('The Sleeper profile contains a current status concern.');
    score = Math.max(score, 55);
  }
  if (!production) {
    reasons.push('No recent nflverse game production resolves to this player.');
    score = Math.max(score, 70);
  } else if (production.games < 3) {
    reasons.push(`The production sample contains only ${production.games} game${production.games === 1 ? '' : 's'}.`);
    score = Math.max(score, 45);
  } else {
    const points = production.weeklyPoints.map((item) => item.points);
    const volatility = standardDeviation(points);
    if (volatility > Math.max(6, Math.abs(production.seasonAverage) * 0.65)) {
      reasons.push('Recent scoring has high week-to-week variation.');
      score = Math.max(score, 38);
    }
  }
  if (reasons.length === 0) reasons.push('The available profile and production show no large risk signal.');
  return {
    level: score >= 65 ? 'high' : score >= 35 ? 'medium' : 'low',
    reasons,
    score,
  };
}

function assignProductionScores(candidates: PreparedCandidate[]): void {
  for (const candidate of candidates) {
    const position = playerPosition(candidate.player);
    const reference = position ? PRODUCTION_REFERENCE_POINTS.get(position) ?? 16 : 16;
    candidate.productionScore = candidate.production
      ? round(clamp(candidate.production.recentAverage / reference * 100, 0, 100))
      : 0;
  }
}

function demandScore(adds: number): number {
  if (!Number.isFinite(adds) || adds <= 0) return 0;
  return round(clamp(
    Math.log10(adds + 1) / Math.log10(DEMAND_REFERENCE_ADDS + 1) * 100,
    0,
    100,
  ));
}

function finalizeCandidate(
  candidate: PreparedCandidate,
  faab: Omit<FaabRange, 'lower' | 'lowerPercent' | 'rationale' | 'upper' | 'upperPercent'> | null,
): RankedWaiverCandidate {
  const rankScore = round(clamp(
    candidate.productionScore * 0.45 +
    candidate.rosterNeed.score * 0.3 +
    candidate.demand.score * 0.25 -
    candidate.risk.score * 0.2,
    0,
    100,
  ));
  return {
    demand: candidate.demand,
    faab: faabRange(rankScore, candidate.risk.level, faab),
    player: {
      active: candidate.player.active ?? null,
      injuryStatus: clean(candidate.player.injury_status),
      name: playerName(candidate.player),
      playerId: candidate.player.player_id,
      position: playerPosition(candidate.player) ?? 'UNKNOWN',
      status: clean(candidate.player.status),
      team: clean(candidate.player.team)?.toUpperCase() ?? null,
    },
    production: candidate.production,
    productionScore: candidate.productionScore,
    rank: 0,
    rankScore,
    rosterNeed: candidate.rosterNeed,
    risk: candidate.risk,
  };
}

function faabRange(
  rankScore: number,
  risk: WaiverRiskLevel,
  faab: Omit<FaabRange, 'lower' | 'lowerPercent' | 'rationale' | 'upper' | 'upperPercent'> | null,
): FaabRange | null {
  if (!faab) return null;
  let [lowerPercent, upperPercent] = rankScore >= 80
    ? [18, 30]
    : rankScore >= 65
      ? [10, 18]
      : rankScore >= 50
        ? [5, 10]
        : rankScore >= 35 ? [2, 5] : [0, 2];
  if (risk === 'high') {
    lowerPercent = 0;
    upperPercent = Math.min(upperPercent, 5);
  }
  let lower = Math.min(faab.remaining, Math.round(faab.budget * lowerPercent / 100));
  let upper = Math.min(faab.remaining, Math.round(faab.budget * upperPercent / 100));
  if (faab.remaining >= faab.minimumBid && upper > 0) {
    lower = Math.max(lower, faab.minimumBid);
    upper = Math.max(upper, lower);
  }
  return {
    ...faab,
    lower,
    lowerPercent,
    rationale: `The ${rankScore} rank score maps to ${lowerPercent}-${upperPercent}% of the ${faab.budget} season budget. The roster has ${faab.remaining} remaining.`,
    upper,
    upperPercent,
  };
}

function leagueFaab(
  league: SleeperLeague,
  roster: SleeperRoster,
): Omit<FaabRange, 'lower' | 'lowerPercent' | 'rationale' | 'upper' | 'upperPercent'> | null {
  const budget = numericSetting(league.settings.waiver_budget);
  if (budget === null || budget < 0) return null;
  const used = Math.max(0, roster.settings.waiver_budget_used ?? 0);
  return {
    budget,
    minimumBid: Math.max(0, numericSetting(league.settings.waiver_bid_min) ?? 0),
    remaining: Math.max(0, budget - used),
    used,
  };
}

function waiverMode(
  league: SleeperLeague,
  faab: ReturnType<typeof leagueFaab>,
): 'faab' | 'priority' | 'unknown' {
  const waiverType = numericSetting(league.settings.waiver_type);
  if (waiverType === 2 || faab) return 'faab';
  if (waiverType !== null) return 'priority';
  return 'unknown';
}

function inspectScoring(league: SleeperLeague): { ignored: string[]; used: string[] } {
  const activeKeys = Object.entries(league.scoring_settings)
    .filter(([, value]) => typeof value === 'number' && value !== 0)
    .map(([key]) => key)
    .sort();
  return {
    ignored: activeKeys.filter((key) => !SUPPORTED_SCORING_KEYS.has(key)),
    used: activeKeys.filter((key) => SUPPORTED_SCORING_KEYS.has(key)),
  };
}

function collectOwnedPlayerIds(rosters: readonly SleeperRoster[]): Set<string> {
  return new Set(rosters.flatMap((roster) => [
    ...(roster.players ?? []),
    ...(roster.starters ?? []),
    ...(roster.reserve ?? []),
    ...(roster.taxi ?? []),
  ]).filter(validPlayerId));
}

function collectRosterPlayers(
  roster: SleeperRoster,
  players: SleeperPlayerMap,
): SleeperPlayer[] {
  const ids = new Set([
    ...(roster.players ?? []),
    ...(roster.starters ?? []),
    ...(roster.reserve ?? []),
    ...(roster.taxi ?? []),
  ].filter(validPlayerId));
  return [...ids].flatMap((id) => players[id] ? [players[id]] : []);
}

function collectEligiblePositions(slots: readonly string[]): Set<string> {
  const positions = new Set<string>();
  for (const rawSlot of slots) {
    const slot = rawSlot.toUpperCase();
    if (NON_STARTER_SLOTS.has(slot)) continue;
    if (ACTIVE_PLAYER_POSITIONS.has(slot)) positions.add(slot);
    for (const position of flexibleSlotPositions(slot)) positions.add(position);
  }
  return positions;
}

function flexibleSlotPositions(slot: string): Set<string> {
  switch (slot.toUpperCase()) {
    case 'FLEX':
    case 'WRRBTE_FLEX':
      return new Set(['RB', 'WR', 'TE']);
    case 'SUPER_FLEX':
      return new Set(['QB', 'RB', 'WR', 'TE']);
    case 'REC_FLEX':
    case 'WRTE_FLEX':
      return new Set(['WR', 'TE']);
    case 'WRRB_FLEX':
      return new Set(['RB', 'WR']);
    case 'IDP_FLEX':
      return new Set(['DL', 'LB', 'DB']);
    default:
      return new Set();
  }
}

function isUnavailable(player: SleeperPlayer): boolean {
  const value = [player.status, player.injury_status, player.practice_participation]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return /\b(out|doubtful|inactive|injured reserve|ir|suspended|pup|nfi)\b/u.test(value);
}

function hasAvailabilityConcern(player: SleeperPlayer): boolean {
  if (isUnavailable(player)) return true;
  const value = [player.status, player.injury_status, player.practice_participation]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return /\b(questionable|limited|did not participate|dnp|game[- ]time decision)\b/u.test(value);
}

function playerPosition(player: SleeperPlayer): string | null {
  return clean(player.position)?.toUpperCase() ??
    player.fantasy_positions?.map((position) => position.toUpperCase()).find(
      (position) => ACTIVE_PLAYER_POSITIONS.has(position),
    ) ?? null;
}

function playerName(player: SleeperPlayer): string {
  const combined = [clean(player.first_name), clean(player.last_name)]
    .filter(Boolean)
    .join(' ');
  return clean(player.full_name) ?? (combined || `Player ${player.player_id}`);
}

function compareCandidates(
  left: RankedWaiverCandidate,
  right: RankedWaiverCandidate,
): number {
  return right.rankScore - left.rankScore ||
    right.demand.adds - left.demand.adds ||
    left.player.name.localeCompare(right.player.name) ||
    left.player.playerId.localeCompare(right.player.playerId);
}

function validPlayerId(value: string): boolean {
  return Boolean(value && value !== '0');
}

function numericSetting(value: number | string | boolean | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function clean(value: string | null | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned || null;
}

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : round(values.reduce((total, value) => total + value, 0) / values.length);
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce(
    (total, value) => total + (value - mean) ** 2,
    0,
  ) / values.length;
  return round(Math.sqrt(variance));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
