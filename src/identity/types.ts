export type IdentityProvider = 'nflverse' | 'sleeper' | (string & {});

export interface SourceIdentity {
  id: string;
  provider: IdentityProvider;
}

export interface CanonicalTeamIdentity {
  aliases: string[];
  canonicalId: string;
  city: string;
  code: string;
  name: string;
  sourceIdentities: SourceIdentity[];
}

export interface CanonicalPlayerIdentity {
  aliases: string[];
  canonicalId: string;
  displayName: string;
  normalizedName: string;
  position: string | null;
  sourceIdentities: SourceIdentity[];
  teamId: string | null;
}

export type IdentityMatchKind =
  | 'alias'
  | 'canonical-id'
  | 'normalized-name'
  | 'source-id';

export interface ResolvedIdentity<T> {
  confidence: 'exact' | 'normalized';
  identity: T;
  matchKind: IdentityMatchKind;
  matchedValue: string;
  status: 'resolved';
}

export interface AmbiguousIdentity<T> {
  candidates: T[];
  normalizedQuery: string;
  reason: string;
  status: 'ambiguous';
}

export interface MissingIdentity {
  normalizedQuery: string;
  reason: string;
  status: 'not-found';
}

export type IdentityResolution<T> =
  | AmbiguousIdentity<T>
  | MissingIdentity
  | ResolvedIdentity<T>;

export interface PlayerIdentitySeed {
  aliases?: readonly string[];
  canonicalId?: string;
  displayName: string;
  position?: string | null;
  sourceId: string;
  sourceProvider: IdentityProvider;
  team?: string | null;
}

export interface PlayerIdentityLink {
  canonicalId?: string;
  members: readonly SourceIdentity[];
}

export interface PlayerIdentityIssue {
  candidates: SourceIdentity[];
  code:
    | 'ambiguous-automatic-match'
    | 'conflicting-canonical-ids'
    | 'duplicate-source-identity'
    | 'empty-name';
  message: string;
}

export interface PlayerIdentityBuildResult {
  issues: PlayerIdentityIssue[];
  registry: import('./players.js').PlayerIdentityRegistry;
}
