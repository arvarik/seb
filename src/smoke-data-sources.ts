import { NflverseClient } from './nflverse/client.js';
import { SourceTracker } from './sources.js';
import { WeatherClient } from './weather/client.js';

const sources = new SourceTracker();
const nflverse = new NflverseClient({ onSource: sources.record });
const weather = new WeatherClient({
  onSource: sources.record,
  ...(process.env.NWS_USER_AGENT?.trim()
    ? { userAgent: process.env.NWS_USER_AGENT.trim() }
    : {}),
});

const [schedule, playerStats, forecast, alerts] = await Promise.all([
  nflverse.getSchedule({ season: 2026 }),
  nflverse.getPlayerWeeklyStats({
    season: 2025,
    playerName: 'Josh Allen',
    seasonType: 'REG',
  }),
  weather.getHourlyForecast(47.5952, -122.3316),
  weather.getActiveAlerts(47.5952, -122.3316),
]);

if (schedule.length === 0) {
  throw new Error('nflverse returned no 2026 schedule rows.');
}
if (playerStats.length === 0) {
  throw new Error('nflverse returned no 2025 Josh Allen statistics.');
}
if (forecast.periods.length === 0) {
  throw new Error('The National Weather Service returned no hourly periods.');
}

process.stdout.write(
  `${JSON.stringify(
    {
      nflverse: {
        scheduleGames: schedule.length,
        playerWeeks: playerStats.length,
      },
      weather: {
        activeAlerts: alerts.length,
        periods: forecast.periods.length,
        timeZone: forecast.timeZone,
      },
      sources: sources.list(),
    },
    null,
    2,
  )}\n`,
);
