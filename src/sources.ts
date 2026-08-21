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

export interface SourceEvidenceSnapshot {
  answerId: string;
  capturedAt: string;
  sources: readonly DataSourceRecord[];
}

export interface EvidenceMarkdownOptions {
  limit?: number;
  now?: Date;
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
      ...(source.warnings ? { warnings: [...source.warnings] } : {}),
    });
  };

  list(): DataSourceRecord[] {
    return [...this.records.values()]
      .sort((left, right) => right.accessedAt.localeCompare(left.accessedAt))
      .map(cloneSourceRecord);
  }

  snapshot(answerId: string, capturedAt = new Date()): SourceEvidenceSnapshot {
    return createSourceEvidenceSnapshot(
      answerId,
      [...this.records.values()].map(cloneSourceRecord),
      capturedAt,
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

export function createSourceEvidenceSnapshot(
  answerId: string,
  sources: readonly DataSourceRecord[],
  capturedAt = new Date(),
): SourceEvidenceSnapshot {
  const records = sources.map(freezeSourceRecord);
  return Object.freeze({
    answerId,
    capturedAt: capturedAt.toISOString(),
    sources: Object.freeze(records),
  });
}

export function sourceEvidenceBadge(
  source: DataSourceRecord,
  now = new Date(),
): string {
  if (source.cacheOutcome === 'stale-if-error') return 'STALE';
  if (source.cacheOutcome !== 'cache-fresh') return 'LIVE';
  return `CACHED ${shortSourceAge(sourceAgeMilliseconds(source, now))}`;
}

export function sourceRetrievalDetail(
  source: DataSourceRecord,
  now = new Date(),
): string {
  const age = shortSourceAge(sourceAgeMilliseconds(source, now));
  const action = source.id.startsWith('web:') ? 'accessed' : 'retrieved';
  const timing = age === 'now' ? `${action} now` : `${action} ${age} ago`;
  const outcome = source.cacheOutcome
    ? source.cacheOutcome.replaceAll('-', ' ')
    : source.id.startsWith('web:')
      ? 'web result'
      : 'direct source';
  return `${timing} · ${outcome}`;
}

export function formatEvidenceMarkdown(
  sources: readonly DataSourceRecord[],
  options: EvidenceMarkdownOptions = {},
): string {
  if (sources.length === 0) return '';
  const limit = Math.max(1, options.limit ?? sources.length);
  const visible = sources.slice(0, limit);
  const hidden = sources.length - visible.length;
  const now = options.now ?? new Date();
  return [
    '## Evidence',
    '',
    ...visible.map((source, index) =>
      `${index + 1}. [${safeMarkdownLabel(source.label)}](<${source.url}>) · **${sourceEvidenceBadge(source, now)}** · ${sourceRetrievalDetail(source, now)}`,
    ),
    ...(hidden > 0
      ? [`${hidden} more source${hidden === 1 ? '' : 's'} · Run \`/sources\` for the exact set.`]
      : []),
  ].join('\n');
}

function cloneSourceRecord(source: DataSourceRecord): DataSourceRecord {
  return {
    ...source,
    ...(source.warnings ? { warnings: [...source.warnings] } : {}),
  };
}

function freezeSourceRecord(source: DataSourceRecord): DataSourceRecord {
  const record = cloneSourceRecord(source);
  if (record.warnings) Object.freeze(record.warnings);
  return Object.freeze(record);
}

function sourceAgeMilliseconds(source: DataSourceRecord, now: Date): number {
  const timestamp = Date.parse(source.retrievedAt ?? source.accessedAt);
  return Number.isFinite(timestamp) ? Math.max(0, now.getTime() - timestamp) : 0;
}

function shortSourceAge(milliseconds: number): string {
  if (milliseconds < 60_000) return 'now';
  if (milliseconds < 3_600_000) return `${Math.floor(milliseconds / 60_000)}m`;
  if (milliseconds < 86_400_000) return `${Math.floor(milliseconds / 3_600_000)}h`;
  return `${Math.floor(milliseconds / 86_400_000)}d`;
}

function safeMarkdownLabel(value: string): string {
  return value.replaceAll('[', '').replaceAll(']', '').replace(/\s+/g, ' ').trim();
}
