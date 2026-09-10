import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { createGunzip } from 'node:zlib';

import { parse } from 'csv-parse';

import {
  CachedResource,
  type ResourceLoadContext,
  type ResourceResult,
} from '../data/cached-resource.js';
import { currentRequestSignal } from '../ai/request-signal.js';
import { normalizePlayerName } from '../identity/normalize.js';
import {
  readResponseBytes,
  readResponseErrorDetail,
} from '../data/response-body.js';
import { ResilientFetch, type RequestPolicy } from '../data/resilient-fetch.js';
import { getSharedSebDatabase, type SebDatabase } from '../data/sqlite-store.js';
import type { SourceObserver } from '../sources.js';
import { SEB_USER_AGENT } from '../version.js';
import {
  nflverseGameSchema,
  nflversePlayerWeekSchema,
  nflversePlayerStatsSchema,
  nflverseScheduleSchema,
} from './schemas.js';
import type {
  NflverseGame,
  NflversePlayerStatFilters,
  NflversePlayerWeek,
  NflverseScheduleFilters,
} from './types.js';

const DEFAULT_BASE_URL =
  'https://github.com/nflverse/nflverse-data/releases/download';
const SCHEDULE_URL = `${DEFAULT_BASE_URL}/schedules/games.csv.gz`;
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_ERROR_BYTES = 4 * 1024;
const CACHE_SCHEMA_VERSION = 'v3';
const STATS_SCHEMA_VERSION = 'v5';
const SCHEDULE_TTL_MS = 6 * 60 * 60 * 1_000;
const STATS_TTL_MS = 6 * 60 * 60 * 1_000;
const STALE_IF_ERROR_MS = 7 * 24 * 60 * 60 * 1_000;

type Fetch = typeof globalThis.fetch;
type CsvRow = Record<string, string>;

const SCHEDULE_REQUIRED_COLUMNS = [
  'game_id',
  'season',
  'game_type',
  'week',
  'gameday',
  'away_team',
  'home_team',
] as const;
const PLAYER_REQUIRED_COLUMNS = [
  'player_id',
  'player_display_name',
  'position',
  'season',
  'week',
  'season_type',
  'game_id',
  'team',
  'opponent_team',
  'completions',
  'attempts',
  'passing_yards',
  'passing_tds',
  'passing_interceptions',
  'carries',
  'rushing_yards',
  'rushing_tds',
  'receptions',
  'targets',
  'receiving_yards',
  'receiving_tds',
  'receiving_air_yards',
  'fantasy_points',
  'fantasy_points_ppr',
] as const;

export interface NflverseClientOptions {
  baseUrl?: string;
  cacheDirectory?: string | false;
  database?: SebDatabase | false;
  databaseFile?: string;
  fetch?: Fetch;
  onSource?: SourceObserver;
  policy?: Partial<RequestPolicy>;
  timeoutMs?: number;
}

export class NflverseApiError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = 'NflverseApiError';
    this.status = status;
    this.url = url;
  }
}

export class NflverseClient {
  private readonly baseUrl: string;
  private readonly database: SebDatabase | false;
  private readonly http: ResilientFetch;
  private readonly onSource: SourceObserver | undefined;

  constructor(options: NflverseClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.database = options.database === false || options.cacheDirectory === false
      ? false
      : (options.database ?? getSharedSebDatabase(
          options.databaseFile ??
            (options.cacheDirectory ? resolve(options.cacheDirectory, 'seb.sqlite') : undefined),
        ));
    this.http = new ResilientFetch({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      policy: { timeoutMs: options.timeoutMs ?? 20_000, ...options.policy },
    });
    this.onSource = options.onSource;
  }

  async getSchedule(
    filters: NflverseScheduleFilters = {},
  ): Promise<NflverseGame[]> {
    const sourceUrl = `${this.baseUrl}/schedules/games.csv.gz`;
    const loaded = await this.loadSchedule(sourceUrl);
    const games = loaded.value;
    this.recordSource('nflverse-schedules', 'nflverse schedules', sourceUrl, loaded);

    const team = filters.team === undefined ? undefined : normalizeNflverseTeam(filters.team);
    const gameType = filters.gameType?.trim().toUpperCase();
    return games.filter(
      (game) =>
        (filters.season === undefined || game.season === filters.season) &&
        (filters.week === undefined || game.week === filters.week) &&
        (gameType === undefined || matchesGameType(game.gameType, gameType)) &&
        (team === undefined || game.homeTeam === team || game.awayTeam === team),
    );
  }

  async getPlayerWeeklyStats(
    filters: NflversePlayerStatFilters,
  ): Promise<NflversePlayerWeek[]> {
    validateSeason(filters.season);
    const fileName = `stats_player_week_${filters.season}.csv.gz`;
    const sourceUrl = `${this.baseUrl}/stats_player/${fileName}`;
    const loaded = await this.loadPlayerStats(filters.season, sourceUrl);
    const stats = loaded.value;
    this.recordSource(
      `nflverse-player-stats-${filters.season}`,
      `nflverse ${filters.season} weekly player statistics`,
      sourceUrl,
      loaded,
    );

    const playerName = normalizeText(filters.playerName);
    const playerId = filters.playerId?.trim();
    const team = filters.team === undefined ? undefined : normalizeNflverseTeam(filters.team);
    const position = filters.position?.trim().toUpperCase();
    const seasonType = filters.seasonType?.trim().toUpperCase();
    return stats.filter(
      (row) =>
        (filters.week === undefined || row.week === filters.week) &&
        (filters.throughWeek === undefined || row.week <= filters.throughWeek) &&
        (playerId === undefined || row.playerId === playerId) &&
        (playerName === undefined ||
          normalizeText(row.playerDisplayName)?.includes(playerName)) &&
        (team === undefined || row.team === team) &&
        (position === undefined || row.position === position) &&
        (seasonType === undefined || row.seasonType === seasonType),
    );
  }

  async clearCache(target: 'all' | 'schedule' | 'stats' = 'all'): Promise<void> {
    if (!this.database) {
      return;
    }
    if (target === 'all') {
      this.database.deleteCache('nflverse');
    } else if (target === 'schedule') {
      this.database.deleteCache('nflverse', `schedule-${CACHE_SCHEMA_VERSION}`);
    } else {
      this.database.deleteCachePrefix('nflverse', 'player-stats-');
    }
  }

  private async fetchCsv(
    url: string,
    conditional: ResourceLoadContext,
  ): Promise<
    | { notModified: true }
    | { etag: string | null; lastModified: string | null; rows: CsvRow[] }
  > {
    let response: Response;
    try {
      const headers = new Headers({
          accept: 'application/gzip, text/csv;q=0.9, */*;q=0.1',
          'user-agent': SEB_USER_AGENT,
      });
      if (conditional.etag) headers.set('if-none-match', conditional.etag);
      if (conditional.lastModified) headers.set('if-modified-since', conditional.lastModified);
      response = await this.http.request(url, {
        headers,
        redirect: 'follow',
        signal: conditional.signal,
      });
    } catch (error) {
      throw new NflverseApiError(
        `The nflverse request failed: ${errorMessage(error)}`,
        0,
        url,
      );
    }

    if (response.status === 304) {
      return { notModified: true };
    }

    if (!response.ok) {
      const detail = await readResponseErrorDetail(response, MAX_ERROR_BYTES);
      throw new NflverseApiError(
        `nflverse returned HTTP ${response.status}.${detail ? ` Response: ${detail}` : ''}`,
        response.status,
        url,
      );
    }

    try {
      const bytes = await readResponseBytes(response, MAX_DOWNLOAD_BYTES);
      conditional.signal.throwIfAborted();
      const expanded = url.endsWith('.gz')
        ? await gunzipBytes(bytes, MAX_EXPANDED_BYTES, conditional.signal)
        : bytes;
      if (expanded.byteLength > MAX_EXPANDED_BYTES) {
        throw new Error(`The expanded nflverse file exceeds ${MAX_EXPANDED_BYTES} bytes.`);
      }
      const rows = await parseCsv(expanded.toString('utf8'), conditional.signal);
      return {
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        rows,
      };
    } catch (error) {
      throw new NflverseApiError(
        `The nflverse file is invalid: ${errorMessage(error)}`,
        response.status,
        url,
      );
    }
  }

  private loadSchedule(sourceUrl: string): Promise<ResourceResult<NflverseGame[]>> {
    const resource = new CachedResource<NflverseGame[]>(
      this.database,
      'nflverse',
      `schedule-${CACHE_SCHEMA_VERSION}`,
      sourceUrl,
      {
        schemaVersion: CACHE_SCHEMA_VERSION,
        snapshotKind: 'nflverse-schedule',
        snapshotRetention: 8,
        staleIfErrorMs: STALE_IF_ERROR_MS,
        ttlMs: SCHEDULE_TTL_MS,
        validate: (value) => nflverseScheduleSchema.parse(value),
      },
      this,
    );
    const signal = currentRequestSignal();
    return resource.read(async (conditional) => {
      const downloaded = await this.fetchCsv(sourceUrl, conditional);
      if ('notModified' in downloaded) return downloaded;
      return {
        etag: downloaded.etag,
        lastModified: downloaded.lastModified,
        sourceTimestamp: downloaded.lastModified,
        value: await parseGames(downloaded.rows, conditional.signal),
        valueValidated: true,
      };
    }, signal ? { signal } : {});
  }

  private loadPlayerStats(
    season: number,
    sourceUrl: string,
  ): Promise<ResourceResult<NflversePlayerWeek[]>> {
    const key = `player-stats-${STATS_SCHEMA_VERSION}-${season}`;
    const resource = new CachedResource<NflversePlayerWeek[]>(
      this.database,
      'nflverse',
      key,
      sourceUrl,
      {
        schemaVersion: STATS_SCHEMA_VERSION,
        snapshotKind: 'nflverse-player-stats',
        snapshotRetention: 4,
        staleIfErrorMs: STALE_IF_ERROR_MS,
        ttlMs: STATS_TTL_MS,
        validate: (value) => nflversePlayerStatsSchema.parse(value),
      },
      this,
    );
    const signal = currentRequestSignal();
    return resource.read(async (conditional) => {
      const downloaded = await this.fetchCsv(sourceUrl, conditional);
      if ('notModified' in downloaded) return downloaded;
      return {
        etag: downloaded.etag,
        lastModified: downloaded.lastModified,
        sourceTimestamp: downloaded.lastModified,
        value: await parsePlayerWeeks(downloaded.rows, conditional.signal),
        valueValidated: true,
      };
    }, signal ? { signal } : {});
  }

  private recordSource<T>(
    id: string,
    label: string,
    url: string,
    loaded: ResourceResult<T>,
  ): void {
    this.onSource?.({
      cacheOutcome: loaded.outcome,
      ...(loaded.error ? { error: loaded.error } : {}),
      ...(loaded.warnings ? { warnings: loaded.warnings } : {}),
      id,
      label,
      retrievedAt: loaded.cache.cachedAt,
      url,
    });
  }
}

function matchesGameType(actual: string, requested: string): boolean {
  if (requested !== 'POST') {
    return actual === requested;
  }
  return ['POST', 'WC', 'DIV', 'CON', 'SB'].includes(actual);
}

function parseGame(row: CsvRow): NflverseGame {
  return {
    gameId: requiredText(row.game_id, 'game_id'),
    season: integer(row.season, 'season'),
    gameType: requiredText(row.game_type, 'game_type'),
    week: integer(row.week, 'week'),
    gameDate: requiredText(row.gameday, 'gameday'),
    gameTime: nullableText(row.gametime),
    awayTeam: normalizeNflverseTeam(requiredText(row.away_team, 'away_team')),
    awayScore: nullableNumber(row.away_score),
    homeTeam: normalizeNflverseTeam(requiredText(row.home_team, 'home_team')),
    homeScore: nullableNumber(row.home_score),
    location: nullableText(row.location),
    awayRest: nullableNumber(row.away_rest),
    homeRest: nullableNumber(row.home_rest),
    spreadLine: nullableNumber(row.spread_line),
    totalLine: nullableNumber(row.total_line),
    roof: nullableText(row.roof),
    surface: nullableText(row.surface),
    temperature: nullableNumber(row.temp),
    wind: nullableNumber(row.wind),
    stadiumId: nullableText(row.stadium_id),
    stadium: nullableText(row.stadium),
  };
}

function parsePlayerWeek(row: CsvRow): NflversePlayerWeek {
  return {
    kicking: {
      fieldGoalsMade: nullableNumber(row.fg_made),
      fieldGoalsAttempted: nullableNumber(row.fg_att),
      extraPointsMade: nullableNumber(row.pat_made),
      extraPointsAttempted: nullableNumber(row.pat_att),
      madeDistances: kickDistances(row.fg_made_list, row.fg_made),
      missedDistances: combineKickDistances(
        kickDistances(row.fg_missed_list, row.fg_missed),
        kickDistances(row.fg_blocked_list, row.fg_blocked),
      ),
    },
    specialTeamsTouchdowns: nullableNumber(row.special_teams_tds),
    fumbleRecoveryTouchdowns: nullableNumber(row.fumble_recovery_tds),

    fumbles: nullableNumber(row.fumbles_total),
    fumblesLost: nullableNumber(row.fumbles_lost_total),
    passingTwoPointConversions: nullableNumber(row.passing_2pt_conversions),
    rushingTwoPointConversions: nullableNumber(row.rushing_2pt_conversions),
    receivingTwoPointConversions: nullableNumber(row.receiving_2pt_conversions),

    playerId: requiredText(row.player_id, 'player_id'),
    playerDisplayName: requiredText(row.player_display_name ?? row.player_name, 'player_display_name'),
    position: requiredText(row.position, 'position'),
    season: integer(row.season, 'season'),
    week: integer(row.week, 'week'),
    seasonType: requiredText(row.season_type, 'season_type'),
    gameId: requiredText(row.game_id, 'game_id'),
    team: normalizeNflverseTeam(requiredText(row.team, 'team')),
    opponentTeam: normalizeNflverseTeam(requiredText(row.opponent_team, 'opponent_team')),
    completions: number(row.completions, 'completions'),
    attempts: number(row.attempts, 'attempts'),
    passingYards: number(row.passing_yards, 'passing_yards'),
    passingTouchdowns: number(row.passing_tds, 'passing_tds'),
    interceptions: number(row.passing_interceptions, 'passing_interceptions'),
    carries: number(row.carries, 'carries'),
    rushingYards: number(row.rushing_yards, 'rushing_yards'),
    rushingTouchdowns: number(row.rushing_tds, 'rushing_tds'),
    receptions: number(row.receptions, 'receptions'),
    targets: number(row.targets, 'targets'),
    receivingYards: number(row.receiving_yards, 'receiving_yards'),
    receivingTouchdowns: number(row.receiving_tds, 'receiving_tds'),
    receivingAirYards: number(row.receiving_air_yards, 'receiving_air_yards'),
    targetShare: nullableNumber(row.target_share),
    airYardsShare: nullableNumber(row.air_yards_share),
    fantasyPoints: number(row.fantasy_points, 'fantasy_points'),
    fantasyPointsPpr: number(row.fantasy_points_ppr, 'fantasy_points_ppr'),
  };
}

function validateSeason(season: number): void {
  if (!Number.isInteger(season) || season < 1999 || season > 2100) {
    throw new RangeError('The nflverse season must be an integer from 1999 through 2100.');
  }
}

function integer(value: string | undefined, field: string): number {
  const parsed = number(value, field, false);
  if (!Number.isInteger(parsed)) {
    throw new TypeError(`The nflverse ${field} value must be an integer.`);
  }
  return parsed;
}

function number(value: string | undefined, field: string, allowBlank = true): number {
  if (value === undefined) {
    throw new TypeError(`The nflverse file has no ${field} column.`);
  }
  if (value.trim() === '' && allowBlank) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`The nflverse ${field} value is not a finite number.`);
  }
  return parsed;
}

function requiredText(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new TypeError(`The nflverse ${field} value is required.`);
  }
  return normalized;
}

async function parseGames(
  rows: CsvRow[],
  signal: AbortSignal,
): Promise<NflverseGame[]> {
  if (rows.length === 0) throw new TypeError('The nflverse schedule has no rows.');
  requireColumns(rows[0] as CsvRow, SCHEDULE_REQUIRED_COLUMNS);
  const games: NflverseGame[] = [];
  for (const [index, row] of rows.entries()) {
    signal.throwIfAborted();
    games.push(nflverseGameSchema.parse(parseGame(row)));
    if ((index + 1) % 1_000 === 0) await setImmediate();
  }
  signal.throwIfAborted();
  return games;
}

async function parsePlayerWeeks(
  rows: CsvRow[],
  signal: AbortSignal,
): Promise<NflversePlayerWeek[]> {
  if (rows.length === 0) throw new TypeError('The nflverse player file has no rows.');
  requireColumns(rows[0] as CsvRow, PLAYER_REQUIRED_COLUMNS);
  const playerWeeks: NflversePlayerWeek[] = [];
  for (const [index, row] of rows.entries()) {
    signal.throwIfAborted();
    if (row.player_id?.trim()) {
      playerWeeks.push(nflversePlayerWeekSchema.parse(parsePlayerWeek(row)));
    }
    if ((index + 1) % 1_000 === 0) await setImmediate();
  }
  signal.throwIfAborted();
  if (playerWeeks.length === 0) {
    throw new TypeError('The nflverse player file has no player rows.');
  }
  return playerWeeks;
}

function requireColumns(row: CsvRow, columns: readonly string[]): void {
  const missing = columns.filter((column) => !(column in row));
  if (missing.length > 0) {
    throw new TypeError(`The nflverse file has no ${missing.join(', ')} column.`);
  }
}

async function parseCsv(text: string, signal: AbortSignal): Promise<CsvRow[]> {
  const source = Readable.from(csvChunks(text, signal));
  const parser = source.pipe(parse({
    bom: true,
    columns: true,
    skip_empty_lines: true,
  }));
  const onSourceError = (error: Error): void => {
    parser.destroy(error);
  };
  source.on('error', onSourceError);
  const rows: CsvRow[] = [];
  try {
    for await (const row of parser) {
      signal.throwIfAborted();
      rows.push(row as CsvRow);
    }
  } finally {
    source.off('error', onSourceError);
    source.destroy();
    parser.destroy();
  }
  return rows;
}

async function* csvChunks(
  text: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const chunkSize = 64 * 1024;
  for (let index = 0; index < text.length; index += chunkSize) {
    signal.throwIfAborted();
    yield text.slice(index, index + chunkSize);
    await setImmediate();
  }
}

async function gunzipBytes(
  bytes: Buffer,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  const source = Readable.from(bytes);
  const decoder = createGunzip();
  const chunks: Buffer[] = [];
  let total = 0;
  const onAbort = (): void => {
    const error = abortError(signal);
    source.destroy();
    decoder.destroy(error);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  source.pipe(decoder);
  try {
    for await (const chunk of decoder) {
      signal.throwIfAborted();
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buffer.byteLength;
      if (total > maximumBytes) {
        throw new Error(`The expanded nflverse file exceeds ${maximumBytes} bytes.`);
      }
      chunks.push(buffer);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, total);
  } finally {
    signal.removeEventListener('abort', onAbort);
    source.destroy();
    decoder.destroy();
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

function nullableNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError('The nflverse file contains an invalid optional number.');
  }
  return parsed;
}

function nullableText(value: string | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function kickDistances(value: string | undefined, count: string | undefined): number[] | null {
  const expected = nullableNumber(count);
  if (value === undefined || expected === null) return null;
  const distances = value.trim() === '' ? [] : value.split(';').map((distance) => Number(distance));
  if (distances.length !== expected || distances.some((distance) => !Number.isInteger(distance) || distance < 0)) return null;
  return distances;
}

function combineKickDistances(missed: number[] | null, blocked: number[] | null): number[] | null {
  return missed && blocked ? [...missed, ...blocked] : null;
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value === undefined ? undefined : normalizePlayerName(value);
  return normalized || undefined;
}

/** nflverse uses LA for the Rams. The rest of Seb uses Sleeper's LAR code. */
function normalizeNflverseTeam(value: string): string {
  const team = value.trim().toUpperCase();
  return team === 'LA' ? 'LAR' : team;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const NFLVERSE_SCHEDULE_SOURCE_URL = SCHEDULE_URL;
