import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
  private writable = true;
  private writeFailure: string | null = null;

  private constructor(
    readonly path: string,
    entries: readonly string[],
  ) {
    super(entries);
  }

  static async load(environment: NodeJS.ProcessEnv): Promise<PromptHistory> {
    if (isDisabled(environment.SEB_HISTORY)) return new MemoryPromptHistory();
    const path = promptHistoryPath(environment);
    let entries: unknown = [];
    try {
      entries = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') entries = [];
    }
    return new FilePromptHistory(path, Array.isArray(entries) ? entries.filter(isString) : []);
  }

  override async add(prompt: string): Promise<void> {
    await super.add(prompt);
    if (!this.writable) return;
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

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.entries, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
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
