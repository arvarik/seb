import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

import { readBoundedUtf8File } from '../setup/bounded-file.js';
import { FileSetupCredentialStore } from '../setup/credentials.js';
import { resolveSetupProfilePath } from '../setup/profile.js';
import { containsLikelySecret } from './commands.js';
import {
  memoryScopeLabel,
  preferenceKey,
  sanitizeMemoryEntry,
  type SavedMemoryNote,
  type SessionState,
} from './session.js';

export const MAX_SAVED_NOTES = 30;
const MAX_NOTE_LENGTH = 200;
// ponytail: one file holds every owner; split it per owner if a connector serves many users.
const MAX_MEMORY_BYTES = 1024 * 1024;
const OWNER_PATTERN = /^(?:local|[a-z][a-z0-9-]{0,31}:[A-Za-z0-9_.@-]{1,128})$/u;

const noteSchema = z.object({
  createdAt: z.iso.datetime(),
  scope: z.string().regex(/^(?:global|\d{1,64})$/u),
  text: z.string().min(1).max(MAX_NOTE_LENGTH),
  updatedAt: z.iso.datetime(),
}).strict();
const memoryFileSchema = z.object({
  owners: z.record(z.string().regex(OWNER_PATTERN), z.array(noteSchema).max(MAX_SAVED_NOTES)),
  schemaVersion: z.literal(1),
}).strict();
type MemoryFile = z.infer<typeof memoryFileSchema>;

/** Saved notes that the user confirmed, kept per account in `memory.json` next to `profile.json`. */
export class UserMemoryStore {
  readonly path: string;
  private readonly lock: FileSetupCredentialStore;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.path = resolve(dirname(resolveSetupProfilePath(environment)), 'memory.json');
    // Share the configuration commit lock so a terminal and a connector cannot overwrite each other.
    this.lock = new FileSetupCredentialStore({ environment });
  }

  async list(owner: string): Promise<SavedMemoryNote[]> {
    return (await this.read()).owners[validOwner(owner)] ?? [];
  }

  async update<T>(owner: string, change: (notes: SavedMemoryNote[]) => T): Promise<T> {
    const key = validOwner(owner);
    return this.lock.withConfigurationCommitLock(async () => {
      const file = await this.read();
      const before = file.owners[key] ?? [];
      const notes = [...before];
      const result = change(notes);
      if (JSON.stringify(notes) === JSON.stringify(before)) return result;
      if (notes.length > 0) file.owners[key] = notes;
      else delete file.owners[key];
      await this.write(memoryFileSchema.parse(file));
      return result;
    });
  }

  private async read(): Promise<MemoryFile> {
    const content = await readBoundedUtf8File(this.path, MAX_MEMORY_BYTES,
      () => new Error(`The memory file exceeds 1 MiB. Move ${this.path} to reset saved notes.`));
    if (content === null) return { owners: {}, schemaVersion: 1 };
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new Error(`The memory file contains invalid JSON. Fix or move ${this.path}.`);
    }
    const parsed = memoryFileSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`The memory file has an invalid format. Fix or move ${this.path}.`);
    }
    return parsed.data;
  }

  private async write(file: MemoryFile): Promise<void> {
    const content = `${JSON.stringify(file, null, 2)}\n`;
    if (Buffer.byteLength(content) > MAX_MEMORY_BYTES) {
      throw new Error('The memory file would exceed 1 MiB. Run /forget to delete saved notes.');
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export function memoryOwner(state: Pick<SessionState, 'user'>): string {
  return state.user ? `sleeper:${state.user.trim().toLowerCase()}` : 'local';
}

export async function saveNotes(
  store: UserMemoryStore,
  owner: string,
  texts: readonly string[],
  scope: string,
  scopeLabel = memoryScopeLabel({ leagues: [] }, scope),
  now = new Date(),
): Promise<string> {
  const values = texts.map((text) => sanitizeMemoryEntry(text, Number.POSITIVE_INFINITY));
  if (values.length === 0 || values.some((text) => !text)) {
    throw new Error('Add the note text: /remember NOTE.');
  }
  if (values.some((text) => text.length > MAX_NOTE_LENGTH)) {
    throw new Error(`Keep each note under ${MAX_NOTE_LENGTH} characters.`);
  }
  if (values.some(containsLikelySecret)) {
    throw new Error('Seb does not save API keys or tokens in memory.');
  }
  const replaced = await store.update(owner, (notes) => {
    const removed = values.flatMap((text) => addNote(notes, text, scope, now.toISOString()));
    if (notes.length > MAX_SAVED_NOTES) {
      throw new Error(`Seb keeps at most ${MAX_SAVED_NOTES} saved notes. Run /forget NUMBER first.`);
    }
    return removed;
  });
  return [
    values.length === 1
      ? `Seb saved the note for future sessions (${scopeLabel}).`
      : `Seb saved ${values.length} notes for future sessions (${scopeLabel}).`,
    '',
    ...values.map((text) => `- ${text}`),
    ...(replaced.length > 0 ? ['', 'It replaced:', '', ...replaced.map((text) => `- ${text}`)] : []),
    '',
    'Run `/memory` to review saved notes.',
  ].join('\n');
}

export async function forgetNotes(
  store: UserMemoryStore,
  owner: string,
  selector: string | undefined,
): Promise<string> {
  const value = selector?.trim().toLowerCase();
  if (value === 'all') {
    const count = await store.update(owner, (notes) => notes.splice(0).length);
    return count === 0
      ? 'Seb has no saved notes to delete.'
      : `Seb deleted ${count} saved note${count === 1 ? '' : 's'}.`;
  }
  if (!value || !/^[1-9]\d{0,2}$/u.test(value)) {
    throw new Error('Use /forget NUMBER or /forget all. Run /memory to list saved notes.');
  }
  const removed = await store.update(owner, (notes) => notes.splice(Number(value) - 1, 1)[0]);
  if (!removed) {
    throw new Error(`Saved note #${value} does not exist. Run /memory to list saved notes.`);
  }
  return `Seb deleted saved note #${value}: ${removed.text}`;
}

export function formatSavedNotes(
  notes: readonly SavedMemoryNote[],
  scopeLabel: (scope: string) => string = (scope) => memoryScopeLabel({ leagues: [] }, scope),
): string {
  if (notes.length === 0) {
    return [
      '## Saved notes',
      '',
      'No saved notes. Run `/remember NOTE` to save one for future sessions.',
    ].join('\n');
  }
  return [
    '## Saved notes',
    '',
    'Seb uses these notes in future sessions.',
    '',
    ...notes.map((note, index) =>
      `${index + 1}. ${note.text} · ${scopeLabel(note.scope)} · saved ${note.updatedAt.slice(0, 10)}`),
    '',
    'Run `/forget NUMBER` or `/forget all` to delete saved notes.',
  ].join('\n');
}

// The same text confirms a note again. The same preference key in the same scope replaces it.
function addNote(
  notes: SavedMemoryNote[],
  text: string,
  scope: string,
  now: string,
): string[] {
  const key = preferenceKey(text);
  const replaced: string[] = [];
  let createdAt = now;
  for (let index = notes.length - 1; index >= 0; index -= 1) {
    const note = notes[index]!;
    if (note.scope !== scope) continue;
    if (note.text.toLowerCase() === text.toLowerCase()) {
      createdAt = note.createdAt;
    } else if (key !== null && preferenceKey(note.text) === key) {
      replaced.push(note.text);
    } else {
      continue;
    }
    notes.splice(index, 1);
  }
  notes.push({ createdAt, scope, text, updatedAt: now });
  return replaced;
}

function validOwner(owner: string): string {
  if (!OWNER_PATTERN.test(owner)) {
    throw new Error('Seb cannot keep saved notes for this account name.');
  }
  return owner;
}
