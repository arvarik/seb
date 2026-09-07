import { tool } from 'ai';
import { z } from 'zod';
import type { SleeperClient } from '../sleeper/client.js';
import { SleeperAnalysisService } from '../sleeper/analysis-service.js';
import { simulatePlayoffOdds, type RemainingMatchup } from './playoffs.js';

export function createPlayoffTools(client: SleeperClient) {
  return { simulatePlayoffOdds: tool({
    description: 'Estimate league playoff qualification odds from completed scores and an available future schedule. Reject unsupported divisions or missing matchups.',
    inputSchema: z.object({ leagueId: z.string().regex(/^\d+$/),
      throughWeek: z.number().int().min(2).max(17), simulations: z.number().int().min(100).max(50_000).default(10_000) }),
    execute: async ({ leagueId, throughWeek, simulations }) => {
      const league = await client.getLeague(leagueId);
      if (Number(league.settings.divisions ?? 0) > 0) throw new Error('Division playoff seeding is not supported by this simulation.');
      const start = Number(league.settings.playoff_week_start);
      const spots = Number(league.settings.playoff_teams);
      if (!Number.isInteger(start) || start <= throughWeek || start > 18 || !Number.isInteger(spots) || spots < 1) {
        throw new Error('The league needs a valid future playoff start and playoff team count.');
      }
      const analysis = await new SleeperAnalysisService(client).analyzeLeague(leagueId, throughWeek);
      const weeks = await Promise.all(Array.from({ length: start - throughWeek - 1 }, async (_, index) => {
        const week = throughWeek + index + 1;
        return { week, games: await client.getLeagueMatchups(leagueId, week) };
      }));
      const matchups: RemainingMatchup[] = [];
      for (const { week, games } of weeks) {
        const groups = new Map<number, number[]>();
        for (const game of games) {
          if (game.matchup_id === null) continue;
          const ids = groups.get(game.matchup_id) ?? []; ids.push(game.roster_id); groups.set(game.matchup_id, ids);
        }
        if (!groups.size || [...groups.values()].some((ids) => ids.length !== 2)) throw new Error(`Week ${week} has no complete fantasy schedule. Seb cannot infer opponents.`);
        for (const ids of groups.values()) matchups.push({ week, rosterA: ids[0]!, rosterB: ids[1]! });
      }
      return simulatePlayoffOdds({ analysis, matchups, playoffTeams: spots, simulations,
        medianMatch: league.settings.league_average_match === 1 });
    },
  }) };
}
