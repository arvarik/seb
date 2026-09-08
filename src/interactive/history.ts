import { randomUUID } from 'node:crypto';
import { readBoundedUtf8File } from '../setup/bounded-file.js';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const MAX_ENTRIES = 200;
const MAX_ENTRY_LENGTH = 16 * 1024;

export interface PromptHistory {
  add(prompt: string): Promise<void>;
  clear(): Promise<void>;
  list(): readonly string[];
}

export class MemoryPromptHistory implements PromptHistory {
  protected entries: string[];

  constructor(entries: readonly string[] = []) {
    this.entries = normalizeEntries(entries);
  }

  add(prompt: string): Promise<void> {
    const value = normalizeEntry(prompt);
    if (!value) return Promise.resolve();
    this.entries = [value, ...this.entries.filter((entry) => entry !== value)].slice(0, MAX_ENTRIES);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.entries = [];
    return Promise.resolve();
  }

  list(): readonly string[] {
    return [...this.entries];
  }
}

export class FilePromptHistory extends MemoryPromptHistory {
  private saves: Promise<void> = Promise.resolve();
  private pendingFailure: string | null;
  private writable: boolean;
  private writeFailure: string | null;

  private constructor(
    readonly path: string,
    entries: readonly string[],
    initialFailure: string | null = null,
  ) {
    super(entries);
    this.pendingFailure = initialFailure;
    this.writable = initialFailure === null;
    this.writeFailure = initialFailure;
  }

  static async load(environment: NodeJS.ProcessEnv): Promise<PromptHistory> {
    if (isDisabled(environment.SEB_HISTORY)) return new MemoryPromptHistory();
    const path = promptHistoryPath(environment);
    let content: string;
    try {
      const loaded = await readBoundedUtf8File(path, MAX_ENTRIES * MAX_ENTRY_LENGTH * 6 + 1024,
        () => new Error('The history file exceeds its size limit.'));
      if (loaded === null) return new FilePromptHistory(path, []);
      content = loaded;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new FilePromptHistory(path, []);
      }
      return new FilePromptHistory(
        path,
        [],
        `Seb could not read the history file: ${errorMessage(error)}`,
      );
    }
    let entries: unknown;
    try {
      entries = JSON.parse(content);
    } catch (error) {
      return new FilePromptHistory(
        path,
        [],
        `The history file contains invalid JSON: ${errorMessage(error)}`,
      );
    }
    if (!Array.isArray(entries)) {
      return new FilePromptHistory(
        path,
        [],
        'The history file must contain a JSON array.',
      );
    }
    return new FilePromptHistory(path, entries.filter(isString));
  }

  override async add(prompt: string): Promise<void> {
    await super.add(prompt);
    if (!this.writable) {
      if (this.pendingFailure) {
        const failure = this.pendingFailure;
        this.pendingFailure = null;
        throw new Error(
          `Seb kept the prompt in memory and preserved ${this.path}: ${failure}`,
        );
      }
      return;
    }
    try {
      await this.save();
    } catch (error) {
      this.writable = false;
      this.writeFailure = errorMessage(error);
      throw new Error(`Seb kept the prompt in memory because it could not write ${this.path}: ${this.writeFailure}`);
    }
  }

  override async clear(): Promise<void> {
    await super.clear();
    if (!this.writable) {
      throw new Error(`Seb cleared memory history, but the history file remains unavailable: ${this.writeFailure ?? this.path}`);
    }
    try {
      await this.save();
    } catch (error) {
      this.writable = false;
      this.writeFailure = errorMessage(error);
      throw new Error(`Seb cleared memory history but could not write ${this.path}: ${this.writeFailure}`);
    }
  }

  private save(): Promise<void> {
    const content = `${JSON.stringify(this.entries, null, 2)}\n`;
    const pending = this.saves.then(() => this.writeSnapshot(content));
    this.saves = pending.catch(() => undefined);
    return pending;
  }

  private async writeSnapshot(content: string): Promise<void> {
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

export function promptHistoryPath(environment: NodeJS.ProcessEnv): string {
  const explicit = environment.SEB_HISTORY_FILE?.trim();
  if (explicit) return resolve(explicit);
  const sebHome = environment.SEB_CONFIG_HOME?.trim();
  if (sebHome) return resolve(sebHome, 'history.json');
  const xdgHome = environment.XDG_CONFIG_HOME?.trim();
  return join(xdgHome ? resolve(xdgHome) : join(homedir(), '.config'), 'seb', 'history.json');
}

function normalizeEntries(entries: readonly string[]): string[] {
  const normalized = entries.map(normalizeEntry).filter((entry): entry is string => entry !== null);
  return [...new Set(normalized)].slice(0, MAX_ENTRIES);
}

function normalizeEntry(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_ENTRY_LENGTH) return null;
  return normalized;
}

function isDisabled(value: string | undefined): boolean {
  return ['0', 'false', 'off', 'no'].includes(value?.trim().toLowerCase() ?? '');
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
