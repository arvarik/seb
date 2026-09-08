import { describe, expect, it, vi } from 'vitest';
import type { Thread } from 'chat';
import { eligibleForSlot, optimizeLineup } from '../src/analysis/lineup.js';
import { postConnectorResponse, splitConnectorMessage } from '../src/connectors/bot.js';
import { formatEvidenceMarkdown } from '../src/sources.js';
import { buildPlayerIdentityRegistry } from '../src/identity/players.js';
import { CircuitOpenError, ResilientFetch } from '../src/data/resilient-fetch.js';
import { CachedResource } from '../src/data/cached-resource.js';
import { parseCliArguments } from '../src/cli-options.js';

describe('audit regressions', () => {
  it.each(['DL', 'LB', 'DB'])('fills IDP with %s', (position) => {
    expect(eligibleForSlot([position], 'IDP')).toBe(true);
    expect(optimizeLineup([{ id: '1', name: 'Defender', positions: [position], points: 10 }], ['IDP']).complete).toBe(true);
    expect(eligibleForSlot(['QB'], 'IDP')).toBe(false);
  });

  it.each([
    ['chat', '--model', 'test-model'], ['ask', '--provider', 'openai'],
    ['replay', '--season', '2025'], ['evaluate', '--season', '2025'],
    ['cache', 'prune', '--retain', '5'], ['snapshots', '--limit', '4'],
    ['learn', 'status', '--season', '2025'], ['learn', 'update', '--season', '2025'],
  ])('normalizes value options in %s', (...args) => {
    const inline = [...args.slice(0, -2), `${args.at(-2)}=${args.at(-1)}`];
    expect(parseCliArguments(inline)).toEqual(parseCliArguments(args));
  });

  it.each(['chat', 'ask', 'replay', 'evaluate', 'cache', 'snapshots', 'learn'])('accepts -h for %s', (command) => {
    expect(parseCliArguments([command, '-h'])).toEqual({ name: 'help' });
  });

  it('accepts leading ask options and preserves literal prompt arguments', () => {
    expect(parseCliArguments(['--json', 'prompt'])).toMatchObject({ name: 'ask', json: true, prompt: 'prompt' });
    expect(parseCliArguments(['ask', '--', '--model=x=y'])).toMatchObject({ prompt: '--model=x=y' });
    expect(parseCliArguments(['evaluate', '--season=2025', '--output=a=b.json'])).toMatchObject({ output: 'a=b.json' });
    expect(() => parseCliArguments(['snapshots', '--limit='])).toThrow('needs a value');
    expect(() => parseCliArguments(['--json=false', 'prompt'])).toThrow();
  });

  it('keeps healthy origins accessible and isolates their success counters', async () => {
    let now = 0;
    const client = new ResilientFetch({ now: () => now, policy: { maxAttempts: 1, circuitBreakerThreshold: 2, circuitBreakerCooldownMs: 100 },
      fetch: async (url) => new Response('', { status: new URL(String(url)).hostname === 'bad.test' ? 503 : 200 }) });
    await client.request('https://bad.test/one');
    await client.request('https://good.test/one');
    expect(client.state('https://bad.test').consecutiveFailures).toBe(1);
    await client.request('https://bad.test/two');
    await expect(client.request('https://bad.test/three')).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(client.request('https://good.test/two')).resolves.toMatchObject({ status: 200 });
    now = 101;
    await expect(client.request('https://bad.test/recovery')).resolves.toMatchObject({ status: 503 });
    expect(client.state('https://bad.test').consecutiveFailures).toBe(1);
  });

  it('keeps an uncancellable waiter alive after another waiter times out', async () => {
    const resource = new CachedResource(false, 'test', 'shared', 'https://example.test',
      { schemaVersion: 'v1', staleIfErrorMs: 0, ttlMs: 1000 }, {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let shared!: AbortSignal;
    const load = vi.fn(async ({ signal }: { signal: AbortSignal }) => { shared = signal; await gate; return { value: 42 }; });
    const controller = new AbortController();
    const first = resource.read(load, { signal: controller.signal });
    const second = resource.read(load);
    controller.abort(new DOMException('Deadline', 'TimeoutError'));
    await expect(first).rejects.toThrow('Deadline');
    expect(shared.aborted).toBe(false);
    release();
    await expect(second).resolves.toMatchObject({ value: 42 });
    expect(shared.aborted).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('relocated identity', () => {
  const active = { sourceProvider: 'sleeper', sourceId: 'active', displayName: 'Saquon Barkley', position: 'RB', team: 'PHI', active: true };
  const historical = { sourceProvider: 'nflverse', sourceId: 'historic', displayName: 'Saquon Barkley', position: 'RB', team: 'NYG' };
  it('links one active player across team changes', () => {
    const { registry } = buildPlayerIdentityRegistry([active, historical]);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.sourceIdentities).toHaveLength(2);
    expect(registry.list()[0]?.teamId).toBe('nfl-team:PHI');
  });
  it.each([
    { ...active, sourceId: 'duplicate' },
    { ...historical, sourceId: 'other-history' },
  ])('does not merge ambiguous names', (duplicate) => {
    const { registry } = buildPlayerIdentityRegistry([active, historical, duplicate]);
    expect(registry.list()).toHaveLength(3);
  });
  it('requires explicit active status and matching position', () => {
    expect(buildPlayerIdentityRegistry([{ ...active, active: false }, historical]).registry.list()).toHaveLength(2);
    expect(buildPlayerIdentityRegistry([active, { ...historical, position: 'WR' }]).registry.list()).toHaveLength(2);
  });
});

describe('connector messages', () => {
  it.each([['discord', 2000], ['telegram', 4096]] as const)('posts every %s chunk below its limit', async (name, limit) => {
    const text = 'a'.repeat(limit - 1) + '🏈' + '\nReport and evidence. '.repeat(700);
    const post = vi.fn().mockResolvedValue({});
    const thread = { adapter: { name }, post } as unknown as Thread;
    await postConnectorResponse(thread, (async function* () { yield text.slice(0, 30); yield text.slice(30); })(), new AbortController().signal);
    const chunks = post.mock.calls.map(([value]) => value.raw as string);
    expect(chunks.join('')).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= limit && !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
    expect(splitConnectorMessage('x'.repeat(limit), limit)).toEqual(['x'.repeat(limit)]);
  });
  it('stops posting after cancellation', async () => {
    const controller = new AbortController();
    const post = vi.fn(async () => { controller.abort(); });
    await expect(postConnectorResponse({ adapter: { name: 'discord' }, post } as unknown as Thread,
      (async function* () { yield 'x'.repeat(6000); })(), controller.signal)).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('does not advertise terminal commands in connector evidence', () => {
    const source = { id: 'one', label: 'Example', url: 'https://example.test', accessedAt: new Date().toISOString() };
    expect(formatEvidenceMarkdown([source, { ...source, id: 'two' }], { limit: 1, surface: 'connector' })).not.toContain('/sources');
  });
});
