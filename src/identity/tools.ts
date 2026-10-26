import { tool } from 'ai';
import { z } from 'zod';

import { NflverseApiError, NflverseClient } from '../nflverse/client.js';
import { SleeperClient } from '../sleeper/client.js';
import type { SleeperPlayer } from '../sleeper/types.js';
import { normalizePlayerName } from './normalize.js';
import {
  buildPlayerIdentityRegistry,
  playerSeedFromNflverse,
  playerSeedFromSleeper,
} from './players.js';
import { TeamIdentityRegistry } from './teams.js';
import { IdentityRepository } from './repository.js';
import type { PlayerIdentityLink } from './types.js';

const seasonSchema = z.number().int().min(1999).max(2100);
const FANTASY_SKILL_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K']);

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
        const loadNflverseStats = (queryName: string, targetSeason: number) =>
          nflverse.getPlayerWeeklyStats({
            playerName: queryName,
            season: targetSeason,
            seasonType: 'REG',
            ...(position ? { position } : {}),
            ...(teamCode ? { team: teamCode } : {}),
          }).catch((error: unknown) => {
            if (error instanceof NflverseApiError && error.status === 404) return [];
            throw error;
          });
        const [rawSleeperPlayers, initialNflverseRows] = await Promise.all([
          sleeper.findPlayers(name, {
            active: false,
            ...(position ? { position } : {}),
            limit: 25,
          }),
          loadNflverseStats(name, season),
        ]);
        let nflverseRows = initialNflverseRows;
        if (nflverseRows.length === 0) {
          nflverseRows = await loadNflverseStats(name, season - 1);
        }
        const sleeperPlayers = disambiguateSleeperCandidates(
          rawSleeperPlayers,
          name,
          position,
          nflverseRows,
        );
        const exactSleeper = sleeperPlayers.find((p) => p.player_id === name.trim()) ??
          (sleeperPlayers.length === 1 ? sleeperPlayers[0] : undefined);
        if (nflverseRows.length === 0 && exactSleeper?.full_name && exactSleeper.full_name !== name.trim()) {
          nflverseRows = await loadNflverseStats(exactSleeper.full_name, season);
          if (nflverseRows.length === 0) {
            nflverseRows = await loadNflverseStats(exactSleeper.full_name, season - 1);
          }
        }
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
            sleeperPlayers: rawSleeperPlayers.length,
          },
        };
      },
    }),
  };
}

function disambiguateSleeperCandidates(
  players: readonly SleeperPlayer[],
  queryName: string,
  requestedPosition: string | undefined,
  nflverseRows: ReadonlyArray<{ playerId: string; position: string }>,
): SleeperPlayer[] {
  if (players.length <= 1 || players.some((player) => player.player_id === queryName.trim())) {
    return [...players];
  }
  const normalizedQuery = normalizePlayerName(queryName);
  const gsisIds = new Set(nflverseRows.map((row) => row.playerId));
  const exactMatches = players.filter((player) => {
    const candidateName = player.full_name ?? [player.first_name, player.last_name].filter(Boolean).join(' ');
    return normalizePlayerName(candidateName) === normalizedQuery;
  });
  let narrowed = [...players];
  if (exactMatches.length > 1) {
    const activeExact = exactMatches.filter(
      (player) => player.active !== false || (player.gsis_id ? gsisIds.has(player.gsis_id.trim()) : false),
    );
    if (activeExact.length >= 1 && activeExact.length < exactMatches.length) {
      const keepIds = new Set(activeExact.map((player) => player.player_id));
      narrowed = narrowed.filter(
        (player) => !exactMatches.includes(player) || keepIds.has(player.player_id),
      );
    }
  }
  if (!requestedPosition) {
    const remainingExact = narrowed.filter((player) => {
      const candidateName = player.full_name ?? [player.first_name, player.last_name].filter(Boolean).join(' ');
      return normalizePlayerName(candidateName) === normalizedQuery;
    });
    if (remainingExact.length > 1) {
      const skillExact = remainingExact.filter((player) =>
        FANTASY_SKILL_POSITIONS.has(player.position?.toUpperCase() ?? ''),
      );
      if (skillExact.length === 1) {
        const keepId = skillExact[0]!.player_id;
        narrowed = narrowed.filter(
          (player) => !remainingExact.includes(player) || player.player_id === keepId,
        );
      }
    }
  }
  return narrowed;
}
