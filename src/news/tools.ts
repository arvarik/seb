import { createGoogle } from '@ai-sdk/google';
import { tool, type JSONValue } from 'ai';
import { z } from 'zod';

import { NewsClient } from './client.js';
import { FIRST_CLASS_NEWS_SOURCES } from './sources.js';

type GoogleProvider = ReturnType<typeof createGoogle>;

export function createGroundedNewsTools(google: GoogleProvider) {
  return {
    searchCurrentNews: google.tools.googleSearch({
      searchTypes: { webSearch: {} },
    }),
    readNewsUrl: google.tools.urlContext({}),
  };
}

export function createFirstClassNewsTools(news: NewsClient) {
  return {
    searchFirstClassNews: tool({
      description:
        'Search Seb\'s cached official NFL, independent NFL, and fantasy-impact sources. Use this before a broad web search.',
      inputSchema: z.object({
        query: z.string().trim().min(2).max(500),
        categories: z.array(
          z.enum(['official', 'independent', 'fantasy']),
        ).max(3).optional(),
        teams: z.array(
          z.string().trim().min(2).max(3).transform((value) => value.toUpperCase()),
        ).max(4).optional(),
        sourceIds: z.array(
          z.string().trim().min(1).max(80),
        ).max(FIRST_CLASS_NEWS_SOURCES.length).optional(),
        maxAgeDays: z.number().int().min(1).max(30).optional().default(7),
        limit: z.number().int().min(1).max(12).optional().default(8),
      }),
      inputExamples: [
        {
          input: {
            query: 'Patrick Mahomes knee status and fantasy impact',
            teams: ['KC'],
            maxAgeDays: 7,
            limit: 8,
          },
        },
      ],
      execute: ({ categories, sourceIds, teams, ...input }) => news.search({
        ...input,
        ...(categories ? { categories } : {}),
        ...(sourceIds ? { sourceIds } : {}),
        ...(teams ? { teams } : {}),
      }),
      toModelOutput: ({ output }) => ({
        type: 'json',
        value: {
          articles: output.articles.map((article) => ({
            category: article.category,
            ...(article.excerpt ? { excerpt: article.excerpt.slice(0, 280) } : {}),
            publishedAt: article.publishedAt,
            publisherLabel: article.publisherLabel,
            ...(article.stale ? { stale: true } : {}),
            ...(article.team ? { team: article.team } : {}),
            title: article.title,
            url: article.url,
          })),
          coverage: {
            categories: output.coverage.categories,
            ...(output.coverage.failedSources.length > 0
              ? {
                  failedSourceIds: output.coverage.failedSources.map(
                    (failure) => failure.id,
                  ),
                }
              : {}),
            publisherCount: output.coverage.publisherCount,
            resultCount: output.coverage.resultCount,
            selectedSourceCount: output.coverage.selectedSourceCount,
            successfulSourceCount: output.coverage.successfulSourceCount,
          },
          fallbackRecommended: output.fallbackRecommended,
          query: output.query,
          searchedAt: output.searchedAt,
        } as unknown as JSONValue,
      }),
    }),
  };
}
