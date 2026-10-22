import { describe, expect, it, vi } from 'vitest';
import { PlayerProjectionService } from '../src/projection/service.js';
import * as playerProjection from '../src/projection/player-projection.js';
import type { NflverseClient } from '../src/nflverse/client.js';
import type { SleeperClient } from '../src/sleeper/client.js';
import type { WeatherClient } from '../src/weather/client.js';
import { game, league, stat } from './analysis-fixtures.js';

describe('PlayerProjectionService positional caching and residual shrinkage', () => {
  it('reuses cached positional priors and pooled residuals across batch player projections', async () => {
    const positionRows = Array.from({ length: 12 }, (_, pIdx) =>
      [1, 2, 3, 4, 5].map((week) =>
        stat({
          playerId: `rb-${pIdx}`,
          playerDisplayName: `Runner ${pIdx}`,
          position: 'RB',
          team: 'BUF',
          week,
          rushingYards: 50 + pIdx * 5 + week * 2,
        }),
      ),
    ).flat();

    const sleeper = {
      getNflState: vi.fn(async () => ({ season: '2025', season_type: 'regular', week: 6 })),
      getLeague: vi.fn(async () => league({ season: '2025' })),
      findPlayers: vi.fn(async (name: string) => [
        {
          full_name: name,
          player_id: name === 'Runner 0' ? 'rb-0' : 'rb-1',
          position: 'RB',
          fantasy_positions: ['RB', 'WR'],
          team: 'BUF',
          status: 'Active',
          active: true,
        },
      ]),
    } as unknown as SleeperClient;

    const nflverse = {
      getPlayerWeeklyStats: vi.fn(async ({ playerName }: { playerName?: string }) => {
        if (playerName) {
          return positionRows.filter((row) => row.playerDisplayName === playerName);
        }
        return positionRows;
      }),
      getSchedule: vi.fn(async () => [
        game({ season: 2025, week: 6, gameDate: '2099-10-12', roof: 'dome' }),
      ]),
    } as unknown as NflverseClient;

    const scoreSpy = vi.spyOn(playerProjection, 'scorePlayerWeek');
    const service = new PlayerProjectionService(sleeper, nflverse, {} as WeatherClient, false);

    const first = await service.project({
      leagueId: '123456',
      playerName: 'Runner 0',
      season: 2025,
      week: 6,
    });
    const callsAfterFirst = scoreSpy.mock.calls.length;

    const second = await service.project({
      leagueId: '123456',
      playerName: 'Runner 1',
      season: 2025,
      week: 6,
    });
    const callsAfterSecond = scoreSpy.mock.calls.length;

    expect(first.interval.method).toBe('rolling-residual');
    expect(second.interval.method).toBe('rolling-residual');
    expect(first.player.fantasy_positions).toEqual(['RB', 'WR']);
    // Second projection only scores Runner 1's 5 weekly rows + opponent adjustment rows, without rescoring 60 position rows for prior/residuals
    expect(callsAfterSecond - callsAfterFirst).toBeLessThan(callsAfterFirst);
    scoreSpy.mockRestore();
  });
});
