import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  SleeperLeague,
  SleeperPlayerMap,
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
  connectSleeperSession,
  disconnectSleeperSession,
  discoverOwnedRosters,
  focusSessionLeague,
  refreshAutomaticSession,
  resolveCurrentNflWeek,
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

describe('automatic NFL week selection', () => {
  it('uses the first valid Sleeper week value', () => {
    expect(resolveCurrentNflWeek({
      display_week: 0,
      league_season: '2026',
      leg: 17,
      season: '2026',
      season_type: 'post',
      week: 18,
    })).toBe(18);
  });
});

describe('first-run setup wizard', () => {
  it('saves only the optional Sleeper username', async () => {
    const store = new MemoryProfileStore();

    const profile = await runFirstRunSetup({
      environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'top-secret-key' },
      now: () => new Date('2026-08-20T12:00:00.000Z'),
      store,
      username: 'arvarik',
    });

    expect(profile).toEqual({
      schemaVersion: SETUP_PROFILE_SCHEMA_VERSION,
      sleeper: { username: 'arvarik' },
      updatedAt: '2026-08-20T12:00:00.000Z',
    });
    expect(store.saved).toEqual(profile);
    expect(JSON.stringify(store.saved)).not.toContain('top-secret-key');
  });

  it('uses the optional environment username and validates its format', async () => {
    const profile = await runFirstRunSetup({
      environment: {
        GOOGLE_GENERATIVE_AI_API_KEY: 'top-secret-key',
        SEB_SLEEPER_USER: 'arvarik',
      },
      store: new MemoryProfileStore(),
    });

    expect(profile.sleeper).toEqual({ username: 'arvarik' });
    await expect(runFirstRunSetup({
      environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'top-secret-key' },
      store: new MemoryProfileStore(),
      username: 'invalid user name',
    })).rejects.toThrow('Use 1 through 100 letters');
  });

  it('stops before Sleeper discovery when the Gemini key is absent', async () => {
    await expect(
      runFirstRunSetup({
        environment: {},
        store: new MemoryProfileStore(),
      }),
    ).rejects.toThrow(SetupWizardError);
  });

  it('validates the Gemini key before it saves the profile', async () => {
    const store = new MemoryProfileStore();
    const verifyApiKey = vi.fn(async () => {
      throw new Error('invalid credential');
    });

    await expect(
      runFirstRunSetup({
        environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'bad-key' },
        store,
        verifyApiKey,
      }),
    ).rejects.toThrow('Gemini key validation failed');
    expect(verifyApiKey).toHaveBeenCalledWith('bad-key');
    expect(store.saved).toBeNull();
  });

  it('includes co-owned rosters and excludes unrelated rosters', async () => {
    const sleeper = new FakeSleeperDiscovery();

    const rosters = await discoverOwnedRosters(sleeper, '200', 'user-1');

    expect(rosters.map((roster) => roster.roster_id)).toEqual([6, 7]);
  });

  it('applies the account without changing automatic NFL context', () => {
    const session = createSessionState(new Date('2026-08-20T12:00:00.000Z'));
    session.user = 'another-user';
    session.leagueId = '999';
    session.rosterId = 3;
    session.team = 'SEA';
    const profile = exampleProfile();

    applySetupProfile(profile, session);

    expect(session).toMatchObject({
      season: 2026,
      user: 'arvarik',
      leagueId: null,
      rosterId: null,
      team: 'SEA',
      mode: 'fantasy',
    });
  });

  it('refreshes NFL time, leagues, rosters, and deadline settings automatically', async () => {
    const session = createSessionState(new Date('2025-01-01T00:00:00.000Z'));
    const sleeper = new FakeSleeperDiscovery();
    vi.spyOn(sleeper, 'getNflState').mockResolvedValue({
      week: 18,
      leg: 18,
      display_week: 1,
      season: '2026',
      league_season: '2027',
      season_type: 'post',
    });
    const leagueRequest = vi.spyOn(sleeper, 'getUserLeagues');

    await refreshAutomaticSession(sleeper, session, 'arvarik');

    expect(session).toMatchObject({
      accountStatus: 'ready',
      mode: 'fantasy',
      season: 2026,
      leagueSeason: 2027,
      seasonType: 'post',
      user: 'arvarik',
      userId: 'user-1',
      week: 1,
    });
    expect(leagueRequest).toHaveBeenCalledWith('user-1', '2027');
    expect(session.leagues.map((item) => item.name)).toEqual([
      'First League',
      'Second League',
    ]);
    expect(session.leagues[0]?.deadlines).toContain('Trade deadline: end of NFL Week 11');
    expect(session.leagues[0]?.actionCenter?.lineups).toEqual([
      { filledSlots: 1, openSlots: 0, rosterId: 6, starterSlots: 1 },
      { filledSlots: 1, openSlots: 0, rosterId: 7, starterSlots: 1 },
    ]);
    expect(session.leagueId).toBeNull();

    focusSessionLeague(session, '200');
    expect(session.leagueId).toBe('200');
    expect(session.rosterOptions).toEqual([6, 7]);

    disconnectSleeperSession(session);
    expect(session).toMatchObject({
      accountStatus: 'disconnected',
      leagues: [],
      mode: 'explore',
      user: null,
    });
  });

  it('records an account refresh failure without losing Explore', async () => {
    const session = createSessionState();
    const sleeper = new FakeSleeperDiscovery();
    vi.spyOn(sleeper, 'getUser').mockRejectedValue(new Error('Sleeper unavailable'));

    await expect(connectSleeperSession(sleeper, session, 'arvarik')).rejects.toThrow(
      'Sleeper unavailable',
    );

    expect(session).toMatchObject({
      accountStatus: 'error',
      accountError: 'Sleeper unavailable',
      user: 'arvarik',
    });
  });

  it('keeps healthy leagues when one roster refresh fails', async () => {
    const session = createSessionState();
    const sleeper = new FakeSleeperDiscovery();
    vi.spyOn(sleeper, 'getLeagueRosters').mockImplementation((leagueId) => {
      if (leagueId === '100') return Promise.reject(new Error('League unavailable'));
      return Promise.resolve([roster(6, 'user-1')]);
    });

    await refreshAutomaticSession(sleeper, session, 'arvarik');

    expect(session.accountStatus).toBe('ready');
    expect(session.accountError).toContain('1 league roster refresh failed');
    expect(session.leagues).toHaveLength(2);
    expect(session.leagues[0]).toMatchObject({
      leagueId: '100',
      rosterIds: [],
      warning: 'League unavailable',
    });
    expect(session.leagues[1]).toMatchObject({
      leagueId: '200',
      rosterIds: [6],
      warning: null,
    });
  });

  it('keeps lineup actions when the player status refresh fails', async () => {
    const session = createSessionState();
    const sleeper = new FakeSleeperDiscovery();
    vi.spyOn(sleeper, 'getPlayers').mockRejectedValue(new Error('Players unavailable'));

    await refreshAutomaticSession(sleeper, session, 'arvarik');

    expect(session.accountStatus).toBe('ready');
    expect(session.accountError).toContain('Player status refresh failed: Players unavailable');
    expect(session.leagues[0]?.actionCenter?.lineups).toEqual([
      { filledSlots: 1, openSlots: 0, rosterId: 6, starterSlots: 1 },
      { filledSlots: 1, openSlots: 0, rosterId: 7, starterSlots: 1 },
    ]);
    expect(session.leagues[0]?.actionCenter?.playerStatusSignals).toEqual([]);
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

  it('migrates a roster-specific version 1 profile to the username-only profile', async () => {
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
    expect(saved).toContain('arvarik');
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
      display_week: 3,
      season: '2026',
      league_season: '2026',
      season_type: 'regular',
    });
  }

  getPlayers(): Promise<SleeperPlayerMap> {
    return Promise.resolve({
      'player-1': {
        full_name: 'Test Player',
        injury_status: null,
        player_id: 'player-1',
        status: 'Active',
      },
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

  getLeagueRosters(_leagueId: string): Promise<SleeperRoster[]> {
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
    roster_positions: ['QB', 'BN'],
    scoring_settings: {},
    settings: {
      trade_deadline: 11,
      playoff_week_start: 15,
      waiver_clear_days: 2,
      waiver_hour: 5,
    },
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
    starters: ['player-1'],
  };
}

function exampleProfile(): SebSetupProfile {
  return {
    schemaVersion: SETUP_PROFILE_SCHEMA_VERSION,
    sleeper: { username: 'arvarik' },
    updatedAt: '2026-08-20T12:00:00.000Z',
  };
}
