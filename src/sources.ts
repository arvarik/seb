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

const MAX_EVIDENCE_SOURCES = 100;
const MAX_ANSWER_ID_CHARACTERS = 512;
const MAX_SOURCE_ERROR_CHARACTERS = 500;
const MAX_SOURCE_ID_CHARACTERS = 512;
const MAX_SOURCE_RECORDS = 200;
const MAX_SOURCE_URL_CHARACTERS = 4_096;
const MAX_SOURCE_WARNING_CHARACTERS = 300;
const MAX_SOURCE_WARNINGS = 10;

export function normalizeWebUrl(value: string): string | null {
  if (typeof value !== 'string' || value.length > MAX_SOURCE_URL_CHARACTERS) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
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
    const record = normalizeSourceRecord({
      ...source,
      accessedAt: new Date().toISOString(),
    });
    if (!record) return;
    this.records.delete(record.id);
    this.records.set(record.id, record);
    while (this.records.size > MAX_SOURCE_RECORDS) {
      const oldestId = this.records.keys().next().value;
      if (typeof oldestId !== 'string') break;
      this.records.delete(oldestId);
    }
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
  const records = sources
    .slice(-MAX_EVIDENCE_SOURCES)
    .map(normalizeSourceRecord)
    .filter((source): source is DataSourceRecord => source !== null)
    .map(freezeSourceRecord);
  return Object.freeze({
    answerId: answerId.slice(0, MAX_ANSWER_ID_CHARACTERS),
    capturedAt: capturedAt.toISOString(),
    sources: Object.freeze(records),
  });
}

function normalizeSourceRecord(
  source: DataSourceRecord,
): DataSourceRecord | null {
  const url = normalizeWebUrl(source.url);
  if (!url) return null;
  const id = typeof source.id === 'string'
    ? source.id.trim().slice(0, MAX_SOURCE_ID_CHARACTERS)
    : '';
  if (!id) return null;
  const cacheOutcome = source.cacheOutcome;
  const validCacheOutcome =
    cacheOutcome === 'cache-fresh' ||
    cacheOutcome === 'source-updated' ||
    cacheOutcome === 'source-not-modified' ||
    cacheOutcome === 'stale-if-error';
  const warnings = Array.isArray(source.warnings)
    ? source.warnings
      .filter((warning): warning is string => typeof warning === 'string')
      .slice(0, MAX_SOURCE_WARNINGS)
      .map((warning) => warning.slice(0, MAX_SOURCE_WARNING_CHARACTERS))
    : [];
  return {
    ...(validCacheOutcome ? { cacheOutcome } : {}),
    ...(typeof source.error === 'string' && source.error
      ? { error: source.error.slice(0, MAX_SOURCE_ERROR_CHARACTERS) }
      : {}),
    id,
    label: normalizeSourceLabel(
      typeof source.label === 'string' ? source.label : undefined,
      new URL(url).hostname,
    ),
    ...(typeof source.retrievedAt === 'string' && source.retrievedAt
      ? { retrievedAt: source.retrievedAt.slice(0, 64) }
      : {}),
    accessedAt: typeof source.accessedAt === 'string'
      ? source.accessedAt.slice(0, 64)
      : '',
    url,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
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
