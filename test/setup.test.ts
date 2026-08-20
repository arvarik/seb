import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises';
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
  type SetupPrompter,
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
  it('discovers leagues and an owned roster before it saves the profile', async () => {
    const store = new MemoryProfileStore();
    const sleeper = new FakeSleeperDiscovery();
    const prompt = new ScriptedPrompter(
      ['arvarik', '2026'],
      ['200', 7],
    );

    const profile = await runFirstRunSetup({
      environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'top-secret-key' },
      now: () => new Date('2026-08-20T12:00:00.000Z'),
      prompt,
      sleeper,
      store,
    });

    expect(profile).toEqual({
      schemaVersion: SETUP_PROFILE_SCHEMA_VERSION,
      updatedAt: '2026-08-20T12:00:00.000Z',
      sleeper: { userId: 'user-1', username: 'arvarik' },
      defaults: {
        season: 2026,
        leagueId: '200',
        leagueName: 'Second League',
        rosterId: 7,
      },
    });
    expect(store.saved).toEqual(profile);
    expect(JSON.stringify(store.saved)).not.toContain('top-secret-key');
  });

  it('stops before Sleeper discovery when the Gemini key is absent', async () => {
    const sleeper = new FakeSleeperDiscovery();
    const getUser = vi.spyOn(sleeper, 'getUser');

    await expect(
      runFirstRunSetup({
        environment: {},
        prompt: new ScriptedPrompter(['arvarik'], []),
        sleeper,
        store: new MemoryProfileStore(),
      }),
    ).rejects.toThrow(SetupWizardError);
    expect(getUser).not.toHaveBeenCalled();
  });

  it('validates the Gemini key before it asks for a Sleeper user', async () => {
    const sleeper = new FakeSleeperDiscovery();
    const getUser = vi.spyOn(sleeper, 'getUser');
    const verifyApiKey = vi.fn(async () => {
      throw new Error('invalid credential');
    });

    await expect(
      runFirstRunSetup({
        environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'bad-key' },
        prompt: new ScriptedPrompter([], []),
        sleeper,
        store: new MemoryProfileStore(),
        verifyApiKey,
      }),
    ).rejects.toThrow('Gemini key validation failed');
    expect(verifyApiKey).toHaveBeenCalledWith('bad-key');
    expect(getUser).not.toHaveBeenCalled();
  });

  it('includes co-owned rosters and excludes unrelated rosters', async () => {
    const sleeper = new FakeSleeperDiscovery();

    const rosters = await discoverOwnedRosters(sleeper, '200', 'user-1');

    expect(rosters.map((roster) => roster.roster_id)).toEqual([6, 7]);
  });

  it('applies the saved default values to an active session', () => {
    const session = createSessionState(new Date('2026-08-20T12:00:00.000Z'));
    const profile = exampleProfile();

    applySetupProfile(profile, session);

    expect(session).toMatchObject({
      user: 'arvarik',
      season: 2026,
      leagueId: '200',
      rosterId: 7,
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

class ScriptedPrompter implements SetupPrompter {
  constructor(
    private readonly inputs: string[],
    private readonly selections: Array<string | number>,
  ) {}

  input(): Promise<string> {
    const value = this.inputs.shift();
    if (value === undefined) throw new Error('The test needs another input.');
    return Promise.resolve(value);
  }

  select<T extends string | number>(): Promise<T> {
    const value = this.selections.shift();
    if (value === undefined) throw new Error('The test needs another selection.');
    return Promise.resolve(value as T);
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
    sleeper: { userId: 'user-1', username: 'arvarik' },
    defaults: {
      season: 2026,
      leagueId: '200',
      leagueName: 'Second League',
      rosterId: 7,
    },
  };
}
