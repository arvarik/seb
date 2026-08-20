import type { CacheEntry, SebDatabase } from './sqlite-store.js';
import { createDirectProvenanceManifest } from '../provenance/direct.js';

export type CacheOutcome =
  | 'cache-fresh'
  | 'source-updated'
  | 'source-not-modified'
  | 'stale-if-error';

export interface ResourcePolicy {
  schemaVersion: string;
  snapshotKind?: string;
  snapshotRetention?: number;
  staleIfErrorMs: number;
  ttlMs: number;
}

export interface ResourceLoadContext {
  etag: string | null;
  lastModified: string | null;
}

export type ResourceLoadResult<T> =
  | {
      etag?: string | null;
      lastModified?: string | null;
      sourceTimestamp?: string | null;
      value: T;
    }
  | { notModified: true };

export interface ResourceResult<T> {
  cache: CacheEntry<T>;
  error?: string;
  outcome: CacheOutcome;
  value: T;
}

export class CachedResource<T> {
  constructor(
    private readonly database: SebDatabase | false,
    private readonly namespace: string,
    private readonly key: string,
    private readonly sourceUrl: string,
    private readonly policy: ResourcePolicy,
  ) {}

  async read(
    load: (context: ResourceLoadContext) => Promise<ResourceLoadResult<T>>,
  ): Promise<ResourceResult<T>> {
    const cached = this.database
      ? this.database.getCache<T>(this.namespace, this.key)
      : null;
    if (cached?.freshness === 'fresh' && cached.schemaVersion === this.policy.schemaVersion) {
      return { cache: cached, outcome: 'cache-fresh', value: cached.value };
    }

    const conditional = cached?.schemaVersion === this.policy.schemaVersion ? cached : null;
    try {
      const loaded = await load({
        etag: conditional?.etag ?? null,
        lastModified: conditional?.lastModified ?? null,
      });
      if ('notModified' in loaded) {
        if (!conditional || !this.database) {
          throw new Error('The source returned not modified without a cached value.');
        }
        try {
          const touched = this.database.touchCache(
            this.namespace,
            this.key,
            this.policy.ttlMs,
            this.policy.staleIfErrorMs,
          ) as CacheEntry<T> | null;
          if (touched) {
            return { cache: touched, outcome: 'source-not-modified', value: touched.value };
          }
        } catch {
          // The source confirmed the value. A local write failure must not hide it.
        }
        return {
          cache: { ...conditional, freshness: 'fresh' },
          outcome: 'source-not-modified',
          value: conditional.value,
        };
      }

      let stored = false;
      let cache: CacheEntry<T>;
      if (this.database) {
        try {
          cache = this.database.putCache<T>({
            etag: loaded.etag ?? null,
            key: this.key,
            lastModified: loaded.lastModified ?? null,
            namespace: this.namespace,
            schemaVersion: this.policy.schemaVersion,
            sourceUrl: this.sourceUrl,
            staleIfErrorMs: this.policy.staleIfErrorMs,
            ttlMs: this.policy.ttlMs,
            value: loaded.value,
          });
          stored = true;
        } catch {
          cache = memoryEntry(
            this.namespace,
            this.key,
            loaded.value,
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
          loaded.value,
          this.sourceUrl,
          this.policy,
          loaded.etag ?? null,
          loaded.lastModified ?? null,
        );
      }
      if (this.database && stored && this.policy.snapshotKind) {
        try {
          const sourceId = `${this.namespace}:${this.key}`;
          const provenance = createDirectProvenanceManifest(loaded.value, {
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
              payload: loaded.value,
              provenance,
              schemaVersion: this.policy.schemaVersion,
              sourceTimestamp: loaded.sourceTimestamp ?? null,
            },
            this.policy.snapshotRetention,
          );
        } catch {
          // A snapshot failure must not hide a valid source response.
        }
      }
      return { cache, outcome: 'source-updated', value: loaded.value };
    } catch (error) {
      if (conditional?.freshness === 'stale') {
        return {
          cache: conditional,
          error: errorMessage(error),
          outcome: 'stale-if-error',
          value: conditional.value,
        };
      }
      throw error;
    }
  }

  clear(): number {
    return this.database ? this.database.deleteCache(this.namespace, this.key) : 0;
  }
}

function memoryEntry<T>(
  namespace: string,
  key: string,
  value: T,
  sourceUrl: string,
  policy: ResourcePolicy,
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
