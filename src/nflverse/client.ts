import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';

import { parse } from 'csv-parse/sync';

import {
  CachedResource,
  type ResourceLoadContext,
  type ResourceResult,
} from '../data/cached-resource.js';
import { ResilientFetch, type RequestPolicy } from '../data/resilient-fetch.js';
import { getSharedSebDatabase, type SebDatabase } from '../data/sqlite-store.js';
import type { SourceObserver } from '../sources.js';
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
const CACHE_SCHEMA_VERSION = 'v1';
const SCHEDULE_TTL_MS = 6 * 60 * 60 * 1_000;
const STATS_TTL_MS = 6 * 60 * 60 * 1_000;
const STALE_IF_ERROR_MS = 7 * 24 * 60 * 60 * 1_000;

type Fetch = typeof globalThis.fetch;
type CsvRow = Record<string, string>;

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
  private scheduleRequest: Promise<ResourceResult<NflverseGame[]>> | undefined;
  private readonly statsRequests = new Map<number, Promise<ResourceResult<NflversePlayerWeek[]>>>();

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

    const team = filters.team?.trim().toUpperCase();
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
    const team = filters.team?.trim().toUpperCase();
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
          'user-agent': 'seb/0.0.2 (+https://github.com/arvarik/seb)',
      });
      if (conditional.etag) headers.set('if-none-match', conditional.etag);
      if (conditional.lastModified) headers.set('if-modified-since', conditional.lastModified);
      response = await this.http.request(url, {
        headers,
        redirect: 'follow',
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
      const detail = (await response.text()).slice(0, 300);
      throw new NflverseApiError(
        `nflverse returned HTTP ${response.status}.${detail ? ` Response: ${detail}` : ''}`,
        response.status,
        url,
      );
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new NflverseApiError(
        `The nflverse file exceeds ${MAX_DOWNLOAD_BYTES} bytes.`,
        response.status,
        url,
      );
    }

    try {
      const text = url.endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
      return {
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        rows: parse(text, {
        bom: true,
        columns: true,
        skip_empty_lines: true,
        }) as CsvRow[],
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
    if (!this.scheduleRequest) {
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
        },
      );
      this.scheduleRequest = resource.read(async (conditional) => {
        const downloaded = await this.fetchCsv(sourceUrl, conditional);
        if ('notModified' in downloaded) return downloaded;
        return {
          etag: downloaded.etag,
          lastModified: downloaded.lastModified,
          sourceTimestamp: downloaded.lastModified,
          value: downloaded.rows.map(parseGame).filter((game) => game.gameId.length > 0),
        };
      }).finally(() => {
        this.scheduleRequest = undefined;
      });
    }
    return this.scheduleRequest;
  }

  private loadPlayerStats(
    season: number,
    sourceUrl: string,
  ): Promise<ResourceResult<NflversePlayerWeek[]>> {
    const active = this.statsRequests.get(season);
    if (active) {
      return active;
    }
    const key = `player-stats-${CACHE_SCHEMA_VERSION}-${season}`;
    const resource = new CachedResource<NflversePlayerWeek[]>(
      this.database,
      'nflverse',
      key,
      sourceUrl,
      {
        schemaVersion: CACHE_SCHEMA_VERSION,
        snapshotKind: 'nflverse-player-stats',
        snapshotRetention: 4,
        staleIfErrorMs: STALE_IF_ERROR_MS,
        ttlMs: STATS_TTL_MS,
      },
    );
    const request = resource.read(async (conditional) => {
      const downloaded = await this.fetchCsv(sourceUrl, conditional);
      if ('notModified' in downloaded) return downloaded;
      return {
        etag: downloaded.etag,
        lastModified: downloaded.lastModified,
        sourceTimestamp: downloaded.lastModified,
        value: downloaded.rows
          .map(parsePlayerWeek)
          .filter((row) => row.playerId.length > 0),
      };
    }).finally(() => {
      this.statsRequests.delete(season);
    });
    this.statsRequests.set(season, request);
    return request;
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
    gameId: row.game_id ?? '',
    season: integer(row.season),
    gameType: row.game_type ?? '',
    week: integer(row.week),
    gameDate: row.gameday ?? '',
    gameTime: nullableText(row.gametime),
    awayTeam: row.away_team ?? '',
    awayScore: nullableNumber(row.away_score),
    homeTeam: row.home_team ?? '',
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
    playerId: row.player_id ?? '',
    playerDisplayName: row.player_display_name ?? row.player_name ?? '',
    position: row.position ?? '',
    season: integer(row.season),
    week: integer(row.week),
    seasonType: row.season_type ?? '',
    gameId: row.game_id ?? '',
    team: row.team ?? '',
    opponentTeam: row.opponent_team ?? '',
    completions: number(row.completions),
    attempts: number(row.attempts),
    passingYards: number(row.passing_yards),
    passingTouchdowns: number(row.passing_tds),
    interceptions: number(row.passing_interceptions),
    carries: number(row.carries),
    rushingYards: number(row.rushing_yards),
    rushingTouchdowns: number(row.rushing_tds),
    receptions: number(row.receptions),
    targets: number(row.targets),
    receivingYards: number(row.receiving_yards),
    receivingTouchdowns: number(row.receiving_tds),
    receivingAirYards: number(row.receiving_air_yards),
    targetShare: nullableNumber(row.target_share),
    airYardsShare: nullableNumber(row.air_yards_share),
    fantasyPoints: number(row.fantasy_points),
    fantasyPointsPpr: number(row.fantasy_points_ppr),
  };
}

function validateSeason(season: number): void {
  if (!Number.isInteger(season) || season < 1999 || season > 2100) {
    throw new RangeError('The nflverse season must be an integer from 1999 through 2100.');
  }
}

function integer(value: string | undefined): number {
  return Math.trunc(number(value));
}

function number(value: string | undefined): number {
  const parsed = Number(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableText(value: string | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  return normalized || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const NFLVERSE_SCHEDULE_SOURCE_URL = SCHEDULE_URL;
