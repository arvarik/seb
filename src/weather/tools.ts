import { tool } from 'ai';
import { z } from 'zod';

import {
  summarizeTeamPerformance,
} from '../nflverse/analytics.js';
import { NflverseClient } from '../nflverse/client.js';
import { WeatherClient } from './client.js';
import { GameWeatherService } from './game-weather.js';
import { findHomeStadium } from './stadiums.js';

const seasonSchema = z.number().int().min(1999).max(2100);
const weekSchema = z.number().int().min(1).max(22);
const teamSchema = z.string().trim().min(2).max(3).transform((value) => value.toUpperCase());

export function createWeatherTools(
  weather: WeatherClient,
  nflverse: NflverseClient,
) {
  const gameWeather = new GameWeatherService(nflverse, weather);

  return {
    getStadiumForecast: tool({
      description:
        'Get the National Weather Service hourly forecast and active alerts for one NFL home stadium.',
      inputSchema: z.object({
        team: teamSchema,
        hours: z.number().int().min(1).max(168).optional().default(48),
      }),
      execute: async ({ team, hours }) => {
        const stadium = findHomeStadium(team);
        if (!stadium) {
          throw new Error(`Seb has no United States stadium coordinate for ${team}.`);
        }
        const [forecast, alerts] = await Promise.all([
          weather.getHourlyForecast(stadium.latitude, stadium.longitude),
          weather.getActiveAlerts(stadium.latitude, stadium.longitude),
        ]);
        return {
          stadium,
          forecast: {
            ...forecast,
            periods: forecast.periods.slice(0, hours),
          },
          alerts,
          source: {
            label: 'National Weather Service API',
            url: 'https://www.weather.gov/documentation/services-web-api',
          },
        };
      },
    }),

    getGameWeather: tool({
      description:
        'Combine an nflverse game and venue with the kickoff-hour National Weather Service forecast and weather risk.',
      inputSchema: z.object({
        season: seasonSchema,
        week: weekSchema,
        team: teamSchema,
      }),
      execute: async (input) => ({
        ...(await gameWeather.getGameWeather(input)),
        sources: [
          {
            label: 'nflverse schedules',
            url: 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv.gz',
          },
          {
            label: 'National Weather Service API',
            url: 'https://www.weather.gov/documentation/services-web-api',
          },
        ],
      }),
    }),

    getWeekWeather: tool({
      description:
        'Screen one NFL week for kickoff weather risk. The tool skips direct field effects for indoor games.',
      inputSchema: z.object({
        season: seasonSchema,
        week: weekSchema,
        includeIndoor: z.boolean().optional().default(false),
        limit: z.number().int().min(1).max(18).optional().default(18),
      }),
      execute: async ({ season, week, includeIndoor, limit }) => {
        const games = await nflverse.getSchedule({
          season,
          week,
          gameType: week <= 18 ? 'REG' : 'POST',
        });
        const selected = games
          .filter((game) => includeIndoor || !isIndoorRoof(game.roof))
          .slice(0, limit);
        const results = await mapWithConcurrency(selected, 4, async (game) => {
          try {
            return await gameWeather.getGameWeather({
              season,
              week,
              team: game.homeTeam,
            });
          } catch (error) {
            return {
              alerts: [],
              fantasyImpact: [],
              forecast: null,
              game,
              kickoffAt: null,
              reason: error instanceof Error ? error.message : String(error),
              risk: null,
              stadium: null,
              status: 'unavailable' as const,
            };
          }
        });
        return {
          season,
          week,
          totalGames: games.length,
          analyzedGames: results.length,
          highRiskGames: results.filter((result) => result.risk === 'high').length,
          mediumRiskGames: results.filter((result) => result.risk === 'medium').length,
          games: results,
          sources: [
            {
              label: 'nflverse schedules',
              url: 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv.gz',
            },
            {
              label: 'National Weather Service API',
              url: 'https://www.weather.gov/documentation/services-web-api',
            },
          ],
        };
      },
    }),

    getGameEnvironment: tool({
      description:
        'Compare both NFL teams, the game venue, the schedule line, and kickoff weather in one game analysis.',
      inputSchema: z.object({
        season: seasonSchema,
        week: weekSchema,
        team: teamSchema,
        analysisSeason: seasonSchema
          .optional()
          .describe('The statistics season. Week 1 defaults to the prior season.'),
        throughWeek: weekSchema.optional(),
      }),
      execute: async ({ season, week, team, analysisSeason, throughWeek }) => {
        const games = await nflverse.getSchedule({
          season,
          week,
          team,
          gameType: week <= 18 ? 'REG' : 'POST',
        });
        const game = games[0];
        if (!game) {
          throw new Error(`nflverse has no ${season} Week ${week} game for ${team}.`);
        }
        const selectedAnalysisSeason = analysisSeason ?? (week === 1 ? season - 1 : season);
        const lastWeek =
          throughWeek ?? (selectedAnalysisSeason < season ? 18 : Math.max(1, week - 1));
        const weatherRequest = gameWeather
          .getGameWeather({ season, week, team })
          .catch((error) => ({
            alerts: [],
            fantasyImpact: [],
            forecast: null,
            game,
            kickoffAt: null,
            reason: error instanceof Error ? error.message : String(error),
            risk: null,
            stadium: null,
            status: 'unavailable' as const,
          }));
        const [weatherResult, homeGames, awayGames, homeStats, awayStats] =
          await Promise.all([
            weatherRequest,
            nflverse.getSchedule({ season: selectedAnalysisSeason, team: game.homeTeam, gameType: 'REG' }),
            nflverse.getSchedule({ season: selectedAnalysisSeason, team: game.awayTeam, gameType: 'REG' }),
            nflverse.getPlayerWeeklyStats({
              season: selectedAnalysisSeason,
              team: game.homeTeam,
              seasonType: 'REG',
              throughWeek: lastWeek,
            }),
            nflverse.getPlayerWeeklyStats({
              season: selectedAnalysisSeason,
              team: game.awayTeam,
              seasonType: 'REG',
              throughWeek: lastWeek,
            }),
          ]);
        return {
          game,
          analysisSeason: selectedAnalysisSeason,
          throughWeek: lastWeek,
          homePerformance: summarizeTeamPerformance(
            game.homeTeam,
            homeGames.filter((candidate) => candidate.week <= lastWeek),
            homeStats,
          ),
          awayPerformance: summarizeTeamPerformance(
            game.awayTeam,
            awayGames.filter((candidate) => candidate.week <= lastWeek),
            awayStats,
          ),
          weather: weatherResult,
          sources: [
            {
              label: 'nflverse data releases',
              url: 'https://github.com/nflverse/nflverse-data/releases',
            },
            {
              label: 'National Weather Service API',
              url: 'https://www.weather.gov/documentation/services-web-api',
            },
          ],
        };
      },
    }),
  };
}

function isIndoorRoof(roof: string | null): boolean {
  const value = roof?.toLowerCase() ?? '';
  return value.includes('dome') || value.includes('closed');
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  action: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) {
        results[index] = await action(value);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}
