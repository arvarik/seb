import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import {
  simulateReadableStream,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';

import { createFantasyFootballAgent } from '../src/agent.js';
import {
  createSessionState,
  formatSessionContext,
  getContextualSuggestions,
  inferExperienceMode,
  inferPlayerNameFromPrompt,
  recordSessionToolInput,
} from '../src/interactive/session.js';
import {
  formatSkillList,
  parseSkillInvocation,
  SEB_SKILLS,
} from '../src/interactive/skills.js';
import {
  INTERACTIVE_HELP,
  SebInteractiveTransport,
} from '../src/interactive/transport.js';
import { NflverseClient } from '../src/nflverse/client.js';
import { SleeperClient } from '../src/sleeper/client.js';
import { SourceTracker } from '../src/sources.js';
import { WeatherClient } from '../src/weather/client.js';
import type { SebSetupProfile, SetupProfileStore } from '../src/setup/profile.js';

describe('interactive skills', () => {
  it('defines unique skills for the major fantasy workflows', () => {
    expect(new Set(SEB_SKILLS.map((skill) => skill.id)).size).toBe(SEB_SKILLS.length);
    expect(SEB_SKILLS.map((skill) => skill.id)).toEqual(
      expect.arrayContaining([
        'start-sit',
        'player-info',
        'team-info',
        'nfl-stats',
        'waiver-scout',
        'weather-watch',
        'usage-trends',
        'game-environment',
        'playoff-planner',
      ]),
    );
    expect(formatSkillList()).toContain('### NFL information');
    expect(formatSkillList()).toContain('### Fantasy');
    expect(formatSkillList()).toContain('### Research');
    expect(SEB_SKILLS.every((skill) => skill.category.length > 0)).toBe(true);
    for (const skill of SEB_SKILLS) {
      expect(parseSkillInvocation(`${skill.id} Test question`)).toEqual({
        prompt: 'Test question',
        skill,
      });
      expect(parseSkillInvocation(skill.title)).toEqual({ prompt: '', skill });
      expect(skill.instructions.length).toBeGreaterThan(0);
      expect(skill.suggestions.length).toBeGreaterThan(0);
    }
  });

  it('shows active skill actions before optional setup actions', () => {
    const trade = createSessionState(new Date('2026-08-20T12:00:00Z'));
    trade.skillId = 'trade-review';
    expect(getContextualSuggestions(trade).slice(0, 3)).toEqual([
      'Compare <Side A> for <Side B>.',
      'Review <Player A> and <Player B> for my roster.',
      'Explain the risk on both sides of <trade>.',
    ]);

    const weather = createSessionState(new Date('2026-08-20T12:00:00Z'));
    weather.skillId = 'weather-watch';
    weather.team = 'SEA';
    weather.week = 2;
    expect(getContextualSuggestions(weather).slice(0, 3)).toEqual([
      "Check SEA's Week 2 kickoff weather.",
      'List outdoor weather risks for Week 2.',
      'Explain the weather impact for SEA.',
    ]);
    expect(formatSessionContext(weather)).toContain('Use getGameWeather');

    const team = createSessionState(new Date('2026-08-20T12:00:00Z'));
    team.skillId = 'team-info';
    team.team = 'SEA';
    expect(getContextualSuggestions(team)[0]).toBe(
      'Show the SEA team profile and player list.',
    );
    expect(formatSessionContext(team)).toContain(
      'Do not add fantasy advice unless the user requests it.',
    );
  });

  it('keeps the active player in standalone follow-up suggestions', () => {
    const session = createSessionState(new Date('2026-08-20T12:00:00Z'));
    session.skillId = 'player-info';
    session.player = inferPlayerNameFromPrompt('derrick henry');

    expect(session.player).toBe('Derrick Henry');
    expect(getContextualSuggestions(session).slice(0, 3)).toEqual([
      "Show Derrick Henry's profile and recent NFL statistics.",
      "Summarize Derrick Henry's season game log.",
      'Find the latest verified news about Derrick Henry.',
    ]);
    expect(formatSessionContext(session)).toContain('NFL player: Derrick Henry.');
  });

  it('updates the active player from player tool input', () => {
    const session = createSessionState();

    recordSessionToolInput(session, 'getPlayerWeeklyStats', {
      playerName: 'Derrick Henry',
      season: 2025,
    });

    expect(session.player).toBe('Derrick Henry');
    recordSessionToolInput(session, 'getNflSchedule', { team: 'BAL' });
    expect(session.player).toBe('Derrick Henry');
    recordSessionToolInput(session, 'findPlayers', { query: '\u001b[2Jfake' });
    expect(session.player).toBe('Derrick Henry');
    expect(inferPlayerNameFromPrompt('show Derrick Henry')).toBeNull();
  });

  it('routes natural questions into the three experiences', () => {
    expect(inferExperienceMode('Show player statistics.', 'analyze')).toBe('explore');
    expect(inferExperienceMode('What needs my attention across my leagues?', 'explore'))
      .toBe('fantasy');
    expect(inferExperienceMode('Look deeper into their stats.', 'explore')).toBe('analyze');
  });
});

describe('SebInteractiveTransport', () => {
  it('runs an inline question with the selected skill', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'Player profile.' },
            { type: 'text-end', id: 'text-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: {
                inputTokens: {
                  total: 5,
                  noCache: 5,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: {
                  total: 2,
                  text: 2,
                  reasoning: undefined,
                },
              },
            },
          ],
        }),
      }),
    });
    const session = createSessionState(new Date('2026-08-20T12:00:00Z'));
    const clients = dataClients();
    const transport = new SebInteractiveTransport({
      agent: createFantasyFootballAgent({
        languageModel: model,
        getRuntimeInstructions: () => formatSessionContext(session),
        ...clients,
      }),
      environment: {},
      model: 'test-model',
      nflverse: clients.nflverseClient,
      session,
      sleeper: clients.sleeperClient,
      sources: new SourceTracker(),
      version: '0.0.1',
      weather: clients.weatherClient,
    });

    const output = await sendCommand(
      transport,
      '/skill player-info Derrick Henry',
      'message-1',
    );
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);

    expect(output).toContain('Player profile.');
    expect(session.skillId).toBe('player-info');
    expect(prompt).toContain('Derrick Henry');
    expect(prompt).toContain('Active skill: player-info');
    expect(prompt).not.toContain('/skill player-info');

    const followUp = 'Look deeper into their stats.';
    await sendConversation(transport, [
      {
        id: 'message-1',
        role: 'user',
        parts: [{ type: 'text', text: '/skill player-info Derrick Henry' }],
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Player profile.' },
          {
            type: 'text',
            text: '\n\nTry next: Show more about him. · Look deeper into his stats.',
          },
        ],
      },
      {
        id: 'message-2',
        role: 'user',
        parts: [{ type: 'text', text: followUp }],
      },
    ]);
    const followUpPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt);

    expect(session.player).toBe('Derrick Henry');
    expect(session.mode).toBe('analyze');
    expect(session.skillId).toBe('player-info');
    expect(followUpPrompt).toContain('Derrick Henry');
    expect(followUpPrompt).toContain('Player profile.');
    expect(followUpPrompt).not.toContain('Try next:');
    expect(followUpPrompt).not.toContain('/skill player-info');
  });

  it('answers help and context commands without calling the model', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('The command must not call the model.');
      },
    });
    const session = createSessionState(new Date('2026-08-20T12:00:00Z'));
    const clients = dataClients();
    clients.sleeperClient = new SleeperClient({
      fetch: async (input) => {
        if (new URL(String(input)).pathname === '/v1/state/nfl') {
          return Response.json({
            season: '2026',
            season_type: 'pre',
            week: 2,
            leg: 2,
          });
        }
        return new Response('Not found', { status: 404 });
      },
      playerCacheFile: false,
    });
    const agent = createFantasyFootballAgent({
      languageModel: model,
      ...clients,
    });
    const transport = new SebInteractiveTransport({
      agent,
      environment: {},
      model: 'test-model',
      nflverse: clients.nflverseClient,
      session,
      sleeper: clients.sleeperClient,
      sources: new SourceTracker(),
      version: '0.0.1',
      weather: clients.weatherClient,
    });

    const help = await sendCommand(transport, '/help', 'message-1');
    const skill = await sendCommand(transport, '/skill weather-watch', 'message-2');
    const team = await sendCommand(transport, '/team SEA', 'message-3');
    const status = await sendCommand(transport, '/context', 'message-4');
    const commands = await sendCommand(transport, '/commands cache', 'message-5');
    const completion = await sendCommand(transport, '/complete /skill wea', 'message-6');
    const devtools = await sendCommand(transport, '/devtools', 'message-7');
    const currentWeek = await sendCommand(transport, '/week current', 'message-8');
    const currentStatus = await sendCommand(transport, '/status', 'message-9');
    const extraArguments = await sendCommand(transport, '/HELP extra', 'message-10');

    expect(help).toContain(INTERACTIVE_HELP);
    expect(skill).toContain('weather-watch');
    expect(team).toContain('SEA');
    expect(status).toContain('Experience: Explore');
    expect(status).toContain('Looking at: SEA');
    expect(status).toContain('Advanced workflow: Weather watch');
    expect(commands).toContain('/cache');
    expect(completion).toContain('/skill weather-watch');
    expect(devtools).toContain('disabled');
    expect(devtools).toContain('npm run devtools');
    expect(currentWeek).toContain('Week 2 kickoff weather');
    expect(currentStatus).toContain('NFL now: 2026 pre, Week 2');
    expect(extraArguments).toContain('Command error: Use /help.');
  });

  it('shows source links recorded during the session', async () => {
    const sources = new SourceTracker();
    sources.record({ id: 'test', label: 'Test source', url: 'https://example.test/data' });
    const clients = dataClients();
    const transport = new SebInteractiveTransport({
      agent: createFantasyFootballAgent({
        languageModel: new MockLanguageModelV4({}),
        ...clients,
      }),
      environment: {},
      model: 'test-model',
      nflverse: clients.nflverseClient,
      session: createSessionState(),
      sleeper: clients.sleeperClient,
      sources,
      version: '0.0.1',
      weather: clients.weatherClient,
    });

    const output = await sendCommand(transport, '/sources', 'message-1');
    const opened = await sendCommand(transport, '/source 1', 'message-2');

    expect(output).toContain('[Test source](https://example.test/data)');
    expect(output).toContain('LIVE');
    expect(opened).toContain('Source 1: [Test source](https://example.test/data)');
    const alias = await sendCommand(transport, '/open 1', 'message-3');
    expect(alias).toContain('Source 1: [Test source](https://example.test/data)');
  });

  it('adds contextual suggestions after a streamed model answer', async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'Model answer.' },
            { type: 'text-end', id: 'text-1' },
            {
              type: 'source',
              sourceType: 'url',
              id: 'news-1',
              url: 'https://example.com/nfl-report',
              title: 'NFL report',
            },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: {
                inputTokens: {
                  total: 10,
                  noCache: 10,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: {
                  total: 3,
                  text: 3,
                  reasoning: undefined,
                },
              },
            },
          ],
        }),
      },
    });
    const clients = dataClients();
    const sources = new SourceTracker();
    const transport = new SebInteractiveTransport({
      agent: createFantasyFootballAgent({ languageModel: model, ...clients }),
      environment: {},
      model: 'test-model',
      nflverse: clients.nflverseClient,
      session: createSessionState(),
      sleeper: clients.sleeperClient,
      sources,
      version: '0.0.1',
      weather: clients.weatherClient,
    });

    const output = await sendCommand(transport, 'Give me an answer.', 'message-1');

    expect(output).toContain('Model answer.');
    expect(output).toContain('## Web sources');
    expect(output).toContain('[NFL report](<https://example.com/nfl-report>)');
    expect(output).toContain('Try next:');
    expect(sources.list()[0]?.label).toBe('NFL report');
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it('connects one username and discovers fantasy context inside the UI', async () => {
    const sleeperFetch: typeof globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/state/nfl') {
        return Response.json({
          display_week: 2,
          league_season: '2026',
          leg: 2,
          season: '2026',
          season_type: 'regular',
          week: 2,
        });
      }
      if (path === '/v1/user/arvarik') {
        return Response.json({ user_id: 'user-1', username: 'arvarik' });
      }
      if (path === '/v1/user/user-1/leagues/nfl/2026') {
        return Response.json([{
          league_id: '200',
          name: 'Test League',
          season: '2026',
          season_type: 'regular',
          sport: 'nfl',
          status: 'in_season',
          total_rosters: 12,
          roster_positions: [],
          scoring_settings: {},
          settings: {},
        }]);
      }
      if (path === '/v1/user/user-1/leagues/nfl/2025') {
        return Response.json([{
          league_id: '150',
          name: 'Archived League',
          season: '2025',
          season_type: 'regular',
          sport: 'nfl',
          status: 'complete',
          total_rosters: 12,
          roster_positions: [],
          scoring_settings: {},
          settings: {},
        }]);
      }
      if (path === '/v1/league/200/rosters') {
        return Response.json([{
          roster_id: 4,
          league_id: '200',
          owner_id: 'user-1',
          players: [],
          settings: {},
        }]);
      }
      if (path === '/v1/league/150/rosters') {
        return Response.json([]);
      }
      return new Response('Not found', { status: 404 });
    };
    const clients = dataClients();
    clients.sleeperClient = new SleeperClient({
      fetch: sleeperFetch,
      playerCacheFile: false,
    });
    const session = createSessionState(new Date('2026-08-20T12:00:00Z'));
    const profileStore = new MemoryProfileStore();
    const transport = new SebInteractiveTransport({
      agent: createFantasyFootballAgent({
        languageModel: new MockLanguageModelV4({}),
        ...clients,
      }),
      environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'secret-value' },
      model: 'test-model',
      nflverse: clients.nflverseClient,
      profileStore,
      session,
      sleeper: clients.sleeperClient,
      sources: new SourceTracker(),
      version: '0.0.1',
      weather: clients.weatherClient,
    });

    const connected = await sendCommand(transport, '/connect arvarik', 'message-1');
    const account = await sendCommand(transport, '/account', 'message-2');
    const leagueCompletion = await sendCommand(transport, '/complete /league 2', 'message-3');
    await sendCommand(transport, '/league 200', 'message-4');
    const rosters = await sendCommand(transport, '/rosters', 'message-5');
    const rosterCompletion = await sendCommand(transport, '/complete /roster 4', 'message-6');
    await sendCommand(transport, '/roster 4', 'message-7');

    expect(connected).toContain('Test League');
    expect(connected).toContain('saved this username');
    expect(account).toContain('Sleeper: @arvarik');
    expect(leagueCompletion).toContain('/league 200');
    expect(rosters).toContain('Roster `4`');
    expect(rosterCompletion).toContain('/roster 4');
    expect(session).toMatchObject({
      user: 'arvarik',
      leagueId: '200',
      rosterId: 4,
      season: 2026,
      mode: 'fantasy',
    });
    expect(profileStore.profile).toMatchObject({
      schemaVersion: 3,
      sleeper: { username: 'arvarik' },
    });
    expect(JSON.stringify(profileStore.profile)).not.toContain('200');
    expect(JSON.stringify(profileStore.profile)).not.toContain('secret-value');

    const historical = await sendCommand(
      transport,
      '/leagues arvarik 2025',
      'message-8',
    );
    expect(historical).toContain('Archived League');
    expect(session.leagueSeason).toBe(2025);

    const disconnected = await sendCommand(transport, '/disconnect', 'message-9');
    expect(disconnected).toContain('disconnected the Sleeper account');
    expect(session).toMatchObject({
      accountStatus: 'disconnected',
      leagueId: null,
      leagues: [],
      mode: 'explore',
      rosterId: null,
      user: null,
    });
    expect(profileStore.profile?.sleeper).toBeNull();
  });
});

class MemoryProfileStore implements SetupProfileStore {
  readonly path = '/memory/profile.json';
  profile: SebSetupProfile | null = null;

  load(): Promise<SebSetupProfile | null> {
    return Promise.resolve(this.profile);
  }

  remove(): Promise<boolean> {
    const removed = this.profile !== null;
    this.profile = null;
    return Promise.resolve(removed);
  }

  save(profile: SebSetupProfile): Promise<void> {
    this.profile = profile;
    return Promise.resolve();
  }
}

function dataClients() {
  const unavailableFetch: typeof globalThis.fetch = async () => {
    throw new Error('The test did not expect a network request.');
  };
  return {
    nflverseClient: new NflverseClient({ cacheDirectory: false, fetch: unavailableFetch }),
    sleeperClient: new SleeperClient({ fetch: unavailableFetch, playerCacheFile: false }),
    weatherClient: new WeatherClient({ cacheDirectory: false, fetch: unavailableFetch }),
  };
}

async function sendCommand(
  transport: SebInteractiveTransport,
  text: string,
  id: string,
): Promise<string> {
  const message: UIMessage = { id, role: 'user', parts: [{ type: 'text', text }] };
  const stream = await transport.sendMessages({
    trigger: 'submit-message',
    chatId: 'test-chat',
    messageId: undefined,
    messages: [message],
    abortSignal: undefined,
  });
  let output = '';
  for await (const chunk of stream) {
    output += textDelta(chunk);
  }
  return output;
}

async function sendConversation(
  transport: SebInteractiveTransport,
  messages: UIMessage[],
): Promise<string> {
  const stream = await transport.sendMessages({
    trigger: 'submit-message',
    chatId: 'test-chat',
    messageId: undefined,
    messages,
    abortSignal: undefined,
  });
  let output = '';
  for await (const chunk of stream) {
    output += textDelta(chunk);
  }
  return output;
}

function textDelta(chunk: UIMessageChunk): string {
  return chunk.type === 'text-delta' ? chunk.delta : '';
}
