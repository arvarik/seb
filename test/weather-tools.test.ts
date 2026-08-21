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

  it('reuses the weekly schedule rows during the weather screen', async () => {
    const game = {
      awayRest: 7,
      awayScore: null,
      awayTeam: 'BUF',
      gameDate: '2026-09-10',
      gameId: '2026_01_BUF_KC',
      gameTime: '20:20',
      gameType: 'REG',
      homeRest: 7,
      homeScore: null,
      homeTeam: 'KC',
      location: 'Home',
      roof: 'closed',
      season: 2026,
      spreadLine: null,
      stadium: 'Arrowhead Stadium',
      stadiumId: 'KAN00',
      surface: 'grass',
      temperature: null,
      totalLine: null,
      week: 1,
      wind: null,
    };
    const getSchedule = vi.fn().mockResolvedValue([game]);
    const nflverse = { getSchedule } as unknown as NflverseClient;
    const weather = {
      getHourlyForecast: vi.fn(),
      getActiveAlerts: vi.fn(),
    } as unknown as WeatherClient;
    const execute = createWeatherTools(weather, nflverse).getWeekWeather.execute as unknown as (
      input: { includeIndoor: boolean; limit: number; season: number; week: number },
    ) => Promise<{ games: unknown[] }>;

    const result = await execute({
      includeIndoor: true,
      limit: 18,
      season: 2026,
      week: 1,
    });

    expect(result.games).toHaveLength(1);
    expect(getSchedule).toHaveBeenCalledOnce();
  });
});
