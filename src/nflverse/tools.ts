import { tool } from 'ai';
import { z } from 'zod';

import { NflverseClient } from './client.js';
import {
  summarizeDefenseAgainstPosition,
  summarizePlayerTrends,
  summarizeTeamPerformance,
} from './analytics.js';

const seasonSchema = z.number().int().min(1999).max(2100);
const weekSchema = z.number().int().min(1).max(22);
const teamSchema = z.string().trim().min(2).max(3).transform((value) => value.toUpperCase());

export function createNflverseTools(client: NflverseClient) {
  return {
    getNflSchedule: tool({
      description:
        'Get the official nflverse NFL schedule, results, venue, roof, surface, rest, spread, and total line fields.',
      inputSchema: z.object({
        season: seasonSchema,
        week: weekSchema.optional(),
        team: teamSchema.optional(),
        gameType: z.enum(['PRE', 'REG', 'POST']).optional(),
        limit: z.number().int().min(1).max(200).optional().default(100),
      }),
      execute: async ({ season, week, team, gameType, limit }) => {
        const filters = {
          season,
          ...(week ? { week } : {}),
          ...(team ? { team } : {}),
          ...(gameType ? { gameType } : {}),
        };
        const games = await client.getSchedule(filters);
        return {
          ...filters,
          totalGames: games.length,
          truncated: games.length > limit,
          games: games.slice(0, limit),
          source: {
            label: 'nflverse schedules',
            url: 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv.gz',
          },
        };
      },
    }),

    getPlayerWeeklyStats: tool({
      description:
        'Get nflverse weekly usage and production statistics. Use this for player trends, start-sit evidence, and projection inputs.',
      inputSchema: z.object({
        season: seasonSchema,
        week: weekSchema.optional(),
        throughWeek: weekSchema.optional(),
        playerName: z.string().trim().min(2).max(100).optional(),
        playerId: z.string().trim().min(2).max(100).optional(),
        team: teamSchema.optional(),
        position: z.enum(['QB', 'RB', 'WR', 'TE', 'K']).optional(),
        seasonType: z.enum(['REG', 'POST']).optional().default('REG'),
        limit: z.number().int().min(1).max(200).optional().default(100),
      }),
      execute: async ({
        season,
        week,
        throughWeek,
        playerName,
        playerId,
        team,
        position,
        seasonType,
        limit,
      }) => {
        const filters = {
          season,
          seasonType,
          ...(week ? { week } : {}),
          ...(throughWeek ? { throughWeek } : {}),
          ...(playerName ? { playerName } : {}),
          ...(playerId ? { playerId } : {}),
          ...(team ? { team } : {}),
          ...(position ? { position } : {}),
        };
        const stats = await client.getPlayerWeeklyStats(filters);
        return {
          ...filters,
          totalRows: stats.length,
          truncated: stats.length > limit,
          stats: stats.slice(0, limit),
          source: nflverseStatsSource(season),
        };
      },
    }),

    comparePlayerTrends: tool({
      description:
        'Compare player PPR production, opportunities, market share, recent form, and volatility from nflverse weekly statistics.',
      inputSchema: z.object({
        season: seasonSchema,
        throughWeek: weekSchema.optional(),
        playerNames: z.array(z.string().trim().min(2).max(100)).min(1).max(12),
      }),
      execute: async ({ season, throughWeek, playerNames }) => {
        const allRows = await client.getPlayerWeeklyStats({
          season,
          ...(throughWeek ? { throughWeek } : {}),
          seasonType: 'REG',
        });
        const names = playerNames.map(normalizeName);
        const rows = allRows.filter((row) =>
          names.some((name) => normalizeName(row.playerDisplayName).includes(name)),
        );
        return {
          season,
          throughWeek: throughWeek ?? null,
          players: summarizePlayerTrends(rows),
          source: nflverseStatsSource(season),
        };
      },
    }),

    getTeamPerformance: tool({
      description:
        'Get a team record, scoring averages, and offense totals from nflverse schedule and weekly player statistics.',
      inputSchema: z.object({
        season: seasonSchema,
        team: teamSchema,
        throughWeek: weekSchema.optional(),
      }),
      execute: async ({ season, team, throughWeek }) => {
        const [games, stats] = await Promise.all([
          client.getSchedule({ season, team, gameType: 'REG' }),
          client.getPlayerWeeklyStats({
            season,
            team,
            seasonType: 'REG',
            ...(throughWeek ? { throughWeek } : {}),
          }),
        ]);
        const selectedGames = throughWeek
          ? games.filter((game) => game.week <= throughWeek)
          : games;
        return {
          season,
          throughWeek: throughWeek ?? null,
          performance: summarizeTeamPerformance(team, selectedGames, stats),
          sources: [
            {
              label: 'nflverse schedules',
              url: 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv.gz',
            },
            nflverseStatsSource(season),
          ],
        };
      },
    }),

    getDefenseVsPosition: tool({
      description:
        'Measure PPR points and targets that one defense allowed to one fantasy position.',
      inputSchema: z.object({
        season: seasonSchema,
        defense: teamSchema,
        position: z.enum(['QB', 'RB', 'WR', 'TE', 'K']),
        throughWeek: weekSchema.optional(),
      }),
      execute: async ({ season, defense, position, throughWeek }) => {
        const stats = await client.getPlayerWeeklyStats({
          season,
          seasonType: 'REG',
          ...(throughWeek ? { throughWeek } : {}),
        });
        return {
          season,
          throughWeek: throughWeek ?? null,
          summary: summarizeDefenseAgainstPosition(defense, position, stats),
          source: nflverseStatsSource(season),
        };
      },
    }),
  };
}

function nflverseStatsSource(season: number) {
  return {
    label: `nflverse ${season} weekly player statistics`,
    url: `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv.gz`,
  };
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}
