import { readBoundedUtf8File } from '../setup/bounded-file.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { SleeperSettings } from '../sleeper/types.js';
import { scoringKey } from './engine.js';
import { learningRevisionSchema, projectionOverrideSchema, type LearningRevision } from './types.js';

const MAX_REVISION_BYTES = 8 * 1024 * 1024;
export class LearningStore {
  readonly directory: string;
  constructor(directory = resolve('.cache/learning')) { this.directory = resolve(directory); }

  async overrides() {
    const value = await readBounded(join(this.directory, 'overrides.json'), 16_384);
    return value === null ? { schemaVersion: 1 as const } : projectionOverrideSchema.parse(JSON.parse(value));
  }

  async context(season: number, throughWeek: number, scoring: SleeperSettings) {
    const overrides = await this.overrides();
    const revision = overrides.enabled === false ? null : await this.latest(season, throughWeek + 1, scoring);
    return { revision, parameters: overrides.enabled === false ? undefined : overrides.parameters ?? revision?.parameters,
      manual: Boolean(overrides.parameters) && overrides.enabled !== false, enabled: overrides.enabled !== false };
  }

  async latest(season: number, beforeWeek: number, scoring: SleeperSettings): Promise<LearningRevision | null> {
    if (!Number.isInteger(season) || season < 1999 || season > 2100 ||
      !Number.isInteger(beforeWeek) || beforeWeek < 1 || beforeWeek > 19) {
      throw new Error('The learning boundary requires a valid season and week.');
    }
    const directory = join(this.directory, `${season}-${scoringKey(scoring)}`);
    let names: string[];
    try { names = await readdir(directory); } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    const candidates = names.filter((name) => /^\d{2}-[a-f0-9]{64}\.json$/.test(name) &&
      Number(name.slice(0, 2)) < beforeWeek).sort().reverse();
    let best: LearningRevision | null = null;
    for (const name of candidates) {
      if (best && Number(name.slice(0, 2)) < best.throughWeek) break;
      const raw = await readBounded(join(directory, name), MAX_REVISION_BYTES);
      if (raw === null) continue;
      const checksum = createHash('sha256').update(raw).digest('hex');
      if (!name.endsWith(`${checksum}.json`)) throw new Error('The learning revision checksum is invalid.');
      const revision = learningRevisionSchema.parse(JSON.parse(raw));
      if (revision.season !== season || revision.throughWeek >= beforeWeek ||
        Number(name.slice(0, 2)) !== revision.throughWeek || scoringKey(revision.scoring) !== scoringKey(scoring)) {
        throw new Error('The learning revision does not match its season, scoring rules, or week.');
      }
      if (!best || revision.throughWeek > best.throughWeek || revision.createdAt > best.createdAt) best = revision;
    }
    return best;
  }

  async save(revision: LearningRevision): Promise<string> {
    const validated = learningRevisionSchema.parse(revision);
    const raw = `${JSON.stringify(validated, null, 2)}\n`;
    if (Buffer.byteLength(raw) > MAX_REVISION_BYTES) throw new Error('The learning revision exceeds its size limit.');
    const directory = join(this.directory, `${validated.season}-${scoringKey(validated.scoring)}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const checksum = createHash('sha256').update(raw).digest('hex');
    const target = join(directory, `${String(validated.throughWeek).padStart(2, '0')}-${checksum}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, raw, { flag: 'wx', mode: 0o600 });
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
    // Keep four corrections for each completed week. Other weeks remain available for replay.
    const names = (await readdir(directory)).filter((name) => name.startsWith(`${String(validated.throughWeek).padStart(2, '0')}-`) && /^\d{2}-[a-f0-9]{64}\.json$/.test(name));
    const corrections = await Promise.all(names.map(async (name) => ({ name, time: (await stat(join(directory, name))).mtimeMs })));
    corrections.sort((a, b) => Number(b.name === basename(target)) - Number(a.name === basename(target)) || b.time - a.time);
    for (const correction of corrections.slice(4)) await rm(join(directory, correction.name), { force: true });
    return target;
  }

  async exclusive<T>(task: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, '.update-lock');
    try { await mkdir(lock); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('A learning update already holds the local lock. Retry after it completes.');
      }
      throw error;
    }
    try { return await task(); } finally { await rm(lock, { recursive: true, force: true }); }
  }
}

async function readBounded(file: string, maximum: number): Promise<string | null> {
  return readBoundedUtf8File(file, maximum, () => new Error('The learning file exceeds its size limit.'));
}

function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
