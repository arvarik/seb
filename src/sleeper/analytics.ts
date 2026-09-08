import { quantile } from '../projection/statistics.js';
import type {
  SleeperLeague,
  SleeperMatchup,
  SleeperRoster,
  SleeperUser,
} from './types.js';

export interface WeeklyMatchups {
  week: number;
  matchups: SleeperMatchup[];
}

export interface TeamAnalysis {
  rosterId: number;
  ownerId: string | null;
  ownerName: string;
  teamName: string;
  record: {
    wins: number;
    losses: number;
    ties: number;
    winRate: number;
  };
  pointsFor: number;
  pointsAgainst: number;
  seasonAverage: number;
  recentAverage: number | null;
  weeklyVolatility: number | null;
  powerScore: number;
  rank: number;
  strengths: string[];
  weaknesses: string[];
  scheduleContext: string;
  recentScores: number[];
}

export interface LeagueAnalysis {
  league: {
    leagueId: string;
    name: string;
    season: string;
    status: string;
    scoringSettings: SleeperLeague['scoring_settings'];
  };
  throughWeek: number;
  method: string;
  teams: TeamAnalysis[];
  historyComplete: boolean;
}

export interface MatchupPrediction {
  rosterA: TeamAnalysis;
  rosterB: TeamAnalysis;
  favoredRosterId: number | null;
  rosterAWinProbability: number;
  rosterBWinProbability: number;
  estimatedScore: {
    rosterA: number;
    rosterB: number;
  };
  confidence: 'low' | 'moderate';
  explanation: string[];
  disclaimer: string;
}

interface BaseTeamAnalysis {
  roster: SleeperRoster;
  ownerId: string | null;
  ownerName: string;
  teamName: string;
  wins: number;
  losses: number;
  ties: number;
  winRate: number;
  pointsFor: number;
  pointsAgainst: number;
  seasonAverage: number;
  recentAverage: number | null;
  weeklyVolatility: number | null;
  recentScores: number[];
  opponentGames: number;
}

export function analyzeLeague(input: {
  league: SleeperLeague;
  rosters: SleeperRoster[];
  users: SleeperUser[];
  weeklyMatchups: WeeklyMatchups[];
  throughWeek: number;
}): LeagueAnalysis {
  const usersById = new Map(input.users.map((user) => [user.user_id, user]));
  if (!Number.isInteger(input.throughWeek) || input.throughWeek < 0 || input.throughWeek > 18) throw new Error('The analysis week must be from zero through 18.');
  const rosterIds = new Set(input.rosters.map((roster) => roster.roster_id));
  if (rosterIds.size !== input.rosters.length || input.rosters.some((roster) => !Number.isSafeInteger(roster.roster_id))) {
    throw new Error('League rosters need distinct integer IDs.');
  }
  const weeks = input.weeklyMatchups.filter((week) => week.week <= input.throughWeek && week.week > 0);
  if (new Set(weeks.map((week) => week.week)).size !== weeks.length || weeks.some((week) =>
    new Set(week.matchups.map((matchup) => matchup.roster_id)).size !== week.matchups.length)) {
    throw new Error('League history contains duplicate weeks or roster scores.');
  }
  if (weeks.some((week) => !Number.isInteger(week.week) || week.matchups.some((matchup) =>
    !rosterIds.has(matchup.roster_id) || !Number.isFinite(matchup.custom_points ?? matchup.points)))) {
    throw new Error('League history contains an unknown roster or an invalid score or week.');
  }
  const historyComplete = input.rosters.length > 0 && Array.from({ length: input.throughWeek }, (_, index) => index + 1).every((number) => {
    const week = weeks.find((candidate) => candidate.week === number);
    return week && week.matchups.length === input.rosters.length && week.matchups.every((matchup) =>
      Number.isSafeInteger(matchup.matchup_id) && week.matchups.filter((other) => other.matchup_id === matchup.matchup_id).length === 2);
  });
  const scoresByRoster = collectScores(weeks);
  const records = recordsFromWeeks(weeks, input.league.settings.league_average_match === 1);

  const baseTeams = input.rosters.map<BaseTeamAnalysis>((roster) => {
    const ownerId = roster.owner_id ?? null;
    const user = ownerId ? usersById.get(ownerId) : undefined;
    const weeklyScores = scoresByRoster.get(roster.roster_id) ?? [];
    const recentScores = weeklyScores.slice(-3);
    const record = records.get(roster.roster_id) ?? { wins: 0, losses: 0, ties: 0, pointsAgainst: 0, opponentGames: 0 };
    const { wins, losses, ties, pointsAgainst } = record;
    const games = wins + losses + ties;
    const pointsFor = weeklyScores.reduce((sum, score) => sum + score, 0);
    const seasonAverage = average(weeklyScores) ?? 0;

    return {
      roster,
      ownerId,
      ownerName: user?.display_name ?? user?.username ?? 'Unassigned',
      teamName:
        user?.metadata?.team_name ??
        user?.display_name ??
        user?.username ??
        `Roster ${roster.roster_id}`,
      wins,
      losses,
      ties,
      winRate: games > 0 ? (wins + ties * 0.5) / games : 0,
      pointsFor,
      pointsAgainst,
      opponentGames: record.opponentGames,
      seasonAverage,
      recentAverage: average(recentScores),
      weeklyVolatility: standardDeviation(weeklyScores),
      recentScores,
    };
  });

  const offenseValues = baseTeams.map((team) => team.seasonAverage);
  const recordValues = baseTeams.map((team) => team.winRate);
  const recentValues = baseTeams.map(
    (team) => team.recentAverage ?? team.seasonAverage,
  );
  const volatilityValues = baseTeams.map(
    (team) => team.weeklyVolatility ?? Number.POSITIVE_INFINITY,
  );
  const pointsAgainstValues = baseTeams.map((team) => {
    return team.opponentGames > 0 ? team.pointsAgainst / team.opponentGames : 0;
  });

  const unsortedTeams = baseTeams.map<TeamAnalysis>((team) => {
    const offensePercentile = percentile(team.seasonAverage, offenseValues);
    const recordPercentile = percentile(team.winRate, recordValues);
    const recentPercentile = percentile(
      team.recentAverage ?? team.seasonAverage,
      recentValues,
    );
    const consistencyPercentile =
      team.weeklyVolatility === null
        ? 0.5
        : 1 - percentile(team.weeklyVolatility, volatilityValues);
    const powerScore =
      100 *
      (offensePercentile * 0.45 +
        recordPercentile * 0.25 +
        recentPercentile * 0.2 +
        consistencyPercentile * 0.1);

    return {
      rosterId: team.roster.roster_id,
      ownerId: team.ownerId,
      ownerName: team.ownerName,
      teamName: team.teamName,
      record: {
        wins: team.wins,
        losses: team.losses,
        ties: team.ties,
        winRate: round(team.winRate, 3),
      },
      pointsFor: round(team.pointsFor),
      pointsAgainst: round(team.pointsAgainst),
      seasonAverage: round(team.seasonAverage),
      recentAverage:
        team.recentAverage === null ? null : round(team.recentAverage),
      weeklyVolatility:
        team.weeklyVolatility === null ? null : round(team.weeklyVolatility),
      powerScore: round(powerScore, 1),
      rank: 0,
      strengths: buildStrengths(
        team,
        offensePercentile,
        recentPercentile,
        consistencyPercentile,
      ),
      weaknesses: buildWeaknesses(
        team,
        offensePercentile,
        recentPercentile,
        consistencyPercentile,
      ),
      scheduleContext: buildScheduleContext(
        team,
        percentile(
          team.opponentGames > 0
            ? team.pointsAgainst / team.opponentGames
            : 0,
          pointsAgainstValues,
        ),
      ),
      recentScores: team.recentScores.map((score) => round(score)),
    };
  });

  const teams = unsortedTeams
    .sort(
      (left, right) =>
        right.powerScore - left.powerScore ||
        right.seasonAverage - left.seasonAverage ||
        left.rosterId - right.rosterId,
    )
    .map((team, index) => ({ ...team, rank: index + 1 }));

  return {
    league: {
      leagueId: input.league.league_id,
      name: input.league.name,
      season: input.league.season,
      status: input.league.status,
      scoringSettings: input.league.scoring_settings,
    },
    throughWeek: input.throughWeek,
    historyComplete,
    method:
      'Power score: 45% season scoring, 25% record, 20% recent scoring, and 10% weekly consistency. All inputs come from this Sleeper league.',
    teams,
  };
}

export function predictMatchup(
  analysis: LeagueAnalysis,
  rosterAId: number,
  rosterBId: number,
): MatchupPrediction {
  if (rosterAId === rosterBId) {
    throw new Error('Select two different roster IDs.');
  }

  const rosterA = analysis.teams.find((team) => team.rosterId === rosterAId);
  const rosterB = analysis.teams.find((team) => team.rosterId === rosterBId);
  if (!rosterA || !rosterB) {
    throw new Error('One or both roster IDs do not exist in this league.');
  }

  if (!analysis.historyComplete || rosterA.recentScores.length < 2 || rosterB.recentScores.length < 2) {
    throw new Error('A matchup forecast needs complete history and at least two scores for each roster.');
  }
  const scoreA = expectedScore(rosterA);
  const scoreB = expectedScore(rosterB);
  const difference = scoreA - scoreB;
  const pooledVolatility = Math.sqrt(
    ((rosterA.weeklyVolatility ?? 15) ** 2 +
      (rosterB.weeklyVolatility ?? 15) ** 2) /
      2,
  );
  const scale = Math.max(12, pooledVolatility);
  const rawProbability = 1 / (1 + Math.exp(-difference / scale));
  const rosterAWinProbability = clamp(rawProbability, 0.1, 0.9);
  const advantage = Math.abs(rosterAWinProbability - 0.5);
  const favoredRosterId =
    Math.abs(difference) < 0.5 ? null : difference > 0 ? rosterAId : rosterBId;

  return {
    rosterA,
    rosterB,
    favoredRosterId,
    rosterAWinProbability: round(rosterAWinProbability, 3),
    rosterBWinProbability: round(1 - rosterAWinProbability, 3),
    estimatedScore: {
      rosterA: round(scoreA),
      rosterB: round(scoreB),
    },
    confidence: advantage >= 0.18 ? 'moderate' : 'low',
    explanation: [
      `The estimate weights the season average at 70% and the recent average at 30%.`,
      `Roster ${rosterAId} has a ${round(rosterA.seasonAverage)} season average and a ${formatRecent(rosterA)} recent average.`,
      `Roster ${rosterBId} has a ${round(rosterB.seasonAverage)} season average and a ${formatRecent(rosterB)} recent average.`,
      `Weekly scoring volatility limits the prediction confidence.`,
    ],
    disclaimer:
      'This heuristic uses past Sleeper league scores only. It excludes player projections, injuries after the latest player update, NFL opponents, weather, and betting markets.',
  };
}

function collectScores(weeks: WeeklyMatchups[]): Map<number, number[]> {
  const scores = new Map<number, number[]>();
  const sortedWeeks = [...weeks].sort((left, right) => left.week - right.week);

  for (const week of sortedWeeks) {
    for (const matchup of week.matchups) {
      const current = scores.get(matchup.roster_id) ?? [];
      current.push(matchup.custom_points ?? matchup.points ?? 0);
      scores.set(matchup.roster_id, current);
    }
  }

  return scores;
}

function recordsFromWeeks(weeks: WeeklyMatchups[], medianMatch: boolean) {
  const records = new Map<number, { wins: number; losses: number; ties: number; pointsAgainst: number; opponentGames: number }>();
  for (const week of weeks) {
    const median = week.matchups.length ? quantile(week.matchups.map((matchup) => matchup.custom_points ?? matchup.points), 0.5) : 0;
    for (const matchup of week.matchups) {
      const record = records.get(matchup.roster_id) ?? { wins: 0, losses: 0, ties: 0, pointsAgainst: 0, opponentGames: 0 };
      const score = matchup.custom_points ?? matchup.points;
      const opponents = matchup.matchup_id === null ? [] : week.matchups.filter((other) => other.matchup_id === matchup.matchup_id && other.roster_id !== matchup.roster_id);
      const against = opponents.length === 1 ? [opponents[0]!.custom_points ?? opponents[0]!.points] : [];
      if (against.length) { record.pointsAgainst += against[0]!; record.opponentGames += 1; }
      if (medianMatch) against.push(median);
      for (const opponentScore of against) {
        if (score > opponentScore) record.wins += 1;
        else if (score < opponentScore) record.losses += 1;
        else record.ties += 1;
      }
      records.set(matchup.roster_id, record);
    }
  }
  return records;
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]): number | null {
  if (values.length < 2) {
    return null;
  }
  const mean = average(values) ?? 0;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    values.length;
  return Math.sqrt(variance);
}

function percentile(value: number, values: number[]): number {
  const finiteValues = values.filter(Number.isFinite);
  if (finiteValues.length <= 1) {
    return 0.5;
  }
  const below = finiteValues.filter((candidate) => candidate < value).length;
  const equal = finiteValues.filter((candidate) => candidate === value).length;
  return (below + Math.max(0, equal - 1) * 0.5) / (finiteValues.length - 1);
}

function buildStrengths(
  team: BaseTeamAnalysis,
  offensePercentile: number,
  recentPercentile: number,
  consistencyPercentile: number,
): string[] {
  const strengths: string[] = [];
  if (offensePercentile >= 0.67) {
    strengths.push('The roster ranks in the top third for average scoring.');
  }
  if (recentPercentile >= 0.67) {
    strengths.push('The roster ranks in the top third for recent scoring.');
  }
  if (consistencyPercentile >= 0.67 && team.weeklyVolatility !== null) {
    strengths.push('The roster has stable weekly scoring relative to the league.');
  }
  if (team.winRate >= 0.65) {
    strengths.push('The roster has a strong win rate.');
  }
  if (strengths.length === 0) {
    strengths.push('The Sleeper results do not show a clear top-third advantage.');
  }
  return strengths;
}

function buildWeaknesses(
  team: BaseTeamAnalysis,
  offensePercentile: number,
  recentPercentile: number,
  consistencyPercentile: number,
): string[] {
  const weaknesses: string[] = [];
  if (offensePercentile <= 0.33) {
    weaknesses.push('The roster ranks in the bottom third for average scoring.');
  }
  if (recentPercentile <= 0.33) {
    weaknesses.push('The roster ranks in the bottom third for recent scoring.');
  }
  if (consistencyPercentile <= 0.33 && team.weeklyVolatility !== null) {
    weaknesses.push('The roster has volatile weekly scoring relative to the league.');
  }
  if (team.winRate <= 0.35 && team.wins + team.losses + team.ties > 0) {
    weaknesses.push('The roster has a weak win rate.');
  }
  if (weaknesses.length === 0) {
    weaknesses.push('The Sleeper results do not show a clear bottom-third weakness.');
  }
  return weaknesses;
}

function buildScheduleContext(
  team: BaseTeamAnalysis,
  pointsAgainstPercentile: number,
): string {
  if (team.wins + team.losses + team.ties === 0) {
    return 'The league has no completed record data for this roster.';
  }
  if (pointsAgainstPercentile >= 0.67) {
    return 'Opponents scored at a top-third rate, which indicates a difficult fantasy schedule.';
  }
  if (pointsAgainstPercentile <= 0.33) {
    return 'Opponents scored at a bottom-third rate, which indicates a favorable fantasy schedule.';
  }
  return 'Opponent scoring was near the league middle.';
}

function expectedScore(team: TeamAnalysis): number {
  return team.seasonAverage * 0.7 +
    (team.recentAverage ?? team.seasonAverage) * 0.3;
}

function formatRecent(team: TeamAnalysis): string {
  return team.recentAverage === null ? 'missing' : String(round(team.recentAverage));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
