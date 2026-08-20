import type { NflversePlayerWeek } from '../nflverse/types.js';
import type { WeeklyMatchups } from '../sleeper/analytics.js';
import type {
  EvaluationDataset,
  EvaluationObservation,
  EvaluationSource,
} from './types.js';

const NFLVERSE_STATS_URL =
  'https://github.com/nflverse/nflverse-data/releases/tag/stats_player';
const SLEEPER_API_URL = 'https://api.sleeper.app/v1';

export interface NflverseDatasetOptions {
  availableAtByGameId: Readonly<Record<string, string>>;
  createdAt?: string;
  datasetId?: string;
  label?: string;
  source?: EvaluationSource;
}

export interface SleeperDatasetOptions {
  availableAtByWeek: Readonly<Record<number, string>>;
  createdAt?: string;
  datasetId?: string;
  label?: string;
  leagueId: string;
  season: number;
  source?: EvaluationSource;
}

export function createNflversePlayerWeekDataset(
  rows: readonly NflversePlayerWeek[],
  options: NflverseDatasetOptions,
): EvaluationDataset {
  const observations = rows.map<EvaluationObservation>((row) => {
    const availableAt = options.availableAtByGameId[row.gameId];
    if (!availableAt) {
      throw new Error(
        `The nflverse game ${row.gameId} needs an availability time.`,
      );
    }
    return {
      id: `${row.season}:${row.week}:${row.gameId}:${row.playerId}`,
      entityId: row.playerId,
      label: row.playerDisplayName,
      season: row.season,
      week: row.week,
      segment: normalizedText(row.position),
      actual: row.fantasyPointsPpr,
      availableAt,
      metadata: {
        gameId: row.gameId,
        team: row.team,
        opponentTeam: row.opponentTeam,
        position: row.position,
        seasonType: row.seasonType,
      },
    };
  });
  return createEvaluationDataset({
    id: options.datasetId ?? 'nflverse-player-week-ppr',
    label: options.label ?? 'nflverse weekly player PPR points',
    kind: 'nflverse-player-week',
    metric: 'fantasyPointsPpr',
    createdAt: options.createdAt ?? new Date().toISOString(),
    source: options.source ?? {
      id: 'nflverse-player-stats',
      label: 'nflverse weekly player statistics',
      url: NFLVERSE_STATS_URL,
    },
    observations,
  });
}

export function createSleeperRosterWeekDataset(
  weeks: readonly WeeklyMatchups[],
  options: SleeperDatasetOptions,
): EvaluationDataset {
  requiredText(options.leagueId, 'The Sleeper league ID');
  integer(options.season, 'The Sleeper season', 1999, 2100);
  const observations = weeks.flatMap((week) => {
    const availableAt = options.availableAtByWeek[week.week];
    if (!availableAt) {
      throw new Error(`Sleeper Week ${week.week} needs an availability time.`);
    }
    return week.matchups.map<EvaluationObservation>((matchup) => ({
      id: `${options.season}:${week.week}:${matchup.roster_id}`,
      entityId: String(matchup.roster_id),
      label: `Roster ${matchup.roster_id}`,
      season: options.season,
      week: week.week,
      segment: options.leagueId,
      actual: matchup.custom_points ?? matchup.points,
      availableAt,
      metadata: {
        leagueId: options.leagueId,
        matchupId: matchup.matchup_id,
        rosterId: matchup.roster_id,
      },
    }));
  });
  return createEvaluationDataset({
    id: options.datasetId ?? `sleeper-${options.leagueId}-roster-week`,
    label: options.label ?? 'Sleeper weekly roster points',
    kind: 'sleeper-roster-week',
    metric: 'rosterPoints',
    createdAt: options.createdAt ?? new Date().toISOString(),
    source: options.source ?? {
      id: `sleeper-league-${options.leagueId}-matchups`,
      label: `Sleeper league ${options.leagueId} matchups`,
      url: `${SLEEPER_API_URL}/league/${encodeURIComponent(options.leagueId)}/matchups`,
    },
    observations,
  });
}

export function createEvaluationDataset(
  dataset: EvaluationDataset,
): EvaluationDataset {
  requiredText(dataset.id, 'The dataset ID');
  requiredText(dataset.label, 'The dataset label');
  requiredText(dataset.metric, 'The dataset metric');
  validInstant(dataset.createdAt, 'The dataset creation time');
  requiredText(dataset.source.id, 'The source ID');
  requiredText(dataset.source.label, 'The source label');
  const ids = new Set<string>();
  const periods = new Set<string>();
  for (const observation of dataset.observations) {
    validateObservation(observation);
    if (ids.has(observation.id)) {
      throw new Error(`The observation ID ${observation.id} occurs more than once.`);
    }
    ids.add(observation.id);
    const periodKey = `${observation.season}:${observation.week}:${observation.entityId}`;
    if (periods.has(periodKey)) {
      throw new Error(
        `The entity ${observation.entityId} has more than one result in ${observation.season} Week ${observation.week}.`,
      );
    }
    periods.add(periodKey);
  }
  return {
    ...dataset,
    observations: [...dataset.observations].sort(compareObservation),
  };
}

function validateObservation(observation: EvaluationObservation): void {
  requiredText(observation.id, 'The observation ID');
  requiredText(observation.entityId, 'The observation entity ID');
  requiredText(observation.label, 'The observation label');
  integer(observation.season, 'The observation season', 1999, 2100);
  integer(observation.week, 'The observation week', 1, 25);
  finite(observation.actual, 'The observed result');
  validInstant(observation.availableAt, 'The observation availability time');
}

function compareObservation(
  left: EvaluationObservation,
  right: EvaluationObservation,
): number {
  return (
    left.season - right.season ||
    left.week - right.week ||
    left.entityId.localeCompare(right.entityId) ||
    left.id.localeCompare(right.id)
  );
}

function normalizedText(value: string): string | null {
  const result = value.trim().toUpperCase();
  return result.length === 0 ? null : result;
}

function validInstant(value: string, label: string): void {
  if (value.trim().length === 0 || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be a valid date and time.`);
  }
}

function requiredText(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty.`);
  }
}

function integer(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${label} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
}

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`);
  }
}
