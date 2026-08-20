export interface DataSourceRecord {
  accessedAt: string;
  cacheOutcome?: 'cache-fresh' | 'source-updated' | 'source-not-modified' | 'stale-if-error';
  error?: string;
  id: string;
  label: string;
  retrievedAt?: string;
  url: string;
}

export type SourceObserver = (
  source: Omit<DataSourceRecord, 'accessedAt'>,
) => void;

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

  clear(): void {
    this.records.clear();
  }
}
