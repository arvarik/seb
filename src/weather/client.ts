import { resolve } from 'node:path';

import {
  CachedResource,
  type ResourceLoadContext,
  type ResourceResult,
} from '../data/cached-resource.js';
import { ResilientFetch, type RequestPolicy } from '../data/resilient-fetch.js';
import { getSharedSebDatabase, type SebDatabase } from '../data/sqlite-store.js';
import type { SourceObserver } from '../sources.js';
import type {
  NwsAlert,
  NwsForecastPeriod,
  NwsHourlyForecast,
  NwsPointMetadata,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.weather.gov';
const POINT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const FORECAST_TTL_MS = 10 * 60 * 1_000;
const ALERT_TTL_MS = 2 * 60 * 1_000;
const POINT_STALE_IF_ERROR_MS = 30 * 24 * 60 * 60 * 1_000;
const FORECAST_STALE_IF_ERROR_MS = 6 * 60 * 60 * 1_000;
const ALERT_STALE_IF_ERROR_MS = 30 * 60 * 1_000;

type Fetch = typeof globalThis.fetch;
type JsonObject = Record<string, unknown>;

export interface WeatherClientOptions {
  baseUrl?: string;
  cacheDirectory?: string | false;
  database?: SebDatabase | false;
  databaseFile?: string;
  fetch?: Fetch;
  onSource?: SourceObserver;
  policy?: Partial<RequestPolicy>;
  timeoutMs?: number;
  userAgent?: string;
}

export class WeatherApiError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = 'WeatherApiError';
    this.status = status;
    this.url = url;
  }
}

export class WeatherClient {
  private readonly baseUrl: string;
  private readonly database: SebDatabase | false;
  private readonly http: ResilientFetch;
  private readonly onSource: SourceObserver | undefined;
  private readonly userAgent: string;

  constructor(options: WeatherClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.database = options.database === false || options.cacheDirectory === false
      ? false
      : (options.database ?? getSharedSebDatabase(
          options.databaseFile ??
            (options.cacheDirectory ? resolve(options.cacheDirectory, 'seb.sqlite') : undefined),
        ));
    this.http = new ResilientFetch({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      policy: { timeoutMs: options.timeoutMs ?? 15_000, ...options.policy },
    });
    this.onSource = options.onSource;
    this.userAgent =
      options.userAgent?.trim() ||
      'seb/0.0.2 (+https://github.com/arvarik/seb)';
  }

  async getPointMetadata(
    latitude: number,
    longitude: number,
  ): Promise<NwsPointMetadata> {
    validateCoordinates(latitude, longitude);
    const key = coordinateKey(latitude, longitude);
    const url = `${this.baseUrl}/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`;
    const loaded = await this.readResource(
      `point-${key}`,
      url,
      POINT_TTL_MS,
      POINT_STALE_IF_ERROR_MS,
      'nws-point',
      parsePoint,
    );
    const point = loaded.value;
    this.validateNwsUrl(point.forecastHourlyUrl);
    this.recordSource(
      `nws-point-${key}`,
      'National Weather Service point metadata',
      url,
      loaded,
    );
    return point;
  }

  async getHourlyForecast(
    latitude: number,
    longitude: number,
  ): Promise<NwsHourlyForecast> {
    const point = await this.getPointMetadata(latitude, longitude);
    const key = coordinateKey(latitude, longitude);
    const loaded = await this.readResource(
      `forecast-${key}`,
      point.forecastHourlyUrl,
      FORECAST_TTL_MS,
      FORECAST_STALE_IF_ERROR_MS,
      'nws-hourly-forecast',
      (document) => parseForecast(document, point.forecastHourlyUrl, point.timeZone),
    );
    const forecast = loaded.value;
    this.recordSource(
      `nws-forecast-${key}`,
      'National Weather Service hourly forecast',
      point.forecastHourlyUrl,
      loaded,
    );
    return forecast;
  }

  async getActiveAlerts(
    latitude: number,
    longitude: number,
  ): Promise<NwsAlert[]> {
    validateCoordinates(latitude, longitude);
    const key = coordinateKey(latitude, longitude);
    const url = new URL(`${this.baseUrl}/alerts/active`);
    url.searchParams.set('point', `${latitude.toFixed(4)},${longitude.toFixed(4)}`);
    url.searchParams.set('status', 'actual');
    const loaded = await this.readResource(
      `alerts-${key}`,
      url.href,
      ALERT_TTL_MS,
      ALERT_STALE_IF_ERROR_MS,
      'nws-alerts',
      parseAlerts,
    );
    const alerts = loaded.value;
    this.recordSource(
      `nws-alerts-${key}`,
      'National Weather Service active alerts',
      url.href,
      loaded,
    );
    return alerts;
  }

  async clearCache(): Promise<void> {
    this.database && this.database.deleteCache('weather');
  }

  private async getJson(
    url: string,
    conditional: ResourceLoadContext,
  ): Promise<
    | { notModified: true }
    | {
        document: JsonObject;
        etag: string | null;
        lastModified: string | null;
      }
  > {
    let response: Response;
    try {
      const headers = new Headers({
          accept: 'application/geo+json, application/json',
          'user-agent': this.userAgent,
      });
      if (conditional.etag) headers.set('if-none-match', conditional.etag);
      if (conditional.lastModified) headers.set('if-modified-since', conditional.lastModified);
      response = await this.http.request(url, {
        headers,
      });
    } catch (error) {
      throw new WeatherApiError(
        `The National Weather Service request failed: ${errorMessage(error)}`,
        0,
        url,
      );
    }

    if (response.status === 304) {
      return { notModified: true };
    }

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new WeatherApiError(
        `The National Weather Service returned HTTP ${response.status}.${detail ? ` Response: ${detail}` : ''}`,
        response.status,
        url,
      );
    }

    try {
      return {
        document: (await response.json()) as JsonObject,
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
      };
    } catch {
      throw new WeatherApiError(
        'The National Weather Service returned invalid JSON.',
        response.status,
        url,
      );
    }
  }

  private readResource<T>(
    key: string,
    url: string,
    ttlMs: number,
    staleIfErrorMs: number,
    snapshotKind: string,
    parse: (document: JsonObject) => T,
  ): Promise<ResourceResult<T>> {
    const resource = new CachedResource<T>(
      this.database,
      'weather',
      key,
      url,
      {
        schemaVersion: 'nws-v1',
        snapshotKind,
        staleIfErrorMs,
        ttlMs,
      },
    );
    return resource.read(async (conditional) => {
      const loaded = await this.getJson(url, conditional);
      if ('notModified' in loaded) return loaded;
      return {
        etag: loaded.etag,
        lastModified: loaded.lastModified,
        sourceTimestamp: loaded.lastModified,
        value: parse(loaded.document),
      };
    });
  }

  private validateNwsUrl(url: string): void {
    const target = new URL(url);
    const base = new URL(this.baseUrl);
    if (target.origin !== base.origin) {
      throw new WeatherApiError(
        'The National Weather Service returned an unexpected forecast host.',
        0,
        url,
      );
    }
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

function parsePoint(document: JsonObject): NwsPointMetadata {
  const properties = object(document.properties);
  const relativeLocation = object(object(properties.relativeLocation).properties);
  const forecastHourlyUrl = text(properties.forecastHourly);
  if (!forecastHourlyUrl) {
    throw new Error('The National Weather Service point has no hourly forecast URL.');
  }
  return {
    gridId: text(properties.gridId) ?? '',
    gridX: numeric(properties.gridX),
    gridY: numeric(properties.gridY),
    forecastHourlyUrl,
    timeZone: text(properties.timeZone),
    city: text(relativeLocation.city),
    state: text(relativeLocation.state),
  };
}

function parseForecast(
  document: JsonObject,
  sourceUrl: string,
  timeZone: string | null,
): NwsHourlyForecast {
  const properties = object(document.properties);
  const periods = Array.isArray(properties.periods) ? properties.periods : [];
  return {
    sourceUrl,
    timeZone,
    generatedAt: text(properties.generatedAt),
    updatedAt: text(properties.updated),
    periods: periods.map((period) => parsePeriod(object(period))),
  };
}

function parsePeriod(period: JsonObject): NwsForecastPeriod {
  return {
    startTime: text(period.startTime) ?? '',
    endTime: text(period.endTime) ?? '',
    isDaytime: period.isDaytime === true,
    temperature: numeric(period.temperature),
    temperatureUnit: text(period.temperatureUnit) ?? 'F',
    precipitationProbability: nullableNumeric(
      object(period.probabilityOfPrecipitation).value,
    ),
    relativeHumidity: nullableNumeric(object(period.relativeHumidity).value),
    windSpeed: text(period.windSpeed) ?? '',
    windDirection: text(period.windDirection) ?? '',
    shortForecast: text(period.shortForecast) ?? '',
    detailedForecast: text(period.detailedForecast) ?? '',
  };
}

function parseAlerts(document: JsonObject): NwsAlert[] {
  const features = Array.isArray(document.features) ? document.features : [];
  return features.map((feature) => {
    const properties = object(object(feature).properties);
    return {
      event: text(properties.event) ?? 'Weather alert',
      severity: text(properties.severity),
      urgency: text(properties.urgency),
      certainty: text(properties.certainty),
      headline: text(properties.headline),
      description: text(properties.description),
      instruction: text(properties.instruction),
      onset: text(properties.onset),
      ends: text(properties.ends),
    };
  });
}

function validateCoordinates(latitude: number, longitude: number): void {
  if (!Number.isFinite(latitude) || latitude < 20 || latitude > 72) {
    throw new RangeError('The latitude must identify a location in the United States.');
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > -60) {
    throw new RangeError('The longitude must identify a location in the United States.');
  }
}

function coordinateKey(latitude: number, longitude: number): string {
  return `${latitude.toFixed(4)}_${longitude.toFixed(4)}`.replace(/\./g, '-');
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numeric(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
