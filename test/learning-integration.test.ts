import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LearningStore } from '../src/learning/store.js';
import { LearningService } from '../src/learning/service.js';
import { learnFromCompletedRows, PPR_SCORING } from '../src/learning/engine.js';
import { evaluateProjectionModels } from '../src/evaluation/projection-benchmark.js';
import { PlayerProjectionService } from '../src/projection/service.js';
import { DEFAULT_PROJECTION_PARAMETERS } from '../src/projection/statistics.js';
import { parseCliArguments } from '../src/cli-options.js';
import { runDoctor } from '../src/doctor.js';
import { runWithRequestSignal } from '../src/ai/request-signal.js';
import type { SleeperClient } from '../src/sleeper/client.js';
import type { NflverseClient } from '../src/nflverse/client.js';
import type { WeatherClient } from '../src/weather/client.js';
import { stat, league, trainingRows, game } from './analysis-fixtures.js';
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function localStore() { const directory = await mkdtemp(join(tmpdir(), 'seb-analysis-test-')); directories.push(directory); return new LearningStore(directory); }
const sleeper = { getLeague: async () => league(), findPlayers: async () => [{ full_name: 'Example Runner', player_id: 's1', position: 'RB', team: 'BUF', status: 'Active' }],
  getNflState: async () => ({ season: '2025', season_type: 'regular', week: 14 }) } as unknown as SleeperClient;
const nflverse = { getSchedule: async () => [], getPlayerWeeklyStats: async () => [1, 2, 3].map((week) => stat({ week })) } as unknown as NflverseClient;
const request = { leagueId: '123456', playerName: 'Example Runner', season: 2025, week: 13 };
const revision = () => learnFromCompletedRows({ rows: trainingRows(), season: 2025, throughWeek: 12 });

describe('forecast learning integration', () => {
  it('uses validated learning only after its cutoff and within the requested analysis window', async () => {
    const local = await localStore(); await local.save(revision());
    const service = new PlayerProjectionService(sleeper, nflverse, {} as WeatherClient, local);
    expect((await service.project(request)).model.learningThroughWeek).toBe(12);
    expect((await service.project({ ...request, throughWeek: 3 })).model.learningThroughWeek).toBeNull();
  });
  it('applies a manual override and disables all learned parameters on request', async () => {
    const local = await localStore(); await local.save(revision());
    const service = new PlayerProjectionService(sleeper, nflverse, {} as WeatherClient, local);
    const parameters = { recentWeight: 0, halfLife: 8, priorGames: 0 };
    await writeFile(join(local.directory, 'overrides.json'), JSON.stringify({ schemaVersion: 1, parameters }));
    expect((await service.project(request)).model).toMatchObject({ parameters, manualOverride: true, learningThroughWeek: null });
    await writeFile(join(local.directory, 'overrides.json'), JSON.stringify({ schemaVersion: 1, enabled: false, parameters }));
    expect((await service.project(request)).model).toMatchObject({ parameters: DEFAULT_PROJECTION_PARAMETERS, manualOverride: false, learningThroughWeek: null });
  });
  it('rejects a requested analysis cutoff that includes an in-progress NFL week', async () => {
    const service = new PlayerProjectionService(sleeper, nflverse, {} as WeatherClient, false);
    await expect(service.project({ ...request, week: 16, throughWeek: 14 })).rejects.toThrow('completed');
    expect((await service.project({ ...request, week: 16 })).throughWeek).toBe(13);
  });
  it('retains four corrections per week and keeps earlier weeks available', async () => {
    const local = await localStore(); const initial = revision();
    await local.save({ ...initial, throughWeek: 11 });
    let latest = '';
    for (let i = 0; i < 6; i += 1) latest = await local.save({ ...initial, createdAt: new Date(Date.UTC(2025, 11, i + 1)).toISOString() });
    expect(JSON.parse(await readFile(latest, 'utf8')).throughWeek).toBe(12);
    const directory = (await readdir(local.directory)).find((name) => name.startsWith('2025-'))!;
    expect(await readdir(join(local.directory, directory))).toHaveLength(5);
    expect((await local.latest(2025, 12, PPR_SCORING))?.throughWeek).toBe(11);
  });
  it('does not write a revision after cancellation or inconsistent game identity', async () => {
    const local = await localStore(); const controller = new AbortController();
    const client = { getSchedule: async () => [game()], getPlayerWeeklyStats: async () => { controller.abort(); return [stat()]; } } as unknown as NflverseClient;
    const service = new LearningService(client, local, () => new Date('2025-09-10T00:00:00Z'));
    await expect(runWithRequestSignal(controller.signal, () => service.update({ season: 2025, throughWeek: 1 }))).rejects.toThrow();
    expect(await local.latest(2025, 2, PPR_SCORING)).toBeNull();
    const badClient = { ...client, getPlayerWeeklyStats: async () => [stat({ week: 2 })] } as unknown as NflverseClient;
    await expect(new LearningService(badClient, local, () => new Date('2025-09-10T00:00:00Z')).update({ season: 2025, throughWeek: 1 })).rejects.toThrow('schedule');
  });
  it('reports an invalid local override through Doctor', async () => {
    const report = await runDoctor({ offline: true, verifyLearning: async () => { throw new Error('invalid'); } });
    expect(report.checks.find((check) => check.name === 'Local forecast learning')).toMatchObject({ status: 'fail' });
  });
  it('rejects duplicate final outcomes and preserves missing outcomes in the benchmark', async () => {
    const rows = trainingRows(5, 2);
    await expect(evaluateProjectionModels({ rows: [...rows, rows.at(-1)!], season: 2025, throughWeek: 5 })).rejects.toThrow('duplicate');
    const report = await evaluateProjectionModels({ rows: rows.filter((row) => row.playerId !== 'p0' || row.week !== 5), season: 2025, throughWeek: 5 });
    expect(report.missingOutcomes).toBe(1);
    expect(report.models.ensemble?.regression.sampleSize).toBe(3);
  });
});

describe('learning command validation', () => {
  it('parses a league-specific update and an evaluation request', () => {
    expect(parseCliArguments(['learn', 'update', '--season', '2026', '--through-week', '2', '--league', '123456', '--json'])).toMatchObject({ name: 'learn', action: 'update', season: 2026, throughWeek: 2, leagueId: '123456', json: true });
    expect(parseCliArguments(['evaluate', '--season', '2025'])).toMatchObject({ name: 'evaluate', season: 2025 });
  });
  it.each([['learn', 'update'], ['learn', 'run', '--season', '2025'], ['learn', 'update', '--season', '2025', '--through-week', '0'], ['learn', 'status', '--season', '2025', '--league', 'wrong']])('rejects invalid arguments %j', (...args) => {
    expect(() => parseCliArguments(args)).toThrow();
  });
});
