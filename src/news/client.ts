import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { z } from 'zod';

import { currentRequestSignal } from '../ai/request-signal.js';
import {
  CachedResource,
  type CacheOutcome,
  type ResourceLoadContext,
  type ResourceResult,
} from '../data/cached-resource.js';
import {
  readResponseBytes,
  readResponseErrorDetail,
} from '../data/response-body.js';
import { ResilientFetch, type RequestPolicy } from '../data/resilient-fetch.js';
import { getSharedSebDatabase, type SebDatabase } from '../data/sqlite-store.js';
import { defaultTeams } from '../identity/teams.js';
import type { SourceObserver } from '../sources.js';
import { SEB_USER_AGENT } from '../version.js';
import {
  parseArticleMetadata,
  parseAtomFeed,
  parseNewsHtml,
  parseNewsSitemap,
  parseRssFeed,
  type ArticleMetadata,
} from './parsers.js';
import { FIRST_CLASS_NEWS_SOURCES } from './sources.js';
import type {
  DiscoveredNewsArticle,
  NewsArticle,
  NewsSearchInput,
  NewsSearchResult,
  NewsSourceCategory,
  NewsSourceDefinition,
  NewsSourceFailure,
  NewsSourceProbeResult,
} from './types.js';

const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_DISCOVERY_BYTES = 4 * 1024 * 1024;
const MAX_ARTICLE_BYTES = 4 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_ERROR_BYTES = 4 * 1024;
const MAX_CRAWL_DELAY_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_PUBLICATION_FUTURE_MS = DAY_MS;
const SEARCH_BUDGET_MS = 20_000;
const SOURCE_SCHEMA_VERSION = 'news-v1';
const USER_AGENT_TOKEN = 'seb';
const ENRICHMENT_LIMIT_PER_SOURCE = 3;
const DEFAULT_RESULT_LIMIT = 8;
const DEFAULT_MAX_AGE_DAYS = 7;
const GENERAL_QUERY_WORDS = new Set([
  'about',
  'and',
  'any',
  'are',
  'can',
  'could',
  'for',
  'from',
  'current',
  'fantasy',
  'find',
  'football',
  'impact',
  'latest',
  'news',
  'nfl',
  'our',
  'playing',
  'please',
  'report',
  'reports',
  'reporting',
  'status',
  'should',
  'show',
  'tell',
  'that',
  'today',
  'the',
  'this',
  'update',
  'updates',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'would',
  'you',
  'your',
]);

type Fetch = typeof globalThis.fetch;

interface RobotsPolicy {
  getCrawlDelay(userAgent?: string): number | undefined;
  isAllowed(url: string, userAgent?: string): boolean | undefined;
}

const robotsParser = createRequire(import.meta.url)('robots-parser') as (
  url: string,
  contents: string,
) => RobotsPolicy;

const dateStringSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  'The news date is invalid.',
);
const nullableDateStringSchema = dateStringSchema.nullable();
const discoveredArticleSchema = z.object({
  categories: z.array(z.string().max(100)).max(30),
  excerpt: z.string().max(600).nullable(),
  modifiedAt: nullableDateStringSchema,
  publisher: z.string().max(100).nullable().optional().default(null),
  publishedAt: nullableDateStringSchema,
  title: z.string().min(1).max(300),
  url: z.url(),
});
const discoveredArticlesSchema = z.array(discoveredArticleSchema).max(500);
const articleMetadataSchema = z.object({
  canonicalUrl: z.url(),
  excerpt: z.string().max(600).nullable(),
  modifiedAt: nullableDateStringSchema,
  publishedAt: dateStringSchema,
  title: z.string().min(1).max(300),
});

interface LoadedNewsSource {
  articles: DiscoveredNewsArticle[];
  error?: string;
  fetchedAt: string;
  outcome: CacheOutcome;
  source: NewsSourceDefinition;
  warnings?: string[];
}

interface NewsClientRequestOptions {
  fetch?: Fetch;
  policy?: Partial<RequestPolicy>;
  timeoutMs?: number;
}

export interface NewsClientOptions extends NewsClientRequestOptions {
  database?: SebDatabase | false;
  databaseFile?: string;
  now?: () => Date;
  onSource?: SourceObserver;
  sources?: readonly NewsSourceDefinition[];
}

export class NewsSourceError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = 'NewsSourceError';
    this.status = status;
    this.url = url;
  }
}

export class NewsClient {
  private readonly database: SebDatabase | false;
  private readonly hostScheduler: HostScheduler;
  private readonly httpByOrigin = new Map<string, ResilientFetch>();
  private readonly now: () => Date;
  private readonly onSource: SourceObserver | undefined;
  private readonly requestOptions: NewsClientRequestOptions;
  private readonly sources: readonly NewsSourceDefinition[];

  constructor(options: NewsClientOptions = {}) {
    this.database = options.database === false
      ? false
      : (options.database ?? getSharedSebDatabase(options.databaseFile));
    this.now = options.now ?? (() => new Date());
    this.onSource = options.onSource;
    this.requestOptions = {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.policy ? { policy: options.policy } : {}),
      timeoutMs: options.timeoutMs ?? 20_000,
    };
    this.hostScheduler = new HostScheduler(() => this.now().getTime());
    this.sources = validateSourceRegistry(
      options.sources ?? FIRST_CLASS_NEWS_SOURCES,
    );
  }

  async search(input: NewsSearchInput): Promise<NewsSearchResult> {
    const query = input.query.trim();
    if (query.length < 2 || query.length > 500) {
      throw new RangeError('The news query must contain from 2 through 500 characters.');
    }
    const limit = clampInteger(input.limit ?? DEFAULT_RESULT_LIMIT, 1, 12);
    const maxAgeDays = clampInteger(
      input.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS,
      1,
      30,
    );
    const teams = resolveRequestedTeams(input.teams, query);
    const selected = this.selectSources(input, query, teams);
    const callerSignal = currentRequestSignal();
    callerSignal?.throwIfAborted();
    const budgetSignal = AbortSignal.timeout(SEARCH_BUDGET_MS);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, budgetSignal])
      : budgetSignal;
    const failures: NewsSourceFailure[] = [];
    const loaded = (await Promise.all(selected.map(async (source) => {
      try {
        return await this.loadSource(source, signal);
      } catch (error) {
        callerSignal?.throwIfAborted();
        failures.push(sourceFailure(source, error));
        return null;
      }
    }))).filter((source): source is LoadedNewsSource => source !== null);
    for (const source of loaded) {
      if (source.outcome !== 'stale-if-error') continue;
      failures.push({
        error: source.error ?? 'The source used stale data after a refresh error.',
        id: source.source.id,
        label: source.source.label,
      });
    }

    const enriched = await Promise.all(loaded.map(async (source) => {
      if (!source.source.enrichArticles) return source;
      const candidates = rankDiscovered(source.articles, query, this.now())
        .filter((article) =>
          source.source.enrichDatedArticles || !article.publishedAt
        )
        .slice(0, ENRICHMENT_LIMIT_PER_SOURCE);
      const candidateUrls = new Set(candidates.map((article) => article.url));
      const enrichedCandidates = (await mapWithConcurrency(
        candidates,
        3,
        async (article) => {
          try {
            const metadata = await this.loadArticleMetadata(
              source.source,
              article,
              signal,
            );
            return applyArticleMetadata(article, metadata);
          } catch {
            callerSignal?.throwIfAborted();
            return article.publishedAt ? article : null;
          }
        },
      )).filter((article): article is DiscoveredNewsArticle => article !== null);
      const articles = [
        ...enrichedCandidates,
        ...source.articles.filter((article) =>
          !candidateUrls.has(article.url) && article.publishedAt
        ),
      ];
      if (articles.length === 0 && source.articles.length > 0) {
        failures.push({
          error: 'The source returned no article with a validated publication date.',
          id: source.source.id,
          label: source.source.label,
        });
      }
      return { ...source, articles };
    }));

    const cutoff = this.now().getTime() - maxAgeDays * DAY_MS;
    const articles = enriched.flatMap((source) =>
      source.articles.flatMap((article): NewsArticle[] => {
        if (
          !article.publishedAt ||
          Date.parse(article.publishedAt) < cutoff ||
          !isPlausiblePublicationDate(article.publishedAt, this.now())
        ) return [];
        const publisherLabel = article.publisher?.trim() || source.source.label;
        const cacheOutcome = combineCacheOutcomes(
          source.outcome,
          article.cacheOutcome,
        );
        return [{
          ...article,
          cacheOutcome,
          category: source.source.category,
          fetchedAt: oldestRetrievalTime(
            source.fetchedAt,
            article.retrievedAt,
          ),
          publisherId: publisherIdentity(publisherLabel, source.source.id),
          publisherLabel,
          publishedAt: article.publishedAt,
          sourceId: source.source.id,
          sourceLabel: source.source.label,
          stale: cacheOutcome === 'stale-if-error',
          team: source.source.team ?? null,
        }];
      })
    );
    const relevant = filterRelevantArticles(articles, query);
    const ranked = diversifyArticles(
      deduplicateArticles(relevant).sort((left, right) =>
        compareArticles(left, right, query, this.now())
      ),
      limit,
    );
    const publisherCount = new Set(ranked.map((article) => article.publisherId)).size;
    const currentArticles = ranked.filter((article) => !article.stale);
    const currentPublisherCount = new Set(
      currentArticles.map((article) => article.publisherId),
    ).size;
    const requiredPublisherCount = input.sourceIds?.length ? 1 : 2;
    const requiredResultCount = Math.min(limit, 5);
    const fallbackRecommended =
      currentArticles.length < requiredResultCount ||
      currentPublisherCount < requiredPublisherCount;

    for (const article of ranked) {
      this.onSource?.({
        id: `news-article:${article.sourceId}:${article.url}`,
        cacheOutcome: article.cacheOutcome,
        label: `${article.publisherLabel}: ${article.title}`,
        retrievedAt: article.fetchedAt,
        url: article.url,
      });
    }

    return {
      articles: ranked,
      coverage: {
        categories: uniqueCategories(ranked),
        failedSources: uniqueFailures(failures),
        publisherCount,
        resultCount: ranked.length,
        selectedSourceCount: selected.length,
        successfulSourceCount: loaded.length,
      },
      fallbackRecommended,
      query,
      searchedAt: this.now().toISOString(),
    };
  }

  async probeSources(
    sourceIds?: readonly string[],
  ): Promise<NewsSourceProbeResult[]> {
    const selected = sourceIds
      ? sourceIds.map((id) => {
          const source = this.sources.find((candidate) => candidate.id === id);
          if (!source) throw new Error(`The news source ID ${id} is not configured.`);
          return source;
        })
      : [...this.sources];
    const signal = currentRequestSignal();
    return mapWithConcurrency(selected, 6, async (originalSource) => {
      const source = originalSource.id === 'fantasypros-team-news'
        ? withFantasyProsTeam(originalSource, 'NE')
        : originalSource;
      try {
        const loaded = await this.loadSource(source, signal);
        if (loaded.outcome === 'cache-fresh' || loaded.outcome === 'stale-if-error') {
          throw new Error('The live probe did not refresh the source.');
        }
        let articles = loaded.articles;
        if (source.enrichArticles) {
          let enriched = false;
          for (const [index, article] of articles.slice(0, 3).entries()) {
            try {
              const metadata = await this.loadArticleMetadata(
                source,
                article,
                signal,
              );
              if (
                metadata.outcome === 'cache-fresh' ||
                metadata.outcome === 'stale-if-error'
              ) {
                continue;
              }
              articles = articles.map((value, articleIndex) =>
                articleIndex === index ? applyArticleMetadata(value, metadata) : value
              );
              enriched = true;
              break;
            } catch {
              signal?.throwIfAborted();
            }
          }
          if (!enriched) {
            throw new Error(
              'The source returned no article with valid publication metadata.',
            );
          }
        }
        const datedArticles = articles.filter((article) =>
          article.publishedAt !== null &&
          isPlausiblePublicationDate(article.publishedAt, this.now())
        );
        const newest = datedArticles
          .map((article) => article.publishedAt as string)
          .sort()
          .at(-1) ?? null;
        if (datedArticles.length === 0 || !newest) {
          throw new Error('The source returned no dated news article.');
        }
        return {
          articleCount: datedArticles.length,
          category: source.category,
          id: originalSource.id,
          label: originalSource.label,
          latestPublishedAt: newest,
          status: 'passed' as const,
          team: originalSource.team ?? null,
          url: source.discoveryUrl,
        };
      } catch (error) {
        signal?.throwIfAborted();
        return {
          articleCount: 0,
          category: source.category,
          error: errorMessage(error),
          id: originalSource.id,
          label: originalSource.label,
          latestPublishedAt: null,
          status: 'failed' as const,
          team: originalSource.team ?? null,
          url: source.discoveryUrl,
        };
      }
    });
  }

  clearCache(): void {
    if (this.database) this.database.deleteCache('news');
  }

  private selectSources(
    input: NewsSearchInput,
    query: string,
    teams: ReadonlySet<string>,
  ): NewsSourceDefinition[] {
    const requestedIds = input.sourceIds
      ? new Set(input.sourceIds.map((id) => id.trim()).filter(Boolean))
      : null;
    if (requestedIds) {
      const unknown = [...requestedIds].filter(
        (id) => !this.sources.some((source) => source.id === id),
      );
      if (unknown.length > 0) {
        throw new Error(`Unknown news source IDs: ${unknown.join(', ')}.`);
      }
    }
    const categories = new Set(
      input.categories ?? ['official', 'independent', 'fantasy'],
    );
    const normalizedQuery = normalizeSearchText(query);
    return this.sources.flatMap((source): NewsSourceDefinition[] => {
      if (requestedIds && !requestedIds.has(source.id)) return [];
      if (!requestedIds && !categories.has(source.category)) return [];
      if (
        source.team &&
        !teams.has(source.team) &&
        !requestedIds?.has(source.id)
      ) return [];
      if (
        source.activationTerms &&
        !requestedIds?.has(source.id) &&
        !source.activationTerms.some((term) => normalizedQuery.includes(term))
      ) return [];
      if (source.id === 'fantasypros-team-news') {
        if (teams.size === 0) return requestedIds?.has(source.id) ? [source] : [];
        return [...teams].map((team) => withFantasyProsTeam(source, team));
      }
      if (
        source.id === 'fantasypros-player-news' &&
        teams.size > 0 &&
        !requestedIds?.has(source.id)
      ) return [];
      return [source];
    });
  }

  private async loadSource(
    source: NewsSourceDefinition,
    signal?: AbortSignal,
  ): Promise<LoadedNewsSource> {
    const resource = new CachedResource<DiscoveredNewsArticle[]>(
      this.database,
      'news',
      `discovery:${source.id}:${source.discoveryUrl}`,
      source.discoveryUrl,
      {
        schemaVersion: SOURCE_SCHEMA_VERSION,
        staleIfErrorMs: sourceStaleIfError(source),
        ttlMs: sourceTtl(source),
        validate: (value) => discoveredArticlesSchema.parse(value),
      },
      this,
    );
    const result = await resource.read(async (conditional) => {
      const fetched = await this.fetchText(
        source.discoveryUrl,
        conditional,
        MAX_DISCOVERY_BYTES,
        source.discoveryKind === 'html' ? 'html' : 'xml',
      );
      if ('notModified' in fetched) return fetched;
      const parsed = parseSourceBody(source, fetched.body, this.now())
        .filter((article) => sourceAllowsArticle(source, article))
        .sort(compareDiscoveredDates)
        .slice(0, 500);
      if (parsed.length === 0) {
        throw new NewsSourceError(
          'The news source returned no valid articles.',
          fetched.status,
          source.discoveryUrl,
        );
      }
      const sourceTimestamp = parsed.find(
        (article) => article.publishedAt,
      )?.publishedAt;
      return {
        etag: fetched.etag,
        lastModified: fetched.lastModified,
        ...(sourceTimestamp ? { sourceTimestamp } : {}),
        value: parsed,
        valueValidated: true as const,
      };
    }, signal ? { signal } : {});
    this.recordSource(source, result);
    return {
      articles: result.value,
      fetchedAt: result.cache.cachedAt,
      outcome: result.outcome,
      source,
      ...(result.error ? { error: result.error } : {}),
      ...(result.warnings ? { warnings: result.warnings } : {}),
    };
  }

  private async loadArticleMetadata(
    source: NewsSourceDefinition,
    article: DiscoveredNewsArticle,
    signal?: AbortSignal,
  ): Promise<ResourceResult<ArticleMetadata>> {
    const resource = new CachedResource<ArticleMetadata>(
      this.database,
      'news',
      `article:${source.id}:${article.url}`,
      article.url,
      {
        schemaVersion: SOURCE_SCHEMA_VERSION,
        staleIfErrorMs: 7 * DAY_MS,
        ttlMs: 0,
        validate: (value) => articleMetadataSchema.parse(value),
      },
      this,
    );
    const result = await resource.read(async (conditional) => {
      const fetched = await this.fetchText(
        article.url,
        conditional,
        MAX_ARTICLE_BYTES,
        'html',
      );
      if ('notModified' in fetched) return fetched;
      const metadata = parseArticleMetadata(fetched.body, article.url);
      if (!metadata) {
        throw new NewsSourceError(
          'The article has no valid publication metadata.',
          fetched.status,
          article.url,
        );
      }
      return {
        etag: fetched.etag,
        lastModified: fetched.lastModified,
        sourceTimestamp: metadata.publishedAt,
        value: metadata,
        valueValidated: true as const,
      };
    }, signal ? { signal } : {});
    return result;
  }

  private async fetchText(
    url: string,
    conditional: ResourceLoadContext,
    byteLimit: number,
    kind: 'html' | 'xml',
  ): Promise<
    | { notModified: true }
    | {
        body: string;
        etag: string;
        lastModified: string | null;
        status: number;
      }
  > {
    const headers = new Headers({
      accept: kind === 'xml'
        ? 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1'
        : 'text/html, application/xhtml+xml;q=0.9, */*;q=0.1',
      'user-agent': SEB_USER_AGENT,
    });
    addConditionalHeaders(headers, conditional);
    const response = await this.requestNewsUrl(
      url,
      headers,
      conditional.signal,
    );
    if (response.status === 304) return { notModified: true };
    if (!response.ok) {
      const detail = await readResponseErrorDetail(response, MAX_ERROR_BYTES);
      throw new NewsSourceError(
        `The news source returned HTTP ${response.status}.${detail ? ` Response: ${detail}` : ''}`,
        response.status,
        url,
      );
    }
    const cacheControl = response.headers.get('cache-control')?.toLowerCase() ?? '';
    if (cacheControl.split(',').some((value) => value.trim() === 'no-store')) {
      void response.body?.cancel().catch(() => undefined);
      throw new NewsSourceError(
        'The news source forbids persistent caching.',
        response.status,
        url,
      );
    }
    const bytes = await readResponseBytes(response, byteLimit);
    conditional.signal.throwIfAborted();
    const body = bytes.toString('utf8');
    assertContentKind(response, body, kind, url);
    const syntheticEtag = contentEtag(bytes);
    const responseEtag = response.headers.get('etag') ?? syntheticEtag;
    if (conditional.etag === responseEtag || conditional.etag === syntheticEtag) {
      return { notModified: true };
    }
    return {
      body,
      etag: responseEtag,
      lastModified: response.headers.get('last-modified'),
      status: response.status,
    };
  }

  private async requestNewsUrl(
    initialUrl: string,
    initialHeaders: Headers,
    signal: AbortSignal,
  ): Promise<Response> {
    let currentUrl = initialUrl;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      assertAllowedRedirect(currentUrl, initialUrl);
      const robots = await this.readRobots(currentUrl, signal);
      if (robots.isAllowed(currentUrl, USER_AGENT_TOKEN) === false) {
        throw new NewsSourceError(
          'The source robots policy disallows this URL.',
          0,
          currentUrl,
        );
      }
      const crawlDelaySeconds = robots.getCrawlDelay(USER_AGENT_TOKEN) ?? 0;
      const crawlDelayMs = Math.round(crawlDelaySeconds * 1_000);
      if (crawlDelayMs > MAX_CRAWL_DELAY_MS) {
        throw new NewsSourceError(
          `The source crawl delay exceeds ${MAX_CRAWL_DELAY_MS} milliseconds.`,
          0,
          currentUrl,
        );
      }
      const target = new URL(currentUrl);
      const headers = new Headers(initialHeaders);
      if (redirectCount > 0) {
        headers.delete('if-modified-since');
        headers.delete('if-none-match');
      }
      const response = await this.hostScheduler.run(
        target.origin,
        crawlDelayMs,
        signal,
        () => this.http(currentUrl).request(currentUrl, {
          headers,
          redirect: 'manual',
          signal,
        }),
      );
      if (!isRedirectResponse(response.status)) return response;
      const location = response.headers.get('location');
      void response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new NewsSourceError(
          'The news source returned a redirect without a location.',
          response.status,
          currentUrl,
        );
      }
      currentUrl = new URL(location, currentUrl).href;
    }
    throw new NewsSourceError(
      `The news source exceeded ${MAX_REDIRECTS} redirects.`,
      0,
      initialUrl,
    );
  }

  private async readRobots(url: string, signal: AbortSignal) {
    const target = new URL(url);
    const robotsUrl = `${target.origin}/robots.txt`;
    const resource = new CachedResource<string>(
      this.database,
      'news',
      `robots:${target.origin}`,
      robotsUrl,
      {
        schemaVersion: SOURCE_SCHEMA_VERSION,
        staleIfErrorMs: 30 * DAY_MS,
        ttlMs: DAY_MS,
        validate: (value) => z.string().max(MAX_ROBOTS_BYTES).parse(value),
      },
      this,
    );
    const result = await resource.read(async (conditional) => {
      const headers = new Headers({
        accept: 'text/plain, */*;q=0.1',
        'user-agent': SEB_USER_AGENT,
      });
      addConditionalHeaders(headers, conditional);
      let response: Response;
      try {
        response = await this.requestRobotsFile(
          robotsUrl,
          headers,
          conditional.signal,
        );
      } catch (error) {
        throw new NewsSourceError(
          `The robots policy is unreachable: ${errorMessage(error)}`,
          0,
          robotsUrl,
        );
      }
      if (response.status === 304) return { notModified: true };
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        void response.body?.cancel().catch(() => undefined);
        return {
          etag: contentEtag(Buffer.alloc(0)),
          lastModified: response.headers.get('last-modified'),
          value: '',
          valueValidated: true as const,
        };
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new NewsSourceError(
          `The robots policy returned HTTP ${response.status}.`,
          response.status,
          robotsUrl,
        );
      }
      const bytes = await readResponseBytes(response, MAX_ROBOTS_BYTES);
      const body = bytes.toString('utf8');
      const syntheticEtag = contentEtag(bytes);
      const responseEtag = response.headers.get('etag') ?? syntheticEtag;
      if (conditional.etag === responseEtag || conditional.etag === syntheticEtag) {
        return { notModified: true };
      }
      return {
        etag: responseEtag,
        lastModified: response.headers.get('last-modified'),
        value: body,
        valueValidated: true as const,
      };
    }, { signal });
    return robotsParser(robotsUrl, result.value);
  }

  private async requestRobotsFile(
    initialUrl: string,
    initialHeaders: Headers,
    signal: AbortSignal,
  ): Promise<Response> {
    let currentUrl = initialUrl;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      assertAllowedRedirect(currentUrl, initialUrl);
      const headers = new Headers(initialHeaders);
      if (redirectCount > 0) {
        headers.delete('if-modified-since');
        headers.delete('if-none-match');
      }
      const response = await this.http(currentUrl).request(currentUrl, {
        headers,
        redirect: 'manual',
        signal,
      });
      if (!isRedirectResponse(response.status)) return response;
      const location = response.headers.get('location');
      void response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new NewsSourceError(
          'The robots policy returned a redirect without a location.',
          response.status,
          currentUrl,
        );
      }
      currentUrl = new URL(location, currentUrl).href;
    }
    throw new NewsSourceError(
      `The robots policy exceeded ${MAX_REDIRECTS} redirects.`,
      0,
      initialUrl,
    );
  }

  private http(url: string): ResilientFetch {
    const origin = new URL(url).origin;
    let client = this.httpByOrigin.get(origin);
    if (!client) {
      client = new ResilientFetch({
        ...(this.requestOptions.fetch ? { fetch: this.requestOptions.fetch } : {}),
        now: () => this.now().getTime(),
        policy: {
          timeoutMs: this.requestOptions.timeoutMs ?? 20_000,
          ...this.requestOptions.policy,
          maxAttempts: 1,
        },
      });
      this.httpByOrigin.set(origin, client);
    }
    return client;
  }

  private recordSource(
    source: NewsSourceDefinition,
    result: ResourceResult<DiscoveredNewsArticle[]>,
  ): void {
    this.onSource?.({
      cacheOutcome: result.outcome,
      ...(result.error ? { error: result.error } : {}),
      id: `news-source:${source.id}`,
      label: source.label,
      retrievedAt: result.cache.cachedAt,
      url: source.discoveryUrl,
      ...(result.warnings ? { warnings: result.warnings } : {}),
    });
  }
}

class HostScheduler {
  private readonly lastStartedAt = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly now: () => number) {}

  async run<T>(
    key: string,
    delayMs: number,
    signal: AbortSignal,
    task: () => Promise<T>,
  ): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = prior.catch(() => undefined).then(() => gate);
    this.tails.set(key, tail);
    try {
      await waitForSignal(prior, signal);
      const lastStartedAt = this.lastStartedAt.get(key) ?? Number.NEGATIVE_INFINITY;
      await waitMilliseconds(Math.max(0, lastStartedAt + delayMs - this.now()), signal);
      signal.throwIfAborted();
      this.lastStartedAt.set(key, this.now());
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

function parseSourceBody(
  source: NewsSourceDefinition,
  body: string,
  referenceDate: Date,
): DiscoveredNewsArticle[] {
  switch (source.discoveryKind) {
    case 'atom':
      return parseAtomFeed(body, source.discoveryUrl);
    case 'html':
      if (!source.htmlFlavor) {
        throw new Error(`The HTML news source ${source.id} has no parser.`);
      }
      return parseNewsHtml(
        body,
        source.discoveryUrl,
        source.htmlFlavor,
        referenceDate,
      );
    case 'news-sitemap':
      return parseNewsSitemap(body, source.discoveryUrl);
    case 'rss':
      return parseRssFeed(body, source.discoveryUrl);
  }
}

function validateSourceRegistry(
  sources: readonly NewsSourceDefinition[],
): readonly NewsSourceDefinition[] {
  const ids = new Set<string>();
  return Object.freeze(sources.map((source) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(source.id)) {
      throw new Error(`The news source ID ${source.id} is invalid.`);
    }
    if (ids.has(source.id)) {
      throw new Error(`The news source ID ${source.id} is duplicated.`);
    }
    ids.add(source.id);
    for (const value of [source.discoveryUrl, source.homepageUrl]) {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password) {
        throw new Error(`The news source ${source.id} must use a public HTTPS URL.`);
      }
    }
    return Object.freeze({ ...source });
  }));
}

function sourceAllowsArticle(
  source: NewsSourceDefinition,
  article: DiscoveredNewsArticle,
): boolean {
  const articleUrl = article.url;
  if (!sameSite(articleUrl, source.homepageUrl)) return false;
  const path = new URL(articleUrl).pathname;
  if (source.urlPathPrefix && !path.startsWith(source.urlPathPrefix)) return false;
  if (source.excludedPathPrefixes?.some((prefix) => path.startsWith(prefix))) {
    return false;
  }
  if (source.id === 'yahoo-nfl') {
    const categories = article.categories.map(normalizeSearchText);
    return !path.startsWith('/college-football/') &&
      !categories.some((category) => category === 'ncaaf');
  }
  if (source.id === 'pff') {
    const categories = article.categories.map(normalizeSearchText);
    return categories.some((category) => category === 'fantasy');
  }
  return true;
}

function sourceTtl(source: NewsSourceDefinition): number {
  if (source.id === 'cbs-nfl' || source.id === 'pff') return 0;
  if (source.id === 'nfl') return 5_000;
  if (source.id === 'fox-nfl') return 20 * MINUTE_MS;
  if (source.id.startsWith('fantasypros-')) return 10 * MINUTE_MS;
  if (source.id === 'profootballtalk' || source.id === 'rotoworld-player-news') {
    return MINUTE_MS;
  }
  return 5 * MINUTE_MS;
}

function sourceStaleIfError(source: NewsSourceDefinition): number {
  return source.id === 'pff' ? 0 : DAY_MS;
}

function withFantasyProsTeam(
  source: NewsSourceDefinition,
  team: string,
): NewsSourceDefinition {
  const url = new URL(source.discoveryUrl);
  url.searchParams.set('team', team === 'JAX' ? 'JAC' : team);
  return {
    ...source,
    discoveryUrl: url.href,
    label: `${source.label} (${team})`,
    team,
  };
}

function resolveRequestedTeams(
  requested: readonly string[] | undefined,
  query: string,
): ReadonlySet<string> {
  const teams = new Set<string>();
  for (const value of requested ?? []) {
    const code = normalizeTeamCode(value);
    if (!code) throw new Error(`The NFL team code ${value} is not supported.`);
    teams.add(code);
  }
  const normalizedQuery = ` ${normalizeSearchText(query)} `;
  for (const team of defaultTeams()) {
    const aliases = [team.city, team.name, ...team.aliases]
      .map(normalizeSearchText)
      .filter((alias) => alias.length >= 4)
      .sort((left, right) => right.length - left.length);
    if (aliases.some((alias) => normalizedQuery.includes(` ${alias} `))) {
      teams.add(team.code);
    }
  }
  return teams;
}

function normalizeTeamCode(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  const aliases: Record<string, string> = {
    ARZ: 'ARI',
    JAC: 'JAX',
    WSH: 'WAS',
  };
  const code = aliases[normalized] ?? normalized;
  return defaultTeams().some((team) => team.code === code) ? code : null;
}

function applyArticleMetadata(
  article: DiscoveredNewsArticle,
  loaded: ResourceResult<ArticleMetadata>,
): DiscoveredNewsArticle {
  const metadata = loaded.value;
  const canonical = usefulCanonical(metadata.canonicalUrl, article.url)
    ? metadata.canonicalUrl
    : article.url;
  return {
    ...article,
    cacheOutcome: loaded.outcome,
    excerpt: metadata.excerpt ?? article.excerpt,
    modifiedAt: metadata.modifiedAt,
    publishedAt: metadata.publishedAt,
    retrievedAt: loaded.cache.cachedAt,
    title: metadata.title,
    url: canonical,
  };
}

function usefulCanonical(canonical: string, original: string): boolean {
  const canonicalUrl = new URL(canonical);
  const originalUrl = new URL(original);
  if (canonicalUrl.protocol !== 'https:' || !sameSite(canonical, original)) {
    return false;
  }
  if (canonicalUrl.pathname === '/' && originalUrl.pathname !== '/') return false;
  return true;
}

function rankDiscovered(
  articles: readonly DiscoveredNewsArticle[],
  query: string,
  now: Date,
): DiscoveredNewsArticle[] {
  return [...articles].sort((left, right) => {
    const difference = scoreDiscovered(right, query, now) -
      scoreDiscovered(left, query, now);
    return difference || compareDiscoveredDates(left, right);
  });
}

function filterRelevantArticles(
  articles: readonly NewsArticle[],
  query: string,
): NewsArticle[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [...articles];
  const minimumMatches = Math.min(2, tokens.length);
  return articles.filter((article) => {
    const text = searchTokenSet(
      `${article.title} ${article.excerpt ?? ''} ${article.url}`,
    );
    return tokens.filter((token) => searchTokenMatches(token, text)).length >=
      minimumMatches;
  });
}

function compareArticles(
  left: NewsArticle,
  right: NewsArticle,
  query: string,
  now: Date,
): number {
  const difference = scoreArticle(right, query, now) - scoreArticle(left, query, now);
  return difference || right.publishedAt.localeCompare(left.publishedAt) ||
    left.title.localeCompare(right.title);
}

function scoreArticle(article: NewsArticle, query: string, now: Date): number {
  let score = scoreDiscovered(article, query, now);
  if (article.category === 'official') score += 1;
  if (article.team) score += 2;
  if (article.sourceId === 'yahoo-nfl') score -= 1;
  return score;
}

function scoreDiscovered(
  article: DiscoveredNewsArticle,
  query: string,
  now: Date,
): number {
  const title = searchTokenSet(article.title);
  const excerpt = searchTokenSet(article.excerpt ?? '');
  const url = searchTokenSet(article.url);
  let score = 0;
  for (const token of queryTokens(query)) {
    if (searchTokenMatches(token, title)) score += 6;
    else if (searchTokenMatches(token, excerpt)) score += 3;
    else if (searchTokenMatches(token, url)) score += 1;
  }
  if (article.publishedAt) {
    const age = Math.max(0, now.getTime() - Date.parse(article.publishedAt));
    if (age <= 6 * HOUR_MS) score += 6;
    else if (age <= DAY_MS) score += 5;
    else if (age <= 3 * DAY_MS) score += 3;
    else if (age <= 7 * DAY_MS) score += 1;
  }
  return score;
}

function compareDiscoveredDates(
  left: DiscoveredNewsArticle,
  right: DiscoveredNewsArticle,
): number {
  return (right.publishedAt ?? '').localeCompare(left.publishedAt ?? '') ||
    (right.modifiedAt ?? '').localeCompare(left.modifiedAt ?? '');
}

function deduplicateArticles(articles: readonly NewsArticle[]): NewsArticle[] {
  const byUrl = new Map<string, NewsArticle>();
  const titleKeys = new Set<string>();
  for (const article of articles) {
    const urlKey = normalizedUrlKey(article.url);
    const titleKey = normalizeSearchText(article.title);
    const existing = byUrl.get(urlKey);
    if (existing) {
      if (sourcePreference(article) > sourcePreference(existing)) {
        byUrl.set(urlKey, article);
      }
      continue;
    }
    if (titleKeys.has(titleKey)) continue;
    byUrl.set(urlKey, article);
    titleKeys.add(titleKey);
  }
  return [...byUrl.values()];
}

function diversifyArticles(
  articles: readonly NewsArticle[],
  limit: number,
): NewsArticle[] {
  const output: NewsArticle[] = [];
  const sourceCounts = new Map<string, number>();
  for (const article of articles) {
    if ((sourceCounts.get(article.publisherId) ?? 0) >= 3) continue;
    output.push(article);
    sourceCounts.set(
      article.publisherId,
      (sourceCounts.get(article.publisherId) ?? 0) + 1,
    );
    if (output.length === limit) break;
  }
  return output;
}

function sourcePreference(article: NewsArticle): number {
  if (article.sourceId === 'yahoo-nfl') return 0;
  if (article.category === 'official') return 3;
  if (article.category === 'independent') return 2;
  return 1;
}

function queryTokens(query: string): string[] {
  return [...new Set(
    normalizeSearchText(query)
      .split(' ')
      .filter((token) => token.length >= 3 && !GENERAL_QUERY_WORDS.has(token)),
  )];
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

function searchTokenSet(value: string): ReadonlySet<string> {
  return new Set(normalizeSearchText(value).split(' ').filter(Boolean));
}

function searchTokenMatches(
  queryToken: string,
  articleTokens: ReadonlySet<string>,
): boolean {
  if (articleTokens.has(queryToken)) return true;
  const variants = [
    `${queryToken}s`,
    `${queryToken}d`,
    `${queryToken}ed`,
    `${queryToken}ing`,
  ];
  if (queryToken.endsWith('y')) {
    variants.push(`${queryToken.slice(0, -1)}ies`);
  }
  if (queryToken === 'injury') variants.push('injured');
  return variants.some((variant) => articleTokens.has(variant));
}

function publisherIdentity(label: string, sourceId: string): string {
  const normalized = normalizeSearchText(label);
  if (normalized.includes('profootballtalk')) return 'profootballtalk';
  if (normalized.includes('profootball talk')) return 'profootballtalk';
  if (normalized.includes('fantasypros')) return 'fantasypros';
  if (normalized.includes('rotoworld')) return 'rotoworld';
  if (normalized === 'nfl news' || normalized.includes('nfl player health')) {
    return 'nfl';
  }
  if (normalized.includes('cbs sports')) return 'cbs-sports';
  if (normalized.includes('fox sports')) return 'fox-sports';
  if (normalized === 'espn' || normalized === 'espn com') return 'espn';
  if (normalized.startsWith('pff')) return 'pff';
  if (normalized === 'yahoo sports') return 'yahoo-nfl';
  if (normalized === 'associated press' || normalized === 'ap') return 'ap-nfl';
  return normalized.replace(/\s+/gu, '-') || sourceId;
}

function combineCacheOutcomes(
  discovery: CacheOutcome,
  metadata: CacheOutcome | undefined,
): CacheOutcome {
  if (!metadata) return discovery;
  if (discovery === 'stale-if-error' || metadata === 'stale-if-error') {
    return 'stale-if-error';
  }
  if (discovery === 'cache-fresh' || metadata === 'cache-fresh') {
    return 'cache-fresh';
  }
  if (discovery === 'source-updated' || metadata === 'source-updated') {
    return 'source-updated';
  }
  return 'source-not-modified';
}

function oldestRetrievalTime(
  discovery: string,
  metadata: string | undefined,
): string {
  if (!metadata) return discovery;
  return Date.parse(metadata) < Date.parse(discovery) ? metadata : discovery;
}

function normalizedUrlKey(value: string): string {
  const url = new URL(value);
  url.hash = '';
  url.hostname = url.hostname.replace(/^www\./u, '');
  url.pathname = url.pathname.replace(/\/$/u, '') || '/';
  return url.href;
}

function sameSite(leftValue: string, rightValue: string): boolean {
  const left = new URL(leftValue).hostname.replace(/^www\./u, '');
  const right = new URL(rightValue).hostname.replace(/^www\./u, '');
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

function assertAllowedRedirect(candidate: string, initial: string): void {
  const target = new URL(candidate);
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    (target.port && target.port !== '443') ||
    !sameSite(candidate, initial)
  ) {
    throw new NewsSourceError(
      'The news source redirected to an unconfigured or unsafe URL.',
      0,
      candidate,
    );
  }
}

function isRedirectResponse(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function addConditionalHeaders(
  headers: Headers,
  conditional: Pick<ResourceLoadContext, 'etag' | 'lastModified'>,
): void {
  if (conditional.etag && !conditional.etag.startsWith('W/"seb-sha256-')) {
    headers.set('if-none-match', conditional.etag);
  }
  if (conditional.lastModified) {
    headers.set('if-modified-since', conditional.lastModified);
  }
}

function contentEtag(bytes: Buffer): string {
  return `W/"seb-sha256-${createHash('sha256').update(bytes).digest('base64url')}"`;
}

function assertContentKind(
  response: Response,
  body: string,
  kind: 'html' | 'xml',
  url: string,
): void {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const trimmed = body.trimStart().toLowerCase();
  const valid = kind === 'html'
    ? contentType.includes('html') || trimmed.startsWith('<!doctype html') ||
      trimmed.startsWith('<html')
    : contentType.includes('xml') || contentType.includes('rss') ||
      contentType.includes('atom') || trimmed.startsWith('<?xml') ||
      trimmed.startsWith('<rss') || trimmed.startsWith('<feed') ||
      trimmed.startsWith('<urlset');
  if (!valid) {
    throw new NewsSourceError(
      `The news source returned an invalid ${kind.toUpperCase()} content type.`,
      response.status,
      url,
    );
  }
}

function sourceFailure(
  source: NewsSourceDefinition,
  error: unknown,
): NewsSourceFailure {
  return { error: errorMessage(error), id: source.id, label: source.label };
}

function uniqueFailures(failures: readonly NewsSourceFailure[]): NewsSourceFailure[] {
  return [...new Map(failures.map((failure) => [failure.id, failure])).values()];
}

function uniqueCategories(articles: readonly NewsArticle[]): NewsSourceCategory[] {
  return [...new Set(articles.map((article) => article.category))].sort();
}

function isPlausiblePublicationDate(value: string, now: Date): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) &&
    timestamp <= now.getTime() + MAX_PUBLICATION_FUTURE_MS;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value)) throw new RangeError('The news limit must be an integer.');
  return Math.min(Math.max(value, minimum), maximum);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = [];
  let nextIndex = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) results[index] = await map(value, index);
      }
    },
  ));
  return results;
}

function waitMilliseconds(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise<void>((resolveWait, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolveWait();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolveWait, reject) => {
    const onAbort = (): void => reject(
      signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'),
    );
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(resolveWait, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    }).catch(() => undefined);
  });
}
