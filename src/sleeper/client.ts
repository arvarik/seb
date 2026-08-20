import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

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

const DEFAULT_BASE_URL = 'https://api.sleeper.app/v1';
const PLAYER_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

type Fetch = typeof globalThis.fetch;

export interface SleeperClientOptions {
  baseUrl?: string;
  fetch?: Fetch;
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

interface PlayerCacheEnvelope {
  cachedAt: string;
  players: SleeperPlayerMap;
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
  private readonly fetchImplementation: Fetch;
  private readonly playerCacheFile: string | false;
  private readonly timeoutMs: number;

  constructor(options: SleeperClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.playerCacheFile =
      options.playerCacheFile === false
        ? false
        : (options.playerCacheFile ??
          resolve(process.cwd(), '.cache/sleeper/players-nfl.json'));
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  getNflState(): Promise<SleeperNflState> {
    return this.get('/state/nfl');
  }

  getUser(identifier: string): Promise<SleeperUser> {
    return this.get(`/user/${encodeURIComponent(identifier)}`);
  }

  getUserLeagues(userId: string, season: string): Promise<SleeperLeague[]> {
    return this.get(
      `/user/${encodeURIComponent(userId)}/leagues/nfl/${encodeURIComponent(season)}`,
    );
  }

  getLeague(leagueId: string): Promise<SleeperLeague> {
    return this.get(`/league/${encodeURIComponent(leagueId)}`);
  }

  getLeagueUsers(leagueId: string): Promise<SleeperUser[]> {
    return this.get(`/league/${encodeURIComponent(leagueId)}/users`);
  }

  getLeagueRosters(leagueId: string): Promise<SleeperRoster[]> {
    return this.get(`/league/${encodeURIComponent(leagueId)}/rosters`);
  }

  getLeagueMatchups(
    leagueId: string,
    week: number,
  ): Promise<SleeperMatchup[]> {
    return this.get(
      `/league/${encodeURIComponent(leagueId)}/matchups/${validateWeek(week)}`,
    );
  }

  getLeagueTransactions(
    leagueId: string,
    week: number,
  ): Promise<SleeperTransaction[]> {
    return this.get(
      `/league/${encodeURIComponent(leagueId)}/transactions/${validateWeek(week)}`,
    );
  }

  async getPlayers(filters: PlayerFilters = {}): Promise<SleeperPlayerMap> {
    const hasFilters = filters.active !== undefined || filters.position !== undefined;
    if (!hasFilters) {
      const cachedPlayers = await this.readPlayerCache();
      if (cachedPlayers) {
        return cachedPlayers;
      }
    }

    const players = await this.get<SleeperPlayerMap>('/players/nfl', {
      active: filters.active,
      position: filters.position?.toUpperCase(),
    });

    if (!hasFilters) {
      await this.writePlayerCache(players);
    }

    return players;
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
    return this.get('/players/nfl/trending/' + type, {
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

  private async get<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SleeperApiError(`Sleeper request failed: ${detail}`, 0, url.href);
    }

    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      const suffix = body ? ` Response: ${body}` : '';
      throw new SleeperApiError(
        `Sleeper returned HTTP ${response.status}.${suffix}`,
        response.status,
        url.href,
      );
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new SleeperApiError(
        'Sleeper returned invalid JSON.',
        response.status,
        url.href,
      );
    }
  }

  private async readPlayerCache(): Promise<SleeperPlayerMap | null> {
    if (!this.playerCacheFile) {
      return null;
    }

    try {
      const value = JSON.parse(
        await readFile(this.playerCacheFile, 'utf8'),
      ) as PlayerCacheEnvelope;
      const ageMs = Date.now() - Date.parse(value.cachedAt);
      if (
        Number.isFinite(ageMs) &&
        ageMs >= 0 &&
        ageMs < PLAYER_CACHE_TTL_MS &&
        value.players &&
        typeof value.players === 'object'
      ) {
        return value.players;
      }
    } catch {
      return null;
    }

    return null;
  }

  private async writePlayerCache(players: SleeperPlayerMap): Promise<void> {
    if (!this.playerCacheFile) {
      return;
    }

    const temporaryFile = `${this.playerCacheFile}.${process.pid}.tmp`;
    const envelope: PlayerCacheEnvelope = {
      cachedAt: new Date().toISOString(),
      players,
    };

    try {
      await mkdir(dirname(this.playerCacheFile), { recursive: true });
      await writeFile(temporaryFile, JSON.stringify(envelope), 'utf8');
      await rename(temporaryFile, this.playerCacheFile);
    } catch {
      // A cache failure must not block a successful Sleeper response.
    }
  }
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
