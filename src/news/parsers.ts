import { load, type CheerioAPI } from 'cheerio/slim';

import type {
  DiscoveredNewsArticle,
  NewsHtmlFlavor,
} from './types.js';

const MAX_TITLE_CHARACTERS = 300;
const MAX_EXCERPT_CHARACTERS = 600;
const MONTH_INDEX = new Map([
  ['jan', 0],
  ['feb', 1],
  ['mar', 2],
  ['apr', 3],
  ['may', 4],
  ['jun', 5],
  ['jul', 6],
  ['aug', 7],
  ['sep', 8],
  ['oct', 9],
  ['nov', 10],
  ['dec', 11],
]);
const TRACKING_PARAMETERS = [
  'cmpid',
  'cid',
  'guccounter',
  'output',
  'rss',
  'source',
] as const;

export interface ArticleMetadata {
  canonicalUrl: string;
  excerpt: string | null;
  modifiedAt: string | null;
  publishedAt: string;
  title: string;
}

export function parseNewsSitemap(
  xml: string,
  baseUrl: string,
): DiscoveredNewsArticle[] {
  const $ = load(xml, { xmlMode: true });
  const output: DiscoveredNewsArticle[] = [];
  $('url').each((_index, element) => {
    const entry = $(element);
    const url = normalizeArticleUrl(entry.find('loc').first().text(), baseUrl);
    const title = cleanText(entry.find('news\\:title').first().text(), MAX_TITLE_CHARACTERS);
    const publishedAt = normalizeDate(
      entry.find('news\\:publication_date').first().text(),
    );
    if (!url || !title) return;
    output.push({
      categories: [],
      excerpt: null,
      modifiedAt: normalizeDate(entry.find('lastmod').first().text()),
      publishedAt,
      title,
      url,
    });
  });
  return uniqueArticles(output);
}

export function parseRssFeed(
  xml: string,
  baseUrl: string,
): DiscoveredNewsArticle[] {
  const $ = load(xml, { xmlMode: true });
  const output: DiscoveredNewsArticle[] = [];
  $('item').each((_index, element) => {
    const item = $(element);
    const url = normalizeArticleUrl(item.find('link').first().text(), baseUrl);
    const title = cleanText(item.find('title').first().text(), MAX_TITLE_CHARACTERS);
    const publishedAt = normalizeDate(
      firstText(item, ['pubDate', 'dc\\:date', 'published']),
    );
    const publisher = cleanText(
      firstText(item, ['dc\\:publisher', 'source']),
      100,
    );
    if (!url || !title || !publishedAt) return;
    output.push({
      categories: item.find('category').map((_categoryIndex, category) =>
        cleanText($(category).text(), 100)
      ).get().filter(Boolean),
      excerpt: htmlToText(firstText(item, ['description', 'summary'])),
      modifiedAt: normalizeDate(firstText(item, ['updated', 'dc\\:modified'])),
      ...(publisher ? { publisher } : {}),
      publishedAt,
      title,
      url,
    });
  });
  return uniqueArticles(output);
}

export function parseAtomFeed(
  xml: string,
  baseUrl: string,
): DiscoveredNewsArticle[] {
  const $ = load(xml, { xmlMode: true });
  const output: DiscoveredNewsArticle[] = [];
  $('entry').each((_index, element) => {
    const entry = $(element);
    const link = entry.find('link[rel="alternate"]').first().attr('href') ??
      entry.find('link').first().attr('href') ??
      entry.find('link').first().text();
    const url = normalizeArticleUrl(link, baseUrl);
    const title = cleanText(entry.find('title').first().text(), MAX_TITLE_CHARACTERS);
    const publishedAt = normalizeDate(firstText(entry, ['published', 'updated']));
    if (!url || !title || !publishedAt) return;
    output.push({
      categories: entry.find('category').map((_categoryIndex, category) =>
        cleanText($(category).attr('term') ?? $(category).text(), 100)
      ).get().filter(Boolean),
      excerpt: htmlToText(firstText(entry, ['summary', 'content'])),
      modifiedAt: normalizeDate(entry.find('updated').first().text()),
      publishedAt,
      title,
      url,
    });
  });
  return uniqueArticles(output);
}

export function parseNewsHtml(
  html: string,
  baseUrl: string,
  flavor: NewsHtmlFlavor,
  referenceDate = new Date(),
): DiscoveredNewsArticle[] {
  const $ = load(html);
  switch (flavor) {
    case 'ap-nfl-hub':
      return parseApHub($, baseUrl);
    case 'fantasypros-player':
    case 'fantasypros-team':
      return parseFantasyPros($, baseUrl, referenceDate);
    case 'nfl-player-health':
      return parseNflPlayerHealth($, baseUrl);
    case 'rotoworld-player':
      return parseRotoworldPlayerNews($, baseUrl);
  }
}

export function parseArticleMetadata(
  html: string,
  pageUrl: string,
): ArticleMetadata | null {
  const $ = load(html);
  const structured = findArticleStructuredData($);
  const title = cleanText(
    stringValue(structured?.headline) ??
      metaContent($, 'property', 'og:title') ??
      $('h1').first().text() ??
      $('title').text(),
    MAX_TITLE_CHARACTERS,
  );
  const publishedAt = normalizeDate(
    stringValue(structured?.datePublished) ??
      metaContent($, 'property', 'article:published_time') ??
      metaContent($, 'name', 'datePublished') ??
      embeddedJsonString(html, 'datePublished') ??
      $('time[datetime]').first().attr('datetime'),
  );
  if (!title || !publishedAt) return null;
  const canonicalUrl = normalizeArticleUrl(
    $('link[rel="canonical"]').first().attr('href') ??
      stringValue(structured?.url) ??
      objectId(structured?.mainEntityOfPage) ??
      pageUrl,
    pageUrl,
  );
  if (!canonicalUrl) return null;
  return {
    canonicalUrl,
    excerpt: cleanText(
      stringValue(structured?.description) ??
        metaContent($, 'name', 'description') ??
        metaContent($, 'property', 'og:description'),
      MAX_EXCERPT_CHARACTERS,
    ) || null,
    modifiedAt: normalizeDate(
      stringValue(structured?.dateModified) ??
        metaContent($, 'property', 'article:modified_time') ??
        embeddedJsonString(html, 'dateModified'),
    ),
    publishedAt,
    title,
  };
}

function parseApHub($: CheerioAPI, baseUrl: string): DiscoveredNewsArticle[] {
  const output: DiscoveredNewsArticle[] = [];
  const hub = $('main.Page-oneColumn').first();
  if (!hub.length) return output;
  hub.find('a[href*="/article/"]').each((_index, element) => {
    const anchor = $(element);
    const url = normalizeArticleUrl(anchor.attr('href'), baseUrl);
    const title = cleanText(
      anchor.attr('aria-label') ?? anchor.text(),
      MAX_TITLE_CHARACTERS,
    );
    if (!url || !title) return;
    output.push(emptyDatedArticle(title, url));
  });
  return uniqueArticles(output);
}

function parseFantasyPros(
  $: CheerioAPI,
  baseUrl: string,
  referenceDate: Date,
): DiscoveredNewsArticle[] {
  const output: DiscoveredNewsArticle[] = [];
  $('.player-news-item').each((_index, element) => {
    const item = $(element);
    const anchor = item
      .find('.player-news-header a[href*="/nfl/news/"]')
      .first();
    const url = normalizeArticleUrl(anchor.attr('href'), baseUrl);
    const title = cleanText(anchor.text(), MAX_TITLE_CHARACTERS);
    if (!url || !title) return;
    const headerText = item.find('.player-news-header p').first().text();
    const publishedAt = parseFantasyProsDate(headerText, referenceDate);
    const content = item.find('.player-news-content p').length > 0
      ? item.find('.player-news-content p')
      : item.find('.player-news-header').first().parent().children('p');
    output.push({
      ...emptyDatedArticle(title, url),
      excerpt: cleanText(
        content.map((_paragraphIndex, paragraph) => $(paragraph).text()).get().join(' '),
        MAX_EXCERPT_CHARACTERS,
      ) || null,
      publishedAt,
    });
  });
  return uniqueArticles(output);
}

function parseNflPlayerHealth(
  $: CheerioAPI,
  baseUrl: string,
): DiscoveredNewsArticle[] {
  const output: DiscoveredNewsArticle[] = [];
  $('a[href*="/playerhealthandsafety/"]').each((_index, element) => {
    const anchor = $(element);
    if (!anchor.find('.d3-o-media-object__title').length) return;
    const url = normalizeArticleUrl(anchor.attr('href'), baseUrl);
    const title = cleanText(
      anchor.find('.d3-o-media-object__title').first().text(),
      MAX_TITLE_CHARACTERS,
    );
    const publishedAt = normalizeDate(
      anchor.find('.d3-o-media-object__date').first().text(),
    );
    if (!url || !title) return;
    output.push({
      categories: [],
      excerpt: cleanText(
        anchor.find('.d3-o-media-object__summary').first().text(),
        MAX_EXCERPT_CHARACTERS,
      ) || null,
      modifiedAt: null,
      publishedAt,
      title,
      url,
    });
  });
  return uniqueArticles(output);
}

function parseRotoworldPlayerNews(
  $: CheerioAPI,
  baseUrl: string,
): DiscoveredNewsArticle[] {
  const output: DiscoveredNewsArticle[] = [];
  $('.PlayerNewsPost').each((_index, element) => {
    const item = $(element);
    const url = normalizeArticleUrl(
      item.find('[data-share-url]').first().attr('data-share-url'),
      baseUrl,
    );
    const title = cleanText(
      item.find('.PlayerNewsPost-headline').first().text(),
      MAX_TITLE_CHARACTERS,
    );
    const publishedAt = normalizeDate(
      item.find('[data-date]').first().attr('data-date'),
    );
    if (!url || !title || !publishedAt) return;
    output.push({
      categories: [
        cleanText(item.find('.PlayerNewsPost-type').first().text(), 100),
      ].filter(Boolean),
      excerpt: cleanText(
        item.find('.PlayerNewsPost-analysis').first().clone()
          .find('.PlayerNewsPost-author').remove().end().text(),
        MAX_EXCERPT_CHARACTERS,
      ) || null,
      modifiedAt: null,
      publishedAt,
      title,
      url,
    });
  });
  return uniqueArticles(output);
}

function findArticleStructuredData(
  $: CheerioAPI,
): Record<string, unknown> | null {
  const candidates: unknown[] = [];
  $('script[type="application/ld+json"]').each((_index, element) => {
    try {
      candidates.push(JSON.parse($(element).text()) as unknown);
    } catch {
      // A malformed block must not hide valid metadata in another block.
    }
  });
  const queue = [...candidates];
  let inspected = 0;
  while (queue.length > 0 && inspected < 2_000) {
    inspected += 1;
    const value = queue.shift();
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    if (isArticleType(record['@type'])) return record;
    queue.push(...Object.values(record));
  }
  return null;
}

function isArticleType(value: unknown): boolean {
  const types = Array.isArray(value) ? value : [value];
  return types.some((type) =>
    typeof type === 'string' &&
    ['Article', 'BlogPosting', 'LiveBlogPosting', 'NewsArticle'].includes(type)
  );
}

function firstText(
  selection: ReturnType<CheerioAPI>,
  selectors: readonly string[],
): string {
  for (const selector of selectors) {
    const value = selection.find(selector).first().text().trim();
    if (value) return value;
  }
  return '';
}

function metaContent(
  $: CheerioAPI,
  attribute: 'name' | 'property',
  value: string,
): string | undefined {
  return $(`meta[${attribute}="${value}"]`).first().attr('content');
}

function embeddedJsonString(html: string, field: string): string | undefined {
  const match = new RegExp(`"${field}"\\s*:\\s*"([^"\\\\]+)"`, 'u').exec(html);
  return match?.[1];
}

function objectId(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  return stringValue((value as Record<string, unknown>)['@id']);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function emptyDatedArticle(
  title: string,
  url: string,
): DiscoveredNewsArticle {
  return {
    categories: [],
    excerpt: null,
    modifiedAt: null,
    publishedAt: null,
    title,
    url,
  };
}

function normalizeDate(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function parseFantasyProsDate(value: string, referenceDate: Date): string | null {
  const match = /(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat),\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:st|nd|rd|th)\s+(\d{1,2}):(\d{2})(am|pm)\s+(EST|EDT)/iu.exec(value);
  if (!match) return null;
  const month = MONTH_INDEX.get(match[1]?.toLowerCase() ?? '');
  const day = Number(match[2]);
  let hour = Number(match[3]);
  const minute = Number(match[4]);
  const period = match[5]?.toLowerCase();
  const zone = match[6]?.toUpperCase();
  if (month === undefined || !Number.isInteger(day) || !Number.isInteger(hour)) {
    return null;
  }
  if (period === 'pm' && hour !== 12) hour += 12;
  if (period === 'am' && hour === 12) hour = 0;
  let year = referenceDate.getUTCFullYear();
  if (month > referenceDate.getUTCMonth() + 1) year -= 1;
  const offsetHours = zone === 'EDT' ? 4 : 5;
  const timestamp = Date.UTC(year, month, day, hour + offsetHours, minute);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeArticleUrl(
  value: string | null | undefined,
  baseUrl: string,
): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  try {
    const url = new URL(normalized, baseUrl);
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    url.hash = '';
    const parameterNames = Array.from(url.searchParams.keys());
    for (const name of parameterNames) {
      if (name.toLowerCase().startsWith('utm_')) url.searchParams.delete(name);
    }
    for (const name of TRACKING_PARAMETERS) url.searchParams.delete(name);
    return url.href;
  } catch {
    return null;
  }
}

function htmlToText(value: string): string | null {
  if (!value.trim()) return null;
  return cleanText(load(`<body>${value}</body>`)('body').text(), MAX_EXCERPT_CHARACTERS) || null;
}

function cleanText(value: string | null | undefined, limit: number): string {
  if (!value) return '';
  const decoded = value.includes('&')
    ? load(`<body>${value}</body>`)('body').text()
    : value;
  return decoded.replace(/\s+/gu, ' ').trim().slice(0, limit);
}

function uniqueArticles(
  articles: readonly DiscoveredNewsArticle[],
): DiscoveredNewsArticle[] {
  const seen = new Set<string>();
  return articles.filter((article) => {
    if (seen.has(article.url)) return false;
    seen.add(article.url);
    return true;
  });
}
