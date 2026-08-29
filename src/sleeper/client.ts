import { dirname, resolve } from 'node:path';

import { CachedResource, type ResourcePolicy } from '../data/cached-resource.js';
import {
  readResponseErrorDetail,
  readResponseJson,
  ResponseBodyLimitError,
} from '../data/response-body.js';
import { ResilientFetch, type RequestPolicy } from '../data/resilient-fetch.js';
import { getSharedSebDatabase, type SebDatabase } from '../data/sqlite-store.js';
import { currentRequestSignal } from '../ai/request-signal.js';

import type {
  ResolvedTrendingPlayer,
  SleeperLeague,
  SleeperMatchup,
  SleeperNflState,
  SleeperPlayer,
  SleeperPlayerMap,
  SleeperRoster,
  SleeperTransaction,
  SleeperTrendingPlayer,
  SleeperUser,
} from './types.js';
import type { SourceObserver } from '../sources.js';
import { z } from 'zod';
import {
  sleeperLeagueListSchema,
  sleeperLeagueSchema,
  sleeperMatchupListSchema,
  sleeperNflStateSchema,
  sleeperPlayerMapSchema,
  sleeperRosterListSchema,
  sleeperTransactionListSchema,
  sleeperTrendingPlayerListSchema,
  sleeperUserListSchema,
  sleeperUserSchema,
} from './schemas.js';

const DEFAULT_BASE_URL = 'https://api.sleeper.app/v1';
const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_BYTES = 4 * 1024;

type Fetch = typeof globalThis.fetch;

export interface SleeperClientOptions {
  baseUrl?: string;
  database?: SebDatabase | false;
  databaseFile?: string;
  fetch?: Fetch;
  onSource?: SourceObserver;
  policy?: Partial<RequestPolicy>;
  /** @deprecated Use database or databaseFile. */
  playerCacheFile?: string | false;
  timeoutMs?: number;
}

export interface PlayerFilters {
  active?: boolean;
  position?: string;
}

export interface PlayerSearchOptions extends PlayerFilters {
  limit?: number;
}

export class SleeperApiError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = 'SleeperApiError';
    this.status = status;
    this.url = url;
  }
}

export class SleeperClient {
  private readonly baseUrl: string;
  private readonly database: SebDatabase | false;
  private readonly http: ResilientFetch;
  private readonly onSource: SourceObserver | undefined;

  constructor(options: SleeperClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    const compatibilityDatabaseFile =
      typeof options.playerCacheFile === 'string'
        ? resolve(dirname(options.playerCacheFile), 'seb.sqlite')
        : undefined;
    this.database = options.database === false || options.playerCacheFile === false
      ? false
      : (options.database ?? getSharedSebDatabase(
          options.databaseFile ?? compatibilityDatabaseFile,
        ));
    this.http = new ResilientFetch({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      policy: { timeoutMs: options.timeoutMs ?? 15_000, ...options.policy },
    });
    this.onSource = options.onSource;
  }

  getNflState(): Promise<SleeperNflState> {
    return this.get('/state/nfl', sleeperNflStateSchema);
  }

  getUser(identifier: string): Promise<SleeperUser> {
    return this.get(`/user/${encodeURIComponent(identifier)}`, sleeperUserSchema);
  }

  getUserLeagues(userId: string, season: string): Promise<SleeperLeague[]> {
    return this.get(
      `/user/${encodeURIComponent(userId)}/leagues/nfl/${encodeURIComponent(season)}`,
      sleeperLeagueListSchema,
    );
  }

  getLeague(leagueId: string): Promise<SleeperLeague> {
    return this.get(`/league/${encodeURIComponent(leagueId)}`, sleeperLeagueSchema);
  }

  getLeagueUsers(leagueId: string): Promise<SleeperUser[]> {
    return this.get(`/league/${encodeURIComponent(leagueId)}/users`, sleeperUserListSchema);
  }

  getLeagueRosters(leagueId: string): Promise<SleeperRoster[]> {
    return this.get(`/league/${encodeURIComponent(leagueId)}/rosters`, sleeperRosterListSchema);
  }

  getLeagueMatchups(
    leagueId: string,
    week: number,
  ): Promise<SleeperMatchup[]> {
    return this.get(
      `/league/${encodeURIComponent(leagueId)}/matchups/${validateWeek(week)}`,
      sleeperMatchupListSchema,
    );
  }

  getLeagueTransactions(
    leagueId: string,
    week: number,
  ): Promise<SleeperTransaction[]> {
    return this.get(
      `/league/${encodeURIComponent(leagueId)}/transactions/${validateWeek(week)}`,
      sleeperTransactionListSchema,
    );
  }

  async getPlayers(filters: PlayerFilters = {}): Promise<SleeperPlayerMap> {
    const hasFilters = filters.active !== undefined || filters.position !== undefined;
    return this.get('/players/nfl', sleeperPlayerMapSchema, {
      active: filters.active,
      position: filters.position?.toUpperCase(),
    }, hasFilters ? sleeperPolicy('players-filtered') : sleeperPolicy('players'));
  }

  async findPlayers(
    query: string,
    options: PlayerSearchOptions = {},
  ): Promise<SleeperPlayer[]> {
    const normalizedQuery = normalizeName(query);
    if (!normalizedQuery) {
      return [];
    }

    const players =
      options.active === false
        ? await this.getPlayers()
        : await this.getPlayers({
            active: true,
            ...(options.position ? { position: options.position } : {}),
          });
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 25);

    return Object.values(players)
      .filter((player) => playerMatches(player, normalizedQuery))
      .sort((left, right) => comparePlayerMatches(left, right, normalizedQuery))
      .slice(0, limit);
  }

  async getTrendingPlayers(
    type: 'add' | 'drop',
    lookbackHours = 24,
    limit = 25,
  ): Promise<SleeperTrendingPlayer[]> {
    return this.get('/players/nfl/trending/' + type, sleeperTrendingPlayerListSchema, {
      lookback_hours: Math.min(Math.max(lookbackHours, 1), 168),
      limit: Math.min(Math.max(limit, 1), 50),
    });
  }

  async getResolvedTrendingPlayers(
    type: 'add' | 'drop',
    lookbackHours = 24,
    limit = 25,
  ): Promise<ResolvedTrendingPlayer[]> {
    const [trending, players] = await Promise.all([
      this.getTrendingPlayers(type, lookbackHours, limit),
      this.getPlayers(),
    ]);

    return trending.map((item) => ({
      ...item,
      player: players[item.player_id] ?? null,
    }));
  }

  async clearCache(): Promise<void> {
    if (this.database) this.database.deleteCache('sleeper');
  }

  private async get<T>(
    path: string,
    schema: z.ZodType<T>,
    query: Record<string, string | number | boolean | undefined> = {},
    policy: ResourcePolicy<T> = sleeperPolicy(path),
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }

    const resource = new CachedResource<T>(
      this.database,
      'sleeper',
      url.href,
      url.href,
      { ...policy, validate: (value) => schema.parse(value) },
      this,
    );
    const signal = currentRequestSignal();
    const result = await resource.read(async (conditional) => {
      let response: Response;
      try {
        response = await this.http.request(url, {
          headers: conditionalHeaders('application/json', conditional),
          signal: conditional.signal,
        });
      } catch (error) {
        throw new SleeperApiError(
          `Sleeper request failed: ${errorMessage(error)}`,
          0,
          url.href,
        );
      }
      if (response.status === 304) {
        return { notModified: true };
      }
      if (!response.ok) {
        const body = await readResponseErrorDetail(response, MAX_ERROR_BYTES);
        throw new SleeperApiError(
          `Sleeper returned HTTP ${response.status}.${body ? ` Response: ${body}` : ''}`,
          response.status,
          url.href,
        );
      }
      try {
        return {
          etag: response.headers.get('etag'),
          lastModified: response.headers.get('last-modified'),
          value: await readResponseJson(response, MAX_JSON_BYTES),
        };
      } catch (error) {
        if (error instanceof ResponseBodyLimitError) {
          throw new SleeperApiError(error.message, response.status, url.href);
        }
        throw new SleeperApiError('Sleeper returned invalid JSON.', response.status, url.href);
      }
    }, signal ? { signal } : {});
    this.onSource?.({
      cacheOutcome: result.outcome,
      ...(result.error ? { error: result.error } : {}),
      ...(result.warnings ? { warnings: result.warnings } : {}),
      id: `sleeper-${path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`,
      label: 'Sleeper read-only API',
      retrievedAt: result.cache.cachedAt,
      url: url.href,
    });
    return result.value;
  }
}

function sleeperPolicy<T>(resource: string): ResourcePolicy<T> {
  if (resource === 'players') {
    return {
      schemaVersion: 'sleeper-v2',
      snapshotKind: 'sleeper-players',
      snapshotRetention: 8,
      staleIfErrorMs: 7 * DAY_MS,
      ttlMs: DAY_MS,
    };
  }
  if (resource.includes('trending') || resource === 'players-filtered') {
    return {
      schemaVersion: 'sleeper-v2',
      staleIfErrorMs: 10 * MINUTE_MS,
      ttlMs: MINUTE_MS,
    };
  }
  const isHistorical = resource.includes('/matchups/') || resource.includes('/transactions/');
  return {
    schemaVersion: 'sleeper-v2',
    snapshotKind: isHistorical ? 'sleeper-league-week' : 'sleeper-resource',
    snapshotRetention: isHistorical ? 16 : 8,
    staleIfErrorMs: isHistorical ? DAY_MS : HOUR_MS,
    ttlMs: isHistorical ? 2 * MINUTE_MS : 5 * MINUTE_MS,
  };
}

function conditionalHeaders(
  accept: string,
  conditional: { etag: string | null; lastModified: string | null },
): Headers {
  const headers = new Headers({ accept });
  if (conditional.etag) {
    headers.set('if-none-match', conditional.etag);
  }
  if (conditional.lastModified) {
    headers.set('if-modified-since', conditional.lastModified);
  }
  return headers;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateWeek(week: number): number {
  if (!Number.isInteger(week) || week < 1 || week > 18) {
    throw new RangeError('The NFL week must be an integer from 1 through 18.');
  }
  return week;
}

function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function playerName(player: SleeperPlayer): string {
  return (
    player.full_name ??
    [player.first_name, player.last_name].filter(Boolean).join(' ')
  );
}

function playerMatches(player: SleeperPlayer, query: string): boolean {
  return [
    playerName(player),
    player.search_full_name,
    player.first_name,
    player.last_name,
    player.player_id,
  ].some((value) => value && normalizeName(value).includes(query));
}

function comparePlayerMatches(
  left: SleeperPlayer,
  right: SleeperPlayer,
  query: string,
): number {
  const leftName = normalizeName(playerName(left));
  const rightName = normalizeName(playerName(right));
  const leftScore = leftName === query ? 0 : leftName.startsWith(query) ? 1 : 2;
  const rightScore = rightName === query ? 0 : rightName.startsWith(query) ? 1 : 2;

  return (
    leftScore - rightScore ||
    (left.search_rank ?? Number.MAX_SAFE_INTEGER) -
      (right.search_rank ?? Number.MAX_SAFE_INTEGER) ||
    leftName.localeCompare(rightName)
  );
}
