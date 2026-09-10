import { tool } from 'ai';
import { z } from 'zod';

import { SleeperAnalysisService } from './analysis-service.js';
import { SleeperClient } from './client.js';
import type { SleeperPlayer } from './types.js';

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe('A Sleeper username or user ID.');
const leagueIdSchema = z
  .string()
  .trim()
  .regex(/^\d+$/)
  .describe('The numeric Sleeper league ID.');
const weekSchema = z
  .number()
  .int()
  .min(1)
  .max(18)
  .describe('The NFL week from 1 through 18.');
const analysisWeekSchema = z
  .number()
  .int()
  .min(0)
  .max(18)
  .optional()
  .describe('The last completed week. Use 0 when no games are complete.');
const teamSchema = z.string().trim().min(2).max(3).transform((value) => value.toUpperCase());

export function createSleeperTools(client: SleeperClient) {
  const analysis = new SleeperAnalysisService(client);

  return {
    getNflState: tool({
      description: 'Get the current NFL season, week, and Sleeper league season.',
      inputSchema: z.object({}),
      execute: async () => client.getNflState(),
    }),

    findPlayers: tool({
      description:
        'Find current Sleeper player records by a name or player ID. This returns profile, team, depth chart, and injury fields.',
      inputSchema: z.object({
        query: z.string().trim().min(1).max(100),
        position: z
          .string()
          .trim()
          .min(1)
          .max(10)
          .optional()
          .describe('An optional position, such as QB, RB, WR, TE, K, or DEF.'),
        includeInactive: z.boolean().optional().default(false),
        limit: z.number().int().min(1).max(25).optional().default(10),
      }),
      inputExamples: [
        {
          input: {
            query: 'Justin Jefferson',
            position: 'WR',
            includeInactive: false,
            limit: 5,
          },
        },
        {
          input: {
            query: '4046',
            includeInactive: true,
            limit: 1,
          },
        },
      ],
      execute: async ({ query, position, includeInactive, limit }) =>
        (
          await client.findPlayers(query, {
            active: !includeInactive,
            ...(position ? { position } : {}),
            limit,
          })
        ).map(compactPlayer),
    }),

    getTeamPlayers: tool({
      description:
        'Get current Sleeper NFL player records for one NFL team. This is not an official NFL roster or transaction source.',
      inputSchema: z.object({
        team: teamSchema,
        position: z.string().trim().min(1).max(10).optional(),
        includeInactive: z.boolean().optional().default(false),
        limit: z.number().int().min(1).max(100).optional().default(100),
      }),
      inputExamples: [
        { input: { team: 'SEA', includeInactive: false, limit: 100 } },
        { input: { team: 'MIN', position: 'WR', includeInactive: false, limit: 25 } },
      ],
      execute: async ({ team, position, includeInactive, limit }) => {
        const players = Object.values(await client.getPlayers({
          active: !includeInactive,
          ...(position ? { position } : {}),
        }))
          .filter((player) => player.team?.toUpperCase() === team)
          .filter((player) => includeInactive || player.active !== false)
          .filter((player) => !position || player.position?.toUpperCase() === position.toUpperCase())
          .sort(compareTeamPlayers);
        return {
          team,
          totalPlayers: players.length,
          truncated: players.length > limit,
          players: players.slice(0, limit).map(compactPlayer),
          sourceLimit: 'Sleeper player records are not an official NFL roster or transaction source.',
        };
      },
    }),

    getUserLeagues: tool({
      description:
        'Get an NFL user and that user\'s Sleeper leagues for one season.',
      inputSchema: z.object({
        user: identifierSchema,
        season: z
          .string()
          .regex(/^20\d{2}$/)
          .optional()
          .describe('The four-digit season. The current Sleeper league season is the default.'),
      }),
      inputExamples: [
        { input: { user: 'example_user', season: '2026' } },
      ],
      execute: async ({ user: identifier, season }) => {
        const [user, state] = await Promise.all([
          client.getUser(identifier),
          season ? Promise.resolve(null) : client.getNflState(),
        ]);
        const selectedSeason = season ?? state?.league_season ?? state?.season;
        if (!selectedSeason) {
          throw new Error('Sleeper did not return a league season.');
        }
        return {
          user,
          season: selectedSeason,
          leagues: await client.getUserLeagues(user.user_id, selectedSeason),
        };
      },
    }),

    getLeagueTeams: tool({
      description:
        'List fantasy team names and owner names for a Sleeper league. Use this for team-name or league-member questions.',
      inputSchema: z.object({ leagueId: leagueIdSchema }),
      execute: async ({ leagueId }) => ({
        leagueId,
        teams: (await client.getLeagueUsers(leagueId)).map((user) => ({
          userId: user.user_id,
          teamName: user.metadata?.team_name?.trim() || null,
          displayName: user.display_name ?? user.username ?? null,
          isCommissioner: user.is_owner ?? null,
        })),
      }),
    }),

    getLeagueOverview: tool({
      description:
        'Get league settings, users, rosters, records, and roster player IDs for a Sleeper league.',
      inputSchema: z.object({ leagueId: leagueIdSchema }),
      inputExamples: [
        { input: { leagueId: '123456789012345678' } },
      ],
      execute: async ({ leagueId }) => {
        const [league, users, rosters] = await Promise.all([
          client.getLeague(leagueId),
          client.getLeagueUsers(leagueId),
          client.getLeagueRosters(leagueId),
        ]);
        return { league, users, rosters };
      },
    }),

    getRosterPlayers: tool({
      description:
        'Get one fantasy roster and resolve its Sleeper player IDs into current player records.',
      inputSchema: z.object({
        leagueId: leagueIdSchema,
        rosterId: z.number().int().positive(),
      }),
      inputExamples: [
        { input: { leagueId: '123456789012345678', rosterId: 4 } },
      ],
      execute: async ({ leagueId, rosterId }) => {
        const details = await analysis.getRosterDetails(leagueId, rosterId);
        return {
          roster: details.roster,
          players: details.players.map(compactPlayer),
          missingPlayerIds: details.missingPlayerIds,
        };
      },
    }),

    getLeagueMatchups: tool({
      description:
        'Get every fantasy roster matchup and score for one Sleeper league week.',
      inputSchema: z.object({ leagueId: leagueIdSchema, week: weekSchema }),
      inputExamples: [
        { input: { leagueId: '123456789012345678', week: 8 } },
      ],
      execute: async ({ leagueId, week }) => ({
        leagueId,
        week,
        matchups: await client.getLeagueMatchups(leagueId, week),
      }),
    }),

    getLeagueTransactions: tool({
      description:
        'Get completed and pending trades, waivers, and free-agent moves for one league week.',
      inputSchema: z.object({ leagueId: leagueIdSchema, week: weekSchema }),
      inputExamples: [
        { input: { leagueId: '123456789012345678', week: 8 } },
      ],
      execute: async ({ leagueId, week }) => ({
        leagueId,
        week,
        transactions: await client.getLeagueTransactions(leagueId, week),
      }),
    }),

    getTrendingPlayers: tool({
      description:
        'Get the most added or dropped Sleeper players and resolve each player record.',
      inputSchema: z.object({
        type: z.enum(['add', 'drop']),
        lookbackHours: z.number().int().min(1).max(168).optional().default(24),
        limit: z.number().int().min(1).max(50).optional().default(25),
      }),
      inputExamples: [
        { input: { type: 'add', lookbackHours: 24, limit: 10 } },
      ],
      execute: async ({ type, lookbackHours, limit }) => ({
        type,
        lookbackHours,
        players: (
          await client.getResolvedTrendingPlayers(type, lookbackHours, limit)
        ).map((item) => ({
          playerId: item.player_id,
          count: item.count,
          player: item.player ? compactPlayer(item.player) : null,
        })),
        source: 'Sleeper trending add and drop activity',
      }),
    }),

    analyzeLeague: tool({
      description:
        'Rank every fantasy roster and describe scoring strengths, weaknesses, recent form, consistency, and schedule context.',
      inputSchema: z.object({
        leagueId: leagueIdSchema,
        throughWeek: analysisWeekSchema,
      }),
      inputExamples: [
        { input: { leagueId: '123456789012345678', throughWeek: 8 } },
      ],
      execute: async ({ leagueId, throughWeek }) =>
        analysis.analyzeLeague(leagueId, throughWeek),
    }),

    predictMatchup: tool({
      description:
        'Compare two fantasy rosters using prior Sleeper scores. Requires at least two completed scores per roster. For Week 1 or current starter and news analysis, use projectPlayers instead.',
      inputSchema: z.object({
        leagueId: leagueIdSchema,
        rosterAId: z.number().int().positive(),
        rosterBId: z.number().int().positive(),
        throughWeek: analysisWeekSchema,
      }),
      inputExamples: [
        {
          input: {
            leagueId: '123456789012345678',
            rosterAId: 4,
            rosterBId: 7,
            throughWeek: 8,
          },
        },
      ],
      execute: async ({ leagueId, rosterAId, rosterBId, throughWeek }) =>
        analysis.predictMatchup(
          leagueId,
          rosterAId,
          rosterBId,
          throughWeek,
        ),
    }),
  };
}

function compactPlayer(player: SleeperPlayer) {
  return {
    playerId: player.player_id,
    name:
      player.full_name ??
      [player.first_name, player.last_name].filter(Boolean).join(' '),
    position: player.position ?? null,
    fantasyPositions: player.fantasy_positions ?? [],
    team: player.team ?? null,
    active: player.active ?? null,
    status: player.status ?? null,
    injuryStatus: player.injury_status ?? null,
    injuryBodyPart: player.injury_body_part ?? null,
    injuryNotes: player.injury_notes ?? null,
    practiceParticipation: player.practice_participation ?? null,
    depthChartPosition: player.depth_chart_position ?? null,
    depthChartOrder: player.depth_chart_order ?? null,
    number: player.number ?? null,
    age: player.age ?? null,
    yearsExperience: player.years_exp ?? null,
  };
}

function compareTeamPlayers(left: SleeperPlayer, right: SleeperPlayer): number {
  const position = (left.position ?? '').localeCompare(right.position ?? '');
  if (position !== 0) {
    return position;
  }
  const leftName = left.full_name ?? `${left.first_name ?? ''} ${left.last_name ?? ''}`;
  const rightName = right.full_name ?? `${right.first_name ?? ''} ${right.last_name ?? ''}`;
  return leftName.localeCompare(rightName);
}
