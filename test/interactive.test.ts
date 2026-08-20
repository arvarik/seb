import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import {
  simulateReadableStream,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';

import { createFantasyFootballAgent } from '../src/agent.js';
import { createSessionState } from '../src/interactive/session.js';
import { SEB_SKILLS } from '../src/interactive/skills.js';
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
        'waiver-scout',
        'weather-watch',
        'usage-trends',
        'game-environment',
        'playoff-planner',
      ]),
    );
  });
});

describe('SebInteractiveTransport', () => {
  it('answers help and context commands without calling the model', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('The command must not call the model.');
      },
    });
    const session = createSessionState(new Date('2026-08-20T12:00:00Z'));
    const clients = dataClients();
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
    const status = await sendCommand(transport, '/status', 'message-4');
    const commands = await sendCommand(transport, '/commands cache', 'message-5');
    const completion = await sendCommand(transport, '/complete /skill wea', 'message-6');

    expect(help).toContain(INTERACTIVE_HELP);
    expect(skill).toContain('weather-watch');
    expect(team).toContain('SEA');
    expect(status).toContain('Skill: `weather-watch`');
    expect(status).toContain('NFL team: SEA');
    expect(commands).toContain('/refresh [all|sleeper|nflverse|weather]');
    expect(completion).toContain('/skill weather-watch');
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

    expect(output).toContain('[Test source](https://example.test/data)');
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
    const transport = new SebInteractiveTransport({
      agent: createFantasyFootballAgent({ languageModel: model, ...clients }),
      environment: {},
      model: 'test-model',
      nflverse: clients.nflverseClient,
      session: createSessionState(),
      sleeper: clients.sleeperClient,
      sources: new SourceTracker(),
      version: '0.0.1',
      weather: clients.weatherClient,
    });

    const output = await sendCommand(transport, 'Give me an answer.', 'message-1');

    expect(output).toContain('Model answer.');
    expect(output).toContain('Try next:');
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it('discovers, saves, and activates a first-run setup profile', async () => {
    const sleeperFetch: typeof globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
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
      if (path === '/v1/league/200/rosters') {
        return Response.json([{
          roster_id: 4,
          league_id: '200',
          owner_id: 'user-1',
          players: [],
          settings: {},
        }]);
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

    const output = await sendCommand(transport, '/setup arvarik 200', 'message-1');

    expect(output).toContain('saved and activated');
    expect(session).toMatchObject({
      user: 'arvarik',
      leagueId: '200',
      rosterId: 4,
      season: 2026,
    });
    expect(JSON.stringify(profileStore.profile)).not.toContain('secret-value');
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

function textDelta(chunk: UIMessageChunk): string {
  return chunk.type === 'text-delta' ? chunk.delta : '';
}
