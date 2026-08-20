import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { NflverseClient } from '../nflverse/client.js';
import type { NflverseGame, NflversePlayerWeek } from '../nflverse/types.js';
import { createNflversePlayerWeekDataset } from './datasets.js';
import { runHistoricalReplay } from './replay.js';
import { serializeReplayReport } from './serialization.js';
import type { ReplayPeriodInput, ReplayReport, ReplayTarget } from './types.js';

export interface NflverseReplayOptions {
  client: NflverseClient;
  positions?: readonly string[];
  season: number;
  throughWeek?: number;
}

export async function runNflverseBaselineReplay(
  options: NflverseReplayOptions,
): Promise<ReplayReport> {
  validateSeason(options.season);
  const throughWeek = options.throughWeek ?? 18;
  if (!Number.isInteger(throughWeek) || throughWeek < 2 || throughWeek > 18) {
    throw new RangeError('The replay through-week must be from 2 through 18.');
  }
  const positions = new Set(
    (options.positions ?? ['QB', 'RB', 'WR', 'TE', 'K'])
      .map((position) => position.trim().toUpperCase()),
  );
  const [games, allRows] = await Promise.all([
    options.client.getSchedule({ season: options.season, gameType: 'REG' }),
    options.client.getPlayerWeeklyStats({
      season: options.season,
      seasonType: 'REG',
      throughWeek,
    }),
  ]);
  const rows = allRows.filter(
    (row) => row.week <= throughWeek && positions.has(row.position),
  );
  if (rows.length === 0) {
    throw new Error(`nflverse has no matching ${options.season} player results.`);
  }
  const gamesById = new Map(games.map((game) => [game.gameId, game]));
  const availableAtByGameId = availabilityTimes(rows, gamesById);
  const dataset = createNflversePlayerWeekDataset(rows, {
    availableAtByGameId,
    createdAt: new Date().toISOString(),
    datasetId: `nflverse-${options.season}-player-week-ppr`,
  });
  const periods = replayPeriods(rows, games, throughWeek, availableAtByGameId);
  if (periods.length === 0) {
    throw new Error('The replay needs at least one week with prior-week targets.');
  }
  return runHistoricalReplay({ dataset, periods });
}

export function formatReplaySummary(report: ReplayReport): string {
  const metrics = report.metrics;
  const audit = report.periods.reduce(
    (total, period) => ({
      evaluated: total.evaluated + period.audit.evaluatedTargets,
      missing: total.missing + period.audit.missingOutcomeEntityIds.length,
      training: total.training + period.audit.trainingObservations,
    }),
    { evaluated: 0, missing: 0, training: 0 },
  );
  return [
    `Dataset: ${report.dataset.label}`,
    `Replay periods: ${report.periods.length}`,
    `Evaluated player-weeks: ${audit.evaluated}`,
    `Targets without an outcome: ${audit.missing}`,
    `Mean absolute error: ${formatMetric(metrics.regression.mae)}`,
    `Root mean squared error: ${formatMetric(metrics.regression.rmse)}`,
    `Interval coverage: ${formatPercent(metrics.intervals.coverage)}`,
    `Pairwise rank accuracy: ${formatPercent(metrics.ranks.pairwiseAccuracy)}`,
    `Spearman correlation: ${formatMetric(metrics.ranks.spearmanCorrelation)}`,
    '',
  ].join('\n');
}

export async function saveReplayReport(
  report: ReplayReport,
  file: string,
): Promise<string> {
  const target = resolve(file);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temporary, serializeReplayReport(report), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, target);
    return target;
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function replayPeriods(
  rows: readonly NflversePlayerWeek[],
  games: readonly NflverseGame[],
  throughWeek: number,
  availableAtByGameId: Readonly<Record<string, string>>,
): ReplayPeriodInput[] {
  const gamesByWeek = groupBy(games, (game) => game.week);
  const rowsByWeek = groupBy(rows, (row) => row.week);
  const periods: ReplayPeriodInput[] = [];
  for (let week = 2; week <= throughWeek; week += 1) {
    const currentGames = gamesByWeek.get(week) ?? [];
    const priorRows = rowsByWeek.get(week - 1) ?? [];
    if (currentGames.length === 0 || priorRows.length === 0) continue;
    const cutoff = earliestGameDate(currentGames);
    const targets = priorRows
      .filter((row) => Date.parse(availableAtByGameId[row.gameId] ?? '') <= Date.parse(cutoff))
      .map<ReplayTarget>((row) => ({
        availableAt: availableAtByGameId[row.gameId]!,
        decisionId: null,
        entityId: row.playerId,
        label: row.playerDisplayName,
        metadata: {
          priorGameId: row.gameId,
          priorTeam: row.team,
          position: row.position,
        },
        segment: row.position,
      }));
    if (targets.length > 0) {
      periods.push({
        boundary: { knowledgeCutoff: cutoff, season: rows[0]!.season, week },
        targets: uniqueTargets(targets),
      });
    }
  }
  return periods;
}

function availabilityTimes(
  rows: readonly NflversePlayerWeek[],
  gamesById: ReadonlyMap<string, NflverseGame>,
): Record<string, string> {
  return Object.fromEntries(
    [...new Set(rows.map((row) => row.gameId))].map((gameId) => {
      const game = gamesById.get(gameId);
      if (!game) {
        throw new Error(`The replay schedule has no game ${gameId}.`);
      }
      const date = new Date(`${game.gameDate}T12:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() + 1);
      return [gameId, date.toISOString()];
    }),
  );
}

function earliestGameDate(games: readonly NflverseGame[]): string {
  const dates = games.map((game) => Date.parse(`${game.gameDate}T00:00:00.000Z`));
  const earliest = Math.min(...dates);
  if (!Number.isFinite(earliest)) {
    throw new Error('The replay schedule contains an invalid game date.');
  }
  return new Date(earliest).toISOString();
}

function uniqueTargets(targets: readonly ReplayTarget[]): ReplayTarget[] {
  return [...new Map(targets.map((target) => [target.entityId, target])).values()]
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
}

function groupBy<T, K>(values: readonly T[], key: (value: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const selected = key(value);
    const group = groups.get(selected) ?? [];
    group.push(value);
    groups.set(selected, group);
  }
  return groups;
}

function formatMetric(value: number | null): string {
  return value === null ? 'not available' : value.toFixed(3);
}

function formatPercent(value: number | null): string {
  return value === null ? 'not available' : `${(value * 100).toFixed(1)}%`;
}

function validateSeason(season: number): void {
  if (!Number.isInteger(season) || season < 1999 || season > 2100) {
    throw new RangeError('The replay season must be from 1999 through 2100.');
  }
}
