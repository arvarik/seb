import {
  getSharedSebDatabase,
  type IdentityRecord,
  type SebDatabase,
} from '../data/sqlite-store.js';
import type { CanonicalPlayerIdentity, CanonicalTeamIdentity } from './types.js';

export class IdentityRepository {
  constructor(private readonly database: SebDatabase = getSharedSebDatabase()) {}

  savePlayer(identity: CanonicalPlayerIdentity): CanonicalPlayerIdentity {
    return this.database.putIdentity({
      canonicalId: identity.canonicalId,
      entityType: 'player',
      sourceIdentities: identity.sourceIdentities,
      value: identity,
    }).value;
  }

  saveTeam(identity: CanonicalTeamIdentity): CanonicalTeamIdentity {
    return this.database.putIdentity({
      canonicalId: identity.canonicalId,
      entityType: 'team',
      sourceIdentities: identity.sourceIdentities,
      value: identity,
    }).value;
  }

  getPlayerBySource(provider: string, sourceId: string): CanonicalPlayerIdentity | null {
    return this.database.getIdentityBySource<CanonicalPlayerIdentity>(
      'player',
      provider,
      sourceId,
    )?.value ?? null;
  }

  getTeamBySource(provider: string, sourceId: string): CanonicalTeamIdentity | null {
    return this.database.getIdentityBySource<CanonicalTeamIdentity>(
      'team',
      provider,
      sourceId,
    )?.value ?? null;
  }

  getPlayer(canonicalId: string): CanonicalPlayerIdentity | null {
    return this.database.getIdentity<CanonicalPlayerIdentity>('player', canonicalId)?.value ?? null;
  }

  getTeam(canonicalId: string): CanonicalTeamIdentity | null {
    return this.database.getIdentity<CanonicalTeamIdentity>('team', canonicalId)?.value ?? null;
  }

  record<T extends CanonicalPlayerIdentity | CanonicalTeamIdentity>(
    entityType: 'player' | 'team',
    canonicalId: string,
  ): IdentityRecord<T> | null {
    return this.database.getIdentity<T>(entityType, canonicalId);
  }
}
