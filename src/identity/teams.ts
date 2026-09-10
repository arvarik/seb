import { normalizeTeamText, sourceIdentityKey } from './normalize.js';
import type {
  CanonicalTeamIdentity,
  IdentityResolution,
  SourceIdentity,
} from './types.js';

interface TeamDefinition {
  aliases?: readonly string[];
  city: string;
  code: string;
  historicCodes?: readonly string[];
  name: string;
}

const TEAM_DEFINITIONS: readonly TeamDefinition[] = [
  { code: 'ARI', city: 'Arizona', name: 'Cardinals', aliases: ['Arizona Cardinals', 'Cards', 'ARZ', 'Phoenix Cardinals', 'St. Louis Cardinals'] },
  { code: 'ATL', city: 'Atlanta', name: 'Falcons', aliases: ['Atlanta Falcons'] },
  { code: 'BAL', city: 'Baltimore', name: 'Ravens', aliases: ['Baltimore Ravens'] },
  { code: 'BUF', city: 'Buffalo', name: 'Bills', aliases: ['Buffalo Bills'] },
  { code: 'CAR', city: 'Carolina', name: 'Panthers', aliases: ['Carolina Panthers'] },
  { code: 'CHI', city: 'Chicago', name: 'Bears', aliases: ['Chicago Bears'] },
  { code: 'CIN', city: 'Cincinnati', name: 'Bengals', aliases: ['Cincinnati Bengals'] },
  { code: 'CLE', city: 'Cleveland', name: 'Browns', aliases: ['Cleveland Browns'] },
  { code: 'DAL', city: 'Dallas', name: 'Cowboys', aliases: ['Dallas Cowboys'] },
  { code: 'DEN', city: 'Denver', name: 'Broncos', aliases: ['Denver Broncos'] },
  { code: 'DET', city: 'Detroit', name: 'Lions', aliases: ['Detroit Lions'] },
  { code: 'GB', city: 'Green Bay', name: 'Packers', aliases: ['Green Bay Packers', 'GNB'] },
  { code: 'HOU', city: 'Houston', name: 'Texans', aliases: ['Houston Texans'] },
  { code: 'IND', city: 'Indianapolis', name: 'Colts', aliases: ['Indianapolis Colts', 'Baltimore Colts'] },
  { code: 'JAX', city: 'Jacksonville', name: 'Jaguars', aliases: ['Jacksonville Jaguars', 'JAC'] },
  { code: 'KC', city: 'Kansas City', name: 'Chiefs', aliases: ['Kansas City Chiefs', 'KAN'] },
  { code: 'LV', city: 'Las Vegas', name: 'Raiders', aliases: ['Las Vegas Raiders', 'Oakland Raiders', 'Los Angeles Raiders', 'LA'], historicCodes: ['OAK'] },
  { code: 'LAC', city: 'Los Angeles', name: 'Chargers', aliases: ['Los Angeles Chargers', 'San Diego Chargers', 'LA'], historicCodes: ['SD'] },
  { code: 'LAR', city: 'Los Angeles', name: 'Rams', aliases: ['Los Angeles Rams', 'St. Louis Rams', 'LA'], historicCodes: ['STL'] },
  { code: 'MIA', city: 'Miami', name: 'Dolphins', aliases: ['Miami Dolphins'] },
  { code: 'MIN', city: 'Minnesota', name: 'Vikings', aliases: ['Minnesota Vikings'] },
  { code: 'NE', city: 'New England', name: 'Patriots', aliases: ['New England Patriots', 'Boston Patriots', 'NWE'] },
  { code: 'NO', city: 'New Orleans', name: 'Saints', aliases: ['New Orleans Saints', 'NOR'] },
  { code: 'NYG', city: 'New York', name: 'Giants', aliases: ['New York Giants'] },
  { code: 'NYJ', city: 'New York', name: 'Jets', aliases: ['New York Jets'] },
  { code: 'PHI', city: 'Philadelphia', name: 'Eagles', aliases: ['Philadelphia Eagles'] },
  { code: 'PIT', city: 'Pittsburgh', name: 'Steelers', aliases: ['Pittsburgh Steelers'] },
  { code: 'SEA', city: 'Seattle', name: 'Seahawks', aliases: ['Seattle Seahawks'] },
  { code: 'SF', city: 'San Francisco', name: '49ers', aliases: ['San Francisco 49ers', 'SFO'] },
  { code: 'TB', city: 'Tampa Bay', name: 'Buccaneers', aliases: ['Tampa Bay Buccaneers', 'Bucs', 'TAM'] },
  { code: 'TEN', city: 'Tennessee', name: 'Titans', aliases: ['Tennessee Titans', 'Houston Oilers', 'Tennessee Oilers'], historicCodes: ['OIL'] },
  { code: 'WAS', city: 'Washington', name: 'Commanders', aliases: ['Washington Commanders', 'Washington Football Team', 'Washington Redskins', 'WSH', 'WFT'] },
];

export class TeamIdentityRegistry {
  private readonly aliases = new Map<string, CanonicalTeamIdentity[]>();
  private readonly canonical = new Map<string, CanonicalTeamIdentity>();
  private readonly sources = new Map<string, CanonicalTeamIdentity>();

  constructor(teams: readonly CanonicalTeamIdentity[] = defaultTeams()) {
    for (const input of teams) {
      const team = cloneTeam(input);
      if (this.canonical.has(team.canonicalId)) {
        throw new Error(`The canonical team ID ${team.canonicalId} is duplicated.`);
      }
      this.canonical.set(team.canonicalId, team);
      for (const identity of team.sourceIdentities) {
        const key = sourceIdentityKey(identity);
        if (this.sources.has(key)) {
          throw new Error(`The team source identity ${key} is duplicated.`);
        }
        this.sources.set(key, team);
      }
      for (const alias of team.aliases) {
        const normalized = normalizeTeamText(alias);
        const matches = this.aliases.get(normalized) ?? [];
        matches.push(team);
        this.aliases.set(normalized, matches);
      }
    }
  }

  list(): CanonicalTeamIdentity[] {
    return [...this.canonical.values()]
      .map(cloneTeam)
      .sort((left, right) => left.code.localeCompare(right.code));
  }

  get(canonicalId: string): CanonicalTeamIdentity | undefined {
    const team = this.canonical.get(canonicalId);
    return team ? cloneTeam(team) : undefined;
  }

  resolve(query: string): IdentityResolution<CanonicalTeamIdentity> {
    const canonical = this.canonical.get(query);
    if (canonical) {
      return resolved(canonical, 'canonical-id', query, 'exact');
    }
    const normalizedQuery = normalizeTeamText(query);
    const candidates = this.aliases.get(normalizedQuery) ?? [];
    if (candidates.length === 1 && candidates[0]) {
      return resolved(candidates[0], 'alias', query, normalizedQuery === query ? 'exact' : 'normalized');
    }
    if (candidates.length > 1) {
      return {
        status: 'ambiguous',
        candidates: candidates.map(cloneTeam),
        normalizedQuery,
        reason: `The team query matches ${candidates.length} franchises. Use a team code or a full team name.`,
      };
    }
    return {
      status: 'not-found',
      normalizedQuery,
      reason: `No canonical NFL team matches "${query}".`,
    };
  }

  resolveSource(
    provider: string,
    sourceId: string,
  ): IdentityResolution<CanonicalTeamIdentity> {
    const key = sourceIdentityKey({ provider, id: sourceId });
    const team = this.sources.get(key);
    if (!team) {
      return {
        status: 'not-found',
        normalizedQuery: key,
        reason: `No canonical NFL team maps to the source identity ${key}.`,
      };
    }
    return resolved(team, 'source-id', key, 'exact');
  }

  serialize(): string {
    return JSON.stringify({ schemaVersion: 1, teams: this.list() });
  }

  static deserialize(value: string): TeamIdentityRegistry {
    const parsed: unknown = JSON.parse(value);
    if (!isSerializedTeams(parsed)) {
      throw new Error('The serialized team identity catalog is invalid.');
    }
    return new TeamIdentityRegistry(parsed.teams);
  }
}

export function defaultTeams(): CanonicalTeamIdentity[] {
  return TEAM_DEFINITIONS.map((team) => {
    const sourceCodes = [team.code, ...(team.historicCodes ?? [])];
    const sourceIdentities: SourceIdentity[] = ['nflverse', 'sleeper'].flatMap(
      (provider) => sourceCodes.map((id) => ({ provider, id })),
    );
    if (team.code === 'LAR') sourceIdentities.push({ provider: 'nflverse', id: 'LA' });
    return {
      canonicalId: `nfl-team:${team.code}`,
      code: team.code,
      city: team.city,
      name: team.name,
      aliases: unique([team.code, team.city, team.name, ...(team.aliases ?? [])]),
      sourceIdentities,
    };
  });
}

function resolved(
  team: CanonicalTeamIdentity,
  matchKind: 'alias' | 'canonical-id' | 'source-id',
  matchedValue: string,
  confidence: 'exact' | 'normalized',
): IdentityResolution<CanonicalTeamIdentity> {
  return {
    status: 'resolved',
    identity: cloneTeam(team),
    confidence,
    matchKind,
    matchedValue,
  };
}

function cloneTeam(team: CanonicalTeamIdentity): CanonicalTeamIdentity {
  return {
    ...team,
    aliases: [...team.aliases],
    sourceIdentities: team.sourceIdentities.map((identity) => ({ ...identity })),
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function isSerializedTeams(
  value: unknown,
): value is { schemaVersion: 1; teams: CanonicalTeamIdentity[] } {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1 && Array.isArray(record.teams) && record.teams.every(isTeam);
}

function isTeam(value: unknown): value is CanonicalTeamIdentity {
  if (!value || typeof value !== 'object') return false;
  const team = value as Record<string, unknown>;
  return (
    typeof team.canonicalId === 'string' &&
    typeof team.code === 'string' &&
    typeof team.city === 'string' &&
    typeof team.name === 'string' &&
    Array.isArray(team.aliases) &&
    team.aliases.every((alias) => typeof alias === 'string') &&
    Array.isArray(team.sourceIdentities) &&
    team.sourceIdentities.every(isSourceIdentity)
  );
}

function isSourceIdentity(value: unknown): value is SourceIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Record<string, unknown>;
  return typeof identity.provider === 'string' && typeof identity.id === 'string';
}
