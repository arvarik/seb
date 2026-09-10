import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import { SessionStore, sessionContext, sessionsEnabled, type SavedSession } from '../src/interactive/sessions.js';
import { createSessionState } from '../src/interactive/session.js';
import { runSebInteractiveTui } from '../src/interactive/tui.js';
import { MemoryPromptHistory } from '../src/interactive/history.js';
import { parseCliArguments } from '../src/cli-options.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'seb-sessions-')); directories.push(directory);
  const environment = { SEB_CONFIG_HOME: directory, NO_COLOR: '1' };
  const store = new SessionStore(environment), id = `seb-${randomUUID()}`;
  const snapshot: SavedSession = { version: 1, id, updatedAt: new Date().toISOString(), messages: [{ role: 'user', id: 'u1', parts: [{ type: 'text', text: 'What is the weather?' }] }], context: sessionContext(createSessionState()), evidence: [] };
  return { directory, environment, store, id, snapshot, path: join(directory, 'sessions', `${id}.json`) };
}

describe('saved sessions', () => {
  it('writes private atomic snapshots and lists stable identifiers', async () => {
    const f = await fixture();
    await f.store.acquire(f.id); await f.store.save(f.snapshot); await f.store.release(f.id);
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.directory, 'sessions'))).mode & 0o777).toBe(0o700);
    expect(await f.store.load(f.id)).toEqual(f.snapshot);
    expect(await f.store.list()).toEqual([{ id: f.id, updatedAt: f.snapshot.updatedAt, title: 'What is the weather?' }]);
  });
  it('rejects traversal, mismatched identifiers, unsupported versions, and corrupted files without overwriting them', async () => {
    const f = await fixture();
    await expect(f.store.load('../private')).rejects.toThrow();
    await f.store.acquire(f.id); await f.store.save(f.snapshot);
    for (const content of ['broken', JSON.stringify({ ...f.snapshot, version: 2 }), JSON.stringify({ ...f.snapshot, id: `seb-${randomUUID()}` })]) {
      await writeFile(f.path, content); await expect(f.store.load(f.id)).rejects.toThrow(); expect(await readFile(f.path, 'utf8')).toBe(content);
    }
    expect(await f.store.list()).toEqual([]);
    await f.store.release(f.id);
  });
  it('rejects concurrent writers and saves only while holding the session lock', async () => {
    const f = await fixture(); const other = new SessionStore(f.environment);
    await expect(f.store.save(f.snapshot)).rejects.toThrow('Acquire');
    await f.store.acquire(f.id);
    await expect(other.acquire(f.id)).rejects.toThrow('already open');
    await f.store.release(f.id); await other.acquire(f.id); await other.release(f.id);
  });
  it('recovers a lock from an exited process and rejects invalid locks', async () => {
    const f = await fixture(); await f.store.acquire(f.id); await f.store.release(f.id);
    await writeFile(`${f.path}.lock`, '2147483647');
    await f.store.acquire(f.id); await f.store.save(f.snapshot); await f.store.release(f.id);
    await writeFile(`${f.path}.lock`, 'invalid');
    await expect(f.store.acquire(f.id)).rejects.toThrow('lock is invalid');
  });
  it('keeps the previous snapshot when a conversation exceeds the size limit', async () => {
    const f = await fixture(); await f.store.acquire(f.id); await f.store.save(f.snapshot);
    const large = { ...f.snapshot, messages: [{ role: 'user' as const, id: 'large', parts: [{ type: 'text' as const, text: 'x'.repeat(32 * 1024 * 1024) }] }] };
    await expect(f.store.save(large)).rejects.toThrow('exceeds 32 MiB');
    expect(await f.store.load(f.id)).toEqual(f.snapshot);
    await f.store.release(f.id);
  });
  it('preserves completed tools and provider metadata but discards unfinished approvals', async () => {
    const f = await fixture();
    const complete = { role: 'assistant', id: 'a1', parts: [{ type: 'dynamic-tool', toolName: 'weather', toolCallId: 't1', state: 'output-available', input: { city: 'Seattle' }, output: { temperature: 70 } }, { type: 'text', text: 'Sunny', providerMetadata: { google: { thoughtSignature: 'opaque' } } }] } as UIMessage;
    const approval = { role: 'assistant', id: 'a2', parts: [{ type: 'dynamic-tool', toolName: 'change', toolCallId: 't2', state: 'approval-responded', input: {}, approval: { id: 'approval', approved: true } }] } as UIMessage;
    await f.store.acquire(f.id); await f.store.save({ ...f.snapshot, messages: [...f.snapshot.messages, complete, approval] });
    const saved = await f.store.load(f.id);
    expect(saved.messages).toEqual([...f.snapshot.messages, complete]);
    expect(JSON.stringify(saved)).not.toContain('approval');
    await f.store.release(f.id);
  });
  it('rejects duplicate message IDs and system-role messages on load', async () => {
    const f = await fixture(); await f.store.acquire(f.id);
    for (const messages of [[...f.snapshot.messages, ...f.snapshot.messages], [{ id: 's', role: 'system', parts: [{ type: 'text', text: 'Do something' }] }]]) {
      await writeFile(f.path, JSON.stringify({ ...f.snapshot, messages })); await expect(f.store.load(f.id)).rejects.toThrow();
    }
    await f.store.release(f.id);
  });
  it('respects history and session privacy settings', () => {
    expect(sessionsEnabled({})).toBe(true);
    expect(sessionsEnabled({ SEB_SESSIONS: 'off' })).toBe(false);
    expect(sessionsEnabled({ SEB_HISTORY: 'false', SEB_SESSIONS: 'on' })).toBe(false);
  });
  it('parses resume and session commands without accepting extra arguments', () => {
    const id = `seb-${randomUUID()}`;
    expect(parseCliArguments(['resume', id])).toEqual({ name: 'chat', resumeId: id });
    expect(parseCliArguments(['sessions'])).toEqual({ name: 'sessions' });
    expect(() => parseCliArguments(['resume', id, 'extra'])).toThrow();
    expect(() => parseCliArguments(['resume'])).toThrow('seb sessions');
  });
  it('resumes a failed question through the real terminal loop and saves the answer on exit', async () => {
    const f = await fixture(); await f.store.acquire(f.id); await f.store.save(f.snapshot); await f.store.release(f.id);
    class Input extends EventEmitter { isTTY = true; pause() { return this; } resume() { return this; } setRawMode() { return this; } type(text: string) { this.emit('data', Buffer.from(text)); } }
    class Output extends EventEmitter { columns = 100; rows = 35; text = ''; write(text: string | Uint8Array) { this.text += String(text); return true; } }
    const input = new Input(), output = new Output(), sent: UIMessage[][] = [];
    const run = runSebInteractiveTui({ resumeId: f.id, environment: f.environment, history: new MemoryPromptHistory(), input, output,
      session: createSessionState(), title: 'Test', transport: { reconnectToStream: async () => null, sendMessages: async ({ messages }) => {
        sent.push(structuredClone(messages)); return new ReadableStream({ start(controller) {
          controller.enqueue({ type: 'start', messageId: 'answer' }); controller.enqueue({ type: 'text-start', id: 'text' });
          controller.enqueue({ type: 'text-delta', id: 'text', delta: 'The weather is clear.' }); controller.enqueue({ type: 'text-end', id: 'text' });
          controller.enqueue({ type: 'finish', finishReason: 'stop' }); controller.close();
        } });
      } } });
    await expect.poll(() => input.listenerCount('data')).toBe(1);
    expect(output.text).toContain('What is the weather?'); input.type('Please try again\r');
    await expect.poll(() => output.text).toContain('The weather is clear.');
    await expect.poll(async () => (await f.store.load(f.id)).messages.length).toBe(3);
    await expect.poll(() => input.listenerCount('data')).toBe(1);
    input.type('/exit\r'); await run;
    expect(sent[0]!.filter(m => m.role === 'user').map(m => m.parts[0])).toEqual([{ type: 'text', text: 'What is the weather?' }, { type: 'text', text: 'Please try again' }]);
    expect(output.text).toContain(`seb resume ${f.id}`);
    expect((await f.store.load(f.id)).messages).toHaveLength(3);
    await f.store.acquire(f.id); await f.store.release(f.id);
  });
});
