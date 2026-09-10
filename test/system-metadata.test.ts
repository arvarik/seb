import { SEB_VERSION } from '../src/version.js';
import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';

import {
  formatSystemMetadata,
  getSystemMetadata,
  isSystemTopic,
  SYSTEM_TOPICS,
  type SystemMetadataResult,
} from '../src/system/metadata.js';
import { createSystemTools } from '../src/system/tools.js';
import { createFantasyFootballAgent } from '../src/agent.js';
import { SebInteractiveTransport } from '../src/interactive/transport.js';
import { createSessionState } from '../src/interactive/session.js';
import { InteractiveUiState } from '../src/interactive/ui-state.js';
import { SourceTracker } from '../src/sources.js';
import { SleeperClient } from '../src/sleeper/client.js';
import { NflverseClient } from '../src/nflverse/client.js';
import { WeatherClient } from '../src/weather/client.js';

describe('system metadata & self-awareness', () => {
  it('defines all required architecture and design topics', () => {
    expect(SYSTEM_TOPICS).toEqual(
      expect.arrayContaining([
        'overview',
        'architecture',
        'projections',
        'sources',
        'storage',
        'learning',
        'models',
        'connectors',
        'cli',
      ]),
    );
  });

  it('validates topics with isSystemTopic', () => {
    expect(isSystemTopic('architecture')).toBe(true);
    expect(isSystemTopic('projections')).toBe(true);
    expect(isSystemTopic('storage')).toBe(true);
    expect(isSystemTopic('invalid-topic')).toBe(false);
    expect(isSystemTopic(null)).toBe(false);
  });

  it('returns overview metadata when no topic is specified', () => {
    const meta = getSystemMetadata();
    expect(meta.name).toBe('Seb');
    expect(meta.mission).toContain('NFL');
    expect(meta.topic).toBe('overview');
    expect(meta.summary).toContain('deterministic projection math');
    expect(meta.availableTopics).toEqual(SYSTEM_TOPICS);
  });

  it('returns deep architectural detail for specific topics', () => {
    const arch = getSystemMetadata('architecture');
    expect(arch.topic).toBe('architecture');
    expect(arch.detail).not.toBeNull();
    expect(arch.detail?.title).toBe('Agent Loop & System Architecture');
    expect(arch.detail?.keyPrinciples).toEqual(
      expect.arrayContaining([
        expect.stringContaining('ToolLoopAgent'),
        expect.stringContaining('Decision gate'),
      ]),
    );
    expect(arch.detail?.subsystemsOrFiles).toEqual(
      expect.arrayContaining(['src/agent.ts']),
    );

    const proj = getSystemMetadata('projections');
    expect(proj.detail?.summary).toContain('Deterministic player projections');
    expect(proj.detail?.keyPrinciples).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Scoring-aware'),
        expect.stringContaining('Exponential recency decay'),
      ]),
    );

    const storage = getSystemMetadata('storage');
    expect(storage.detail?.summary).toContain('SQLite database');
    expect(storage.detail?.keyPrinciples).toEqual(
      expect.arrayContaining([
        expect.stringContaining('SQLite database schema 6'),
        expect.stringContaining('0700'),
      ]),
    );
  });

  it('falls back gracefully on unknown topics', () => {
    const fallback = getSystemMetadata('not-a-topic');
    expect(fallback.topic).toBe('overview');
    expect(fallback.detail).toBeNull();
  });

  it('formats markdown for the terminal correctly', () => {
    const formattedOverview = formatSystemMetadata();
    expect(formattedOverview).toContain('Seb v');
    expect(formattedOverview).toContain('/about architecture');
    expect(formattedOverview).toContain('/about projections');

    const formattedArch = formatSystemMetadata('architecture');
    expect(formattedArch).toContain('Agent Loop & System Architecture');
    expect(formattedArch).toContain('Key Principles');
    expect(formattedArch).toContain('Core Files & Subsystems');
    expect(formattedArch).toContain('docs/ARCHITECTURE.md');
  });

  it('provides inspectSystemDocs tool that executes successfully', async () => {
    const tools = createSystemTools();
    expect(tools.inspectSystemDocs).toBeDefined();

    const result = (await tools.inspectSystemDocs.execute?.(
      { topic: 'models' },
      { context: {}, messages: [], toolCallId: 'test-call' },
    )) as SystemMetadataResult;

    expect(result).toMatchObject({
      name: 'Seb',
      topic: 'models',
    });
    expect(result.detail?.title).toBe('Multi-Provider Model Support');
  });

  it('handles /about and /architecture slash commands in interactive transport', async () => {
    const session = createSessionState();
    const uiState = new InteractiveUiState();
    const sources = new SourceTracker();
    const sleeper = { getNflState: async () => ({ season: 2026, week: 1 }) } as unknown as SleeperClient;
    const nflverse = {} as unknown as NflverseClient;
    const weather = {} as unknown as WeatherClient;

    const transport = new SebInteractiveTransport({
      agent: createFantasyFootballAgent({
        languageModel: new MockLanguageModelV4({}),
        sleeperClient: sleeper,
        nflverseClient: nflverse,
        weatherClient: weather,
      }),
      environment: {},
      model: 'test-model',
      nflverse,
      provider: 'google',
      providerLabel: 'Google Gemini',
      session,
      sleeper,
      sources,
      uiState,
      version: '1.0.1',
      weather,
    });

    const sendCommand = async (command: string) => {
      const stream = await transport.sendMessages({
        abortSignal: undefined,
        chatId: 'test-chat',
        messageId: undefined,
        messages: [{
          id: 'test-msg',
          parts: [{ text: command, type: 'text' }],
          role: 'user',
        }],
        trigger: 'submit-message',
      });
      let output = '';
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') output += chunk.delta;
      }
      return output;
    };

    const aboutGeneral = await sendCommand('/about');
    expect(aboutGeneral).toContain(`Seb v${SEB_VERSION}: System Architecture & Capabilities`);
    expect(aboutGeneral).toContain('/about architecture');

    const aboutStorage = await sendCommand('/about storage');
    expect(aboutStorage).toContain('Storage, SQLite Cache & Privacy');
    expect(aboutStorage).toContain('docs/STORAGE.md');

    const archAlias = await sendCommand('/architecture');
    expect(archAlias).toContain(`Seb v${SEB_VERSION}: System Architecture & Capabilities`);

    const archTopic = await sendCommand('/arch projections');
    expect(archTopic).toContain('Deterministic Projection Engine');
  });
});
