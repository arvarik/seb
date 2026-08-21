import { NflverseClient } from './nflverse/client.js';
import { SleeperClient } from './sleeper/client.js';
import { SourceTracker } from './sources.js';
import { WeatherClient } from './weather/client.js';

const sources = new SourceTracker();
const sleeper = new SleeperClient({
  database: false,
  onSource: sources.record,
  playerCacheFile: false,
});
const nflverse = new NflverseClient({
  database: false,
  onSource: sources.record,
});
const weather = new WeatherClient({
  database: false,
  onSource: sources.record,
  ...(process.env.NWS_USER_AGENT?.trim()
    ? { userAgent: process.env.NWS_USER_AGENT.trim() }
    : {}),
});

const nflState = await sleeper.getNflState();
const currentSeason = Number.parseInt(nflState.season, 10);
const [schedule, playerStats, forecast, alerts] = await Promise.all([
  nflverse.getSchedule({ season: currentSeason }),
  nflverse.getPlayerWeeklyStats({
    season: currentSeason - 1,
    playerName: 'Josh Allen',
    seasonType: 'REG',
  }),
  weather.getHourlyForecast(47.5952, -122.3316),
  weather.getActiveAlerts(47.5952, -122.3316),
]);

if (!/^\d{4}$/u.test(nflState.season) || !Number.isInteger(nflState.week)) {
  throw new Error('Sleeper returned an invalid NFL state contract.');
}
if (schedule.length === 0) {
  throw new Error(`nflverse returned no ${currentSeason} schedule rows.`);
}
if (playerStats.length === 0) {
  throw new Error(
    `nflverse returned no ${currentSeason - 1} Josh Allen statistics.`,
  );
}
if (forecast.periods.length === 0) {
  throw new Error('The National Weather Service returned no hourly periods.');
}

process.stdout.write(
  `${JSON.stringify(
    {
      sleeper: {
        season: nflState.season,
        seasonType: nflState.season_type,
        week: nflState.week,
      },
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
