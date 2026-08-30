import type { CacheOutcome } from '../data/cached-resource.js';

export type NewsSourceCategory = 'fantasy' | 'independent' | 'official';

export type NewsDiscoveryKind = 'atom' | 'html' | 'news-sitemap' | 'rss';

export type NewsHtmlFlavor =
  | 'ap-nfl-hub'
  | 'fantasypros-player'
  | 'fantasypros-team'
  | 'nfl-player-health'
  | 'rotoworld-player';

export interface NewsSourceDefinition {
  activationTerms?: readonly string[];
  category: NewsSourceCategory;
  discoveryKind: NewsDiscoveryKind;
  discoveryUrl: string;
  enrichArticles?: boolean;
  enrichDatedArticles?: boolean;
  excludedPathPrefixes?: readonly string[];
  homepageUrl: string;
  htmlFlavor?: NewsHtmlFlavor;
  id: string;
  label: string;
  team?: string;
  urlPathPrefix?: string;
}

export interface DiscoveredNewsArticle {
  cacheOutcome?: CacheOutcome;
  categories: string[];
  excerpt: string | null;
  modifiedAt: string | null;
  publisher?: string | null;
  publishedAt: string | null;
  retrievedAt?: string;
  title: string;
  url: string;
}

export interface NewsArticle extends DiscoveredNewsArticle {
  cacheOutcome: CacheOutcome;
  category: NewsSourceCategory;
  fetchedAt: string;
  publisherId: string;
  publisherLabel: string;
  publishedAt: string;
  sourceId: string;
  sourceLabel: string;
  stale: boolean;
  team: string | null;
}

export interface NewsSourceFailure {
  error: string;
  id: string;
  label: string;
}

export interface NewsSearchInput {
  categories?: readonly NewsSourceCategory[];
  limit?: number;
  maxAgeDays?: number;
  query: string;
  sourceIds?: readonly string[];
  teams?: readonly string[];
}

export interface NewsSearchCoverage {
  categories: NewsSourceCategory[];
  failedSources: NewsSourceFailure[];
  publisherCount: number;
  resultCount: number;
  selectedSourceCount: number;
  successfulSourceCount: number;
}

export interface NewsSearchResult {
  articles: NewsArticle[];
  coverage: NewsSearchCoverage;
  fallbackRecommended: boolean;
  query: string;
  searchedAt: string;
}

export interface NewsSourceProbeResult {
  articleCount: number;
  category: NewsSourceCategory;
  error?: string;
  id: string;
  label: string;
  latestPublishedAt: string | null;
  status: 'failed' | 'passed';
  team: string | null;
  url: string;
}
