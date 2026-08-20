import type {
  NflverseGame,
  NflversePlayerWeek,
  PlayerTrendSummary,
  TeamPerformanceSummary,
} from './types.js';

export function summarizePlayerTrends(
  rows: readonly NflversePlayerWeek[],
): PlayerTrendSummary[] {
  const groups = new Map<string, NflversePlayerWeek[]>();
  for (const row of rows) {
    const group = groups.get(row.playerId) ?? [];
    group.push(row);
    groups.set(row.playerId, group);
  }
  return [...groups.values()]
    .map(summarizePlayer)
    .sort((left, right) => right.averagePprPoints - left.averagePprPoints);
}

export function summarizeTeamPerformance(
  team: string,
  games: readonly NflverseGame[],
  stats: readonly NflversePlayerWeek[],
): TeamPerformanceSummary {
  const normalizedTeam = team.trim().toUpperCase();
  const completedGames = games.filter(
    (game) =>
      (game.homeTeam === normalizedTeam || game.awayTeam === normalizedTeam) &&
      game.homeScore !== null &&
      game.awayScore !== null,
  );
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let pointsScored = 0;
  let pointsAllowed = 0;

  for (const game of completedGames) {
    const home = game.homeTeam === normalizedTeam;
    const scored = home ? game.homeScore ?? 0 : game.awayScore ?? 0;
    const allowed = home ? game.awayScore ?? 0 : game.homeScore ?? 0;
    pointsScored += scored;
    pointsAllowed += allowed;
    if (scored > allowed) {
      wins += 1;
    } else if (scored < allowed) {
      losses += 1;
    } else {
      ties += 1;
    }
  }

  const teamStats = stats.filter((row) => row.team === normalizedTeam);
  return {
    team: normalizedTeam,
    games: completedGames.length,
    wins,
    losses,
    ties,
    averagePointsScored: average(pointsScored, completedGames.length),
    averagePointsAllowed: average(pointsAllowed, completedGames.length),
    passingYards: sum(teamStats, (row) => row.passingYards),
    passingTouchdowns: sum(teamStats, (row) => row.passingTouchdowns),
    rushingYards: sum(teamStats, (row) => row.rushingYards),
    rushingTouchdowns: sum(teamStats, (row) => row.rushingTouchdowns),
    receivingYards: sum(teamStats, (row) => row.receivingYards),
    receivingTouchdowns: sum(teamStats, (row) => row.receivingTouchdowns),
  };
}

export interface DefensePositionSummary {
  averagePprPointsAllowed: number;
  averageTargetsAllowed: number;
  defense: string;
  games: number;
  position: string;
  totalPprPointsAllowed: number;
}

export function summarizeDefenseAgainstPosition(
  defense: string,
  position: string,
  rows: readonly NflversePlayerWeek[],
): DefensePositionSummary {
  const normalizedDefense = defense.trim().toUpperCase();
  const normalizedPosition = position.trim().toUpperCase();
  const matches = rows.filter(
    (row) =>
      row.opponentTeam === normalizedDefense && row.position === normalizedPosition,
  );
  const games = new Set(matches.map((row) => row.gameId)).size;
  const totalPprPointsAllowed = sum(matches, (row) => row.fantasyPointsPpr);
  return {
    defense: normalizedDefense,
    position: normalizedPosition,
    games,
    totalPprPointsAllowed: round(totalPprPointsAllowed),
    averagePprPointsAllowed: average(totalPprPointsAllowed, games),
    averageTargetsAllowed: average(sum(matches, (row) => row.targets), games),
  };
}

function summarizePlayer(rows: readonly NflversePlayerWeek[]): PlayerTrendSummary {
  const ordered = [...rows].sort((left, right) => left.week - right.week);
  const latest = ordered.at(-1);
  if (!latest) {
    throw new Error('A player summary needs at least one weekly row.');
  }
  const recent = ordered.slice(-3);
  const points = ordered.map((row) => row.fantasyPointsPpr);
  return {
    playerId: latest.playerId,
    playerDisplayName: latest.playerDisplayName,
    position: latest.position,
    team: latest.team,
    games: ordered.length,
    latestWeek: latest.week,
    totalPprPoints: round(sum(ordered, (row) => row.fantasyPointsPpr)),
    averagePprPoints: average(sum(points, (value) => value), points.length),
    recentAveragePprPoints: average(
      sum(recent, (row) => row.fantasyPointsPpr),
      recent.length,
    ),
    averageTargets: average(sum(ordered, (row) => row.targets), ordered.length),
    recentAverageTargets: average(sum(recent, (row) => row.targets), recent.length),
    averageTouches: average(
      sum(ordered, (row) => row.targets + row.carries),
      ordered.length,
    ),
    recentAverageTouches: average(
      sum(recent, (row) => row.targets + row.carries),
      recent.length,
    ),
    targetShare: averageNullable(ordered.map((row) => row.targetShare)),
    airYardsShare: averageNullable(ordered.map((row) => row.airYardsShare)),
    volatility: standardDeviation(points),
  };
}

function averageNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0
    ? null
    : average(sum(present, (value) => value), present.length);
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const mean = sum(values, (value) => value) / values.length;
  const variance =
    sum(values, (value) => (value - mean) ** 2) / values.length;
  return round(Math.sqrt(variance));
}

function average(total: number, count: number): number {
  return count === 0 ? 0 : round(total / count);
}

function sum<T>(values: readonly T[], select: (value: T) => number): number {
  return values.reduce((total, value) => total + select(value), 0);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
