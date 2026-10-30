import type { SourceEvidenceSnapshot } from '../sources.js';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isToolUIPart, validateUIMessages, type UIMessage } from 'ai';
import { z } from 'zod';
import { readBoundedUtf8File } from '../setup/bounded-file.js';
import { isLocalOnlyInteractiveCommandInput } from './commands.js';
import { promptHistoryPath } from './history.js';
import { hasSessionWorkingMemory, type SessionState } from './session.js';

const MAX_BYTES = 32 * 1024 * 1024;
const idSchema = z.string().regex(/^seb-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const memorySchema = z.object({
  decisions: z.array(z.string().max(240)).max(12),
  notedPreferences: z.array(z.string().max(200)).max(8),
  trackedPlayers: z.array(z.string().max(100)).max(16),
  updatedAt: z.string(),
});
const contextSchema = z.object({
  user: z.string().nullable(), leagueId: z.string().nullable(), rosterId: z.number().int().nullable(),
  player: z.string().nullable(), team: z.string().nullable(), skillId: z.string(),
  mode: z.enum(['explore', 'analyze', 'fantasy']), contextAfterMessageId: z.string().nullable(),
  memory: memorySchema.optional(),
});
const sourceSchema = z.object({ id: z.string(), label: z.string(), url: z.string(), accessedAt: z.string(),
  retrievedAt: z.string().optional(), cacheOutcome: z.enum(['cache-fresh', 'source-updated', 'source-not-modified', 'stale-if-error']).optional(),
  error: z.string().optional(), warnings: z.array(z.string()).optional() });
const snapshotSchema = z.object({ version: z.literal(1), id: idSchema, updatedAt: z.string().datetime(),
  messages: z.array(z.unknown()).max(10000), context: contextSchema,
  localOnlyMessageIds: z.array(z.string().min(1).max(200)).max(256).optional(),
  evidence: z.array(z.object({ answerId: z.string(), capturedAt: z.string(), sources: z.array(sourceSchema) })).max(50),
});
export type SavedSession = Omit<z.infer<typeof snapshotSchema>, 'messages' | 'evidence'> & { messages: UIMessage[]; evidence: SourceEvidenceSnapshot[] };
export function sessionContext(session: SessionState): SavedSession['context'] {
  const parsed = contextSchema.parse(session);
  if (parsed.memory && !hasSessionWorkingMemory(parsed.memory)) {
    const { memory: _memory, ...rest } = parsed;
    return rest;
  }
  return parsed;
}
export function sessionsEnabled(environment: NodeJS.ProcessEnv): boolean {
  return ![environment.SEB_SESSIONS, environment.SEB_HISTORY].some(v => ['0', 'off', 'false', 'no'].includes(v?.trim().toLowerCase() ?? ''));
}
export class SessionStore {
  readonly directory: string;
  private held = new Set<string>();
  constructor(environment: NodeJS.ProcessEnv) { this.directory = join(dirname(promptHistoryPath(environment)), 'sessions'); }
  private path(id: string) { return join(this.directory, `${idSchema.parse(id)}.json`); }
  async load(id: string): Promise<SavedSession> {
    const content = await readBoundedUtf8File(this.path(id), MAX_BYTES, () => new Error('The saved session exceeds 32 MiB.'));
    if (content === null) throw new Error(`Session ${id} does not exist. Use seb sessions to list saved sessions.`);
    const parsed = snapshotSchema.parse(JSON.parse(content));
    if (parsed.id !== id) throw new Error('The saved session identifier does not match its file.');
    const messages = await validateUIMessages({ messages: stripDeprecatedErrorRawInput(parsed.messages) });
    if (new Set(messages.map(m => m.id)).size !== messages.length || messages.some(m => m.role === 'system')) throw new Error('The saved conversation has invalid message identities or roles.');
    // An interrupted approval never becomes authorization when the session resumes.
    return { ...parsed, evidence: parsed.evidence as SourceEvidenceSnapshot[], messages: completedMessages(messages) };
  }
  async list(): Promise<{ id: string; updatedAt: string; title: string }[]> {
    let files: string[];
    try { files = await readdir(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const entries: { id: string; updatedAt: string; title: string }[] = [];
    for (const file of files) {
      const id = file.replace(/\.json$/u, '');
      if (!file.endsWith('.json') || !idSchema.safeParse(id).success) continue;
      try {
        const saved = await this.load(id);
        const localIds = new Set(saved.localOnlyMessageIds ?? []);
        const userMessages = saved.messages.filter(m => m.role === 'user');
        const chosen = userMessages.find(m => !localIds.has(m.id) && !isLocalOnlyInteractiveCommandInput(userMessageText(m))) ?? userMessages[0];
        entries.push({ id, updatedAt: saved.updatedAt, title: (chosen ? userMessageText(chosen) : '').replace(/\s+/gu, ' ').slice(0, 80) || 'Empty conversation' });
      } catch { /* A damaged snapshot remains untouched. */ }
    }
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async resolve(selector?: string): Promise<string> {
    const query = selector?.trim() ?? '';
    if (!query || query.toLowerCase() === 'latest' || query.toLowerCase() === 'last') {
      const entries = await this.list();
      if (entries.length === 0) {
        throw new Error('No saved sessions found. Start a conversation with seb first.');
      }
      const preferred = entries.find(
        (entry) =>
          entry.title !== 'Empty conversation' && !isLocalOnlyInteractiveCommandInput(entry.title),
      );
      return (preferred ?? entries[0]!).id;
    }
    if (idSchema.safeParse(query).success) {
      await this.load(query);
      return query;
    }
    if (/^[1-9]\d*$/u.test(query)) {
      const entries = await this.list();
      if (entries.length === 0) {
        throw new Error('No saved sessions found. Start a conversation with seb first.');
      }
      const chosen = entries[Number(query) - 1];
      if (!chosen) {
        throw new Error(
          `Saved session #${query} does not exist (${entries.length} available). Use seb sessions to list saved sessions.`,
        );
      }
      return chosen.id;
    }
    const entries = await this.list();
    if (entries.length === 0) {
      throw new Error('No saved sessions found. Start a conversation with seb first.');
    }
    const needle = query.toLowerCase();
    const prefixMatches = entries.filter(
      (entry) =>
        entry.id.toLowerCase().startsWith(needle) ||
        entry.id.slice(4).toLowerCase().startsWith(needle),
    );
    if (prefixMatches.length === 1) return prefixMatches[0]!.id;
    if (prefixMatches.length > 1) {
      throw new Error(
        `Session prefix "${query}" matches ${prefixMatches.length} saved sessions. Use a longer prefix or run seb sessions.`,
      );
    }
    const titleMatches = entries.filter((entry) => entry.title.toLowerCase().includes(needle));
    if (titleMatches.length > 0) return titleMatches[0]!.id;
    for (const entry of entries) {
      try {
        const saved = await this.load(entry.id);
        const localIds = new Set(saved.localOnlyMessageIds ?? []);
        const matchedTranscript = saved.messages.some((message) => {
          if (message.role !== 'user' || localIds.has(message.id)) return false;
          const text = userMessageText(message);
          return !isLocalOnlyInteractiveCommandInput(text) && text.toLowerCase().includes(needle);
        });
        const matchedContext =
          Boolean(saved.context.player?.toLowerCase().includes(needle)) ||
          Boolean(saved.context.leagueId?.toLowerCase().includes(needle)) ||
          Boolean(saved.context.memory?.trackedPlayers.some((p) => p.toLowerCase().includes(needle)));
        if (matchedTranscript || matchedContext) return entry.id;
      } catch {
        // Ignore unreadable sessions during search.
      }
    }
    throw new Error(
      `No saved session matched "${query}". Use seb sessions to list saved sessions.`,
    );
  }
  async acquire(id: string): Promise<void> {
    const lock = `${this.path(id)}.lock`;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    try { await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const recovery = `${lock}.recovery`;
      try { await writeFile(recovery, '', { flag: 'wx', mode: 0o600 }); }
      catch { throw new Error('Another terminal is checking this session lock. Retry in a moment.'); }
      try {
        // Re-read under the recovery guard so competing restarts cannot remove a new writer's lock.
        const pid = Number(await readBoundedUtf8File(lock, 32, () => new Error('The session lock is invalid.')));
        if (!Number.isInteger(pid) || pid < 1) throw new Error('The session lock is invalid.');
        try { process.kill(pid, 0); }
        catch (check) {
          if ((check as NodeJS.ErrnoException).code === 'ESRCH') {
            await rm(lock);
            await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
            this.held.add(id);
            return;
          }
          throw check;
        }
      } finally { await rm(recovery, { force: true }); }
      throw new Error('This session is already open in another terminal.');
    }
    this.held.add(id);
  }
  async save(snapshot: SavedSession): Promise<void> {
    if (!this.held.has(snapshot.id)) throw new Error('Acquire the session before saving it.');
    const parsed = snapshotSchema.parse({ ...snapshot, messages: completedMessages(snapshot.messages) });
    const text = JSON.stringify(parsed);
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('The session exceeds 32 MiB. The previous saved conversation remains available.');
    const target = this.path(snapshot.id), temporary = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, text, { flag: 'wx', mode: 0o600 }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
  }
  async release(id: string): Promise<void> {
    if (!this.held.delete(id)) return;
    await rm(`${this.path(id)}.lock`, { force: true });
  }
}
function completedMessages(messages: readonly UIMessage[]): UIMessage[] {
  return messages.filter(m => m.role !== 'assistant' || !m.parts.some(p => isToolUIPart(p) && !['output-available', 'output-error', 'output-denied'].includes(p.state)));
}
function userMessageText(message: UIMessage): string {
  return message.parts.filter(p => p.type === 'text').map(p => p.text).join(' ');
}
function stripDeprecatedErrorRawInput(messages: readonly unknown[]): unknown[] {
  return messages.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
    const record = message as Record<string, unknown>;
    if (!Array.isArray(record.parts)) return message;
    return {
      ...record,
      parts: record.parts.map((part) => {
        if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
        const partRecord = part as Record<string, unknown>;
        if (partRecord.state !== 'output-error' || !('rawInput' in partRecord)) return part;
        const { rawInput: _unused, ...rest } = partRecord;
        return rest;
      }),
    };
  });
}
