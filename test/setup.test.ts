import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  SleeperLeague,
  SleeperRoster,
  SleeperUser,
} from '../src/sleeper/types.js';
import {
  FileSetupProfileStore,
  SETUP_PROFILE_SCHEMA_VERSION,
  type SebSetupProfile,
  type SetupProfileStore,
} from '../src/setup/profile.js';
import {
  applySetupProfile,
  checkGeminiApiKey,
  discoverOwnedRosters,
  runFirstRunSetup,
  SetupWizardError,
  type SleeperSetupDiscovery,
} from '../src/setup/wizard.js';
import { createSessionState } from '../src/interactive/session.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('Gemini API key setup check', () => {
  it('checks presence without returning or saving the secret', () => {
    const result = checkGeminiApiKey({
      GOOGLE_GENERATIVE_AI_API_KEY: 'top-secret-key',
    });

    expect(result.present).toBe(true);
    expect(JSON.stringify(result)).not.toContain('top-secret-key');
  });
});

describe('first-run setup wizard', () => {
  it('saves a team-independent season profile', async () => {
    const store = new MemoryProfileStore();
    const sleeper = new FakeSleeperDiscovery();
    const getUser = vi.spyOn(sleeper, 'getUser');

    const profile = await runFirstRunSetup({
      environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'top-secret-key' },
      now: () => new Date('2026-08-20T12:00:00.000Z'),
      sleeper,
      store,
    });

    expect(profile).toEqual({
      schemaVersion: SETUP_PROFILE_SCHEMA_VERSION,
      updatedAt: '2026-08-20T12:00:00.000Z',
      defaults: { season: 2026 },
    });
    expect(store.saved).toEqual(profile);
    expect(JSON.stringify(store.saved)).not.toContain('top-secret-key');
    expect(getUser).not.toHaveBeenCalled();
  });

  it('stops before Sleeper discovery when the Gemini key is absent', async () => {
    const sleeper = new FakeSleeperDiscovery();
    const getUser = vi.spyOn(sleeper, 'getUser');

    await expect(
      runFirstRunSetup({
        environment: {},
        sleeper,
        store: new MemoryProfileStore(),
      }),
    ).rejects.toThrow(SetupWizardError);
    expect(getUser).not.toHaveBeenCalled();
  });

  it('validates the Gemini key before it reads the current season', async () => {
    const sleeper = new FakeSleeperDiscovery();
    const getNflState = vi.spyOn(sleeper, 'getNflState');
    const verifyApiKey = vi.fn(async () => {
      throw new Error('invalid credential');
    });

    await expect(
      runFirstRunSetup({
        environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'bad-key' },
        sleeper,
        store: new MemoryProfileStore(),
        verifyApiKey,
      }),
    ).rejects.toThrow('Gemini key validation failed');
    expect(verifyApiKey).toHaveBeenCalledWith('bad-key');
    expect(getNflState).not.toHaveBeenCalled();
  });

  it('includes co-owned rosters and excludes unrelated rosters', async () => {
    const sleeper = new FakeSleeperDiscovery();

    const rosters = await discoverOwnedRosters(sleeper, '200', 'user-1');

    expect(rosters.map((roster) => roster.roster_id)).toEqual([6, 7]);
  });

  it('applies only the season and preserves session-specific teams', () => {
    const session = createSessionState(new Date('2026-08-20T12:00:00.000Z'));
    session.user = 'another-user';
    session.leagueId = '999';
    session.rosterId = 3;
    session.team = 'SEA';
    const profile = exampleProfile();

    applySetupProfile(profile, session);

    expect(session).toMatchObject({
      season: 2026,
      user: 'another-user',
      leagueId: '999',
      rosterId: 3,
      team: 'SEA',
    });
  });
});

describe('file setup profile store', () => {
  it('uses an atomic private file and preserves only validated fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'seb-profile-test-'));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o755);
    const path = join(directory, 'config', 'profile.json');
    const store = new FileSetupProfileStore({ path });

    await store.save(exampleProfile());

    expect(await store.load()).toEqual(exampleProfile());
    const content = await readFile(path, 'utf8');
    expect(content).not.toContain('API_KEY');
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, 'config'))).mode & 0o777).toBe(0o700);
    }
    expect(await store.remove()).toBe(true);
    expect(await store.remove()).toBe(false);
  });

  it('migrates a roster-specific version 1 profile to version 2', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'seb-profile-migration-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'profile.json');
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      updatedAt: '2026-08-20T12:00:00.000Z',
      sleeper: { userId: 'user-1', username: 'arvarik' },
      defaults: {
        season: 2026,
        leagueId: '200',
        leagueName: 'Second League',
        rosterId: 7,
      },
    }));
    const store = new FileSetupProfileStore({ path });

    expect(await store.load()).toEqual(exampleProfile());
    const saved = await readFile(path, 'utf8');
    expect(saved).not.toContain('arvarik');
    expect(saved).not.toContain('leagueId');
  });
});

class MemoryProfileStore implements SetupProfileStore {
  readonly path = '/memory/profile.json';
  saved: SebSetupProfile | null = null;

  load(): Promise<SebSetupProfile | null> {
    return Promise.resolve(this.saved);
  }

  remove(): Promise<boolean> {
    const removed = this.saved !== null;
    this.saved = null;
    return Promise.resolve(removed);
  }

  save(profile: SebSetupProfile): Promise<void> {
    this.saved = profile;
    return Promise.resolve();
  }
}

class FakeSleeperDiscovery implements SleeperSetupDiscovery {
  getNflState() {
    return Promise.resolve({
      week: 1,
      leg: 1,
      season: '2026',
      season_type: 'regular',
    });
  }

  getUser(): Promise<SleeperUser> {
    return Promise.resolve({ user_id: 'user-1', username: 'arvarik' });
  }

  getUserLeagues(): Promise<SleeperLeague[]> {
    return Promise.resolve([
      league('100', 'First League'),
      league('200', 'Second League'),
    ]);
  }

  getLeagueRosters(): Promise<SleeperRoster[]> {
    return Promise.resolve([
      roster(8, 'someone-else'),
      roster(7, 'co-owner', ['user-1']),
      roster(6, 'user-1'),
    ]);
  }
}

function league(leagueId: string, name: string): SleeperLeague {
  return {
    league_id: leagueId,
    name,
    season: '2026',
    season_type: 'regular',
    sport: 'nfl',
    status: 'in_season',
    total_rosters: 12,
    roster_positions: [],
    scoring_settings: {},
    settings: {},
  };
}

function roster(
  rosterId: number,
  ownerId: string,
  coOwners?: string[],
): SleeperRoster {
  return {
    roster_id: rosterId,
    league_id: '200',
    owner_id: ownerId,
    ...(coOwners ? { co_owners: coOwners } : {}),
    players: ['player-1'],
    settings: {},
  };
}

function exampleProfile(): SebSetupProfile {
  return {
    schemaVersion: SETUP_PROFILE_SCHEMA_VERSION,
    updatedAt: '2026-08-20T12:00:00.000Z',
    defaults: { season: 2026 },
  };
}
