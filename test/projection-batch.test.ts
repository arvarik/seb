import { describe, expect, it, vi } from 'vitest';
import { projectPlayers } from '../src/projection/batch.js';
import type { ScoringAwarePlayerProjection } from '../src/projection/player-projection.js';
import { ResearchDataError } from '../src/data/research-error.js';
import { runWithRequestSignal } from '../src/ai/request-signal.js';

const projection = { expectedPoints: 20, recommendationEligible: true, scoreScope: 'weekly-estimate' } as ScoringAwarePlayerProjection;
const request = { leagueId: '123', season: 2026, week: 1 };

describe('batch player projections', () => {
  it.each(['partial-scoring', 'historical-baseline'] as const)('does not report a complete matchup for %s results', async (scoreScope) => {
    expect((await projectPlayers({ project: async () => ({ ...projection, scoreScope }) },
      { ...request, playerNames: ['Player One'] })).complete).toBe(false);
  });
  it('limits concurrency, deduplicates names, and preserves order and missing players', async () => {
    let active = 0;
    let maximum = 0;
    const project = vi.fn(async ({ playerName }: { playerName: string }) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      if (playerName === 'Rookie Player') throw new ResearchDataError('No completed games.');
      return projection;
    });
    const names = ['Player One', 'Rookie Player', ...Array.from({ length: 28 }, (_, index) => `Player ${index}`)];
    const result = await projectPlayers({ project }, { ...request, playerNames: [...names, ' player one '] });
    expect(maximum).toBe(4);
    expect(project).toHaveBeenCalledTimes(30);
    expect(result.complete).toBe(false);
    expect(result.results.map((item) => item.playerName)).toEqual(names);
    expect(result.results[1]).toEqual({ playerName: 'Rookie Player', status: 'unavailable', reason: 'No completed games.' });
    expect(result.results.filter((item) => item.status === 'projected')).toHaveLength(29);
    expect(project).toHaveBeenCalledWith({ ...request, playerName: 'Player One' });
  });

  it('does not expose unknown errors or turn unavailable points into zero', async () => {
    const result = await projectPlayers({ project: async () => { throw new Error('Authorization: secret'); } },
      { ...request, playerNames: ['Player One'] });
    expect(result.complete).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/secret|expectedPoints/);
  });

  it('cancels the batch before it starts more players', async () => {
    const controller = new AbortController();
    const project = vi.fn(async () => { controller.abort(); return projection; });
    await expect(runWithRequestSignal(controller.signal, () => projectPlayers({ project },
      { ...request, playerNames: Array.from({ length: 30 }, (_, index) => `Player ${index}`) }))).rejects.toThrow();
    expect(project).toHaveBeenCalledTimes(1);
  });

  it('reports complete projections and propagates direct cancellation', async () => {
    expect((await projectPlayers({ project: async () => projection }, { ...request, playerNames: ['Player One'] })).complete).toBe(true);
    await expect(projectPlayers({ project: async () => { throw new DOMException('Stopped', 'AbortError'); } },
      { ...request, playerNames: ['Player One'] })).rejects.toThrow('Stopped');
  });
});
