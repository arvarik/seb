import { createGoogle } from '@ai-sdk/google';
import { describe, expect, it } from 'vitest';

import { createGeminiLanguageModel } from '../src/gemini-model.js';
import { createFantasyFootballAgent, MAX_AGENT_STEPS } from '../src/agent.js';
import { SleeperClient } from '../src/sleeper/client.js';
import { NflverseClient } from '../src/nflverse/client.js';
import { WeatherClient } from '../src/weather/client.js';

describe('Gemini model selection', () => {
  it('uses the standard generateContent provider', () => {
    const provider = createGoogle({ apiKey: 'test-key' });
    const model = createGeminiLanguageModel(provider, 'gemini-test');

    expect(model.provider).toBe('google.generative-ai');
    expect(model.provider).not.toBe('google.generative-ai.interactions');
  });

  it.each([false, true])('finishes long Gemini tool loops with signatures intact (stream=%s)', async (stream) => {
    const requests: Array<{
      contents: Array<{ parts: Array<{ thoughtSignature?: string; functionCall?: unknown }> }>;
      tools?: Array<{ functionDeclarations?: unknown[]; googleSearch?: unknown; urlContext?: unknown }>;
      toolConfig?: { functionCallingConfig?: { mode?: string } };
    }> = [];
    const google = createGoogle({ apiKey: 'test-key', fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as typeof requests[number];
      requests.push(body);
      const conclude = body.toolConfig?.functionCallingConfig?.mode === 'NONE';
      const response = {
        candidates: [{ content: { role: 'model', parts: conclude
          ? [{ text: 'The final answer uses all the research.' }]
          : [{ functionCall: { name: 'getNflState', args: {} }, thoughtSignature: `signature-${requests.length}` }] },
        finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
      };
      return stream ? new Response(`data: ${JSON.stringify(response)}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      }) : Response.json(response);
    } });
    const fetch: typeof globalThis.fetch = async () => Response.json({
      season: '2026', season_type: 'regular', week: 2, leg: 2, league_season: '2026',
    });
    const agent = createFantasyFootballAgent({
      apiKey: 'test-key', enableWebTools: true,
      languageModel: createGeminiLanguageModel(google, 'gemini-3.8-flash'),
      identityRepository: false,
      sleeperClient: new SleeperClient({ fetch, database: false }),
      nflverseClient: new NflverseClient({ fetch, database: false }),
      weatherClient: new WeatherClient({ fetch, database: false }),
    });
    const result = stream ? await agent.stream({ prompt: 'Research the NFL week.' })
      : await agent.generate({ prompt: 'Research the NFL week.' });
    if (stream && 'fullStream' in result) for await (const _part of result.fullStream) { /* Consume the stream. */ }
    expect(await result.text).toBe('The final answer uses all the research.');
    expect(await result.finishReason).toBe('stop');
    expect(requests).toHaveLength(MAX_AGENT_STEPS);
    const final = requests.at(-1)!;
    expect(final.toolConfig?.functionCallingConfig?.mode).toBe('NONE');
    expect(final.tools?.some((entry) => entry.functionDeclarations?.length)).toBe(true);
    expect(final.tools?.some((entry) => entry.googleSearch || entry.urlContext)).toBe(false);
    const signatures = final.contents.flatMap((message) => message.parts)
      .flatMap((part) => part.thoughtSignature ? [part.thoughtSignature] : []);
    expect(signatures).toEqual(Array.from({ length: MAX_AGENT_STEPS - 1 }, (_, index) => `signature-${index + 1}`));
  });
});
