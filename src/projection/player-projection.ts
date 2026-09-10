import { DEFENSE_SETTINGS } from './defense.js';
import { ResearchDataError } from '../data/research-error.js';
import { KICKING_SETTINGS, scoreKicking } from './kicking.js';
import { DEFAULT_PROJECTION_PARAMETERS, forecastMean, forecastInterval, rollingResiduals, PROJECTION_MODEL_VERSION, type ProjectionParameters } from './statistics.js';
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
  season: number;
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
  expectedPoints: number;
  scoreScope: 'weekly-estimate' | 'partial-scoring' | 'historical-baseline';
  interval: ReturnType<typeof forecastInterval>;
  model: { version: string; parameters: ProjectionParameters | { teamPriorGames: number; touchdownPriorGames: number; maximumTeamWeight: number; maximumOpponentWeight: number }; learningThroughWeek: number | null; learningSeason: number | null; manualOverride: boolean };

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
  projectionSeason?: number;
  scheduled?: boolean;
  gameStarted?: boolean;
  kickoffKnown?: boolean;
  currentProfileKnown?: boolean;
  parameters?: ProjectionParameters;
  priorMean?: number | null;
  calibrationResiduals?: readonly number[];
  learningThroughWeek?: number;
  learningSeason?: number;
  manualOverride?: boolean;
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
  'st_ff', 'st_fum_rec', 'st_tkl_solo', 'kr_yd', 'pr_yd', 'st_td', 'fum_rec_td', 'fum', 'fum_lost', 'pass_2pt', 'rush_2pt', 'rec_2pt',
  'pass_cmp', 'pass_att', 'pass_inc', 'rush_att', 'rec_tgt',
  'bonus_rec_rb', 'bonus_rec_wr', 'bonus_rec_te',
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
  'fgm', 'fgm_0_19', 'fgm_20_29', 'fgm_30_39', 'fgm_40_49', 'fgm_50p', 'fgmiss', 'xpm', 'xpmiss',
  'def_st_ff', 'def_st_fum_rec', 'ff', 'fum_rec',
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
  const projectionSeason = input.projectionSeason ?? input.analysisSeason;
  if (![input.analysisSeason, projectionSeason].every((season) => Number.isInteger(season) && season >= 1999 && season <= 2100) ||
    ![input.week, input.throughWeek].every((week) => Number.isInteger(week) && week >= 1 && week <= 18) ||
    input.analysisSeason > projectionSeason ||
    (input.analysisSeason === projectionSeason && input.throughWeek >= input.week)) {
    throw new ResearchDataError('Projection training must end before the projected week.');
  }
  const ordered = [...input.rows]
    .filter((row) => row.season === input.analysisSeason && row.seasonType === 'REG' && row.week <= input.throughWeek)
    .sort((left, right) => left.week - right.week);
  const latest = ordered.at(-1);
  if (!latest) {
    throw new ResearchDataError('A player projection needs at least one completed game.');
  }
  if (!['QB', 'RB', 'WR', 'TE', 'K'].includes(latest.position.toUpperCase())) {
    throw new ResearchDataError('Seb projects QB, RB, WR, TE, and K scoring only. Team defense and individual defender projections are unavailable. Do not count them as zero.');
  }
  const playerIds = new Set(ordered.map((row) => row.playerId));
  if (playerIds.size !== 1) {
    throw new ResearchDataError('A player projection needs one resolved player identity.');
  }

  if (new Set(ordered.map((row) => row.week)).size !== ordered.length) {
    throw new ResearchDataError('A projection cannot count duplicate player weeks.');
  }
  const scoring = inspectPlayerScoringSettings(input.scoringSettings, latest.position);
  const scoredGames = ordered.map((row) => scorePlayerWeek(row, input.scoringSettings));
  const parameters = input.parameters ?? DEFAULT_PROJECTION_PARAMETERS;
  const base = forecastMean(scoredGames, input.priorMean ?? null, parameters);
  const adjustments: ProjectionAdjustment[] = [];

  const matchup = matchupAdjustment(
    latest.position,
    input.opponent ?? null,
    (input.opponentRows ?? []).filter((row) => row.season === input.analysisSeason && row.seasonType === 'REG' && row.week <= input.throughWeek),
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
  const median = base * factor;
  const interval = forecastInterval(median,
    input.calibrationResiduals ?? rollingResiduals(scoredGames, parameters), scoredGames);

  const limitations = projectionLimitations(
    input,
    latest.position,
    latest.team,
    scoring,
    ordered.length,
  );
  const confidence = projectionConfidence({
    games: ordered.length,
    hasOpponent: Boolean(matchup),
    ignoredSettings: scoring.ignoredSettings.length,
    injuryStatus: input.injuryStatus ?? null,
    weatherStatus: input.weatherStatus ?? null,
  });
  const inactive = availability?.factor === 0;
  if (interval.method === 'uncalibrated-small-sample') limitations.push('The range lacks enough past prediction errors for calibration.');
  limitations.push('The confidence score measures evidence completeness. It is not a probability of an accurate prediction.');
  if (input.kickoffKnown === false) limitations.push('The schedule has no verified kickoff time. Seb cannot confirm that a lineup change remains available.');
  if (input.currentProfileKnown === false) limitations.push('The current player profile has no verified active team. The estimate uses historical identity only.');
  if (input.gameStarted) limitations.push('The scheduled game has started. Do not change this player into the starting lineup.');
  if (input.scheduled === false) limitations.push('The source has no verified game for this team in the requested week. This is a historical baseline, not a weekly score. Do not include it in a matchup total.');


  return {
    adjustments,
    analysisSeason: input.analysisSeason,
    season: projectionSeason,
    ceiling: round(inactive ? 0 : interval.upper),
    confidence,
    floor: round(inactive ? 0 : interval.lower),
    games: ordered.length,
    league: { leagueId: input.leagueId, name: input.leagueName },
    limitations,
    median: round(median),
    expectedPoints: round(median),
    scoreScope: input.scheduled === false || input.currentProfileKnown === false ? 'historical-baseline'
      : scoring.ignoredSettings.length > 0 || scoring.usedSettings.length === 0 ? 'partial-scoring' : 'weekly-estimate',
    interval: inactive ? { ...interval, lower: 0, upper: 0 } : interval,
    model: { version: PROJECTION_MODEL_VERSION, parameters: { ...parameters }, learningThroughWeek: input.learningThroughWeek ?? null, learningSeason: input.learningSeason ?? null, manualOverride: input.manualOverride ?? false },
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
      scoring.ignoredSettings.length === 0 &&
      ['QB', 'RB', 'WR', 'TE', 'K'].includes(latest.position) &&
      input.scheduled !== false &&
      !input.gameStarted &&
      input.kickoffKnown !== false &&
      input.currentProfileKnown !== false &&
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
    (row.position.toUpperCase() === 'K' ? scoreKicking(row, settings) : 0) +
    optionalScore(row.specialTeamsForcedFumbles, settings, 'st_ff') +
    optionalScore(row.specialTeamsRecoveries, settings, 'st_fum_rec') +
    optionalScore(row.specialTeamsTackles, settings, 'st_tkl_solo') +
    optionalScore(row.kickReturnYards, settings, 'kr_yd') +
    optionalScore(row.puntReturnYards, settings, 'pr_yd') +
    optionalScore(row.specialTeamsTouchdowns, settings, 'st_td') +
    optionalScore(row.fumbleRecoveryTouchdowns, settings, 'fum_rec_td') +
    optionalScore(row.fumbles, settings, 'fum') +
    optionalScore(row.fumblesLost, settings, 'fum_lost') +
    optionalScore(row.passingTwoPointConversions, settings, 'pass_2pt') +
    optionalScore(row.rushingTwoPointConversions, settings, 'rush_2pt') +
    optionalScore(row.receivingTwoPointConversions, settings, 'rec_2pt') +
    row.completions * setting(settings, 'pass_cmp') +
    row.attempts * setting(settings, 'pass_att') +
    (row.attempts - row.completions) * setting(settings, 'pass_inc') +
    row.carries * setting(settings, 'rush_att') +
    row.targets * setting(settings, 'rec_tgt') +
    row.receptions * setting(settings, `bonus_rec_${row.position.toLowerCase()}`) +
    row.passingYards * setting(settings, 'pass_yd') +
    row.passingTouchdowns * setting(settings, 'pass_td') +
    row.interceptions * setting(settings, 'pass_int') +
    row.rushingYards * setting(settings, 'rush_yd') +
    row.rushingTouchdowns * setting(settings, 'rush_td') +
    row.receptions * setting(settings, 'rec') +
    row.receivingYards * setting(settings, 'rec_yd') +
    row.receivingTouchdowns * setting(settings, 'rec_td') +
    thresholdBonus(row.passingYards, settings, 'bonus_pass_yd_300', 300, 400) +
    thresholdBonus(row.passingYards, settings, 'bonus_pass_yd_400', 400) +
    thresholdBonus(row.rushingYards, settings, 'bonus_rush_yd_100', 100, 200) +
    thresholdBonus(row.rushingYards, settings, 'bonus_rush_yd_200', 200) +
    thresholdBonus(row.receivingYards, settings, 'bonus_rec_yd_100', 100, 200) +
    thresholdBonus(row.receivingYards, settings, 'bonus_rec_yd_200', 200);
  if (!Number.isFinite(round(points))) throw new ResearchDataError('The league score must be finite. Check the source statistics and scoring settings.');
  return round(points);
}

export function inspectPlayerScoringSettings(settings: SleeperSettings, position?: string): {
  ignoredSettings: string[];
  usedSettings: string[];
} {
  for (const key of Object.keys(settings)) setting(settings, key);
  const active = Object.entries(settings)
    .filter(([, value]) => typeof value === 'number' && value !== 0)
    .map(([key]) => key)
    .sort();
  return {
    usedSettings: active.filter((key) => position?.toUpperCase() === 'K' ? KICKING_SETTINGS.has(key) || /^(st_|kr_yd$|pr_yd$|fum)/u.test(key) && SUPPORTED_SETTINGS.has(key) : SUPPORTED_SETTINGS.has(key)),
    ignoredSettings: active.filter(
      (key) => !SUPPORTED_SETTINGS.has(key) && !NON_PLAYER_SETTINGS.has(key) && !DEFENSE_SETTINGS.has(key) && !KICKING_SETTINGS.has(key),
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
  const seen = new Set<string>();
  for (const row of selected) {
    const identity = `${row.season}:${row.week}:${row.playerId}`;
    if (seen.has(identity)) throw new ResearchDataError('The opponent data contains duplicate player weeks.');
    seen.add(identity);
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
  if (status === 'historical') return null;
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
  if (/\b(out|ir|pup|nfi|suspended|inactive|injured reserve)\b/.test(normalized)) {
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
  if ((input.projectionSeason ?? input.analysisSeason) > input.analysisSeason) limitations.push('The baseline comes from a prior season. Player roles and team strength can change.');
  if (games < 3) limitations.push('The projection has fewer than three completed games.');
  if (scoring.usedSettings.length === 0) {
    limitations.push(`The league has no supported ${position === 'K' ? 'kicking' : 'offensive'} scoring settings.`);
  }
  if (scoring.ignoredSettings.length > 0) {
    limitations.push(`The projection cannot calculate these active settings from nflverse weekly rows: ${scoring.ignoredSettings.join(', ')}.`);
  }
  if (position === 'K') limitations.push('The kicker estimate uses completed kicking results. Seb has not validated kicker-specific forecast accuracy.');
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
  if (value === null || value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ResearchDataError(`Scoring setting ${key} must be a finite number.`);
  return value;
}

function optionalScore(value: number | null | undefined, settings: SleeperSettings, key: string): number {
  const weight = setting(settings, key);
  if (!weight) return 0;
  if (value === null || value === undefined || !Number.isFinite(value)) {
    throw new ResearchDataError(`The source lacks ${key} statistics required by this league. Do not treat missing values as zero.`);
  }
  return value * weight;
}

function thresholdBonus(
  value: number,
  settings: SleeperSettings,
  key: string,
  threshold: number,
  exclusiveMaximum = Infinity,
): number {
  return value >= threshold && value < exclusiveMaximum ? setting(settings, key) : 0;
}

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
