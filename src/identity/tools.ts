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
import type { PlayerIdentityLink } from './types.js';

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
      inputExamples: [
        { input: { query: 'Seattle Seahawks' } },
        { input: { query: 'JAX', provider: 'nflverse' } },
      ],
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
      inputExamples: [
        {
          input: {
            name: 'Justin Jefferson',
            season: 2026,
            position: 'WR',
            team: 'MIN',
          },
        },
      ],
      execute: async ({ name, season, position, team }) => {
        const teamResolution = team ? teams.resolve(team) : null;
        if (teamResolution?.status === 'ambiguous') {
          return teamResolution;
        }
        if (teamResolution?.status === 'not-found') {
          return teamResolution;
        }
        const teamCode = teamResolution?.identity.code;
        const sleeperPlayers = await sleeper.findPlayers(name, {
          active: false,
          ...(position ? { position } : {}),
          limit: 25,
        });
        const exactSleeperMatch = sleeperPlayers.find((p) => p.player_id === name.trim());
        const nflversePlayerName = exactSleeperMatch
          ? (exactSleeperMatch.full_name ?? name)
          : sleeperPlayers.length === 1 && sleeperPlayers[0]?.full_name
            ? sleeperPlayers[0].full_name
            : name;
        const nflverseRows = await nflverse.getPlayerWeeklyStats({
          season,
          playerName: nflversePlayerName,
          seasonType: 'REG',
          ...(position ? { position } : {}),
          ...(teamCode ? { team: teamCode } : {}),
        });
        const links: PlayerIdentityLink[] = [];
        for (const p of sleeperPlayers) {
          const gsisId = p.gsis_id?.trim();
          if (gsisId) {
            links.push({
              members: [
                { provider: 'sleeper', id: p.player_id },
                { provider: 'nflverse', id: gsisId },
              ],
            });
          }
        }
        const build = buildPlayerIdentityRegistry(
          [
            ...sleeperPlayers.map(playerSeedFromSleeper),
            ...nflverseRows.map(playerSeedFromNflverse),
          ],
          { automaticMatching: 'strict', links, teamRegistry: teams },
        );
        let resolution = build.registry.resolveName({
          name,
          ...(position ? { position } : {}),
          ...(teamResolution?.status === 'resolved'
            ? { team: teamResolution.identity.canonicalId }
            : {}),
        });
        if (resolution.status === 'not-found') {
          const sourceRes = build.registry.resolveSource('sleeper', name.trim());
          if (sourceRes.status === 'resolved') {
            resolution = sourceRes;
          } else {
            const canonicalRes = build.registry.resolveCanonical(name.trim());
            if (canonicalRes.status === 'resolved') {
              resolution = canonicalRes;
            }
          }
        }
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
