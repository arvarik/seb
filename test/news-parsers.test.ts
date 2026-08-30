import { describe, expect, it } from 'vitest';

import {
  parseArticleMetadata,
  parseAtomFeed,
  parseNewsHtml,
  parseNewsSitemap,
  parseRssFeed,
} from '../src/news/parsers.js';

describe('news feed parsers', () => {
  it('parses RSS metadata and removes duplicate tracking URLs', () => {
    const xml = `
      <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <channel>
          <item>
            <title><![CDATA[Josh Allen&#39;s return to practice]]></title>
            <link>/nfl/josh-allen?utm_source=feed&amp;output=1</link>
            <pubDate>Fri, 28 Aug 2026 18:30:00 GMT</pubDate>
            <dc:modified>2026-08-28T19:00:00Z</dc:modified>
            <dc:publisher>Example Sports</dc:publisher>
            <description><![CDATA[<p>Allen completed the full practice.</p>]]></description>
            <category>Injuries</category>
            <category>AFC East</category>
          </item>
          <item>
            <title>Duplicate URL</title>
            <link>https://news.example/nfl/josh-allen</link>
            <pubDate>Fri, 28 Aug 2026 18:30:00 GMT</pubDate>
          </item>
          <item>
            <title>Missing publication date</title>
            <link>https://news.example/nfl/undated</link>
          </item>
        </channel>
      </rss>
    `;

    expect(parseRssFeed(xml, 'https://news.example/feed')).toEqual([
      {
        categories: ['Injuries', 'AFC East'],
        excerpt: 'Allen completed the full practice.',
        modifiedAt: '2026-08-28T19:00:00.000Z',
        publisher: 'Example Sports',
        publishedAt: '2026-08-28T18:30:00.000Z',
        title: "Josh Allen's return to practice",
        url: 'https://news.example/nfl/josh-allen',
      },
    ]);
  });

  it('parses Atom alternate links, categories, and updated date fallbacks', () => {
    const xml = `
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>Rookie earns the starting job</title>
          <link rel="self" href="https://feed.example/entries/1" />
          <link rel="alternate" href="/news/rookie?utm_medium=atom#top" />
          <published>2026-08-27T09:15:00-04:00</published>
          <updated>2026-08-27T14:30:00Z</updated>
          <summary type="html">&lt;p&gt;The coach confirmed the move.&lt;/p&gt;</summary>
          <category term="Depth chart" />
        </entry>
        <entry>
          <title>Updated-only entry</title>
          <link href="https://feed.example/news/updated-only" />
          <updated>2026-08-26T12:00:00Z</updated>
        </entry>
      </feed>
    `;

    expect(parseAtomFeed(xml, 'https://feed.example/atom.xml')).toEqual([
      {
        categories: ['Depth chart'],
        excerpt: 'The coach confirmed the move.',
        modifiedAt: '2026-08-27T14:30:00.000Z',
        publishedAt: '2026-08-27T13:15:00.000Z',
        title: 'Rookie earns the starting job',
        url: 'https://feed.example/news/rookie',
      },
      {
        categories: [],
        excerpt: null,
        modifiedAt: '2026-08-26T12:00:00.000Z',
        publishedAt: '2026-08-26T12:00:00.000Z',
        title: 'Updated-only entry',
        url: 'https://feed.example/news/updated-only',
      },
    ]);
  });

  it('parses News sitemap publication and modification dates', () => {
    const xml = `
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
              xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
        <url>
          <loc>https://league.example/news/rule-change?cid=sitemap</loc>
          <lastmod>2026-08-29T08:10:00Z</lastmod>
          <news:news>
            <news:publication_date>2026-08-29T08:00:00Z</news:publication_date>
            <news:title>League approves a rule change</news:title>
          </news:news>
        </url>
        <url>
          <loc>javascript:alert(1)</loc>
          <news:news>
            <news:publication_date>2026-08-29</news:publication_date>
            <news:title>Invalid link</news:title>
          </news:news>
        </url>
      </urlset>
    `;

    expect(parseNewsSitemap(xml, 'https://league.example/sitemap.xml')).toEqual([
      {
        categories: [],
        excerpt: null,
        modifiedAt: '2026-08-29T08:10:00.000Z',
        publishedAt: '2026-08-29T08:00:00.000Z',
        title: 'League approves a rule change',
        url: 'https://league.example/news/rule-change',
      },
    ]);
  });
});

describe('news HTML discovery parsers', () => {
  it('parses and deduplicates AP NFL hub links', () => {
    const html = `
      <a href="/article/global-navigation-456">Global navigation story</a>
      <main class="Page-oneColumn">
        <a href="/article/nfl-camp-123?utm_campaign=home" aria-label="Camp report"></a>
        <a href="https://apnews.com/article/nfl-camp-123">Repeated report</a>
        <a href="mailto:desk@example.com">Contact</a>
      </main>
    `;

    expect(parseNewsHtml(html, 'https://apnews.com/hub/nfl', 'ap-nfl-hub')).toEqual([
      {
        categories: [],
        excerpt: null,
        modifiedAt: null,
        publishedAt: null,
        title: 'Camp report',
        url: 'https://apnews.com/article/nfl-camp-123',
      },
    ]);
  });

  it.each(['fantasypros-player', 'fantasypros-team'] as const)(
    'parses the %s page flavor',
    (flavor) => {
      const html = `
        <div class="player-news-item">
          <div class="clearfix">
            <div class="ten columns">
              <div class="player-news-header">
                <div class="ten columns">
                  <a href="/nfl/news/quarterback-update.php?utm_source=page">
                    Quarterback receives a workload update
                  </a>
                  <p>Sat, Aug 29th 6:04pm EDT<br />By Reporter</p>
                </div>
              </div>
              <p>The player took every first-team snap.</p>
              <p><b><em>Fantasy Impact:</em></b> The role now has weekly value.</p>
            </div>
          </div>
        </div>
      `;

      expect(parseNewsHtml(
        html,
        'https://www.fantasypros.com/nfl/player-news.php',
        flavor,
        new Date('2026-08-29T20:00:00.000Z'),
      )).toEqual([
        {
          categories: [],
          excerpt:
            'The player took every first-team snap. Fantasy Impact: The role now has weekly value.',
          modifiedAt: null,
          publishedAt: '2026-08-29T22:04:00.000Z',
          title: 'Quarterback receives a workload update',
          url: 'https://www.fantasypros.com/nfl/news/quarterback-update.php',
        },
      ]);
    },
  );

  it('parses NFL player health cards with their displayed dates', () => {
    const html = `
      <a href="/playerhealthandsafety/resources/press-releases/helmet-update">
        <span class="d3-o-media-object__title">NFL publishes helmet test results</span>
        <span class="d3-o-media-object__date">August 28, 2026 12:30:00 GMT</span>
        <span class="d3-o-media-object__summary">The report lists the tested models.</span>
      </a>
      <a href="/playerhealthandsafety/about">About the program</a>
    `;

    expect(parseNewsHtml(
      html,
      'https://www.nfl.com/playerhealthandsafety/resources/press-releases/',
      'nfl-player-health',
    )).toEqual([
      {
        categories: [],
        excerpt: 'The report lists the tested models.',
        modifiedAt: null,
        publishedAt: '2026-08-28T12:30:00.000Z',
        title: 'NFL publishes helmet test results',
        url: 'https://www.nfl.com/playerhealthandsafety/resources/press-releases/helmet-update',
      },
    ]);
  });

  it('parses Rotoworld player posts and removes the author from analysis', () => {
    const html = `
      <article class="PlayerNewsPost">
        <div data-share-url="/fantasy/football/player-news/post-1?source=share"></div>
        <h2 class="PlayerNewsPost-headline">Receiver returns to practice</h2>
        <time data-date="2026-08-29T16:45:00Z"></time>
        <span class="PlayerNewsPost-type">Injury</span>
        <div class="PlayerNewsPost-analysis">
          The receiver took limited repetitions.
          <span class="PlayerNewsPost-author">Staff</span>
        </div>
      </article>
    `;

    expect(parseNewsHtml(
      html,
      'https://www.nbcsports.com/fantasy/football/player-news',
      'rotoworld-player',
    )).toEqual([
      {
        categories: ['Injury'],
        excerpt: 'The receiver took limited repetitions.',
        modifiedAt: null,
        publishedAt: '2026-08-29T16:45:00.000Z',
        title: 'Receiver returns to practice',
        url: 'https://www.nbcsports.com/fantasy/football/player-news/post-1',
      },
    ]);
  });
});

describe('article metadata parser', () => {
  it('finds nested JSON-LD NewsArticle metadata and its canonical URL', () => {
    const html = `
      <html>
        <head>
          <link rel="canonical" href="/news/training-camp?utm_source=page#story" />
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@graph": [
                { "@type": "WebSite", "name": "Example Sports" },
                {
                  "@type": ["NewsArticle", "Article"],
                  "headline": "Training camp report",
                  "description": "The team changed its starting lineup.",
                  "datePublished": "2026-08-29T07:00:00-04:00",
                  "dateModified": "2026-08-29T12:15:00Z",
                  "mainEntityOfPage": { "@id": "https://sports.example/news/training-camp" }
                }
              ]
            }
          </script>
        </head>
      </html>
    `;

    expect(parseArticleMetadata(
      html,
      'https://sports.example/news/training-camp?output=1',
    )).toEqual({
      canonicalUrl: 'https://sports.example/news/training-camp',
      excerpt: 'The team changed its starting lineup.',
      modifiedAt: '2026-08-29T12:15:00.000Z',
      publishedAt: '2026-08-29T11:00:00.000Z',
      title: 'Training camp report',
    });
  });

  it('uses embedded dates and Open Graph metadata when JSON-LD is malformed', () => {
    const html = `
      <html>
        <head>
          <title>Fallback title</title>
          <meta property="og:title" content="Roster move announced" />
          <meta property="og:description" content="The club signed a veteran defender." />
          <link rel="canonical" href="https://club.example/news/roster-move" />
          <script type="application/ld+json">{ malformed }</script>
          <script>
            window.page = {
              "datePublished": "2026-08-28T22:05:00Z",
              "dateModified": "2026-08-28T22:20:00Z"
            };
          </script>
        </head>
      </html>
    `;

    expect(parseArticleMetadata(
      html,
      'https://club.example/news/roster-move?rss=1',
    )).toEqual({
      canonicalUrl: 'https://club.example/news/roster-move',
      excerpt: 'The club signed a veteran defender.',
      modifiedAt: '2026-08-28T22:20:00.000Z',
      publishedAt: '2026-08-28T22:05:00.000Z',
      title: 'Roster move announced',
    });
  });

  it('rejects metadata without a publication date or a public URL', () => {
    expect(parseArticleMetadata(
      '<h1>Undated article</h1>',
      'https://sports.example/news/undated',
    )).toBeNull();
    expect(parseArticleMetadata(`
      <meta property="og:title" content="Credential URL" />
      <meta property="article:published_time" content="2026-08-29T10:00:00Z" />
      <link rel="canonical" href="https://user:secret@sports.example/news/private" />
    `, 'https://user:secret@sports.example/news/private')).toBeNull();
  });
});
