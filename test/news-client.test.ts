import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runWithRequestSignal } from '../src/ai/request-signal.js';
import { SebDatabase } from '../src/data/sqlite-store.js';
import { NewsClient } from '../src/news/client.js';
import type {
  DiscoveredNewsArticle,
  NewsSourceCategory,
  NewsSourceDefinition,
} from '../src/news/types.js';
import { SourceTracker, type SourceObserver } from '../src/sources.js';

const NOW = new Date('2026-08-29T20:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1_000;
const databases: SebDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('NewsClient source policy', () => {
  it('selects the requested categories, team, and activation terms', async () => {
    const general = newsSource('official-general', 'official');
    const team = newsSource('team-ne-test', 'official', { team: 'NE' });
    const health = newsSource('health-test', 'official', {
      activationTerms: ['concussion'],
    });
    const independent = newsSource('independent-test', 'independent');
    const fantasy = newsSource('fantasy-test', 'fantasy');
    const calls: FetchCall[] = [];
    const fetch = routeFetch(new Map([
      [general.discoveryUrl, rssResponse([
        article('Patriots quarterback injury update', '/news/general'),
      ])],
      [team.discoveryUrl, rssResponse([
        article('Patriots quarterback returns', '/news/team'),
      ])],
    ]), calls);
    const client = createClient(
      [general, team, health, independent, fantasy],
      fetch,
    );

    const result = await client.search({
      categories: ['official'],
      limit: 2,
      query: 'New England Patriots quarterback injury',
    });

    expect(result.coverage.selectedSourceCount).toBe(2);
    expect(result.articles.map((item) => item.sourceId).sort()).toEqual([
      'official-general',
      'team-ne-test',
    ]);
    expect(discoveryCalls(calls)).toEqual([
      general.discoveryUrl,
      team.discoveryUrl,
    ]);
  });

  it('uses an explicit source list and rejects unknown selectors', async () => {
    const alpha = newsSource('alpha');
    const beta = newsSource('beta');
    const fetch = routeFetch(new Map([
      [alpha.discoveryUrl, rssResponse([
        article('Quarterback practice report', '/news/alpha'),
      ])],
    ]));
    const client = createClient([alpha, beta], fetch);

    const result = await client.search({
      limit: 1,
      query: 'quarterback practice',
      sourceIds: ['alpha'],
    });

    expect(result.articles).toHaveLength(1);
    expect(result.coverage.selectedSourceCount).toBe(1);
    expect(result.fallbackRecommended).toBe(false);
    await expect(client.search({
      query: 'quarterback practice',
      sourceIds: ['missing'],
    })).rejects.toThrow('Unknown news source IDs: missing.');
    await expect(client.search({
      query: 'quarterback practice',
      teams: ['XXX'],
    })).rejects.toThrow('The NFL team code XXX is not supported.');
  });

  it('loads an explicitly requested team source without a team selector', async () => {
    const team = newsSource('team-kc-test', 'official', { team: 'KC' });
    const fetch = routeFetch(new Map([
      [team.discoveryUrl, rssResponse([
        article('Chiefs quarterback practice report', '/news/team'),
      ])],
    ]));
    const client = createClient([team], fetch);

    const result = await client.search({
      limit: 1,
      query: 'Chiefs quarterback practice',
      sourceIds: [team.id],
    });

    expect(result.articles).toHaveLength(1);
    expect(result.coverage.selectedSourceCount).toBe(1);
  });

  it('blocks a source when its robots policy disallows discovery', async () => {
    const source = newsSource('blocked');
    const calls: FetchCall[] = [];
    const fetch = routeFetch(new Map([
      [robotsUrl(source), textResponse('User-agent: seb\nDisallow: /rss')],
      [source.discoveryUrl, rssResponse([
        article('Quarterback report', '/news/report'),
      ])],
    ]), calls);
    const client = createClient([source], fetch);

    const result = await client.search({
      limit: 1,
      query: 'quarterback report',
      sourceIds: [source.id],
    });

    expect(result.articles).toEqual([]);
    expect(result.coverage.failedSources).toEqual([
      expect.objectContaining({
        error: 'The source robots policy disallows this URL.',
        id: source.id,
      }),
    ]);
    expect(discoveryCalls(calls)).toEqual([]);
  });

  it('accepts a specific robots allow rule over a broad disallow rule', async () => {
    const source = newsSource('allowed');
    const fetch = routeFetch(new Map([
      [robotsUrl(source), textResponse(
        'User-agent: seb\nDisallow: /\nAllow: /rss',
      )],
      [source.discoveryUrl, rssResponse([
        article('Quarterback report', '/news/report'),
      ])],
    ]));
    const client = createClient([source], fetch);

    const result = await client.search({
      limit: 1,
      query: 'quarterback report',
      sourceIds: [source.id],
    });

    expect(result.articles).toHaveLength(1);
    expect(result.coverage.failedSources).toEqual([]);
  });

  it('does not cache a source response that declares no-store', async () => {
    const source = newsSource('private-cache');
    const database = createDatabase();
    const fetch = routeFetch(new Map([
      [source.discoveryUrl, rssResponse(
        [article('Quarterback report', '/news/report')],
        { 'cache-control': 'no-store' },
      )],
    ]));
    const client = createClient([source], fetch, { database });

    const result = await client.search({
      limit: 1,
      query: 'quarterback report',
      sourceIds: [source.id],
    });

    expect(result.articles).toEqual([]);
    expect(result.coverage.failedSources[0]?.error).toContain(
      'forbids persistent caching',
    );
    expect(database.getCache('news', discoveryCacheKey(source))).toBeNull();
  });

  it('rejects an unsafe redirect before it requests the target', async () => {
    const source = newsSource('unsafe-redirect');
    const calls: FetchCall[] = [];
    const fetch = routeFetch(new Map([
      [source.discoveryUrl, new Response(null, {
        headers: { location: 'http://127.0.0.1/private' },
        status: 302,
      })],
    ]), calls);
    const client = createClient([source], fetch);

    const result = await client.search({
      limit: 1,
      query: 'quarterback practice',
      sourceIds: [source.id],
    });

    expect(result.articles).toEqual([]);
    expect(result.coverage.failedSources[0]?.error).toContain(
      'unconfigured or unsafe URL',
    );
    expect(calls.some((call) => call.url.includes('127.0.0.1'))).toBe(false);
  });

  it('stops a pending crawl when the request signal aborts', async () => {
    const source = newsSource('cancelled');
    let markDiscoveryStarted!: () => void;
    const discoveryStarted = new Promise<void>((resolveStarted) => {
      markDiscoveryStarted = resolveStarted;
    });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === robotsUrl(source)) return textResponse('User-agent: *\nAllow: /');
      if (url !== source.discoveryUrl) return new Response('missing', { status: 404 });
      markDiscoveryStarted();
      return await new Promise<Response>((_resolveResponse, reject) => {
        const signal = init?.signal;
        const rejectAbort = (): void => reject(signal?.reason);
        if (signal?.aborted) rejectAbort();
        else signal?.addEventListener('abort', rejectAbort, { once: true });
      });
    };
    const client = createClient([source], fetch);
    const controller = new AbortController();
    const reason = new DOMException('The caller stopped news.', 'AbortError');

    const pending = runWithRequestSignal(controller.signal, () => client.search({
      limit: 1,
      query: 'quarterback report',
      sourceIds: [source.id],
    }));
    const rejection = expect(pending).rejects.toBe(reason);
    await discoveryStarted;
    controller.abort(reason);

    await rejection;
  });
});

describe('NewsClient article results', () => {
  it('enriches an undated HTML discovery entry from article metadata', async () => {
    const source = newsSource('ap-enrichment', 'independent', {
      discoveryKind: 'html',
      discoveryUrl: 'https://ap.example/hub/nfl',
      enrichArticles: true,
      homepageUrl: 'https://ap.example/hub/nfl',
      htmlFlavor: 'ap-nfl-hub',
      urlPathPrefix: '/article/',
    });
    const articleUrl = 'https://ap.example/article/training-camp';
    const fetch = routeFetch(new Map([
      [source.discoveryUrl, htmlResponse(`
        <main class="Page-oneColumn">
          <a href="${articleUrl}">Training camp update</a>
        </main>
      `)],
      [articleUrl, htmlResponse(`
        <link rel="canonical" href="${articleUrl}?utm_source=page" />
        <script type="application/ld+json">
          {
            "@type": "NewsArticle",
            "headline": "Training camp injury update",
            "description": "The quarterback returned to team drills.",
            "datePublished": "2026-08-29T18:30:00Z"
          }
        </script>
      `)],
    ]));
    const client = createClient([source], fetch);

    const result = await client.search({
      limit: 1,
      query: 'quarterback injury',
      sourceIds: [source.id],
    });

    expect(result.articles).toEqual([
      expect.objectContaining({
        excerpt: 'The quarterback returned to team drills.',
        publishedAt: '2026-08-29T18:30:00.000Z',
        sourceId: source.id,
        title: 'Training camp injury update',
        url: articleUrl,
      }),
    ]);
  });

  it('ranks relevant fresh articles and diversifies the selected publishers', async () => {
    const alpha = newsSource('alpha-ranking', 'independent');
    const beta = newsSource('beta-ranking', 'fantasy');
    const fetch = routeFetch(new Map([
      [alpha.discoveryUrl, rssResponse([
        article('Quarterback report one', '/news/one', '2026-08-29T19:50:00Z'),
        article('Quarterback report two', '/news/two', '2026-08-29T19:40:00Z'),
        article('Quarterback report three', '/news/three', '2026-08-29T19:30:00Z'),
        article('Quarterback report four', '/news/four', '2026-08-29T19:20:00Z'),
      ])],
      [beta.discoveryUrl, rssResponse([
        article('Quarterback fantasy impact', '/news/five', '2026-08-29T19:45:00Z'),
        article('Quarterback waiver impact', '/news/six', '2026-08-29T19:35:00Z'),
      ])],
    ]));
    const client = createClient([alpha, beta], fetch);

    const result = await client.search({
      limit: 5,
      query: 'latest quarterback news',
      sourceIds: [alpha.id, beta.id],
    });

    expect(result.articles).toHaveLength(5);
    expect(result.articles[0]?.title).toBe('Quarterback report one');
    expect(result.articles.filter(
      (item) => item.sourceId === alpha.id,
    )).toHaveLength(3);
    expect(new Set(result.articles.map((item) => item.sourceId)).size).toBe(2);
    expect(result.coverage.categories).toEqual(['fantasy', 'independent']);
    expect(result.fallbackRecommended).toBe(false);
  });

  it('deduplicates canonical URLs and normalized titles', async () => {
    const official = newsSource('official-duplicate', 'official', {
      discoveryUrl: 'https://shared.example/official.xml',
      homepageUrl: 'https://shared.example/news/',
    });
    const independent = newsSource('independent-duplicate', 'independent', {
      discoveryUrl: 'https://shared.example/independent.xml',
      homepageUrl: 'https://shared.example/news/',
    });
    const fantasy = newsSource('fantasy-duplicate', 'fantasy', {
      discoveryUrl: 'https://shared.example/fantasy.xml',
      homepageUrl: 'https://shared.example/news/',
    });
    const sharedArticle = 'https://shared.example/news/quarterback-trade';
    const fetch = routeFetch(new Map([
      [official.discoveryUrl, rssResponse([
        article(
          'Quarterback trade report',
          sharedArticle,
          '2026-08-27T20:00:00Z',
        ),
      ])],
      [independent.discoveryUrl, rssResponse([
        article(
          'Quarterback trade report',
          `${sharedArticle}/`,
          '2026-08-29T19:00:00Z',
        ),
        article(
          'Veteran quarterback traded',
          '/news/second-version',
          '2026-08-29T18:00:00Z',
        ),
      ])],
      [fantasy.discoveryUrl, rssResponse([
        article(
          'Veteran quarterback traded!',
          '/news/fantasy-version',
          '2026-08-29T17:00:00Z',
        ),
      ])],
    ]));
    const client = createClient([official, independent, fantasy], fetch);

    const result = await client.search({
      limit: 5,
      query: 'quarterback trade',
      sourceIds: [official.id, independent.id, fantasy.id],
    });

    expect(result.articles).toHaveLength(2);
    expect(result.articles.filter(
      (item) => item.url.replace(/\/$/u, '') === sharedArticle,
    )).toEqual([
      expect.objectContaining({ sourceId: official.id }),
    ]);
    expect(result.articles.filter(
      (item) => item.title.startsWith('Veteran quarterback traded'),
    )).toHaveLength(1);
  });

  it('recommends broad search when direct coverage lacks results or publishers', async () => {
    const source = newsSource('thin-coverage');
    const fetch = routeFetch(new Map([
      [source.discoveryUrl, rssResponse([
        article('Quarterback practice report', '/news/report'),
      ])],
    ]));
    const client = createClient([source], fetch);

    const result = await client.search({
      limit: 5,
      query: 'quarterback practice',
    });

    expect(result.coverage).toMatchObject({
      publisherCount: 1,
      resultCount: 1,
    });
    expect(result.fallbackRecommended).toBe(true);
  });

  it('rejects substring-only and single-keyword matches in a detailed query', async () => {
    const alpha = newsSource('false-match-alpha');
    const beta = newsSource('false-match-beta', 'fantasy');
    const fetch = routeFetch(new Map([
      [alpha.discoveryUrl, rssResponse([
        article('Unrelated Cleveland story', '/news/cleveland'),
        article('Generic roster report', '/news/roster'),
      ])],
      [beta.discoveryUrl, rssResponse([
        article('Generic fantasy draft tips', '/news/draft'),
        article('Weekly fantasy rankings', '/news/rankings'),
      ])],
    ]));
    const client = createClient([alpha, beta], fetch);

    const result = await client.search({
      limit: 5,
      query: 'Patrick Mahomes knee status and fantasy impact',
    });

    expect(result.articles).toEqual([]);
    expect(result.fallbackRecommended).toBe(true);
  });

  it('keeps a one-entity match after it removes request words', async () => {
    const source = newsSource('entity-query');
    const fetch = routeFetch(new Map([
      [source.discoveryUrl, rssResponse([
        article('Mahomes returns to practice', '/news/mahomes'),
      ])],
    ]));
    const client = createClient([source], fetch);

    const result = await client.search({
      limit: 1,
      query: 'Any news on Mahomes?',
      sourceIds: [source.id],
    });

    expect(result.articles).toHaveLength(1);
  });

  it('rejects an implausible future publication date', async () => {
    const source = newsSource('future-date');
    const fetch = routeFetch(new Map([
      [source.discoveryUrl, rssResponse([
        article(
          'Quarterback practice report',
          '/news/future',
          '2027-08-29T19:00:00Z',
        ),
      ])],
    ]));
    const client = createClient([source], fetch);

    const result = await client.search({
      limit: 1,
      query: 'quarterback practice',
      sourceIds: [source.id],
    });

    expect(result.articles).toEqual([]);
    expect(result.fallbackRecommended).toBe(true);
  });
});

describe('NewsClient cache', () => {
  it('uses a content hash to revalidate an unchanged source without an ETag', async () => {
    const source = newsSource('hash-cache');
    const database = createDatabase();
    const tracker = new SourceTracker();
    const calls: FetchCall[] = [];
    const body = rssBody([
      article('Quarterback practice report', '/news/report'),
    ]);
    const fetch = routeFetch(new Map([
      [source.discoveryUrl, xmlResponse(body)],
    ]), calls);
    const client = createClient([source], fetch, {
      database,
      onSource: tracker.record,
    });

    await client.search({
      limit: 1,
      query: 'quarterback practice',
      sourceIds: [source.id],
    });
    const cached = database.getCache<DiscoveredNewsArticle[]>(
      'news',
      discoveryCacheKey(source),
    );
    expect(cached?.etag).toMatch(/^W\/"seb-sha256-/u);
    expireDiscoveryCache(database, source, cached);

    const second = await client.search({
      limit: 1,
      query: 'quarterback practice',
      sourceIds: [source.id],
    });

    expect(second.articles).toHaveLength(1);
    expect(discoveryCalls(calls)).toEqual([
      source.discoveryUrl,
      source.discoveryUrl,
    ]);
    const secondRequest = calls.filter(
      (call) => call.url === source.discoveryUrl,
    )[1];
    expect(secondRequest?.headers.get('if-none-match')).toBeNull();
    expect(tracker.list()).toContainEqual(expect.objectContaining({
      cacheOutcome: 'source-not-modified',
      id: `news-source:${source.id}`,
    }));
  });

  it('returns a stale cached source after a temporary refresh error', async () => {
    const source = newsSource('stale-cache');
    const database = createDatabase();
    const tracker = new SourceTracker();
    let sourceCalls = 0;
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === robotsUrl(source)) return textResponse('User-agent: *\nAllow: /');
      if (url !== source.discoveryUrl) return new Response('missing', { status: 404 });
      sourceCalls += 1;
      if (sourceCalls > 1) throw new Error('temporary source outage');
      return rssResponse([
        article('Quarterback practice report', '/news/report'),
      ]);
    };
    const client = createClient([source], fetch, {
      database,
      onSource: tracker.record,
    });

    await client.search({
      limit: 1,
      query: 'quarterback practice',
      sourceIds: [source.id],
    });
    const cached = database.getCache<DiscoveredNewsArticle[]>(
      'news',
      discoveryCacheKey(source),
    );
    expireDiscoveryCache(database, source, cached);

    const second = await client.search({
      limit: 1,
      query: 'quarterback practice',
      sourceIds: [source.id],
    });

    expect(second.articles).toHaveLength(1);
    expect(second.articles[0]?.stale).toBe(true);
    expect(second.coverage.failedSources).toEqual([
      expect.objectContaining({
        error: 'temporary source outage',
        id: source.id,
      }),
    ]);
    expect(second.fallbackRecommended).toBe(true);
    expect(tracker.list()).toContainEqual(expect.objectContaining({
      cacheOutcome: 'stale-if-error',
      error: 'temporary source outage',
      id: `news-source:${source.id}`,
    }));
  });
});

interface FetchCall {
  headers: Headers;
  url: string;
}

interface ClientOverrides {
  database?: SebDatabase;
  onSource?: SourceObserver;
}

interface FeedArticle {
  description?: string;
  publishedAt: string;
  title: string;
  url: string;
}

function article(
  title: string,
  url: string,
  publishedAt = '2026-08-29T19:00:00Z',
  description?: string,
): FeedArticle {
  return {
    ...(description ? { description } : {}),
    publishedAt,
    title,
    url,
  };
}

function createClient(
  sources: readonly NewsSourceDefinition[],
  fetch: typeof globalThis.fetch,
  overrides: ClientOverrides = {},
): NewsClient {
  return new NewsClient({
    database: overrides.database ?? false,
    fetch,
    now: () => NOW,
    ...(overrides.onSource ? { onSource: overrides.onSource } : {}),
    policy: { maxAttempts: 1 },
    sources,
  });
}

function createDatabase(): SebDatabase {
  const directory = mkdtempSync(resolve(tmpdir(), 'seb-news-client-'));
  const database = new SebDatabase(resolve(directory, 'seb.sqlite'));
  databases.push(database);
  return database;
}

function newsSource(
  id: string,
  category: NewsSourceCategory = 'independent',
  overrides: Partial<NewsSourceDefinition> = {},
): NewsSourceDefinition {
  return {
    category,
    discoveryKind: 'rss',
    discoveryUrl: `https://${id}.example/rss`,
    homepageUrl: `https://${id}.example/news/`,
    id,
    label: `${id} news`,
    ...overrides,
  };
}

function routeFetch(
  routes: ReadonlyMap<string, Response>,
  calls: FetchCall[] = [],
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = String(input);
    calls.push({ headers: new Headers(init?.headers), url });
    const configured = routes.get(url);
    if (configured) return configured.clone();
    if (new URL(url).pathname === '/robots.txt') {
      return textResponse('User-agent: *\nAllow: /');
    }
    return new Response('missing', { status: 404 });
  };
}

function discoveryCalls(calls: readonly FetchCall[]): string[] {
  return calls
    .map((call) => call.url)
    .filter((url) => new URL(url).pathname !== '/robots.txt');
}

function robotsUrl(source: NewsSourceDefinition): string {
  return `${new URL(source.discoveryUrl).origin}/robots.txt`;
}

function rssResponse(
  articles: readonly FeedArticle[],
  headers: HeadersInit = {},
): Response {
  return xmlResponse(rssBody(articles), headers);
}

function rssBody(articles: readonly FeedArticle[]): string {
  return `
    <rss version="2.0">
      <channel>
        ${articles.map((item) => `
          <item>
            <title>${item.title}</title>
            <link>${item.url}</link>
            <pubDate>${item.publishedAt}</pubDate>
            ${item.description ? `<description>${item.description}</description>` : ''}
          </item>
        `).join('')}
      </channel>
    </rss>
  `;
}

function xmlResponse(body: string, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/rss+xml');
  return new Response(body, { headers, status: 200 });
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
    status: 200,
  });
}

function textResponse(body: string): Response {
  return new Response(body, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    status: 200,
  });
}

function discoveryCacheKey(source: NewsSourceDefinition): string {
  return `discovery:${source.id}:${source.discoveryUrl}`;
}

function expireDiscoveryCache(
  database: SebDatabase,
  source: NewsSourceDefinition,
  cached: ReturnType<SebDatabase['getCache']>,
): void {
  if (!cached) throw new Error('The test discovery cache is missing.');
  database.putCache({
    cachedAt: new Date(Date.now() - 10 * 60 * 1_000).toISOString(),
    etag: cached.etag,
    key: discoveryCacheKey(source),
    lastModified: cached.lastModified,
    namespace: 'news',
    schemaVersion: 'news-v1',
    sourceUrl: source.discoveryUrl,
    staleIfErrorMs: DAY_MS,
    ttlMs: 5 * 60 * 1_000,
    value: cached.value,
  });
}
