import { describe, expect, it } from 'vitest';

import { MockLanguageModelV4 } from 'ai/test';

import { createFantasyFootballAgent } from '../src/agent.js';
import { SleeperClient } from '../src/sleeper/client.js';

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 10,
    text: 10,
    reasoning: undefined,
  },
};

describe('fantasy football agent harness', () => {
  it('executes a Sleeper tool and returns the model answer', async () => {
    let sleeperCalls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      sleeperCalls += 1;
      return new Response(
        JSON.stringify({
          season: '2026',
          season_type: 'pre',
          week: 2,
          leg: 2,
          league_season: '2026',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'getNflState',
              input: '{}',
            },
          ],
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage,
          warnings: [],
        },
        {
          content: [
            {
              type: 'text',
              text: 'Sleeper reports the 2026 preseason, Week 2.',
            },
          ],
          finishReason: { unified: 'stop', raw: undefined },
          usage,
          warnings: [],
        },
      ],
    });
    const agent = createFantasyFootballAgent({
      languageModel: model,
      sleeperClient: new SleeperClient({ fetch, playerCacheFile: false }),
    });

    const result = await agent.generate({
      prompt: 'What is the current NFL state?',
    });

    expect(result.text).toBe('Sleeper reports the 2026 preseason, Week 2.');
    expect(sleeperCalls).toBe(1);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(
      model.doGenerateCalls[0]?.tools?.some(
        (candidate) =>
          candidate.type === 'function' && candidate.name === 'getNflState',
      ),
    ).toBe(true);
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain(
      'league_season',
    );
  });
});
