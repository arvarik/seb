export interface DataSourceRecord {
  accessedAt: string;
  cacheOutcome?: 'cache-fresh' | 'source-updated' | 'source-not-modified' | 'stale-if-error';
  error?: string;
  id: string;
  label: string;
  retrievedAt?: string;
  url: string;
  warnings?: string[];
}

export type SourceObserver = (
  source: Omit<DataSourceRecord, 'accessedAt'>,
) => void;

export function normalizeWebUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.href;
  } catch {
    return null;
  }
}

export function normalizeSourceLabel(
  value: string | undefined,
  fallback: string,
): string {
  return value?.replace(/\s+/g, ' ').trim().slice(0, 300) || fallback;
}

export class SourceTracker {
  private readonly records = new Map<string, DataSourceRecord>();

  readonly record: SourceObserver = (source) => {
    this.records.set(source.id, {
      ...source,
      accessedAt: new Date().toISOString(),
    });
  };

  list(): DataSourceRecord[] {
    return [...this.records.values()].sort((left, right) =>
      right.accessedAt.localeCompare(left.accessedAt),
    );
  }

  recordUrlSource(source: {
    id: string;
    title?: string | undefined;
    url: string;
  }): boolean {
    const normalizedUrl = normalizeWebUrl(source.url);
    if (!normalizedUrl) return false;
    const hostname = new URL(normalizedUrl).hostname;
    this.record({
      id: `web:${source.id}`,
      label: normalizeSourceLabel(source.title, hostname),
      url: normalizedUrl,
    });
    return true;
  }

  clear(): void {
    this.records.clear();
  }
}
