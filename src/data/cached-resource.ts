import type { CacheEntry, SebDatabase } from './sqlite-store.js';
import { createDirectProvenanceManifest } from '../provenance/direct.js';

export type CacheOutcome =
  | 'cache-fresh'
  | 'source-updated'
  | 'source-not-modified'
  | 'stale-if-error';

export interface ResourcePolicy<T = unknown> {
  schemaVersion: string;
  snapshotKind?: string;
  snapshotRetention?: number;
  staleIfErrorMs: number;
  ttlMs: number;
  validate?: (value: unknown) => T;
}

export interface ResourceLoadContext {
  etag: string | null;
  lastModified: string | null;
  signal: AbortSignal;
}

export interface ResourceReadOptions {
  signal?: AbortSignal;
}

export type ResourceLoadResult<T = unknown> =
  | {
      etag?: string | null;
      lastModified?: string | null;
      sourceTimestamp?: string | null;
      value: T;
      valueValidated?: true;
    }
  | { notModified: true };

export interface ResourceResult<T> {
  cache: CacheEntry<T>;
  error?: string;
  outcome: CacheOutcome;
  value: T;
  warnings?: string[];
}

interface ResourceFlight {
  controller: AbortController;
  key: string;
  promise: Promise<ResourceResult<unknown>>;
  registry: Map<string, ResourceFlight>;
  settled: boolean;
  waiters: Set<symbol>;
}

const DATABASE_RESOURCE_FLIGHTS = new Map<string, Map<string, ResourceFlight>>();
const SCOPED_RESOURCE_FLIGHTS = new WeakMap<object, Map<string, ResourceFlight>>();
const NEVER_ABORT_SIGNAL = new AbortController().signal;

export class CachedResource<T> {
  constructor(
    private readonly database: SebDatabase | false,
    private readonly namespace: string,
    private readonly key: string,
    private readonly sourceUrl: string,
    private readonly policy: ResourcePolicy<T>,
    private readonly flightScope?: object,
  ) {}

  async read(
    load: (context: ResourceLoadContext) => Promise<ResourceLoadResult>,
    options: ResourceReadOptions = {},
  ): Promise<ResourceResult<T>> {
    options.signal?.throwIfAborted();
    const warnings: string[] = [];
    let cached: CacheEntry<T> | null = null;
    let cacheRevision: number | null = this.database ? null : 0;
    if (this.database) {
      try {
        cacheRevision = this.database.cacheRevision(this.namespace);
        cached = this.validateCachedEntry(
          this.database.getCache<unknown>(this.namespace, this.key),
          warnings,
        );
      } catch (error) {
        warnings.push(`Seb could not read the local cache: ${errorMessage(error)}`);
      }
    }
    if (cached?.freshness === 'fresh') {
      return {
        cache: cached,
        outcome: 'cache-fresh',
        value: cached.value,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    const flightScope = this.database ? this.database.file : this.flightScope;
    if (!flightScope) {
      return this.loadAndStore(
        cached,
        warnings,
        load,
        options.signal ?? NEVER_ABORT_SIGNAL,
      );
    }

    const registry = typeof flightScope === 'string'
      ? databaseFlightRegistry(flightScope)
      : scopedFlightRegistry(flightScope);
    const key = this.flightKey(cacheRevision);
    let flight = registry.get(key);
    if (!flight || flight.controller.signal.aborted) {
      const controller = new AbortController();
      flight = {
        controller,
        key,
        promise: Promise.resolve(undefined as never),
        registry,
        settled: false,
        waiters: new Set(),
      };
      const createdFlight = flight;
      createdFlight.promise = this.loadAndStoreResult(
        cached,
        warnings,
        load,
        controller.signal,
        cacheRevision,
      ).finally(() => {
        createdFlight.settled = true;
        if (registry.get(key) === createdFlight) registry.delete(key);
        if (
          typeof flightScope === 'string' &&
          registry.size === 0 &&
          DATABASE_RESOURCE_FLIGHTS.get(flightScope) === registry
        ) {
          DATABASE_RESOURCE_FLIGHTS.delete(flightScope);
        }
      });
      void createdFlight.promise.catch(() => undefined);
      registry.set(key, createdFlight);
    }
    const signal = options.signal ?? NEVER_ABORT_SIGNAL;
    try {
      const result = await waitForResourceFlight(flight, options.signal);
      signal.throwIfAborted();
      return mergeResourceWarnings(result as ResourceResult<T>, warnings);
    } catch (error) {
      return this.useStaleOrThrow(cached, warnings, error, signal);
    }
  }

  private async loadAndStore(
    conditional: CacheEntry<T> | null,
    warnings: string[],
    load: (context: ResourceLoadContext) => Promise<ResourceLoadResult>,
    signal: AbortSignal,
  ): Promise<ResourceResult<T>> {
    try {
      return await this.loadAndStoreResult(conditional, warnings, load, signal);
    } catch (error) {
      return this.useStaleOrThrow(conditional, warnings, error, signal);
    }
  }

  private async loadAndStoreResult(
    conditional: CacheEntry<T> | null,
    warnings: string[],
    load: (context: ResourceLoadContext) => Promise<ResourceLoadResult>,
    signal: AbortSignal,
    cacheRevision: number | null = null,
  ): Promise<ResourceResult<T>> {
    const loaded = await load({
      etag: conditional?.etag ?? null,
      lastModified: conditional?.lastModified ?? null,
      signal,
    });
    signal.throwIfAborted();
    return this.storeLoaded(conditional, warnings, loaded, cacheRevision);
  }

  private storeLoaded(
    conditional: CacheEntry<T> | null,
    warnings: string[],
    loaded: ResourceLoadResult,
    cacheRevision: number | null,
  ): ResourceResult<T> {
    if ('notModified' in loaded) {
      if (!conditional || !this.database) {
        throw new Error('The source returned not modified without a cached value.');
      }
      if (cacheRevision === null) {
        return this.notModifiedMemoryResult(conditional, warnings);
      }
      try {
        const touched = this.database.touchCache(
          this.namespace,
          this.key,
          this.policy.ttlMs,
          this.policy.staleIfErrorMs,
          undefined,
          conditional,
          cacheRevision,
        ) as CacheEntry<T> | null;
        if (touched) {
          return {
            cache: touched,
            outcome: 'source-not-modified',
            value: touched.value,
            ...(warnings.length > 0 ? { warnings } : {}),
          };
        }
      } catch (error) {
        warnings.push(`Seb could not renew the local cache: ${errorMessage(error)}`);
      }
      return this.notModifiedMemoryResult(conditional, warnings);
    }

    const value = loaded.valueValidated
      ? loaded.value as T
      : this.validate(loaded.value);
    let stored = false;
    let cache: CacheEntry<T>;
    if (this.database && cacheRevision !== null) {
      try {
        const storedCache = this.database.putCache<T>({
          etag: loaded.etag ?? null,
          key: this.key,
          lastModified: loaded.lastModified ?? null,
          namespace: this.namespace,
          schemaVersion: this.policy.schemaVersion,
          sourceUrl: this.sourceUrl,
          staleIfErrorMs: this.policy.staleIfErrorMs,
          ttlMs: this.policy.ttlMs,
          value,
        }, cacheRevision);
        if (storedCache) {
          cache = storedCache;
          stored = true;
        } else {
          cache = memoryEntry(
            this.namespace,
            this.key,
            value,
            this.sourceUrl,
            this.policy,
            loaded.etag ?? null,
            loaded.lastModified ?? null,
          );
        }
      } catch (error) {
        warnings.push(`Seb could not save the local cache: ${errorMessage(error)}`);
        cache = memoryEntry(
          this.namespace,
          this.key,
          value,
          this.sourceUrl,
          this.policy,
          loaded.etag ?? null,
          loaded.lastModified ?? null,
        );
      }
    } else {
      cache = memoryEntry(
        this.namespace,
        this.key,
        value,
        this.sourceUrl,
        this.policy,
        loaded.etag ?? null,
        loaded.lastModified ?? null,
      );
    }
    if (
      this.database &&
      stored &&
      this.policy.snapshotKind &&
      cacheRevision !== null
    ) {
      try {
        const sourceId = `${this.namespace}:${this.key}`;
        const provenance = createDirectProvenanceManifest(value, {
          envelopeId: `snapshot:${sourceId}:${cache.cachedAt}`,
          now: cache.cachedAt,
          source: {
            id: sourceId,
            label: this.namespace,
            provider: this.namespace,
            retrievedAt: cache.cachedAt,
            url: this.sourceUrl,
            freshnessPolicy: {
              freshForMs: this.policy.ttlMs,
              staleIfErrorForMs: this.policy.staleIfErrorMs,
            },
            ...(loaded.sourceTimestamp
              ? { observedAt: loaded.sourceTimestamp }
              : {}),
          },
        });
        this.database.createSnapshot(
          {
            entityKey: this.key,
            kind: this.policy.snapshotKind,
            payload: value,
            provenance,
            schemaVersion: this.policy.schemaVersion,
            sourceTimestamp: loaded.sourceTimestamp ?? null,
          },
          this.policy.snapshotRetention,
          {
            namespace: this.namespace,
            revision: cacheRevision,
          },
        );
      } catch (error) {
        warnings.push(`Seb could not save the source snapshot: ${errorMessage(error)}`);
      }
    }
    return {
      cache,
      outcome: 'source-updated',
      value,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  private notModifiedMemoryResult(
    conditional: CacheEntry<T>,
    warnings: string[],
  ): ResourceResult<T> {
    return {
      cache: memoryEntry(
        this.namespace,
        this.key,
        conditional.value,
        this.sourceUrl,
        this.policy,
        conditional.etag,
        conditional.lastModified,
      ),
      outcome: 'source-not-modified',
      value: conditional.value,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  private useStaleOrThrow(
    conditional: CacheEntry<T> | null,
    warnings: string[],
    error: unknown,
    signal: AbortSignal,
  ): ResourceResult<T> {
    signal.throwIfAborted();
    if (conditional?.freshness === 'stale' && Date.now() <= Date.parse(conditional.staleUntil)) {
      return {
        cache: conditional,
        error: errorMessage(error),
        outcome: 'stale-if-error',
        value: conditional.value,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }
    throw error;
  }

  clear(): number {
    return this.database ? this.database.deleteCache(this.namespace, this.key) : 0;
  }

  private validate(value: unknown): T {
    return this.policy.validate ? this.policy.validate(value) : value as T;
  }

  private validateCachedEntry(
    entry: CacheEntry<unknown> | null,
    warnings: string[],
  ): CacheEntry<T> | null {
    if (
      !entry ||
      entry.schemaVersion !== this.policy.schemaVersion ||
      entry.sourceUrl !== this.sourceUrl
    ) {
      return null;
    }
    try {
      const cachedAtMs = Date.parse(entry.cachedAt);
      if (!Number.isFinite(cachedAtMs)) {
        throw new Error('The cached retrieval time is invalid.');
      }
      const expiresAtMs = cachedAtMs + this.policy.ttlMs;
      const staleUntilMs = expiresAtMs + this.policy.staleIfErrorMs;
      const nowMs = Date.now();
      const expiresAt = new Date(expiresAtMs).toISOString();
      const staleUntil = new Date(staleUntilMs).toISOString();
      if (
        this.database &&
        (entry.expiresAt !== expiresAt || entry.staleUntil !== staleUntil)
      ) {
        try {
          this.database.updateCachePolicy(
            this.namespace,
            this.key,
            entry.cachedAt,
            entry.checksum,
            this.policy.ttlMs,
            this.policy.staleIfErrorMs,
          );
        } catch (error) {
          warnings.push(`Seb could not update the local cache policy: ${errorMessage(error)}`);
        }
      }
      return {
        ...entry,
        expiresAt,
        freshness:
          nowMs < expiresAtMs
            ? 'fresh'
            : nowMs <= staleUntilMs
              ? 'stale'
              : 'expired',
        staleUntil,
        value: this.validate(entry.value),
      };
    } catch {
      if (this.database) this.database.deleteCache(this.namespace, this.key);
      return null;
    }
  }

  private flightKey(cacheRevision: number | null): string {
    return JSON.stringify([
      this.namespace,
      this.key,
      this.sourceUrl,
      this.policy.schemaVersion,
      this.policy.ttlMs,
      this.policy.staleIfErrorMs,
      this.policy.snapshotKind ?? null,
      this.policy.snapshotRetention ?? null,
      cacheRevision,
    ]);
  }
}

function databaseFlightRegistry(file: string): Map<string, ResourceFlight> {
  const existing = DATABASE_RESOURCE_FLIGHTS.get(file);
  if (existing) return existing;
  const created = new Map<string, ResourceFlight>();
  DATABASE_RESOURCE_FLIGHTS.set(file, created);
  return created;
}

function scopedFlightRegistry(scope: object): Map<string, ResourceFlight> {
  const existing = SCOPED_RESOURCE_FLIGHTS.get(scope);
  if (existing) return existing;
  const created = new Map<string, ResourceFlight>();
  SCOPED_RESOURCE_FLIGHTS.set(scope, created);
  return created;
}

function waitForResourceFlight(
  flight: ResourceFlight,
  signal: AbortSignal | undefined,
): Promise<ResourceResult<unknown>> {
  const waiter = Symbol('resource-waiter');
  flight.waiters.add(waiter);

  return new Promise<ResourceResult<unknown>>((resolve, reject) => {
    let finished = false;
    const finish = (
      action: () => void,
      abortReason?: unknown,
    ): void => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      flight.waiters.delete(waiter);
      if (flight.waiters.size === 0 && !flight.settled) {
        if (flight.registry.get(flight.key) === flight) {
          flight.registry.delete(flight.key);
        }
        flight.controller.abort(abortReason);
      }
      action();
    };
    const onAbort = (): void => {
      const reason = abortSignalReason(signal);
      finish(() => reject(reason), reason);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    flight.promise.then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function mergeResourceWarnings<T>(
  result: ResourceResult<T>,
  warnings: string[],
): ResourceResult<T> {
  if (warnings.length === 0) return result;
  const combined = [...new Set([...(result.warnings ?? []), ...warnings])];
  return { ...result, warnings: combined };
}

function abortSignalReason(signal: AbortSignal | undefined): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

function memoryEntry<T>(
  namespace: string,
  key: string,
  value: T,
  sourceUrl: string,
  policy: ResourcePolicy<T>,
  etag: string | null,
  lastModified: string | null,
): CacheEntry<T> {
  const cachedAt = new Date().toISOString();
  const cachedAtMs = Date.parse(cachedAt);
  return {
    cachedAt,
    checksum: '',
    etag,
    expiresAt: new Date(cachedAtMs + policy.ttlMs).toISOString(),
    freshness: 'fresh',
    key,
    lastModified,
    namespace,
    schemaVersion: policy.schemaVersion,
    sourceUrl,
    staleUntil: new Date(
      cachedAtMs + policy.ttlMs + policy.staleIfErrorMs,
    ).toISOString(),
    value,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
