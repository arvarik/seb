import type { SourceEvidenceSnapshot } from '../sources.js';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isToolUIPart, validateUIMessages, type UIMessage } from 'ai';
import { z } from 'zod';
import { readBoundedUtf8File } from '../setup/bounded-file.js';
import { promptHistoryPath } from './history.js';
import type { SessionState } from './session.js';

const MAX_BYTES = 32 * 1024 * 1024;
const idSchema = z.string().regex(/^seb-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const contextSchema = z.object({
  user: z.string().nullable(), leagueId: z.string().nullable(), rosterId: z.number().int().nullable(),
  player: z.string().nullable(), team: z.string().nullable(), skillId: z.string(),
  mode: z.enum(['explore', 'analyze', 'fantasy']), contextAfterMessageId: z.string().nullable(),
});
const sourceSchema = z.object({ id: z.string(), label: z.string(), url: z.string(), accessedAt: z.string(),
  retrievedAt: z.string().optional(), cacheOutcome: z.enum(['cache-fresh', 'source-updated', 'source-not-modified', 'stale-if-error']).optional(),
  error: z.string().optional(), warnings: z.array(z.string()).optional() });
const snapshotSchema = z.object({ version: z.literal(1), id: idSchema, updatedAt: z.string().datetime(),
  messages: z.array(z.unknown()).max(10000), context: contextSchema,
  evidence: z.array(z.object({ answerId: z.string(), capturedAt: z.string(), sources: z.array(sourceSchema) })).max(50),
});
export type SavedSession = Omit<z.infer<typeof snapshotSchema>, 'messages' | 'evidence'> & { messages: UIMessage[]; evidence: SourceEvidenceSnapshot[] };
export function sessionContext(session: SessionState): SavedSession['context'] { return contextSchema.parse(session); }
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
    const messages = await validateUIMessages({ messages: parsed.messages });
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
      try { const saved = await this.load(id); entries.push({ id, updatedAt: saved.updatedAt, title: saved.messages.find(m => m.role === 'user')?.parts.filter(p => p.type === 'text').map(p => p.text).join(' ').replace(/\s+/gu, ' ').slice(0, 80) || 'Empty conversation' }); } catch { /* A damaged snapshot remains untouched. */ }
    }
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
