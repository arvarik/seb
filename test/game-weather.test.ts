import { afterEach, describe, expect, it, vi } from 'vitest';

import { NflverseClient } from '../src/nflverse/client.js';
import type { NflverseGame } from '../src/nflverse/types.js';
import { WeatherClient } from '../src/weather/client.js';
import { GameWeatherService } from '../src/weather/game-weather.js';

afterEach(() => vi.useRealTimers());

describe('GameWeatherService', () => {
  it('skips an outdoor forecast for a closed roof', async () => {
    const weather = { getHourlyForecast: vi.fn(), getActiveAlerts: vi.fn() };
    const service = new GameWeatherService(
      nflverseWithGame(game({ roof: 'closed' })),
      weather as unknown as WeatherClient,
    );

    const result = await service.getGameWeather({ season: 2026, week: 1, team: 'KC' });

    expect(result.status).toBe('indoor');
    expect(weather.getHourlyForecast).not.toHaveBeenCalled();
  });

  it('selects the kickoff forecast and describes high weather risk', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
    const weather = {
      getHourlyForecast: vi.fn().mockResolvedValue({
        periods: [
          {
            startTime: '2026-09-10T20:00:00-04:00',
            endTime: '2026-09-10T21:00:00-04:00',
            isDaytime: false,
            temperature: 42,
            temperatureUnit: 'F',
            precipitationProbability: 80,
            relativeHumidity: 90,
            windSpeed: '22 to 28 mph',
            windDirection: 'NW',
            shortForecast: 'Heavy Rain',
            detailedForecast: '',
          },
        ],
      }),
      getActiveAlerts: vi.fn().mockResolvedValue([]),
    };
    const service = new GameWeatherService(
      nflverseWithGame(game({ gameDate: '2026-09-10', gameTime: '20:20' })),
      weather as unknown as WeatherClient,
    );

    const result = await service.getGameWeather({ season: 2026, week: 1, team: 'KC' });

    expect(result.status).toBe('available');
    expect(result.risk).toBe('high');
    expect(result.fantasyImpact.join(' ')).toContain('deep-passing');
    expect(result.stadium?.name).toContain('Arrowhead');
  });

  it('does not request weather outside the NWS forecast window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T12:00:00Z'));
    const weather = { getHourlyForecast: vi.fn(), getActiveAlerts: vi.fn() };
    const service = new GameWeatherService(
      nflverseWithGame(game({ gameDate: '2026-12-10' })),
      weather as unknown as WeatherClient,
    );

    const result = await service.getGameWeather({ season: 2026, week: 14, team: 'KC' });

    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain('forecast window');
    expect(weather.getHourlyForecast).not.toHaveBeenCalled();
  });

  it('does not apply a home coordinate to a neutral venue', async () => {
    const weather = { getHourlyForecast: vi.fn(), getActiveAlerts: vi.fn() };
    const service = new GameWeatherService(
      nflverseWithGame(game({ location: 'Neutral' })),
      weather as unknown as WeatherClient,
    );

    const result = await service.getGameWeather({ season: 2026, week: 1, team: 'KC' });

    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain('neutral venue');
    expect(weather.getHourlyForecast).not.toHaveBeenCalled();
  });
});

function nflverseWithGame(value: NflverseGame): NflverseClient {
  return {
    getSchedule: async () => [value],
  } as unknown as NflverseClient;
}

function game(overrides: Partial<NflverseGame>): NflverseGame {
  return {
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
    roof: 'outdoors',
    season: 2026,
    spreadLine: -2.5,
    stadium: 'Arrowhead Stadium',
    stadiumId: 'KAN00',
    surface: 'grass',
    temperature: null,
    totalLine: 48.5,
    week: 1,
    wind: null,
    ...overrides,
  };
}
