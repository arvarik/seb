import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NflverseClient } from '../src/nflverse/client.js';
import { learnFromCompletedRows, PPR_SCORING, scoringKey } from '../src/learning/engine.js';
import { LearningStore } from '../src/learning/store.js';
import { LearningService } from '../src/learning/service.js';
import { evaluateProjectionModels } from '../src/evaluation/projection-benchmark.js';
import { game, stat, trainingRows } from './analysis-fixtures.js';
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function store() { const directory = await mkdtemp(join(tmpdir(), 'seb-learning-test-')); directories.push(directory); return new LearningStore(directory); }
const learn = (rows = trainingRows()) => learnFromCompletedRows({ rows, season: 2025, throughWeek: 12 });

describe('local weekly learning', () => {
  it('selects parameters on early weeks and validates on separate final weeks', () => {
    const revision = learn();
    expect(revision.validationWeeks).toEqual([10, 11, 12]);
    expect(revision.baseline.samples).toBe(120);
    expect(revision.promoted).toBe(true);
    expect(revision.candidateMetrics.mae!).toBeLessThan(revision.baseline.mae! * 0.99);
    expect(revision.candidateMetrics.rmse!).toBeLessThanOrEqual(revision.baseline.rmse!);
    expect(Object.keys(revision.players)).toHaveLength(40);
    expect(revision.teams.BUF?.samples).toBe(60);
  });
  it('retains defaults for small samples', () => {
    expect(learn(trainingRows(4, 2)).promoted).toBe(false);
  });
  it('does not learn from later weeks or other seasons', () => {
    const rows = trainingRows();
    const a = learn(rows);
    const b = learn([...rows, stat({ week: 13, rushingYards: 5000 }), stat({ season: 2026, rushingYards: 5000 })]);
    expect(b.dataChecksum).toBe(a.dataChecksum);
    expect(b.parameters).toEqual(a.parameters);
  });
  it('rejects duplicate records and unsupported scoring', () => {
    expect(() => learn([...trainingRows(), trainingRows()[0]!])).toThrow('Duplicate');
    expect(() => learnFromCompletedRows({ rows: trainingRows(), season: 2025, throughWeek: 12, scoring: { unsupported: 1 } })).toThrow('supported');
  });
  it('canonicalizes scoring keys without mixing scoring formats', () => {
    expect(scoringKey({ rec: 1, rush_yd: 0.1 })).toBe(scoringKey({ rush_yd: 0.1, rec: 1, unused: 0 }));
    expect(scoringKey({ rec: 1 })).not.toBe(scoringKey({ rec: 0.5 }));
  });
  it('round-trips immutable revisions and enforces future boundaries', async () => {
    const local = await store(); const revision = learn();
    await local.save(revision);
    expect(await local.latest(2025, 12, PPR_SCORING)).toBeNull();
    expect(await local.latest(2025, 13, PPR_SCORING)).toEqual(revision);
    expect(await local.latest(2025, 13, { rec: 0.5 })).toBeNull();
  });
  it('detects altered revision content', async () => {
    const local = await store(); const file = await local.save(learn());
    await writeFile(file, (await readFile(file, 'utf8')).replace('Runner 0', 'Edited Player'));
    await expect(local.latest(2025, 13, PPR_SCORING)).rejects.toThrow('checksum');
  });
  it('validates local overrides and allows disabling learning', async () => {
    const local = await store();
    expect(await local.overrides()).toEqual({ schemaVersion: 1 });
    await writeFile(join(local.directory, 'overrides.json'), JSON.stringify({ schemaVersion: 1, enabled: false }));
    expect((await local.overrides()).enabled).toBe(false);
    await writeFile(join(local.directory, 'overrides.json'), JSON.stringify({ schemaVersion: 1, parameters: { recentWeight: 10, halfLife: 4, priorGames: 2 } }));
    await expect(local.overrides()).rejects.toThrow();
  });
  it('serializes writers and releases the lock after failures', async () => {
    const local = await store();
    await local.exclusive(async () => { await expect(local.exclusive(async () => 1)).rejects.toThrow('lock'); });
    await expect(local.exclusive(async () => { throw new Error('failure'); })).rejects.toThrow('failure');
    expect(await local.exclusive(async () => 2)).toBe(2);
  });
  it('updates once and retains the same revision on repeated results', async () => {
    const local = await store();
    const client = { getSchedule: async () => [game()], getPlayerWeeklyStats: async () => [stat()] } as unknown as NflverseClient;
    const service = new LearningService(client, local, () => new Date('2025-09-10T00:00:00Z'));
    expect((await service.update({ season: 2025, throughWeek: 1 })).changed).toBe(true);
    expect((await service.update({ season: 2025, throughWeek: 1 })).changed).toBe(false);
  });
  it.each(['pending', 'too-early', 'missing-stats'])('rejects incomplete outcomes: %s', async (scenario) => {
    const local = await store();
    const client = { getSchedule: async () => [game(scenario === 'pending' ? { homeScore: null } : {})],
      getPlayerWeeklyStats: async () => scenario === 'missing-stats' ? [] : [stat()] } as unknown as NflverseClient;
    const now = scenario === 'too-early' ? new Date('2025-09-07T20:00:00Z') : new Date('2025-09-10T00:00:00Z');
    await expect(new LearningService(client, local, () => now).update({ season: 2025, throughWeek: 1 })).rejects.toThrow();
  });
  it('evaluates production forecasts by chronological week and position', async () => {
    const result = await evaluateProjectionModels({ rows: trainingRows(10, 4), season: 2025, throughWeek: 10 });
    expect(result.models.adaptive?.regression.sampleSize).toBe(28);
    expect(result.byPosition.RB?.adaptive?.regression.sampleSize).toBe(28);
    expect(result.updates.every((update) => update.throughWeek < 10)).toBe(true);
  });
});

it('rejects oversized and non-file learning overrides', async () => {
  const local = await store(); const path = join(local.directory, 'overrides.json');
  await writeFile(path, ' '.repeat(16 * 1024 + 1));
  await expect(local.overrides()).rejects.toThrow('size limit');
  await rm(path); await mkdir(path);
  await expect(local.overrides()).rejects.toThrow('regular file');
});
