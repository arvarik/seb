import type { NflversePlayerWeek } from '../nflverse/types.js';
import type { SleeperSettings } from '../sleeper/types.js';
import type { WeatherRisk } from '../weather/game-weather.js';

export type ProjectionConfidence = 'low' | 'medium' | 'high';

export interface ProjectionAdjustment {
  factor: number;
  label: string;
  reason: string;
}

export interface ScoringAwarePlayerProjection {
  adjustments: ProjectionAdjustment[];
  analysisSeason: number;
  ceiling: number;
  confidence: {
    label: ProjectionConfidence;
    reasons: string[];
    score: number;
  };
  floor: number;
  games: number;
  league: {
    leagueId: string;
    name: string;
  };
  limitations: string[];
  median: number;
  opponent: string | null;
  player: {
    name: string;
    playerId: string;
    position: string;
    team: string;
  };
  recommendationEligible: boolean;
  scoring: {
    ignoredSettings: string[];
    usedSettings: string[];
  };
  throughWeek: number;
  week: number;
}

export interface ProjectPlayerInput {
  analysisSeason: number;
  currentTeam?: string | null;
  injuryStatus?: string | null;
  leagueId: string;
  leagueName: string;
  opponent?: string | null;
  opponentRows?: readonly NflversePlayerWeek[];
  rows: readonly NflversePlayerWeek[];
  scoringSettings: SleeperSettings;
  throughWeek: number;
  weatherRisk?: WeatherRisk | null;
  weatherStatus?: 'available' | 'historical' | 'indoor' | 'unavailable' | null;
  week: number;
}

const SUPPORTED_SETTINGS = new Set([
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

const NON_PLAYER_SETTINGS = new Set([
  'pts_allow_0',
  'pts_allow_1_6',
  'pts_allow_7_13',
  'pts_allow_14_20',
  'pts_allow_21_27',
  'pts_allow_28_34',
  'pts_allow_35p',
  'sack',
  'safe',
  'int',
  'def_td',
  'def_st_td',
  'blk_kick',
]);

export function projectPlayer(input: ProjectPlayerInput): ScoringAwarePlayerProjection {
  const ordered = [...input.rows]
    .filter((row) => row.season === input.analysisSeason && row.week <= input.throughWeek)
    .sort((left, right) => left.week - right.week);
  const latest = ordered.at(-1);
  if (!latest) {
    throw new Error('A player projection needs at least one completed game.');
  }
  const playerIds = new Set(ordered.map((row) => row.playerId));
  if (playerIds.size !== 1) {
    throw new Error('A player projection needs one resolved player identity.');
  }

  const scoring = inspectPlayerScoringSettings(input.scoringSettings);
  const scoredGames = ordered.map((row) => scorePlayerWeek(row, input.scoringSettings));
  const recent = scoredGames.slice(-3);
  const seasonAverage = average(scoredGames);
  const recentAverage = average(recent);
  const base = seasonAverage * 0.55 + recentAverage * 0.45;
  const adjustments: ProjectionAdjustment[] = [];

  const matchup = matchupAdjustment(
    latest.position,
    input.opponent ?? null,
    input.opponentRows ?? [],
    input.scoringSettings,
  );
  if (matchup) adjustments.push(matchup);

  const weather = weatherAdjustment(
    latest.position,
    input.weatherRisk ?? null,
    input.weatherStatus ?? null,
  );
  if (weather) adjustments.push(weather);

  const availability = availabilityAdjustment(input.injuryStatus ?? null);
  if (availability) adjustments.push(availability);

  const factor = adjustments.reduce((value, adjustment) => value * adjustment.factor, 1);
  const median = Math.max(0, base * factor);
  const volatility = standardDeviation(scoredGames);
  const width = Math.max(volatility * 0.85, median * 0.2, 1);
  const limitations = projectionLimitations(
    input,
    latest.position,
    latest.team,
    scoring,
    ordered.length,
  );
  const confidence = projectionConfidence({
    games: ordered.length,
    hasOpponent: Boolean(input.opponent),
    ignoredSettings: scoring.ignoredSettings.length,
    injuryStatus: input.injuryStatus ?? null,
    weatherStatus: input.weatherStatus ?? null,
  });
  const inactive = availability?.factor === 0;

  return {
    adjustments,
    analysisSeason: input.analysisSeason,
    ceiling: round(inactive ? 0 : median + width),
    confidence,
    floor: round(inactive ? 0 : Math.max(0, median - width)),
    games: ordered.length,
    league: { leagueId: input.leagueId, name: input.leagueName },
    limitations,
    median: round(median),
    opponent: input.opponent ?? null,
    player: {
      name: latest.playerDisplayName,
      playerId: latest.playerId,
      position: latest.position,
      team: input.currentTeam ?? latest.team,
    },
    recommendationEligible:
      ordered.length >= 3 &&
      scoring.usedSettings.length > 0 &&
      latest.position !== 'K' &&
      !inactive,
    scoring,
    throughWeek: input.throughWeek,
    week: input.week,
  };
}

export function scorePlayerWeek(
  row: NflversePlayerWeek,
  settings: SleeperSettings,
): number {
  const points =
    row.passingYards * setting(settings, 'pass_yd') +
    row.passingTouchdowns * setting(settings, 'pass_td') +
    row.interceptions * setting(settings, 'pass_int') +
    row.rushingYards * setting(settings, 'rush_yd') +
    row.rushingTouchdowns * setting(settings, 'rush_td') +
    row.receptions * setting(settings, 'rec') +
    row.receivingYards * setting(settings, 'rec_yd') +
    row.receivingTouchdowns * setting(settings, 'rec_td') +
    thresholdBonus(row.passingYards, settings, 'bonus_pass_yd_300', 300) +
    thresholdBonus(row.passingYards, settings, 'bonus_pass_yd_400', 400) +
    thresholdBonus(row.rushingYards, settings, 'bonus_rush_yd_100', 100) +
    thresholdBonus(row.rushingYards, settings, 'bonus_rush_yd_200', 200) +
    thresholdBonus(row.receivingYards, settings, 'bonus_rec_yd_100', 100) +
    thresholdBonus(row.receivingYards, settings, 'bonus_rec_yd_200', 200);
  return round(points);
}

export function inspectPlayerScoringSettings(settings: SleeperSettings): {
  ignoredSettings: string[];
  usedSettings: string[];
} {
  const active = Object.entries(settings)
    .filter(([, value]) => typeof value === 'number' && value !== 0)
    .map(([key]) => key)
    .sort();
  return {
    usedSettings: active.filter((key) => SUPPORTED_SETTINGS.has(key)),
    ignoredSettings: active.filter(
      (key) => !SUPPORTED_SETTINGS.has(key) && !NON_PLAYER_SETTINGS.has(key),
    ),
  };
}

function matchupAdjustment(
  position: string,
  opponent: string | null,
  rows: readonly NflversePlayerWeek[],
  settings: SleeperSettings,
): ProjectionAdjustment | null {
  if (!opponent) return null;
  const selected = rows.filter((row) => row.position === position);
  if (selected.length === 0) return null;
  const byDefense = new Map<string, Map<string, number>>();
  for (const row of selected) {
    const games = byDefense.get(row.opponentTeam) ?? new Map<string, number>();
    games.set(row.gameId, (games.get(row.gameId) ?? 0) + scorePlayerWeek(row, settings));
    byDefense.set(row.opponentTeam, games);
  }
  const defenseAverages = [...byDefense.values()]
    .map((games) => average([...games.values()]))
    .filter(Number.isFinite);
  const opponentGames = byDefense.get(opponent.toUpperCase());
  if (!opponentGames || opponentGames.size < 2 || defenseAverages.length < 4) return null;
  const leagueAverage = average(defenseAverages);
  if (leagueAverage <= 0) return null;
  const allowed = average([...opponentGames.values()]);
  const factor = clamp(1 + (allowed / leagueAverage - 1) * 0.35, 0.9, 1.1);
  return {
    factor: round(factor, 3),
    label: 'Opponent adjustment',
    reason: `${opponent.toUpperCase()} allowed ${round(allowed)} scoring-adjusted ${position} points per game against a ${round(leagueAverage)} league average.`,
  };
}

function weatherAdjustment(
  position: string,
  risk: WeatherRisk | null,
  status: ProjectPlayerInput['weatherStatus'] | null,
): ProjectionAdjustment | null {
  if (status === 'indoor' || risk === 'low') {
    return {
      factor: 1,
      label: 'Weather adjustment',
      reason: status === 'indoor'
        ? 'The scheduled game is indoors.'
        : 'The kickoff forecast has a low weather risk.',
    };
  }
  if (risk === 'medium') {
    const factor = ['QB', 'WR', 'TE', 'K'].includes(position) ? 0.97 : 0.99;
    return {
      factor,
      label: 'Weather adjustment',
      reason: 'The kickoff forecast has a medium weather risk.',
    };
  }
  if (risk === 'high') {
    const factor = ['QB', 'WR', 'TE', 'K'].includes(position) ? 0.92 : 0.97;
    return {
      factor,
      label: 'Weather adjustment',
      reason: 'The kickoff forecast has a high weather risk.',
    };
  }
  return null;
}

function availabilityAdjustment(status: string | null): ProjectionAdjustment | null {
  const normalized = status?.trim().toLowerCase() ?? '';
  if (!normalized) return null;
  if (['out', 'ir', 'pup', 'suspended', 'inactive'].includes(normalized)) {
    return {
      factor: 0,
      label: 'Availability adjustment',
      reason: `The Sleeper player profile lists the player as ${status}.`,
    };
  }
  if (normalized.includes('doubt')) {
    return {
      factor: 0.4,
      label: 'Availability adjustment',
      reason: `The Sleeper player profile lists the player as ${status}.`,
    };
  }
  if (normalized.includes('question')) {
    return {
      factor: 0.85,
      label: 'Availability adjustment',
      reason: `The Sleeper player profile lists the player as ${status}.`,
    };
  }
  return null;
}

function projectionLimitations(
  input: ProjectPlayerInput,
  position: string,
  baselineTeam: string,
  scoring: { ignoredSettings: string[]; usedSettings: string[] },
  games: number,
): string[] {
  const limitations: string[] = [];
  if (games < 3) limitations.push('The projection has fewer than three completed games.');
  if (scoring.usedSettings.length === 0) {
    limitations.push('The league has no supported offensive scoring settings.');
  }
  if (scoring.ignoredSettings.length > 0) {
    limitations.push(`The projection cannot calculate these active settings from nflverse weekly rows: ${scoring.ignoredSettings.join(', ')}.`);
  }
  if (position === 'K') {
    limitations.push('The nflverse weekly rows do not provide scoring-aware kicking components.');
  }
  if (!input.injuryStatus) {
    limitations.push('The Sleeper profile has no current injury status.');
  } else {
    limitations.push('The Sleeper injury field is not an official injury report.');
  }
  if (!input.opponent) limitations.push('The projection has no scheduled opponent adjustment.');
  if (input.currentTeam && input.currentTeam !== baselineTeam) {
    limitations.push(
      `Sleeper lists ${input.currentTeam} as the current team. The production baseline includes the prior team.`,
    );
  }
  if (!input.weatherStatus || input.weatherStatus === 'unavailable') {
    limitations.push('The projection has no kickoff weather adjustment.');
  }
  return limitations;
}

function projectionConfidence(input: {
  games: number;
  hasOpponent: boolean;
  ignoredSettings: number;
  injuryStatus: string | null;
  weatherStatus: ProjectPlayerInput['weatherStatus'] | null;
}): ScoringAwarePlayerProjection['confidence'] {
  const reasons: string[] = [];
  let score = 0.3 + Math.min(input.games, 12) * 0.04;
  if (input.games < 4) reasons.push('The sample contains fewer than four games.');
  else reasons.push(`The sample contains ${input.games} completed games.`);
  if (input.hasOpponent) {
    score += 0.05;
    reasons.push('The projection includes the scheduled opponent.');
  } else {
    score -= 0.08;
  }
  if (input.weatherStatus === 'available' || input.weatherStatus === 'indoor') score += 0.04;
  else score -= 0.04;
  if (input.injuryStatus) score += 0.02;
  else score -= 0.05;
  score -= Math.min(input.ignoredSettings, 3) * 0.04;
  const normalized = clamp(score, 0.15, 0.88);
  return {
    label: normalized >= 0.72 ? 'high' : normalized >= 0.5 ? 'medium' : 'low',
    reasons,
    score: round(normalized, 2),
  };
}

function setting(settings: SleeperSettings, key: string): number {
  const value = settings[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function thresholdBonus(
  value: number,
  settings: SleeperSettings,
  key: string,
  threshold: number,
): number {
  return value >= threshold ? setting(settings, key) : 0;
}

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
