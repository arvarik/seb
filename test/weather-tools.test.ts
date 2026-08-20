import { describe, expect, it, vi } from 'vitest';

import { NflverseClient } from '../src/nflverse/client.js';
import { WeatherClient } from '../src/weather/client.js';
import { createWeatherTools } from '../src/weather/tools.js';

describe('weather tools', () => {
  it('returns a limited home-stadium outlook when nflverse has no preseason row', async () => {
    const periods = Array.from({ length: 60 }, (_, index) => ({ number: index + 1 }));
    const weather = {
      getHourlyForecast: vi.fn().mockResolvedValue({ periods, timeZone: 'America/Los_Angeles' }),
      getActiveAlerts: vi.fn().mockResolvedValue([]),
    } as unknown as WeatherClient;
    const nflverse = {
      getSchedule: vi.fn().mockResolvedValue([]),
    } as unknown as NflverseClient;
    const execute = createWeatherTools(weather, nflverse).getGameWeather.execute as unknown as (
      input: { gameType: 'PRE'; season: number; team: string; week: number },
    ) => Promise<{
      forecast: { periods: unknown[] };
      reason: string;
      status: string;
    }>;

    const result = await execute({
      season: 2026,
      week: 2,
      team: 'SEA',
      gameType: 'PRE',
    });

    expect(result.status).toBe('stadium-outlook');
    expect(result.reason).toContain('not matched to a game, venue, or kickoff');
    expect(result.forecast.periods).toHaveLength(48);
  });
});
