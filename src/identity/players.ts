import type { NflversePlayerWeek } from '../nflverse/types.js';
import type { SleeperPlayer } from '../sleeper/types.js';
import { normalizePlayerName, normalizePosition, sourceIdentityKey } from './normalize.js';
import { TeamIdentityRegistry } from './teams.js';
import type {
  CanonicalPlayerIdentity,
  IdentityResolution,
  PlayerIdentityBuildResult,
  PlayerIdentityIssue,
  PlayerIdentityLink,
  PlayerIdentitySeed,
  SourceIdentity,
} from './types.js';

export interface PlayerNameQuery {
  name: string;
  position?: string;
  team?: string;
}

export interface BuildPlayerIdentityOptions {
  automaticMatching?: 'name-position' | 'off' | 'strict';
  links?: readonly PlayerIdentityLink[];
  teamRegistry?: TeamIdentityRegistry;
}

interface PreparedSeed {
  aliases: string[];
  canonicalId: string | null;
  displayName: string;
  normalizedName: string;
  position: string | null;
  source: SourceIdentity;
  teamId: string | null;
}

export class PlayerIdentityRegistry {
  private readonly byCanonicalId = new Map<string, CanonicalPlayerIdentity>();
  private readonly byName = new Map<string, CanonicalPlayerIdentity[]>();
  private readonly bySourceId = new Map<string, CanonicalPlayerIdentity>();

  constructor(players: readonly CanonicalPlayerIdentity[]) {
    for (const input of players) {
      const player = clonePlayer(input);
      if (this.byCanonicalId.has(player.canonicalId)) {
        throw new Error(`The canonical player ID ${player.canonicalId} is duplicated.`);
      }
      this.byCanonicalId.set(player.canonicalId, player);
      for (const source of player.sourceIdentities) {
        const key = sourceIdentityKey(source);
        if (this.bySourceId.has(key)) {
          throw new Error(`The player source identity ${key} is duplicated.`);
        }
        this.bySourceId.set(key, player);
      }
      const names = unique([player.displayName, ...player.aliases]);
      for (const name of names) {
        const normalized = normalizePlayerName(name);
        if (!normalized) continue;
        const candidates = this.byName.get(normalized) ?? [];
        if (!candidates.some((candidate) => candidate.canonicalId === player.canonicalId)) {
          candidates.push(player);
        }
        this.byName.set(normalized, candidates);
      }
    }
  }

  list(): CanonicalPlayerIdentity[] {
    return [...this.byCanonicalId.values()]
      .map(clonePlayer)
      .sort((left, right) =>
        left.displayName.localeCompare(right.displayName) ||
        left.canonicalId.localeCompare(right.canonicalId),
      );
  }

  get(canonicalId: string): CanonicalPlayerIdentity | undefined {
    const player = this.byCanonicalId.get(canonicalId);
    return player ? clonePlayer(player) : undefined;
  }

  resolveCanonical(canonicalId: string): IdentityResolution<CanonicalPlayerIdentity> {
    const player = this.byCanonicalId.get(canonicalId);
    if (!player) {
      return missing(canonicalId, `No player uses the canonical ID ${canonicalId}.`);
    }
    return resolved(player, 'canonical-id', canonicalId, 'exact');
  }

  resolveSource(
    provider: string,
    sourceId: string,
  ): IdentityResolution<CanonicalPlayerIdentity> {
    const key = sourceIdentityKey({ provider, id: sourceId });
    const player = this.bySourceId.get(key);
    if (!player) {
      return missing(key, `No canonical player maps to the source identity ${key}.`);
    }
    return resolved(player, 'source-id', key, 'exact');
  }

  resolveName(
    input: string | PlayerNameQuery,
  ): IdentityResolution<CanonicalPlayerIdentity> {
    const query = typeof input === 'string' ? { name: input } : input;
    const normalizedQuery = normalizePlayerName(query.name);
    const position = normalizePosition(query.position);
    const teamId = query.team ? normalizeTeamId(query.team) : null;
    const candidates = (this.byName.get(normalizedQuery) ?? []).filter(
      (player) =>
        (!position || player.position === position) &&
        (!teamId || player.teamId === teamId),
    );
    if (candidates.length === 1 && candidates[0]) {
      return resolved(
        candidates[0],
        'normalized-name',
        query.name,
        normalizedQuery === query.name ? 'exact' : 'normalized',
      );
    }
    if (candidates.length > 1) {
      return {
        status: 'ambiguous',
        candidates: candidates.map(clonePlayer),
        normalizedQuery,
        reason: `The player query matches ${candidates.length} identities. Add a position, team, or source ID.`,
      };
    }
    return missing(normalizedQuery, `No canonical player matches "${query.name}" with the supplied filters.`);
  }

  serialize(): string {
    return JSON.stringify({ schemaVersion: 1, players: this.list() });
  }

  static deserialize(value: string): PlayerIdentityRegistry {
    const parsed: unknown = JSON.parse(value);
    if (!isSerializedPlayers(parsed)) {
      throw new Error('The serialized player identity catalog is invalid.');
    }
    return new PlayerIdentityRegistry(parsed.players);
  }
}

export function buildPlayerIdentityRegistry(
  seeds: readonly PlayerIdentitySeed[],
  options: BuildPlayerIdentityOptions = {},
): PlayerIdentityBuildResult {
  const teamRegistry = options.teamRegistry ?? new TeamIdentityRegistry();
  const issues: PlayerIdentityIssue[] = [];
  const prepared = prepareSeeds(seeds, teamRegistry, issues);
  const parent = new Map<string, string>();
  for (const seed of prepared) parent.set(sourceIdentityKey(seed.source), sourceIdentityKey(seed.source));

  for (const link of options.links ?? []) {
    const present = link.members
      .map(sourceIdentityKey)
      .filter((key) => parent.has(key));
    const first = present[0];
    if (first) {
      for (const key of present.slice(1)) union(parent, first, key);
    }
  }

  const automaticMatching = options.automaticMatching ?? 'strict';
  if (automaticMatching !== 'off') {
    applyAutomaticMatches(
      prepared,
      parent,
      automaticMatching,
      issues,
    );
  }

  const groups = new Map<string, PreparedSeed[]>();
  for (const seed of prepared) {
    const root = find(parent, sourceIdentityKey(seed.source));
    const members = groups.get(root) ?? [];
    members.push(seed);
    groups.set(root, members);
  }

  const linkIds = new Map<string, string[]>();
  for (const link of options.links ?? []) {
    if (!link.canonicalId) continue;
    for (const member of link.members) {
      const key = sourceIdentityKey(member);
      if (!parent.has(key)) continue;
      const root = find(parent, key);
      const ids = linkIds.get(root) ?? [];
      ids.push(link.canonicalId);
      linkIds.set(root, ids);
    }
  }

  const players = [...groups.entries()].map(([root, members]) => {
    const requestedIds = unique([
      ...(linkIds.get(root) ?? []),
      ...members.flatMap((member) => member.canonicalId ? [member.canonicalId] : []),
    ]);
    if (requestedIds.length > 1) {
      issues.push({
        code: 'conflicting-canonical-ids',
        candidates: members.map((member) => ({ ...member.source })),
        message: `One linked player group requested several canonical IDs: ${requestedIds.join(', ')}.`,
      });
    }
    return combinePlayer(members, requestedIds[0]);
  });

  return { registry: new PlayerIdentityRegistry(players), issues };
}

export function playerSeedFromSleeper(player: SleeperPlayer): PlayerIdentitySeed {
  const displayName =
    player.full_name?.trim() ||
    [player.first_name, player.last_name].filter(Boolean).join(' ').trim();
  return {
    sourceProvider: 'sleeper',
    sourceId: player.player_id,
    displayName,
    ...(player.position !== undefined ? { position: player.position } : {}),
    ...(player.team !== undefined ? { team: player.team } : {}),
    aliases: [player.search_full_name ?? ''].filter(Boolean),
  };
}

export function playerSeedFromNflverse(row: NflversePlayerWeek): PlayerIdentitySeed {
  return {
    sourceProvider: 'nflverse',
    sourceId: row.playerId,
    displayName: row.playerDisplayName,
    position: row.position,
    team: row.team,
  };
}

function prepareSeeds(
  seeds: readonly PlayerIdentitySeed[],
  teamRegistry: TeamIdentityRegistry,
  issues: PlayerIdentityIssue[],
): PreparedSeed[] {
  const bySource = new Map<string, PreparedSeed>();
  for (const input of seeds) {
    const source = { provider: input.sourceProvider, id: input.sourceId.trim() };
    const key = sourceIdentityKey(source);
    const displayName = input.displayName.trim();
    const normalizedName = normalizePlayerName(displayName);
    if (!normalizedName) {
      issues.push({
        code: 'empty-name',
        candidates: [source],
        message: `The player source identity ${key} has no usable name.`,
      });
      continue;
    }
    const teamId = resolveTeamId(input.team, input.sourceProvider, teamRegistry);
    const next: PreparedSeed = {
      aliases: unique([displayName, ...(input.aliases ?? [])]),
      canonicalId: input.canonicalId?.trim() || null,
      displayName,
      normalizedName,
      position: normalizePosition(input.position),
      source,
      teamId,
    };
    const previous = bySource.get(key);
    if (!previous) {
      bySource.set(key, next);
      continue;
    }
    if (
      previous.normalizedName !== next.normalizedName ||
      previous.position !== next.position
    ) {
      issues.push({
        code: 'duplicate-source-identity',
        candidates: [source],
        message: `The source identity ${key} has conflicting names or positions.`,
      });
    }
    previous.aliases = unique([...previous.aliases, ...next.aliases]);
    previous.teamId = next.teamId ?? previous.teamId;
    previous.canonicalId = next.canonicalId ?? previous.canonicalId;
  }
  return [...bySource.values()];
}

function applyAutomaticMatches(
  seeds: readonly PreparedSeed[],
  parent: Map<string, string>,
  strategy: 'name-position' | 'strict',
  issues: PlayerIdentityIssue[],
): void {
  const candidates = new Map<string, PreparedSeed[]>();
  for (const seed of seeds) {
    const teamPart = strategy === 'strict' ? seed.teamId ?? 'unknown-team' : '';
    const key = `${seed.normalizedName}|${seed.position ?? 'unknown-position'}|${teamPart}`;
    const matches = candidates.get(key) ?? [];
    matches.push(seed);
    candidates.set(key, matches);
  }
  for (const matches of candidates.values()) {
    if (matches.length < 2) continue;
    const providers = new Set(matches.map((match) => match.source.provider));
    const uniqueProviderCount = providers.size === matches.length;
    if (!uniqueProviderCount) {
      issues.push({
        code: 'ambiguous-automatic-match',
        candidates: matches.map((match) => ({ ...match.source })),
        message: 'Automatic matching found more than one candidate from the same provider.',
      });
      continue;
    }
    const first = matches[0];
    if (!first) continue;
    const firstKey = sourceIdentityKey(first.source);
    for (const match of matches.slice(1)) {
      union(parent, firstKey, sourceIdentityKey(match.source));
    }
  }
}

function combinePlayer(
  members: readonly PreparedSeed[],
  requestedCanonicalId: string | undefined,
): CanonicalPlayerIdentity {
  const preferred =
    members.find((member) => member.source.provider === 'nflverse') ?? members[0];
  if (!preferred) throw new Error('A canonical player needs at least one source identity.');
  const sourceIdentities = members
    .map((member) => ({ ...member.source }))
    .sort((left, right) => sourceIdentityKey(left).localeCompare(sourceIdentityKey(right)));
  const generatedId = `nfl-player:${preferred.source.provider}:${encodeURIComponent(preferred.source.id)}`;
  const positions = unique(members.flatMap((member) => member.position ? [member.position] : []));
  const teams = unique(members.flatMap((member) => member.teamId ? [member.teamId] : []));
  return {
    canonicalId: requestedCanonicalId ?? generatedId,
    displayName: preferred.displayName,
    normalizedName: preferred.normalizedName,
    position: positions.length === 1 ? positions[0] ?? null : preferred.position,
    teamId: teams.length === 1 ? teams[0] ?? null : preferred.teamId,
    aliases: unique(members.flatMap((member) => member.aliases)),
    sourceIdentities,
  };
}

function resolveTeamId(
  team: string | null | undefined,
  provider: string,
  registry: TeamIdentityRegistry,
): string | null {
  if (!team?.trim()) return null;
  const sourceResolution = registry.resolveSource(provider, team);
  if (sourceResolution.status === 'resolved') return sourceResolution.identity.canonicalId;
  const aliasResolution = registry.resolve(team);
  return aliasResolution.status === 'resolved' ? aliasResolution.identity.canonicalId : null;
}

function normalizeTeamId(team: string): string {
  if (team.startsWith('nfl-team:')) return team;
  const resolution = new TeamIdentityRegistry().resolve(team);
  return resolution.status === 'resolved' ? resolution.identity.canonicalId : team;
}

function resolved(
  player: CanonicalPlayerIdentity,
  matchKind: 'canonical-id' | 'normalized-name' | 'source-id',
  matchedValue: string,
  confidence: 'exact' | 'normalized',
): IdentityResolution<CanonicalPlayerIdentity> {
  return { status: 'resolved', identity: clonePlayer(player), confidence, matchKind, matchedValue };
}

function missing(normalizedQuery: string, reason: string): IdentityResolution<CanonicalPlayerIdentity> {
  return { status: 'not-found', normalizedQuery, reason };
}

function clonePlayer(player: CanonicalPlayerIdentity): CanonicalPlayerIdentity {
  return {
    ...player,
    aliases: [...player.aliases],
    sourceIdentities: player.sourceIdentities.map((identity) => ({ ...identity })),
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function find(parent: Map<string, string>, key: string): string {
  const direct = parent.get(key);
  if (!direct) throw new Error(`The identity graph does not contain ${key}.`);
  if (direct === key) return key;
  const root = find(parent, direct);
  parent.set(key, root);
  return root;
}

function union(parent: Map<string, string>, left: string, right: string): void {
  const leftRoot = find(parent, left);
  const rightRoot = find(parent, right);
  if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
}

function isSerializedPlayers(
  value: unknown,
): value is { schemaVersion: 1; players: CanonicalPlayerIdentity[] } {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1 && Array.isArray(record.players) && record.players.every(isPlayer);
}

function isPlayer(value: unknown): value is CanonicalPlayerIdentity {
  if (!value || typeof value !== 'object') return false;
  const player = value as Record<string, unknown>;
  return (
    typeof player.canonicalId === 'string' &&
    typeof player.displayName === 'string' &&
    typeof player.normalizedName === 'string' &&
    (typeof player.position === 'string' || player.position === null) &&
    (typeof player.teamId === 'string' || player.teamId === null) &&
    Array.isArray(player.aliases) &&
    player.aliases.every((alias) => typeof alias === 'string') &&
    Array.isArray(player.sourceIdentities) &&
    player.sourceIdentities.every((identity) => {
      if (!identity || typeof identity !== 'object') return false;
      const source = identity as Record<string, unknown>;
      return typeof source.provider === 'string' && typeof source.id === 'string';
    })
  );
}
