import { normalizePlayerName } from '../identity/normalize.js';
import { optimizeLineup } from '../analysis/lineup.js';
import { forecastMean, type ProjectionParameters } from '../projection/statistics.js';
import type { NflversePlayerWeek } from '../nflverse/types.js';
import {
  inspectPlayerScoringSettings,
  scorePlayerWeek,
} from '../projection/player-projection.js';
import type {
  SleeperLeague,
  SleeperPlayer,
  SleeperRoster,
} from '../sleeper/types.js';

export interface TradePlayerImpact {
  availabilityFactor: number;
  estimatedWeeklyValue: number;
  games: number;
  injuryStatus: string | null;
  name: string;
  playerId: string;
  position: string;
  recentAverage: number;
  seasonAverage: number;
  team: string | null;
  volatility: number;
}

export interface TradeSideImpact {
  players: TradePlayerImpact[];
  totalWeeklyValue: number;
}

export interface TradeRosterFitChange {
  after: number;
  before: number;
  minimumStarters: number;
  position: string;
  state: 'improved' | 'reduced' | 'unchanged';
}

export interface TradeImpactAnalysis {
  analysisSeason: number;
  give: TradeSideImpact;
  league: {
    leagueId: string;
    name: string;
    season: string;
  };
  limitations: string[];
  recommendationEligible: false;
  receive: TradeSideImpact;
  rosterFit: TradeRosterFitChange[];
  rosterId: number;
  scoring: {
    ignoredSettings: string[];
    usedSettings: string[];
  };
  throughWeek: number;
  valueDelta: number;
  lineupImpact: { scope: 'offensive-starters'; before: ReturnType<typeof optimizeLineup>; after: ReturnType<typeof optimizeLineup>; delta: number } | null;
  verdict: 'insufficient-lineup-data' | 'close' | 'gives-more-weekly-value' | 'receives-more-weekly-value';
}

export interface AnalyzeTradeImpactInput {
  parameters?: ProjectionParameters;
  analysisSeason: number;
  givePlayers: SleeperPlayer[];
  league: SleeperLeague;
  receivePlayers: SleeperPlayer[];
  roster: SleeperRoster;
  rosterPlayers: SleeperPlayer[];
  rows: readonly NflversePlayerWeek[];
  throughWeek: number;
}

const OFFENSIVE_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
const OFFENSIVE_SLOTS = new Set(['QB', 'RB', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'REC_FLEX', 'WRTE_FLEX', 'WRRB_FLEX', 'WRRBTE_FLEX']);
const NON_STARTER_SLOTS = new Set(['BN', 'BENCH', 'FLEX', 'SUPER_FLEX', 'REC_FLEX', 'IDP_FLEX', 'IR', 'RESERVE', 'TAXI']);

export function analyzeTradeImpact(
  input: AnalyzeTradeImpactInput,
): TradeImpactAnalysis {
  if (input.givePlayers.length === 0 || input.receivePlayers.length === 0) {
    throw new Error('A trade analysis needs at least one player on each side.');
  }
  if ([...input.givePlayers, ...input.receivePlayers].some((player) => !OFFENSIVE_POSITIONS.has(player.position?.toUpperCase() ?? ''))) throw new Error('Trade forecasts support QB, RB, WR, and TE players.');
  const rowsByName = groupRowsByName(input.rows.filter((row) => row.season === input.analysisSeason && row.seasonType === 'REG'), input.throughWeek);
  const allRows = [...rowsByName.values()].flat();
  const priorFor = buildPriorLookup(allRows, input.league.scoring_settings);
  const give = tradeSide(input.givePlayers, rowsByName, allRows, input.league, input.parameters, priorFor);
  const receive = tradeSide(input.receivePlayers, rowsByName, allRows, input.league, input.parameters, priorFor);
  const giveIds = new Set(input.givePlayers.map((player) => player.player_id));
  const afterPlayers = [...input.rosterPlayers.filter((player) => !giveIds.has(player.player_id)), ...input.receivePlayers];
  const starterIds = new Set(input.roster.starters ?? []);
  const skippedBenchPlayers = new Set<string>();
  let lineupImpact: TradeImpactAnalysis['lineupImpact'] = null;
  try {
    const knownSlots = new Set([...OFFENSIVE_SLOTS, 'K', 'DEF', 'DL', 'DE', 'DT', 'LB', 'DB', 'CB', 'S', 'IDP_FLEX', 'IDP', 'BN', 'BENCH', 'IR', 'RESERVE', 'TAXI']);
    if (input.league.roster_positions.some((slot) => !knownSlots.has(slot.toUpperCase()))) throw new Error('Unsupported starter slot.');
    const lineup = (players: SleeperPlayer[]) => optimizeLineup(
      players.filter((player) => OFFENSIVE_POSITIONS.has(player.position?.toUpperCase() ?? '')).flatMap((player) => {
        try {
          const [impact] = tradeSide([player], rowsByName, allRows, input.league, input.parameters, priorFor).players;
          return impact ? [{
            id: impact.playerId,
            name: impact.name,
            positions: player.fantasy_positions?.length ? player.fantasy_positions : [impact.position],
            points: impact.estimatedWeeklyValue,
          }] : [];
        } catch (error) {
          if (starterIds.has(player.player_id) || !isSkippableBenchPlayerError(error)) {
            throw error;
          }
          skippedBenchPlayers.add(playerName(player));
          return [];
        }
      }), input.league.roster_positions.filter((slot) => OFFENSIVE_SLOTS.has(slot.toUpperCase())));
    if ((input.roster.players ?? []).some((id) => !input.rosterPlayers.some((player) => player.player_id === id))) throw new Error('Missing roster identity.');
    const before = lineup(input.rosterPlayers);
    const after = lineup(afterPlayers);
    if (before.complete && after.complete && before.assignments.length > 0) lineupImpact = { scope: 'offensive-starters', before, after, delta: round(after.expectedPoints - before.expectedPoints) };
  } catch { /* Missing or ambiguous starter evidence prevents a lineup verdict. */ }
  const valueDelta = round(receive.totalWeeklyValue - give.totalWeeklyValue);
  const decisionDelta = lineupImpact?.delta ?? 0;
  const scoring = inspectPlayerScoringSettings(input.league.scoring_settings);
  const closeThreshold = Math.max(2, (give.totalWeeklyValue + receive.totalWeeklyValue) * 0.05);
  const rosterFit = rosterFitChanges(
    input.league,
    input.roster,
    input.rosterPlayers,
    input.givePlayers,
    input.receivePlayers,
  );

  return {
    analysisSeason: input.analysisSeason,
    give,
    league: {
      leagueId: input.league.league_id,
      name: input.league.name,
      season: input.league.season,
    },
    lineupImpact,
    limitations: [
      'The verdict measures the change in the best legal offensive starting lineup. Unchanged kicker and defense slots cancel from the comparison.',
      ...(!lineupImpact ? ['The full lineup lacks resolved production or supported starter slots. Seb cannot give a lineup value verdict.'] : []),
      ...(lineupImpact && skippedBenchPlayers.size > 0
        ? [`Lineup comparison excluded bench players without resolved historical production: ${[...skippedBenchPlayers].join(', ')}.`]
        : []),
      ...(input.givePlayers.length !== input.receivePlayers.length
        ? [`Uneven trade (${input.givePlayers.length} for ${input.receivePlayers.length}): total value delta does not account for the replacement waiver player or dropped roster spot.`]
        : []),
      'The value uses completed weekly production and the selected league scoring rules.',
      'The value excludes draft picks, contract values, and unverified market rankings.',
      'The Sleeper injury field is not an official injury report.',
      'Current news must support any final accept or decline recommendation.',
      ...(scoring.ignoredSettings.length > 0
        ? [`The value cannot calculate these active settings from nflverse weekly rows: ${scoring.ignoredSettings.join(', ')}.`]
        : []),
    ],
    recommendationEligible: false,
    receive,
    rosterFit,
    rosterId: input.roster.roster_id,
    scoring,
    throughWeek: input.throughWeek,
    valueDelta,
    verdict: !lineupImpact ? 'insufficient-lineup-data' : Math.abs(decisionDelta) <= closeThreshold
      ? 'close'
      : decisionDelta > 0
        ? 'receives-more-weekly-value'
        : 'gives-more-weekly-value',
  };
}

function tradeSide(
  players: readonly SleeperPlayer[],
  rowsByName: ReadonlyMap<string, NflversePlayerWeek[]>,
  allRows: readonly NflversePlayerWeek[],
  league: SleeperLeague,
  parameters?: ProjectionParameters,
  priorFor?: (position: string, playerId: string) => number | null,
): TradeSideImpact {
  const resolvePrior = priorFor ?? buildPriorLookup(allRows, league.scoring_settings);
  const impacts = players.map((player) => {
    const name = playerName(player);
    const gsisId = player.gsis_id?.trim();
    const normalizedPos = player.position?.toUpperCase() ?? '';
    let matches = (rowsByName.get(normalizeName(name)) ?? []).filter((row) => row.position === normalizedPos);
    if (gsisId) {
      const byGsis = allRows.filter((row) => row.playerId?.trim() === gsisId);
      if (byGsis.length > 0) matches = byGsis;
    }
    const ids = new Set(matches.map((row) => row.playerId));
    if (ids.size > 1 && player.team) {
      const targetTeam = player.team.toUpperCase();
      const matchingTeamIds = new Set(
        matches.filter((row) => row.team === targetTeam).map((row) => row.playerId),
      );
      if (matchingTeamIds.size === 1) {
        const teamMatchId = [...matchingTeamIds][0]!;
        matches = matches.filter((row) => row.playerId === teamMatchId);
      }
    }
    const resolvedIds = new Set(matches.map((row) => row.playerId));
    if (resolvedIds.size > 1) throw new Error(`The historical identity for ${name} is ambiguous.`);
    const rows = matches;
    if (new Set(rows.map((row) => row.week)).size !== rows.length) throw new Error('Duplicate player-week statistics cannot support a trade.');
    if (rows.length === 0) {
      throw new Error(`nflverse found no completed weekly statistics for ${name}.`);
    }
    const values = rows.map((row) => scorePlayerWeek(row, league.scoring_settings));
    const recent = values.slice(-3);
    const seasonAverage = average(values);
    const recentAverage = average(recent);
    const availabilityFactor = playerAvailabilityFactor(
      [player.injury_status, player.status].filter(Boolean).join(' ') || null,
    );
    return {
      availabilityFactor,
      estimatedWeeklyValue: round(
        forecastMean(values, resolvePrior(normalizedPos, rows[0]!.playerId), parameters) * availabilityFactor,
      ),
      games: rows.length,
      injuryStatus: [player.injury_status, player.status].filter(Boolean).join(' ') || null,
      name,
      playerId: player.player_id,
      position: normalizedPos || 'UNKNOWN',
      recentAverage: round(recentAverage),
      seasonAverage: round(seasonAverage),
      team: player.team ?? null,
      volatility: round(standardDeviation(values)),
    };
  });
  return {
    players: impacts,
    totalWeeklyValue: round(
      impacts.reduce((total, player) => total + player.estimatedWeeklyValue, 0),
    ),
  };
}

function buildPriorLookup(
  allRows: readonly NflversePlayerWeek[],
  scoring: SleeperLeague['scoring_settings'],
): (position: string, playerId: string) => number | null {
  const byPosition = new Map<
    string,
    { byPlayer: Map<string, { count: number; sum: number }>; totalCount: number; totalSum: number }
  >();
  return (position: string, playerId: string) => {
    let summary = byPosition.get(position);
    if (!summary) {
      summary = { byPlayer: new Map(), totalCount: 0, totalSum: 0 };
      for (const row of allRows) {
        if (row.position !== position) continue;
        const score = scorePlayerWeek(row, scoring);
        summary.totalCount += 1;
        summary.totalSum += score;
        const player = summary.byPlayer.get(row.playerId) ?? { count: 0, sum: 0 };
        player.count += 1;
        player.sum += score;
        summary.byPlayer.set(row.playerId, player);
      }
      byPosition.set(position, summary);
    }
    const excluded = summary.byPlayer.get(playerId);
    const count = summary.totalCount - (excluded?.count ?? 0);
    return count >= 20 ? (summary.totalSum - (excluded?.sum ?? 0)) / count : null;
  };
}

function isSkippableBenchPlayerError(error: unknown): boolean {
  return error instanceof Error && (
    error.message.startsWith('nflverse found no completed weekly statistics for ') ||
    error.message.startsWith('The historical identity for ') ||
    error.message === 'Duplicate player-week statistics cannot support a trade.'
  );
}

function rosterFitChanges(
  league: SleeperLeague,
  roster: SleeperRoster,
  rosterPlayers: readonly SleeperPlayer[],
  give: readonly SleeperPlayer[],
  receive: readonly SleeperPlayer[],
): TradeRosterFitChange[] {
  const playersByPosition = new Map<string, number>();
  const rosterPlayerIds = new Set(roster.players ?? []);
  for (const player of rosterPlayers) {
    if (!rosterPlayerIds.has(player.player_id)) continue;
    const position = player.position?.toUpperCase();
    if (position) playersByPosition.set(position, (playersByPosition.get(position) ?? 0) + 1);
  }
  const positions = [...new Set(
    [...give, ...receive]
      .map((player) => player.position?.toUpperCase())
      .filter((value): value is string => Boolean(value)),
  )].sort();
  return positions.map((position) => {
    const before = playersByPosition.get(position) ?? 0;
    const after = before - give.filter((player) => player.position?.toUpperCase() === position).length +
      receive.filter((player) => player.position?.toUpperCase() === position).length;
    const minimumStarters = league.roster_positions.filter(
      (slot) => slot.toUpperCase() === position && !NON_STARTER_SLOTS.has(slot.toUpperCase()),
    ).length;
    return {
      after,
      before,
      minimumStarters,
      position,
      state: after > before ? 'improved' : after < before ? 'reduced' : 'unchanged',
    };
  });
}

function groupRowsByName(
  rows: readonly NflversePlayerWeek[],
  throughWeek: number,
): Map<string, NflversePlayerWeek[]> {
  const groups = new Map<string, NflversePlayerWeek[]>();
  for (const row of rows) {
    if (row.week > throughWeek) continue;
    const key = normalizeName(row.playerDisplayName);
    const current = groups.get(key) ?? [];
    current.push(row);
    groups.set(key, current);
  }
  for (const values of groups.values()) {
    values.sort((left, right) => left.week - right.week);
  }
  return groups;
}

function playerAvailabilityFactor(status: string | null): number {
  const value = status?.trim().toLowerCase() ?? '';
  if (/\b(out|ir|pup|nfi|suspended|inactive|injured reserve)\b/.test(value)) return 0;
  if (value.includes('doubt')) return 0.4;
  if (value.includes('question')) return 0.85;
  return 1;
}

function playerName(player: SleeperPlayer): string {
  return player.full_name ?? (
    [player.first_name, player.last_name].filter(Boolean).join(' ') || player.player_id
  );
}

function normalizeName(value: string): string {
  return normalizePlayerName(value);
}

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
