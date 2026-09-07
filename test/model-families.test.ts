import { describe, expect, it, vi } from 'vitest';
import { latestModelInFamily, resolveModelFamilies } from '../src/ai/model-families.js';
import { loadModelConfiguration } from '../src/ai/model-configuration.js';
import { createModelSettings } from '../src/ai/model-settings.js';
import { createSetupCredentials } from '../src/setup/credentials.js';
import { completeInteractiveInput } from '../src/interactive/commands.js';
import { createProviderLanguageModel } from '../src/ai/model-provider.js';
import type { ModelProviderId, ResolvedModelProvider } from '../src/ai/model-provider.js';

const google: ResolvedModelProvider = {
  apiKey: 'private-test-key', provider: 'google', model: 'gemini-flash', fallbackModel: 'gemini-flash',
};
const googleModel = (name: string) => ({ name: `models/${name}`, supportedGenerationMethods: ['generateContent'] });

describe('model families', () => {
  it.each([
    ['google', 'gemini-flash', ['gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3.10-flash',
      'gemini-4-flash-preview', 'gemini-9-flash-image', 'gemini-10-flash-lite'], 'gemini-3.10-flash'],
    ['google', 'gemini-pro', ['gemini-2.5-pro', 'gemini-3-pro-preview'], 'gemini-2.5-pro'],
    ['google', 'gemini-flash-lite', ['gemini-3.5-flash-lite', 'gemini-3.8-flash'], 'gemini-3.5-flash-lite'],
    ['anthropic', 'claude-sonnet', ['claude-3-5-sonnet-20241022', 'claude-sonnet-4-5-20250929',
      'claude-sonnet-5', 'claude-opus-6', 'claude-sonnet-6-preview'], 'claude-sonnet-5'],
    ['anthropic', 'claude-haiku', ['claude-3-haiku-20240307', 'claude-haiku-4-5',
      'claude-haiku-4-5-20251001'], 'claude-haiku-4-5-20251001'],
    ['openai', 'gpt-mini', ['gpt-5-mini', 'gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17',
      'gpt-6-mini-preview', 'gpt-6-nano', 'gpt-5.4-mini-fast'], 'gpt-5.4-mini-2026-03-17'],
    ['openai', 'gpt-luna', ['gpt-5.6-luna', 'gpt-5.7-luna', 'gpt-6-astra'], 'gpt-5.7-luna'],
    ['openai', 'gpt', ['gpt-5', 'gpt-5.5', 'gpt-6-astra', 'gpt-5.6-luna'], 'gpt-5.5'],
  ] as const)('selects the newest stable %s %s version', (provider, family, models, expected) => {
    expect(latestModelInFamily(provider, family, models)).toBe(expected);
    expect(latestModelInFamily(provider, family, [...models].reverse())).toBe(expected);
  });

  it('offers family completions only for the active provider', () => {
    expect(completeInteractiveInput('/model gemini-', { provider: 'google' }).map((item) => item.value))
      .toEqual(expect.arrayContaining(['/model gemini-flash', '/model gemini-flash-lite', '/model gemini-pro']));
    expect(completeInteractiveInput('/model gemini-', { provider: 'openai' })).toEqual([]);
  });

  it('rejects an unresolved family before creating an SDK model', () => {
    expect(() => createProviderLanguageModel(google)).toThrow('Resolve the model family');
  });

  it('resolves both families across every Google page and filters non-text models', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ models: [googleModel('gemini-3.7-flash')], nextPageToken: 'next&safe' }))
      .mockResolvedValueOnce(Response.json({ models: [googleModel('gemini-3.8-flash'),
        googleModel('gemini-3.5-flash-lite'),
        { name: 'models/gemini-9-flash', supportedGenerationMethods: ['embedContent'] }] }));
    const result = await resolveModelFamilies({ ...google, fallbackModel: 'gemini-flash-lite' }, { fetch });
    expect(result).toMatchObject({ model: 'gemini-3.8-flash', fallbackModel: 'gemini-3.5-flash-lite' });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[1]!;
    expect(String(url)).toContain('pageToken=next%26safe');
    expect(String(url)).not.toContain(google.apiKey);
    expect(init).toMatchObject({ headers: { 'x-goog-api-key': google.apiKey }, redirect: 'error' });
    expect(google.model).toBe('gemini-flash');
  });

  it('paginates Anthropic and uses its required authentication headers', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'claude-sonnet-4-5' }], has_more: true, last_id: 'cursor' }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'claude-sonnet-5' }], has_more: false }));
    const result = await resolveModelFamilies({ ...google, provider: 'anthropic',
      model: 'claude-sonnet', fallbackModel: 'claude-sonnet' }, { fetch });
    expect(result.model).toBe('claude-sonnet-5');
    expect(String(fetch.mock.calls[1]?.[0])).toContain('after_id=cursor');
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({
      'x-api-key': google.apiKey, 'anthropic-version': '2023-06-01',
    });
  });

  it('reads the OpenAI catalog from the fixed provider endpoint', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ data: [{ id: 'gpt-5.6-luna' }] }));
    const result = await resolveModelFamilies({ ...google, provider: 'openai',
      model: 'gpt-luna', fallbackModel: 'gpt-luna' }, { fetch });
    expect(result.model).toBe('gpt-5.6-luna');
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://api.openai.com/v1/models');
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: `Bearer ${google.apiKey}` });
  });

  it.each(['google', 'anthropic', 'openai', 'openai-compatible'] as ModelProviderId[])(
    'does not discover pinned IDs for %s', async (provider) => {
      const selection = { ...google, provider, model: 'exact-model-v1', fallbackModel: 'exact-fallback-v1' };
      const fetch = vi.fn<typeof globalThis.fetch>();
      expect(await resolveModelFamilies(selection, { fetch })).toBe(selection);
      expect(fetch).not.toHaveBeenCalled();
    });

  it('leaves compatible endpoint aliases to the endpoint', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(await resolveModelFamilies({ ...google, provider: 'openai-compatible' }, { fetch }))
      .toMatchObject({ model: 'gemini-flash' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not select another class or a preview when a family is unavailable', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ models: [
      googleModel('gemini-4-flash-preview'), googleModel('gemini-4-pro'),
    ] }));
    await expect(resolveModelFamilies(google, { fetch })).rejects.toThrow('No stable gemini-flash');
  });

  it.each([
    () => Response.json({ error: 'private-test-key' }, { status: 401 }),
    () => new Response('not json'),
    () => Response.json({ unexpected: [] }),
    () => new Response('x'.repeat(1024 * 1024 + 1)),
    () => new Response('{}', { headers: { 'content-length': String(1024 * 1024 + 1) } }),
  ])('rejects catalog failures without exposing credentials', async (response) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    await expect(resolveModelFamilies(google, { fetch })).rejects.toThrow('Retry, or enter an exact model ID');
    await expect(resolveModelFamilies(google, { fetch })).rejects.not.toThrow('private-test-key');
  });

  it('rejects repeated pagination cursors instead of selecting from a partial catalog', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
      Response.json({ models: [googleModel('gemini-3.8-flash')], nextPageToken: 'loop' }));
    await expect(resolveModelFamilies(google, { fetch })).rejects.toThrow('could not read');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('cancels a stalled catalog body', async () => {
    const abort = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const cancelled = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new ReadableStream({
      pull() { started(); }, cancel: cancelled,
    })));
    const resolved = resolveModelFamilies(google, { fetch, signal: abort.signal });
    await ready;
    abort.abort();
    await expect(resolved).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('refreshes a saved family on each load without replacing the family setting', async () => {
    const settings = createModelSettings('google', { google: { model: 'gemini-flash', fallbackModel: 'gemini-flash' } });
    const settingsStore = { path: '/test/settings', load: async () => settings, save: vi.fn(), remove: vi.fn() };
    const credentialStore = { path: '/test/credentials', load: async () => createSetupCredentials({ google: 'test-key' }),
      save: vi.fn(), remove: vi.fn() };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ models: [googleModel('gemini-3.7-flash')] }))
      .mockResolvedValueOnce(Response.json({ models: [googleModel('gemini-3.8-flash')] }));
    const options = { environment: {}, settingsStore, credentialStore, fetch };
    expect((await loadModelConfiguration(options)).selection.model).toBe('gemini-3.7-flash');
    expect((await loadModelConfiguration(options)).selection.model).toBe('gemini-3.8-flash');
    expect(settings.providers.google?.model).toBe('gemini-flash');
    expect((await loadModelConfiguration({ ...options, discoverModels: false })).selection.model).toBe('gemini-flash');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(settingsStore.save).not.toHaveBeenCalled();
  });
});
