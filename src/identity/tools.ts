import { tool } from 'ai';
import { z } from 'zod';

import { NflverseClient } from '../nflverse/client.js';
import { SleeperClient } from '../sleeper/client.js';
import {
  buildPlayerIdentityRegistry,
  playerSeedFromNflverse,
  playerSeedFromSleeper,
} from './players.js';
import { TeamIdentityRegistry } from './teams.js';
import { IdentityRepository } from './repository.js';

const seasonSchema = z.number().int().min(1999).max(2100);

export function createIdentityTools(
  sleeper: SleeperClient,
  nflverse: NflverseClient,
  options: { repository?: IdentityRepository | false } = {},
) {
  const teams = new TeamIdentityRegistry();
  const repository = options.repository === false
    ? false
    : (options.repository ?? new IdentityRepository());
  return {
    resolveTeamIdentity: tool({
      description:
        'Resolve an NFL team code, full name, nickname, or historical alias to one canonical franchise identity.',
      inputSchema: z.object({
        query: z.string().trim().min(1).max(100),
        provider: z.enum(['sleeper', 'nflverse']).optional(),
      }),
      execute: async ({ query, provider }) => {
        const resolution = provider
          ? teams.resolveSource(provider, query)
          : teams.resolve(query);
        return resolution.status === 'resolved' && repository
          ? { ...resolution, identity: repository.saveTeam(resolution.identity) }
          : resolution;
      },
    }),
    resolvePlayerIdentity: tool({
      description:
        'Link matching Sleeper and nflverse player identifiers with a canonical identity. Report ambiguity instead of guessing.',
      inputSchema: z.object({
        name: z.string().trim().min(2).max(100),
        season: seasonSchema,
        position: z.string().trim().min(1).max(10).optional(),
        team: z.string().trim().min(2).max(100).optional(),
      }),
      execute: async ({ name, season, position, team }) => {
        const teamResolution = team ? teams.resolve(team) : null;
        if (teamResolution?.status === 'ambiguous') {
          return teamResolution;
        }
        if (teamResolution?.status === 'not-found') {
          return teamResolution;
        }
        const teamCode = teamResolution?.identity.code;
        const [sleeperPlayers, nflverseRows] = await Promise.all([
          sleeper.findPlayers(name, {
            active: false,
            ...(position ? { position } : {}),
            limit: 25,
          }),
          nflverse.getPlayerWeeklyStats({
            season,
            playerName: name,
            seasonType: 'REG',
            ...(position ? { position } : {}),
            ...(teamCode ? { team: teamCode } : {}),
          }),
        ]);
        const build = buildPlayerIdentityRegistry(
          [
            ...sleeperPlayers.map(playerSeedFromSleeper),
            ...nflverseRows.map(playerSeedFromNflverse),
          ],
          { automaticMatching: 'strict', teamRegistry: teams },
        );
        const resolution = build.registry.resolveName({
            name,
            ...(position ? { position } : {}),
            ...(teamResolution?.status === 'resolved'
              ? { team: teamResolution.identity.canonicalId }
              : {}),
          });
        const persisted = resolution.status === 'resolved' && repository
          ? { ...resolution, identity: repository.savePlayer(resolution.identity) }
          : resolution;
        return {
          resolution: persisted,
          issues: build.issues,
          sourceCounts: {
            nflverseRows: nflverseRows.length,
            sleeperPlayers: sleeperPlayers.length,
          },
        };
      },
    }),
  };
}
