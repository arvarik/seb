import { tool } from 'ai';
import { z } from 'zod';

import {
  summarizeTeamPerformance,
} from '../nflverse/analytics.js';
import { NflverseClient } from '../nflverse/client.js';
import { WeatherClient } from './client.js';
import {
  GameScheduleNotFoundError,
  GameWeatherService,
  resolveWeatherGameType,
} from './game-weather.js';
import { findHomeStadium } from './stadiums.js';

const seasonSchema = z.number().int().min(1999).max(2100);
const weekSchema = z.number().int().min(1).max(22);
const teamSchema = z.string().trim().min(2).max(3).transform((value) => value.toUpperCase());
const gameTypeSchema = z.enum(['PRE', 'REG', 'POST']);

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
      inputExamples: [
        { input: { team: 'SEA', hours: 48 } },
      ],
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
        'Combine one nflverse game with the kickoff-hour NWS forecast. PRE returns a home-stadium outlook when nflverse has no preseason row.',
      inputSchema: z.object({
        season: seasonSchema,
        week: weekSchema,
        team: teamSchema,
        gameType: gameTypeSchema.optional(),
      }),
      inputExamples: [
        { input: { season: 2026, week: 8, team: 'SEA', gameType: 'REG' } },
        { input: { season: 2026, week: 2, team: 'SEA', gameType: 'PRE' } },
      ],
      execute: async (input) => {
        try {
          return {
            ...(await gameWeather.getGameWeather(input)),
            sources: weatherSources(),
          };
        } catch (error) {
          if (input.gameType !== 'PRE' || !(error instanceof GameScheduleNotFoundError)) {
            throw error;
          }
          return preseasonStadiumForecast(weather, input);
        }
      },
    }),

    getWeekWeather: tool({
      description:
        'Screen one NFL week for kickoff weather risk. PRE reports the nflverse source limit. The tool separates indoor games.',
      inputSchema: z.object({
        season: seasonSchema,
        week: weekSchema,
        gameType: gameTypeSchema.optional(),
        includeIndoor: z.boolean().optional().default(false),
        limit: z.number().int().min(1).max(18).optional().default(18),
      }),
      inputExamples: [
        {
          input: {
            season: 2026,
            week: 8,
            gameType: 'REG',
            includeIndoor: false,
            limit: 18,
          },
        },
      ],
      execute: async ({ season, week, gameType, includeIndoor, limit }) => {
        const selectedGameType = resolveWeatherGameType(week, gameType);
        const games = await nflverse.getSchedule({
          season,
          week,
          gameType: selectedGameType,
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
              gameType: selectedGameType,
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
          gameType: selectedGameType,
          reason: games.length === 0 && selectedGameType === 'PRE'
            ? 'The nflverse schedule release has no preseason game rows. Select one team for a home-stadium outlook.'
            : null,
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
        'Compare both NFL teams, the venue, the schedule line, and kickoff weather for a regular-season or postseason game.',
      inputSchema: z.object({
        season: seasonSchema,
        week: weekSchema,
        team: teamSchema,
        gameType: gameTypeSchema.optional(),
        analysisSeason: seasonSchema
          .optional()
          .describe('The statistics season. Week 1 defaults to the prior season.'),
        throughWeek: weekSchema.optional(),
      }),
      inputExamples: [
        {
          input: {
            season: 2026,
            week: 8,
            team: 'SEA',
            gameType: 'REG',
            analysisSeason: 2026,
            throughWeek: 7,
          },
        },
      ],
      execute: async ({ season, week, team, gameType, analysisSeason, throughWeek }) => {
        const selectedGameType = resolveWeatherGameType(week, gameType);
        const games = await nflverse.getSchedule({
          season,
          week,
          team,
          gameType: selectedGameType,
        });
        const game = games[0];
        if (!game) {
          throw new Error(`nflverse has no ${season} Week ${week} game for ${team}.`);
        }
        const selectedAnalysisSeason = analysisSeason ?? (week === 1 ? season - 1 : season);
        const lastWeek =
          throughWeek ?? (selectedAnalysisSeason < season ? 18 : Math.max(1, week - 1));
        const weatherRequest = gameWeather
          .getGameWeather({ season, week, team, gameType: selectedGameType })
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

async function preseasonStadiumForecast(
  weather: WeatherClient,
  input: { season: number; team: string; week: number },
) {
  const stadium = findHomeStadium(input.team);
  if (!stadium) {
    return {
      season: input.season,
      week: input.week,
      gameType: 'PRE' as const,
      team: input.team,
      status: 'unavailable' as const,
      reason: 'The nflverse schedule release has no preseason game row, and Seb has no home-stadium coordinate for this team.',
      sources: weatherSources(),
    };
  }
  const [forecast, alerts] = await Promise.all([
    weather.getHourlyForecast(stadium.latitude, stadium.longitude),
    weather.getActiveAlerts(stadium.latitude, stadium.longitude),
  ]);
  return {
    season: input.season,
    week: input.week,
    gameType: 'PRE' as const,
    team: input.team,
    status: 'stadium-outlook' as const,
    reason: 'The nflverse schedule release has no preseason game rows. This home-stadium forecast is not matched to a game, venue, or kickoff.',
    stadium,
    forecast: {
      ...forecast,
      periods: forecast.periods.slice(0, 48),
    },
    alerts,
    sources: weatherSources(),
  };
}

function weatherSources() {
  return [
    {
      label: 'nflverse schedules',
      url: 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv.gz',
    },
    {
      label: 'National Weather Service API',
      url: 'https://www.weather.gov/documentation/services-web-api',
    },
  ];
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
