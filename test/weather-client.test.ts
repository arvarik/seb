import { describe, expect, it } from 'vitest';

import { WeatherClient } from '../src/weather/client.js';

describe('WeatherClient', () => {
  it('discovers and loads an NWS hourly forecast with the required user agent', async () => {
    const requests: Array<{ url: string; userAgent: string | null }> = [];
    const client = new WeatherClient({
      baseUrl: 'https://api.weather.test',
      cacheDirectory: false,
      userAgent: 'seb-test test@example.com',
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({
          url,
          userAgent: new Headers(init?.headers).get('user-agent'),
        });
        if (url.includes('/points/')) {
          return jsonResponse(pointDocument());
        }
        return jsonResponse(forecastDocument());
      },
    });

    const forecast = await client.getHourlyForecast(47.5952, -122.3316);

    expect(forecast.periods[0]).toMatchObject({
      temperature: 58,
      precipitationProbability: 40,
      windSpeed: '12 mph',
    });
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.userAgent === 'seb-test test@example.com')).toBe(true);
  });

  it('loads active NWS alerts for a stadium point', async () => {
    const client = new WeatherClient({
      baseUrl: 'https://api.weather.test',
      cacheDirectory: false,
      fetch: async () =>
        jsonResponse({
          features: [
            {
              properties: {
                event: 'Wind Advisory',
                severity: 'Moderate',
                headline: 'Strong wind expected',
              },
            },
          ],
        }),
    });

    const alerts = await client.getActiveAlerts(47.5952, -122.3316);

    expect(alerts[0]).toMatchObject({ event: 'Wind Advisory', severity: 'Moderate' });
  });

  it('rejects a forecast URL from an unexpected host', async () => {
    const client = new WeatherClient({
      baseUrl: 'https://api.weather.test',
      cacheDirectory: false,
      fetch: async () =>
        jsonResponse({
          properties: {
            gridId: 'SEW',
            gridX: 1,
            gridY: 2,
            forecastHourly: 'https://unexpected.test/forecast',
          },
        }),
    });

    await expect(client.getPointMetadata(47.5952, -122.3316)).rejects.toThrow(
      'unexpected forecast host',
    );
  });

  it('rejects a successful response with missing point fields', async () => {
    const client = new WeatherClient({
      baseUrl: 'https://api.weather.test',
      cacheDirectory: false,
      fetch: async () => jsonResponse({ properties: { gridId: 'SEW' } }),
    });

    await expect(client.getPointMetadata(47.5952, -122.3316)).rejects.toThrow();
  });
});

function pointDocument() {
  return {
    properties: {
      gridId: 'SEW',
      gridX: 1,
      gridY: 2,
      forecastHourly: 'https://api.weather.test/gridpoints/SEW/1,2/forecast/hourly',
      timeZone: 'America/Los_Angeles',
      relativeLocation: { properties: { city: 'Seattle', state: 'WA' } },
    },
  };
}

function forecastDocument() {
  return {
    properties: {
      generatedAt: '2026-08-20T12:00:00Z',
      updated: '2026-08-20T12:00:00Z',
      periods: [
        {
          startTime: '2026-08-20T12:00:00-07:00',
          endTime: '2026-08-20T13:00:00-07:00',
          isDaytime: true,
          temperature: 58,
          temperatureUnit: 'F',
          probabilityOfPrecipitation: { value: 40 },
          relativeHumidity: { value: 70 },
          windSpeed: '12 mph',
          windDirection: 'SW',
          shortForecast: 'Chance Rain',
          detailedForecast: '',
        },
      ],
    },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/geo+json' },
  });
}
