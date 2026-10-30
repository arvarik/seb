import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';

import { simulateReadableStream, type UIMessage, type UIMessageChunk } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFantasyFootballAgent } from '../src/agent.js';
import { runWithRequestSignal } from '../src/ai/request-signal.js';
import {
  buildWeeklyPortfolioBrief,
  createPortfolioBriefTools,
  formatWeeklyPortfolioBrief,
  stripPortfolioBriefRawData,
} from '../src/analysis/portfolio-brief.js';
import {
  buildFreeformRecommendationEvidence,
  enforceFreeformRecommendation,
} from '../src/analysis/recommendation-eligibility.js';
import { parseCliArguments } from '../src/cli-options.js';
import { runCli } from '../src/cli.js';
import { postOutboundConnectorMessage } from '../src/connectors/bot.js';
import { SebDatabase } from '../src/data/sqlite-store.js';
import {
  clearSessionWorkingMemory,
  createSessionState,
  formatSessionData,
  formatSessionWorkingMemory,
  hasSessionWorkingMemory,
  recordSessionTurnMemory,
} from '../src/interactive/session.js';
import { sessionContext, SessionStore, type SavedSession } from '../src/interactive/sessions.js';
import { SebInteractiveTransport } from '../src/interactive/transport.js';
import { InteractiveUiState } from '../src/interactive/ui-state.js';
import type { NewsClient } from '../src/news/client.js';
import { bundleCandidateNewsChecks } from '../src/news/tools.js';
import type { NewsSearchResult } from '../src/news/types.js';
import type { NflverseClient } from '../src/nflverse/client.js';
import { PlayerProjectionService } from '../src/projection/service.js';
import { createProjectionTools } from '../src/projection/tools.js';
import type { SetupProfileStore } from '../src/setup/profile.js';
import type { SleeperClient } from '../src/sleeper/client.js';
import type {
  SleeperLeague,
  SleeperMatchup,
  SleeperPlayerMap,
  SleeperRoster,
  SleeperTrendingPlayer,
  SleeperUser,
} from '../src/sleeper/types.js';
import { SourceTracker, type DataSourceRecord } from '../src/sources.js';
import { createWaiverTools } from '../src/waivers/tools.js';
import type { WeatherClient } from '../src/weather/client.js';
import { game, league, stat } from './analysis-fixtures.js';

const tempDirs: string[] = [];
const databases: SebDatabase[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) {
    db.close();
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

function freshSources(): DataSourceRecord[] {
  const now = new Date().toISOString();
  return [
    {
      accessedAt: now,
      cacheOutcome: 'source-updated',
      id: 'sleeper:test',
      label: 'Sleeper NFL data',
      retrievedAt: now,
      url: 'https://api.sleeper.app/v1/state/nfl',
    },
    {
      accessedAt: now,
      cacheOutcome: 'source-updated',
      id: 'nflverse:test',
      label: 'nflverse player stats',
      retrievedAt: now,
      url: 'https://github.com/nflverse/nflverse-data/releases',
    },
    {
      accessedAt: now,
      cacheOutcome: 'source-updated',
      id: 'news-source:nfl-news',
      label: 'NFL.com News (Official)',
      retrievedAt: now,
      url: 'https://www.nfl.com/rss/rsslanding?searchString=home',
    },
    {
      accessedAt: now,
      cacheOutcome: 'source-updated',
      id: 'news-article:nfl-news-1',
      label: 'NFL.com News article',
      retrievedAt: now,
      url: 'https://www.nfl.com/news/status-report',
    },
  ];
}

function mockNewsSearchResult(query: string, playerName: string, team?: string): NewsSearchResult {
  const now = new Date().toISOString();
  return {
    articles: [
      {
        cacheOutcome: 'source-updated',
        categories: [],
        category: 'official',
        corroboratedBy: ['ESPN NFL'],
        excerpt: `${playerName} practiced in full and carries no game status designation.`,
        fetchedAt: now,
        modifiedAt: null,
        publishedAt: now,
        publisherId: 'nfl-com',
        publisherLabel: 'NFL.com News',
        sourceId: 'nfl-news',
        sourceLabel: 'NFL.com News',
        stale: false,
        team: team ?? null,
        title: `${playerName} full go for Sunday`,
        url: `https://www.nfl.com/news/${encodeURIComponent(playerName.toLowerCase().replace(/\s+/gu, '-'))}`,
      },
    ],
    coverage: {
      categories: ['official'],
      failedSources: [],
      publisherCount: 1,
      resultCount: 1,
      selectedSourceCount: 3,
      successfulSourceCount: 3,
    },
    fallbackRecommended: false,
    query,
    searchedAt: now,
  };
}

async function execTool<IN, OUT>(
  definition: { execute?: (input: IN, options: never) => PromiseLike<OUT> | OUT },
  input: IN,
): Promise<Exclude<Awaited<OUT>, AsyncIterable<unknown>>> {
  const output = await definition.execute!(
    input,
    { context: undefined, messages: [], toolCallId: 'tc' } as never,
  );
  return output as Exclude<Awaited<OUT>, AsyncIterable<unknown>>;
}

function createMockNews(spy?: ReturnType<typeof vi.fn>): Pick<NewsClient, 'search'> {
  const fn = spy ?? vi.fn(async (input: { query: string; teams?: string[] }) => {
    const playerName = input.query.replace(/\s+injury status and fantasy impact$/iu, '');
    return mockNewsSearchResult(input.query, playerName, input.teams?.[0]);
  });
  return { search: fn as unknown as NewsClient['search'] };
}

function buildMultiPlayerFixture(options: { runner0Injury?: string | null; throughWeek?: number } = {}) {
  const maxWeek = options.throughWeek ?? 5;
  const weeks = Array.from({ length: maxWeek }, (_, idx) => idx + 1);
  const peerRows = Array.from({ length: 12 }, (_, pIdx) =>
    weeks.map((week) =>
      stat({
        playerDisplayName: pIdx === 0
          ? 'Runner Zero'
          : pIdx === 1
            ? 'Runner One'
            : pIdx === 2
              ? 'Bench Low'
              : `Peer Runner ${pIdx}`,
        playerId: `rb-${pIdx}`,
        position: 'RB',
        receivingYards: pIdx === 0 ? 35 : pIdx === 1 ? 15 : 5,
        receptions: pIdx === 0 ? 4 : pIdx === 1 ? 2 : 1,
        rushingTouchdowns: pIdx === 0 ? 1 : 0,
        rushingYards: pIdx === 0 ? 95 + week * 4 : pIdx === 1 ? 55 + week * 2 : 20,
        season: 2025,
        team: pIdx % 2 === 0 ? 'BUF' : 'MIA',
        week,
      }),
    ),
  ).flat();

  const wrRows = Array.from({ length: 10 }, (_, pIdx) =>
    weeks.map((week) =>
      stat({
        carries: 0,
        playerDisplayName: pIdx === 0 ? 'Wide Waiver' : `Peer Wide ${pIdx}`,
        playerId: pIdx === 0 ? 'wr-waiver' : `wr-${pIdx}`,
        position: 'WR',
        receivingTouchdowns: pIdx === 0 ? 1 : 0,
        receivingYards: pIdx === 0 ? 85 : 40,
        receptions: pIdx === 0 ? 6 : 3,
        rushingYards: 0,
        season: 2025,
        targets: pIdx === 0 ? 9 : 5,
        team: 'BUF',
        week,
      }),
    ),
  ).flat();

  const allStats = [...peerRows, ...wrRows];

  const playerMap: SleeperPlayerMap = {
    'rb-0': {
      active: true,
      fantasy_positions: ['RB'],
      first_name: 'Runner',
      full_name: 'Runner Zero',
      ...(options.runner0Injury ? { injury_status: options.runner0Injury } : {}),
      last_name: 'Zero',
      player_id: 'rb-0',
      position: 'RB',
      status: 'Active',
      team: 'BUF',
    },
    'rb-1': {
      active: true,
      fantasy_positions: ['RB'],
      first_name: 'Runner',
      full_name: 'Runner One',
      last_name: 'One',
      player_id: 'rb-1',
      position: 'RB',
      status: 'Active',
      team: 'MIA',
    },
    'rb-2': {
      active: true,
      fantasy_positions: ['RB'],
      first_name: 'Bench',
      full_name: 'Bench Low',
      last_name: 'Low',
      player_id: 'rb-2',
      position: 'RB',
      status: 'Active',
      team: 'BUF',
    },
    'rb-opp': {
      active: true,
      fantasy_positions: ['RB'],
      first_name: 'Peer',
      full_name: 'Peer Runner 3',
      last_name: 'Runner 3',
      player_id: 'rb-opp',
      position: 'RB',
      status: 'Active',
      team: 'MIA',
    },
    'wr-waiver': {
      active: true,
      fantasy_positions: ['WR'],
      first_name: 'Wide',
      full_name: 'Wide Waiver',
      last_name: 'Waiver',
      player_id: 'wr-waiver',
      position: 'WR',
      status: 'Active',
      team: 'BUF',
    },
    'rb-waiver': {
      active: true,
      fantasy_positions: ['RB'],
      first_name: 'Peer',
      full_name: 'Peer Runner 4',
      last_name: 'Runner 4',
      player_id: 'rb-waiver',
      position: 'RB',
      status: 'Active',
      team: 'BUF',
    },
  };

  const leagueA: SleeperLeague = league({
    league_id: '1001',
    name: 'Alpha Guillotine',
    roster_positions: ['RB', 'BN', 'BN'],
    season: '2025',
    settings: { waiver_budget: 100, waiver_type: 2 },
    status: 'in_season',
  });
  const leagueB: SleeperLeague = league({
    league_id: '1002',
    name: 'Beta Dynasty',
    roster_positions: ['RB', 'BN', 'BN'],
    season: '2025',
    settings: { waiver_budget: 200, waiver_type: 2 },
    status: 'in_season',
  });
  const leagueOffseason: SleeperLeague = league({
    league_id: '1003',
    name: 'Completed Bestball',
    roster_positions: ['RB', 'BN'],
    season: '2025',
    status: 'complete',
  });

  // League A: user owns roster 1 (currently starting rb-1 over higher-projected rb-0 -> recommends swap!)
  const rostersA: SleeperRoster[] = [
    {
      league_id: '1001',
      owner_id: 'user-1',
      players: ['rb-0', 'rb-1', 'rb-2'],
      roster_id: 1,
      settings: { waiver_budget_used: 25 },
      starters: ['rb-1'],
    },
    {
      league_id: '1001',
      owner_id: 'opp-user',
      players: ['rb-opp'],
      roster_id: 2,
      settings: { waiver_budget_used: 10 },
      starters: ['rb-opp'],
    },
  ];
  // League B: user is co-owner of roster 2 (second in Sleeper array -> tests winProbability inversion!)
  const rostersB: SleeperRoster[] = [
    {
      league_id: '1002',
      owner_id: 'opp-user',
      players: ['rb-opp'],
      roster_id: 1,
      settings: { waiver_budget_used: 0 },
      starters: ['rb-opp'],
    },
    {
      co_owners: ['user-1'],
      league_id: '1002',
      owner_id: 'partner-user',
      players: ['rb-0', 'rb-2'],
      roster_id: 2,
      settings: { waiver_budget_used: 40 },
      starters: ['rb-0'],
    },
  ];

  const matchupsA: SleeperMatchup[] = [
    { matchup_id: 1, players: ['rb-0', 'rb-1', 'rb-2'], points: 0, roster_id: 1, starters: ['rb-1'] },
    { matchup_id: 1, players: ['rb-opp'], points: 0, roster_id: 2, starters: ['rb-opp'] },
  ];
  const matchupsB: SleeperMatchup[] = [
    { matchup_id: 7, players: ['rb-opp'], points: 0, roster_id: 1, starters: ['rb-opp'] },
    { matchup_id: 7, players: ['rb-0', 'rb-2'], points: 0, roster_id: 2, starters: ['rb-0'] },
  ];

  const leagueUsers: SleeperUser[] = [
    { display_name: 'Arvind', user_id: 'user-1', username: 'arvind' },
    {
      display_name: 'RivalManager',
      metadata: { team_name: 'Blitz Creek' },
      user_id: 'opp-user',
      username: 'rival',
    },
  ];

  const trending: SleeperTrendingPlayer[] = [
    { count: 140, player_id: 'wr-waiver' },
    { count: 95, player_id: 'rb-waiver' },
  ];

  const sleeper = {
    findPlayers: vi.fn(async (query: string) =>
      Object.values(playerMap).filter(
        (p) => p.full_name?.toLowerCase() === query.trim().toLowerCase(),
      ),
    ),
    getLeague: vi.fn(async (id: string) => {
      if (id === '1002') return leagueB;
      if (id === '1003') return leagueOffseason;
      return leagueA;
    }),
    getLeagueMatchups: vi.fn(async (id: string) => (id === '1002' ? matchupsB : matchupsA)),
    getLeagueRosters: vi.fn(async (id: string) => (id === '1002' ? rostersB : rostersA)),
    getLeagueUsers: vi.fn(async () => leagueUsers),
    getNflState: vi.fn(async () => ({
      display_week: maxWeek + 1,
      league_season: '2025',
      season: '2025',
      season_type: 'regular',
      week: maxWeek + 1,
    })),
    getPlayers: vi.fn(async () => playerMap),
    getTrendingPlayers: vi.fn(async () => trending),
    getUser: vi.fn(async (username: string) => ({
      display_name: username,
      user_id: 'user-1',
      username,
    })),
    getUserLeagues: vi.fn(async () => [leagueA, leagueB, leagueOffseason]),
  } as unknown as SleeperClient;

  const nflverse = {
    getPlayerWeeklyStats: vi.fn(
      async ({
        playerName,
        position,
        throughWeek: tw,
      }: {
        playerName?: string;
        position?: string;
        throughWeek?: number;
      }) => {
        const cap = tw ?? maxWeek;
        return allStats.filter((row) => {
          if (row.week > cap) return false;
          if (playerName) return row.playerDisplayName.toLowerCase() === playerName.toLowerCase();
          if (position) return row.position.toUpperCase() === position.toUpperCase();
          return true;
        });
      },
    ),
    getSchedule: vi.fn(async ({ team, week }: { season: number; team?: string; week?: number }) => {
      const targetWeek = week ?? maxWeek + 1;
      const g = game({
        awayTeam: 'MIA',
        gameDate: '2099-10-19',
        gameId: `2025_${String(targetWeek).padStart(2, '0')}_MIA_BUF`,
        gameTime: '13:00',
        homeTeam: 'BUF',
        roof: 'dome',
        season: 2025,
        week: targetWeek,
      });
      if (team && team !== 'BUF' && team !== 'MIA') return [];
      return [g];
    }),
  } as unknown as NflverseClient;

  return { nflverse, playerMap, sleeper };
}

async function readAllText(stream: ReadableStream<UIMessageChunk>): Promise<string> {
  const reader = stream.getReader();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.type === 'text-delta') text += value.delta;
  }
  return text;
}

describe('Feature 1: auto-bundled newsroom checks & single-call decision gate', () => {
  it('deduplicates candidates, normalizes team codes, survives partial errors, and honors abort signals', async () => {
    const searchSpy = vi.fn(async (input: { query: string; teams?: string[] }) => {
      if (input.query.includes('Failing Player')) {
        throw new Error('upstream RSS timeout');
      }
      return mockNewsSearchResult(input.query, input.query.split(' injury')[0]!, input.teams?.[0]);
    });
    const checks = await bundleCandidateNewsChecks(
      { search: searchSpy as unknown as NewsClient['search'] },
      [
        { name: 'Runner Zero', team: 'buf ' },
        { name: 'runner zero.', team: 'BUF' },
        { name: 'Empty Slot', team: 'MIA' },
        { name: '   ', team: 'KC' },
        { name: 'Failing Player', team: 'INVALID_TEAM' },
        { name: 'Runner One', team: 'mia' },
      ],
      3,
    );

    expect(searchSpy).toHaveBeenCalledTimes(3);
    expect(searchSpy).toHaveBeenNthCalledWith(1, {
      limit: 4,
      maxAgeDays: 7,
      query: 'Runner Zero injury status and fantasy impact',
      teams: ['BUF'],
    });
    expect(searchSpy).toHaveBeenNthCalledWith(2, {
      limit: 4,
      maxAgeDays: 7,
      query: 'Failing Player injury status and fantasy impact',
    });
    expect(checks.map((c) => c.playerName)).toEqual(['Runner Zero', 'Runner One']);

    const aborted = new AbortController();
    await expect(
      runWithRequestSignal(aborted.signal, () =>
        bundleCandidateNewsChecks(
          {
            search: (async () => {
              aborted.abort(new Error('cancelled mid-flight'));
              throw new Error('cancelled mid-flight');
            }) as unknown as NewsClient['search'],
          },
          [{ name: 'Runner Zero', team: 'BUF' }],
        ),
      ),
    ).rejects.toThrow('cancelled mid-flight');
  });

  it('passes the recommendation gate in a single compareStartSit, optimizeRosterLineup, or rankWaiverTargets call', async () => {
    const { nflverse, sleeper } = buildMultiPlayerFixture();
    const newsSpy = vi.fn(async (input: { query: string; teams?: string[] }) => {
      const playerName = input.query.replace(/\s+injury status and fantasy impact$/iu, '');
      return mockNewsSearchResult(input.query, playerName, input.teams?.[0]);
    });
    const news = createMockNews(newsSpy);

    const projectionTools = createProjectionTools(sleeper, nflverse, {} as WeatherClient, {
      news,
    });
    const startSitOutput = await execTool(projectionTools.compareStartSit, {
      leagueId: '1001',
      playerNames: ['Runner Zero', 'Runner One'],
      season: 2025,
      week: 6,
    });

    expect(
      'bundledNewsChecks' in startSitOutput
        ? startSitOutput.bundledNewsChecks.map((c) => c.playerName)
        : [],
    ).toEqual(['Runner Zero', 'Runner One']);

    const startSitEvidence = buildFreeformRecommendationEvidence({
      question: 'Should I start Runner Zero or Runner One in Week 6?',
      sources: freshSources(),
      toolResults: [
        {
          input: { leagueId: '1001', playerNames: ['Runner Zero', 'Runner One'], season: 2025, week: 6 },
          output: startSitOutput,
          toolName: 'compareStartSit',
        },
      ],
    });
    const startSitDecision = enforceFreeformRecommendation(
      'Recommendation: Start Runner Zero over Runner One in Week 6.',
      startSitEvidence,
    );
    expect(startSitDecision.eligibility.outcome).toBe('allowed');

    // Single-call optimizeRosterLineup
    const lineupOutput = await execTool(projectionTools.optimizeRosterLineup, {
      leagueId: '1001',
      rosterId: 1,
      season: 2025,
      week: 6,
    });
    expect(
      'bundledNewsChecks' in lineupOutput ? lineupOutput.bundledNewsChecks.length : 0,
    ).toBeGreaterThanOrEqual(2);
    const lineupEvidence = buildFreeformRecommendationEvidence({
      question: 'Optimize my lineup for Week 6.',
      sources: freshSources(),
      toolResults: [
        {
          input: { leagueId: '1001', rosterId: 1, season: 2025, week: 6 },
          output: lineupOutput,
          toolName: 'optimizeRosterLineup',
        },
      ],
    });
    const lineupDecision = enforceFreeformRecommendation(
      'Recommendation: Start Runner Zero over Runner One in your RB slot.',
      lineupEvidence,
    );
    expect(lineupDecision.eligibility.outcome).toBe('allowed');

    // Single-call rankWaiverTargets (also covers uncovered positions beyond top 3)
    const multiPosSleeper = {
      ...sleeper,
      getLeague: vi.fn(async () =>
        league({
          league_id: '1001',
          name: 'Multi Pos League',
          roster_positions: ['RB', 'WR', 'BN', 'BN'],
          season: '2025',
          settings: { waiver_budget: 100, waiver_type: 2 },
        }),
      ),
    } as unknown as SleeperClient;
    const waiverTools = createWaiverTools(multiPosSleeper, nflverse, news);
    const waiverOutput = await execTool(waiverTools.rankWaiverTargets, {
      leagueId: '1001',
      lookbackHours: 24,
      resultLimit: 5,
      rosterId: 1,
      trendingLimit: 50,
    });
    expect(
      'bundledNewsChecks' in waiverOutput
        ? waiverOutput.bundledNewsChecks.map((c) => c.playerName)
        : [],
    ).toEqual(expect.arrayContaining(['Wide Waiver', 'Peer Runner 4']));
    const waiverEvidence = buildFreeformRecommendationEvidence({
      question: 'Who should I add off waivers in league 1001?',
      sources: freshSources(),
      toolResults: [
        {
          input: { leagueId: '1001', rosterId: 1 },
          output: waiverOutput,
          toolName: 'rankWaiverTargets',
        },
      ],
    });
    const waiverDecision = enforceFreeformRecommendation(
      'Recommendation: Add Wide Waiver with a $15 FAAB bid.',
      waiverEvidence,
    );
    expect(waiverDecision.eligibility.outcome).toBe('allowed');
  });
});

describe('Feature 2: multi-league weekly autopilot brief & outbound connector delivery', () => {
  it('fans out across active Sleeper leagues, inverts win odds for second-listed rosters, deduplicates news, and passes the recommendation gate', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'seb-brief-db-'));
    tempDirs.push(dir);
    const db = new SebDatabase(resolve(dir, 'seb.sqlite'));
    databases.push(db);

    const { nflverse, sleeper } = buildMultiPlayerFixture();
    const newsSpy = vi.fn(async (input: { query: string; teams?: string[] }) => {
      const playerName = input.query.replace(/\s+injury status and fantasy impact$/iu, '');
      return mockNewsSearchResult(input.query, playerName, input.teams?.[0]);
    });
    const news = createMockNews(newsSpy);

    const brief = await buildWeeklyPortfolioBrief(
      {
        news,
        nflverse,
        sleeper,
        snapshotDatabase: db,
        weather: {} as WeatherClient,
      },
      { username: 'arvind' },
    );

    // Filtered out 'complete' offseason league 1003, kept active leagues 1001 & 1002
    expect(brief.leagues.map((l) => l.leagueId)).toEqual(['1001', '1002']);
    expect(brief.leagues[0]?.rosterId).toBe(1);
    expect(brief.leagues[1]?.rosterId).toBe(2); // Co-owned roster!

    // League A has Runner Zero on bench > Runner One in starter slot -> swap recommended + Bench Low suggested drop
    expect(brief.leagues[0]?.lineup?.recommendedSwaps).toHaveLength(1);
    expect(brief.leagues[0]?.lineup?.recommendedSwaps[0]?.startPlayer.name).toBe('Runner Zero');
    expect(brief.leagues[0]?.suggestedDrops[0]?.name).toBe('Bench Low');

    // League B has user on roster 2 (rosters[1]) where Runner Zero out-projects Peer Runner 3 -> inverted winProbability > 0.5!
    expect(brief.leagues[1]?.matchup?.opponentLabel).toBe('Blitz Creek');
    expect(brief.leagues[1]?.matchup?.winProbability).toBeGreaterThan(0.5);

    // Cross-league newsroom deduplication: Wide Waiver & Runner Zero appear in both leagues, searched only once each
    const queriedPlayers = newsSpy.mock.calls.map((call) => call[0].query);
    expect(new Set(queriedPlayers).size).toBe(queriedPlayers.length);

    const markdown = formatWeeklyPortfolioBrief(brief);
    expect(markdown).toContain('## Seb Weekly Brief · 2025 Week 6 · @arvind');
    expect(markdown).toContain('### Alpha Guillotine (`1001` · Roster 1)');
    expect(markdown).toContain('### Beta Dynasty (`1002` · Roster 2)');
    expect(markdown).toContain('Start **Runner Zero**');
    expect(markdown).toContain('Suggested drop: Bench Low');
    expect(markdown).toContain('### Newsroom Wire');

    // AI tool strips rawLineup/rawMatchup/rawWaivers in toModelOutput and passes single-call recommendation gate
    const tools = createPortfolioBriefTools(
      { news, nflverse, sleeper, snapshotDatabase: db, weather: {} as WeatherClient },
      () => 'arvind',
    );
    const toolOutput = await execTool(tools.runWeeklyPortfolioBrief, {});
    const modelJson = stripPortfolioBriefRawData(toolOutput);
    expect('rawLineup' in modelJson.leagues[0]!).toBe(false);

    const evidence = buildFreeformRecommendationEvidence({
      question: 'Run my weekly autopilot brief and recommend my lineup swaps and waiver claims.',
      sources: freshSources(),
      toolResults: [{ input: {}, output: toolOutput, toolName: 'runWeeklyPortfolioBrief' }],
    });
    const decision = enforceFreeformRecommendation(
      'Recommendation: In Alpha Guillotine, start Runner Zero over Runner One and bid $15 FAAB on Wide Waiver.',
      evidence,
    );
    expect(decision.eligibility.outcome).toBe('allowed');
  });

  it('parses seb brief CLI flags and delivers chunked messages to Slack, Discord, Telegram, and GroupMe', async () => {
    expect(parseCliArguments(['brief'])).toEqual({ json: false, name: 'brief' });
    expect(
      parseCliArguments([
        'brief',
        '--user',
        'arvind',
        '--league',
        '1001',
        '--roster',
        '1',
        '--season',
        '2025',
        '--week',
        '6',
        '--post',
        'slack',
        '--channel',
        'C12345',
        '--json',
      ]),
    ).toEqual({
      channel: 'C12345',
      json: true,
      leagueId: '1001',
      name: 'brief',
      post: 'slack',
      rosterId: 1,
      season: 2025,
      username: 'arvind',
      week: 6,
    });
    expect(() => parseCliArguments(['brief', '--channel', 'C123'])).toThrow('--post');
    expect(() => parseCliArguments(['brief', '--post', 'irc'])).toThrow('slack');

    const calls: Array<{ body: unknown; headers: unknown; url: string }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        body: init?.body ? JSON.parse(String(init.body)) : null,
        headers: init?.headers,
        url: String(url),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    // Slack (uses default channel env var)
    const slackRes = await postOutboundConnectorMessage({
      connector: 'slack',
      environment: { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_DEFAULT_CHANNEL_ID: 'C999' },
      fetchImpl: fetchMock,
      text: 'Weekly brief body',
    });
    expect(slackRes).toEqual({ channel: 'C999', chunksSent: 1, connector: 'slack' });
    expect(calls[0]?.url).toBe('https://slack.com/api/chat.postMessage');

    // Discord (splits >1900 chars & enforces numeric snowflake channel ID)
    await expect(
      postOutboundConnectorMessage({
        channel: '#general',
        connector: 'discord',
        environment: { DISCORD_BOT_TOKEN: 'disc-tok' },
        fetchImpl: fetchMock,
        text: 'Hello',
      }),
    ).rejects.toThrow('numeric --channel');

    const discordRes = await postOutboundConnectorMessage({
      channel: '123456789012345678',
      connector: 'discord',
      environment: { DISCORD_BOT_TOKEN: 'disc-tok' },
      fetchImpl: fetchMock,
      text: `${'Line one of brief.\n'.repeat(130)}`,
    });
    expect(discordRes.chunksSent).toBe(2);

    // Telegram
    const tgRes = await postOutboundConnectorMessage({
      connector: 'telegram',
      environment: { TELEGRAM_BOT_TOKEN: 'tg-tok', TELEGRAM_DEFAULT_CHAT_ID: '-100555' },
      fetchImpl: fetchMock,
      text: 'Telegram brief',
    });
    expect(tgRes).toEqual({ channel: '-100555', chunksSent: 1, connector: 'telegram' });

    // GroupMe (rejects --channel, posts with GROUPME_BOT_ID)
    await expect(
      postOutboundConnectorMessage({
        channel: 'room-1',
        connector: 'groupme',
        environment: { GROUPME_BOT_ID: 'gm-bot' },
        fetchImpl: fetchMock,
        text: 'GroupMe brief',
      }),
    ).rejects.toThrow('does not take --channel');

    const gmRes = await postOutboundConnectorMessage({
      connector: 'groupme',
      environment: { GROUPME_BOT_ID: 'gm-bot' },
      fetchImpl: fetchMock,
      text: 'GroupMe brief',
    });
    expect(gmRes).toEqual({ channel: null, chunksSent: 1, connector: 'groupme' });
  });
});

describe('Feature 3: zero-UUID seb resume, session working memory, and SQLite forecast diffs', () => {
  it('resolves latest, numeric index, exact UUID, unique prefix, and title query, and prints numbered seb sessions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'seb-resume-'));
    tempDirs.push(directory);
    const environment = { NO_COLOR: '1', SEB_CONFIG_HOME: directory };
    const store = new SessionStore(environment);

    await expect(store.resolve()).rejects.toThrow('No saved sessions found');

    const olderId = 'seb-11111111-2222-4333-8444-555555555555';
    const newerId = 'seb-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const older: SavedSession = {
      context: sessionContext(createSessionState()),
      evidence: [],
      id: olderId,
      messages: [{ id: 'u1', parts: [{ text: 'Rank my Week 5 waiver wire targets', type: 'text' }], role: 'user' }],
      updatedAt: '2026-10-20T10:00:00.000Z',
      version: 1,
    };
    const newer: SavedSession = {
      context: sessionContext(createSessionState()),
      evidence: [],
      id: newerId,
      messages: [{ id: 'u2', parts: [{ text: 'Compare Josh Allen and Lamar Jackson', type: 'text' }], role: 'user' }],
      updatedAt: '2026-10-21T12:00:00.000Z',
      version: 1,
    };
    for (const snap of [older, newer]) {
      await store.acquire(snap.id);
      await store.save(snap);
      await store.release(snap.id);
    }

    expect(await store.resolve()).toBe(newerId);
    expect(await store.resolve('latest')).toBe(newerId);
    expect(await store.resolve('1')).toBe(newerId);
    expect(await store.resolve('2')).toBe(olderId);
    await expect(store.resolve('3')).rejects.toThrow('#3 does not exist');
    expect(await store.resolve(olderId)).toBe(olderId);
    expect(await store.resolve('seb-1111')).toBe(olderId);
    expect(await store.resolve('aaaa')).toBe(newerId);
    await expect(store.resolve('seb-')).rejects.toThrow('matches 2 saved sessions');
    expect(await store.resolve('waiver wire')).toBe(olderId);
    await expect(store.resolve('nonexistent-topic')).rejects.toThrow('No saved session matched');

    let stdoutText = '';
    const stdout = new Writable({
      write(chunk, _enc, cb) {
        stdoutText += String(chunk);
        cb();
      },
    });
    const code = await runCli(
      ['sessions'],
      { stderr: stdout, stdin: process.stdin, stdout },
      environment,
    );
    expect(code).toBe(0);
    expect(stdoutText).toContain(`1. ${newerId}`);
    expect(stdoutText).toContain(`2. ${olderId}`);
  });

  it('persists working memory across snapshots, folds evicted turns past 24 messages, and supports /brief and /memory', async () => {
    const state = createSessionState(new Date('2026-10-25T00:00:00.000Z'));
    expect(hasSessionWorkingMemory(state.memory)).toBe(false);
    expect(JSON.parse(formatSessionData(state))).not.toHaveProperty('workingMemory');
    expect(sessionContext(state)).not.toHaveProperty('memory');

    recordSessionTurnMemory(
      state,
      {
        answerText:
          '**Recommendation**: Start Runner Zero over Runner One for safe RB volume.\n\n## Evidence\n- Sleeper',
        player: 'Runner Zero',
        userPrompt:
          'I need a safe floor this week, my league is 6-pt passing TD, and avoid Thursday players.',
      },
      new Date('2026-10-25T01:00:00.000Z'),
    );

    expect(hasSessionWorkingMemory(state.memory)).toBe(true);
    expect(state.memory?.trackedPlayers).toEqual(['Runner Zero']);
    expect(state.memory?.notedPreferences).toHaveLength(3);
    expect(state.memory?.decisions).toEqual([
      'Start Runner Zero over Runner One for safe RB volume.',
    ]);
    expect(JSON.parse(formatSessionData(state)).workingMemory).toMatchObject({
      decisions: ['Start Runner Zero over Runner One for safe RB volume.'],
      trackedPlayers: ['Runner Zero'],
    });
    expect(formatSessionWorkingMemory(state)).toContain('Start Runner Zero over Runner One');

    // Round-trip through SessionStore
    const directory = await mkdtemp(join(tmpdir(), 'seb-memory-'));
    tempDirs.push(directory);
    const environment = { NO_COLOR: '1', SEB_CONFIG_HOME: directory };
    const store = new SessionStore(environment);
    const id = `seb-${randomUUID()}`;
    await store.acquire(id);
    await store.save({
      context: sessionContext(state),
      evidence: [],
      id,
      messages: [{ id: 'u1', parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      updatedAt: new Date().toISOString(),
      version: 1,
    });
    const loaded = await store.load(id);
    await store.release(id);
    expect(loaded.context.memory).toEqual(state.memory);

    // Transport eviction folding (>24 messages) + /brief + /memory [clear]
    const { nflverse, sleeper } = buildMultiPlayerFixture();
    const news = createMockNews();
    let capturedPromptCount = 0;
    const model = new MockLanguageModelV4({
      doStream: async (opts) => {
        capturedPromptCount = opts.prompt.filter((m) => m.role === 'user' || m.role === 'assistant').length;
        return {
          stream: simulateReadableStream({
            chunks: [
              { id: 't1', type: 'text-start' },
              { delta: 'Acknowledged turn.', id: 't1', type: 'text-delta' },
              { id: 't1', type: 'text-end' },
              {
                finishReason: { raw: 'stop', unified: 'stop' },
                type: 'finish',
                usage: {
                  inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 10, total: 10 },
                  outputTokens: { reasoning: undefined, text: 5, total: 5 },
                },
              },
            ],
          }),
        };
      },
    });
    const sources = new SourceTracker();
    const transportSession = createSessionState();
    transportSession.user = 'arvind';
    transportSession.season = 2025;
    transportSession.leagueSeason = 2025;
    transportSession.week = 6;
    const agent = createFantasyFootballAgent({
      identityRepository: false,
      languageModel: model,
      nflverseClient: nflverse,
      sleeperClient: sleeper,
      weatherClient: {} as WeatherClient,
    });
    const profileStore: SetupProfileStore = {
      load: async () => null,
      path: join(directory, 'profile.json'),
      remove: async () => false,
      save: async () => undefined,
    };
    const transport = new SebInteractiveTransport({
      agent,
      environment,
      model: 'gemini-3-flash-preview',
      news: news as unknown as NewsClient,
      nflverse,
      profileStore,
      session: transportSession,
      sleeper,
      sources,
      uiState: new InteractiveUiState(),
      version: '1.1.3',
      weather: {} as WeatherClient,
    });

    // Build 14 historical turns (28 messages) + 1 new user message = 29 messages (> 24 limit)
    const longHistory: UIMessage[] = [];
    for (let i = 1; i <= 14; i += 1) {
      longHistory.push({
        id: `u-${i}`,
        parts: [{ text: i === 1 ? 'Early turn: check Bijan Robinson role' : `Question ${i}`, type: 'text' }],
        role: 'user',
      });
      longHistory.push({
        id: `a-${i}`,
        parts: [{ text: i === 1 ? 'Bijan handled 82% of snaps.' : `Answer ${i}`, type: 'text' }],
        role: 'assistant',
      });
    }
    longHistory.push({
      id: 'u-15',
      parts: [{ text: 'What did we decide earlier?', type: 'text' }],
      role: 'user',
    });

    const replyText = await readAllText(
      await transport.sendMessages({
        abortSignal: undefined,
        chatId: 'chat-1',
        messageId: 'u-15',
        messages: longHistory,
        trigger: 'submit-message',
      }),
    );
    expect(replyText).toContain('Acknowledged turn.');
    expect(capturedPromptCount).toBeLessThanOrEqual(24);
    expect(
      transportSession.memory?.decisions.some((d) =>
        d.includes('Early turn: check Bijan Robinson role -> Bijan handled 82% of snaps.'),
      ),
    ).toBe(true);

    // /brief slash command in transport
    const briefReply = await readAllText(
      await transport.sendMessages({
        abortSignal: undefined,
        chatId: 'chat-1',
        messageId: 'cmd-brief',
        messages: [{ id: 'cmd-brief', parts: [{ text: '/brief', type: 'text' }], role: 'user' }],
        trigger: 'submit-message',
      }),
    );
    expect(briefReply).toContain('## Seb Weekly Brief · 2025 Week 6 · @arvind');

    // /memory and /memory clear slash commands
    const memView = await readAllText(
      await transport.sendMessages({
        abortSignal: undefined,
        chatId: 'chat-1',
        messageId: 'cmd-mem',
        messages: [{ id: 'cmd-mem', parts: [{ text: '/memory', type: 'text' }], role: 'user' }],
        trigger: 'submit-message',
      }),
    );
    expect(memView).toContain('## Session working memory');
    expect(memView).toContain('Bijan handled 82% of snaps');

    const memCleared = await readAllText(
      await transport.sendMessages({
        abortSignal: undefined,
        chatId: 'chat-1',
        messageId: 'cmd-mem-clear',
        messages: [{ id: 'cmd-mem-clear', parts: [{ text: '/memory clear', type: 'text' }], role: 'user' }],
        trigger: 'submit-message',
      }),
    );
    expect(memCleared).toContain('Seb cleared the pinned session working memory.');
    expect(hasSessionWorkingMemory(transportSession.memory)).toBe(false);

    // Verify clearSessionWorkingMemory directly
    recordSessionTurnMemory(transportSession, { player: 'Runner Zero', userPrompt: 'Check Runner Zero' });
    expect(hasSessionWorkingMemory(transportSession.memory)).toBe(true);
    clearSessionWorkingMemory(transportSession);
    expect(transportSession.memory).toBeUndefined();
  });

  it('persists deduplicated SQLite player-projection snapshots and attributes forecastDiff drivers across runs', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'seb-forecast-diff-'));
    tempDirs.push(dir);
    const db = new SebDatabase(resolve(dir, 'seb.sqlite'));
    databases.push(db);

    // Run 1: baseline through Week 5, healthy
    const f1 = buildMultiPlayerFixture({ runner0Injury: null, throughWeek: 5 });
    const service1 = new PlayerProjectionService(
      f1.sleeper,
      f1.nflverse,
      {} as WeatherClient,
      false,
      db,
    );
    const first = await service1.project({
      leagueId: '1001',
      playerName: 'Runner Zero',
      season: 2025,
      throughWeek: 5,
      week: 7,
    });
    expect(first.forecastDiff).toBeUndefined();
    expect(db.listSnapshotMetadata({ kind: 'player-projection' })).toHaveLength(1);

    // Run 2: identical inputs -> no duplicate snapshot row, sets unchangedSince
    const second = await service1.project({
      leagueId: '1001',
      playerName: 'Runner Zero',
      season: 2025,
      throughWeek: 5,
      week: 7,
    });
    expect(db.listSnapshotMetadata({ kind: 'player-projection' })).toHaveLength(1);
    expect(second.forecastDiff).toMatchObject({
      deltaExpectedPoints: 0,
      drivers: ['Unchanged since previous forecast'],
      previousExpectedPoints: first.expectedPoints,
    });
    expect(second.forecastDiff?.unchangedSince).toBeTruthy();

    // Run 3: Week 6 stats added + Questionable injury tag -> records new snapshot & attributes drivers!
    const f2 = buildMultiPlayerFixture({ runner0Injury: 'Questionable', throughWeek: 6 });
    const service2 = new PlayerProjectionService(
      f2.sleeper,
      f2.nflverse,
      {} as WeatherClient,
      false,
      db,
    );
    const third = await service2.project({
      leagueId: '1001',
      playerName: 'Runner Zero',
      season: 2025,
      throughWeek: 6,
      week: 7,
    });
    expect(db.listSnapshotMetadata({ kind: 'player-projection' })).toHaveLength(2);
    expect(third.forecastDiff).toBeDefined();
    expect(third.forecastDiff?.previousExpectedPoints).toBe(first.expectedPoints);
    expect(third.forecastDiff?.deltaExpectedPoints).not.toBe(0);
    expect(third.forecastDiff?.drivers).toEqual(
      expect.arrayContaining([
        'Completed stats window advanced (2025 W5 -> 2025 W6)',
        'Injury status changed (Active -> Questionable Active)',
      ]),
    );

    // Run 4: repeat of Run 3 -> still 2 snapshots, preserves non-zero shift + sets unchangedSince!
    const fourth = await service2.project({
      leagueId: '1001',
      playerName: 'Runner Zero',
      season: 2025,
      throughWeek: 6,
      week: 7,
    });
    expect(db.listSnapshotMetadata({ kind: 'player-projection' })).toHaveLength(2);
    expect(fourth.forecastDiff?.deltaExpectedPoints).toBe(third.forecastDiff?.deltaExpectedPoints);
    expect(fourth.forecastDiff?.unchangedSince).toBeTruthy();
  });
});
