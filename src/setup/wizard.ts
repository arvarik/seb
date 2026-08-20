import type {
  SleeperLeague,
  SleeperNflState,
  SleeperRoster,
  SleeperUser,
} from '../sleeper/types.js';
import type { SessionState } from '../interactive/session.js';
import {
  SETUP_PROFILE_SCHEMA_VERSION,
  type SebSetupProfile,
  type SetupProfileStore,
} from './profile.js';

export interface SetupPromptChoice<T extends string | number> {
  description?: string;
  label: string;
  value: T;
}

export interface SetupPrompter {
  input(request: {
    defaultValue?: string;
    label: string;
    validate?: (value: string) => string | null;
  }): Promise<string>;
  select<T extends string | number>(request: {
    choices: readonly SetupPromptChoice<T>[];
    label: string;
  }): Promise<T>;
}

export interface SleeperSetupDiscovery {
  getLeagueRosters(leagueId: string): Promise<SleeperRoster[]>;
  getNflState(): Promise<SleeperNflState>;
  getUser(identifier: string): Promise<SleeperUser>;
  getUserLeagues(userId: string, season: string): Promise<SleeperLeague[]>;
}

export interface ApiKeyPresence {
  message: string;
  present: boolean;
  variable: 'GOOGLE_GENERATIVE_AI_API_KEY';
}

export interface DiscoveredSleeperAccount {
  leagues: SleeperLeague[];
  season: number;
  user: SleeperUser;
}

export interface FirstRunSetupOptions {
  environment: NodeJS.ProcessEnv;
  now?: () => Date;
  prompt: SetupPrompter;
  sleeper: SleeperSetupDiscovery;
  store: SetupProfileStore;
  verifyApiKey?: (apiKey: string) => Promise<void>;
}

export class SetupWizardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupWizardError';
  }
}

export function checkGeminiApiKey(environment: NodeJS.ProcessEnv): ApiKeyPresence {
  const present = Boolean(environment.GOOGLE_GENERATIVE_AI_API_KEY?.trim());
  return {
    variable: 'GOOGLE_GENERATIVE_AI_API_KEY',
    present,
    message: present
      ? 'The Gemini API key is present in the environment.'
      : 'Add GOOGLE_GENERATIVE_AI_API_KEY to the environment. Seb does not save this key in the profile.',
  };
}

export async function discoverSleeperAccount(
  sleeper: SleeperSetupDiscovery,
  username: string,
  season?: number,
): Promise<DiscoveredSleeperAccount> {
  const normalizedUsername = validateUsername(username);
  const [user, nflState] = await Promise.all([
    sleeper.getUser(normalizedUsername),
    season === undefined ? sleeper.getNflState() : Promise.resolve(null),
  ]);
  if (!user?.user_id) {
    throw new SetupWizardError(`Sleeper did not find the user \`${normalizedUsername}\`.`);
  }
  const resolvedSeason = season ?? parseSeason(nflState?.season);
  const leagues = await sleeper.getUserLeagues(user.user_id, String(resolvedSeason));
  return {
    user,
    season: resolvedSeason,
    leagues: [...leagues].sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function discoverOwnedRosters(
  sleeper: SleeperSetupDiscovery,
  leagueId: string,
  userId: string,
): Promise<SleeperRoster[]> {
  const rosters = await sleeper.getLeagueRosters(leagueId);
  return rosters
    .filter(
      (roster) => roster.owner_id === userId || roster.co_owners?.includes(userId),
    )
    .sort((left, right) => left.roster_id - right.roster_id);
}

export async function runFirstRunSetup(
  options: FirstRunSetupOptions,
): Promise<SebSetupProfile> {
  const key = checkGeminiApiKey(options.environment);
  if (!key.present) {
    throw new SetupWizardError(key.message);
  }
  if (options.verifyApiKey) {
    try {
      await options.verifyApiKey(
        options.environment.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ?? '',
      );
    } catch (error) {
      throw new SetupWizardError(
        `The Gemini key validation failed: ${errorMessage(error)}`,
      );
    }
  }

  const username = await options.prompt.input({
    label: 'Sleeper username',
    validate: (value) => usernameError(value),
  });
  const nflState = await options.sleeper.getNflState();
  const defaultSeason = parseSeason(nflState.season);
  const selectedSeason = await options.prompt.input({
    defaultValue: String(defaultSeason),
    label: 'NFL season',
    validate: seasonError,
  });
  const account = await discoverSleeperAccount(
    options.sleeper,
    username,
    Number(selectedSeason),
  );
  if (account.leagues.length === 0) {
    throw new SetupWizardError(
      `Sleeper found no NFL league for ${account.season}. Check the username or season.`,
    );
  }

  const selectedLeagueId = account.leagues.length === 1
    ? account.leagues[0]!.league_id
    : await options.prompt.select({
        label: `NFL league for ${account.season}`,
        choices: account.leagues.map((candidate) => ({
          value: candidate.league_id,
          label: candidate.name,
          description: `${candidate.total_rosters} rosters`,
        })),
      });
  const league = account.leagues.find(
    (candidate) => candidate.league_id === selectedLeagueId,
  );
  if (!league) {
    throw new SetupWizardError('Select one listed Sleeper league.');
  }

  const ownedRosters = await discoverOwnedRosters(
    options.sleeper,
    league.league_id,
    account.user.user_id,
  );
  if (ownedRosters.length === 0) {
    throw new SetupWizardError(
      `The Sleeper user does not own a roster in \`${league.name}\`.`,
    );
  }
  const selectedRosterId = ownedRosters.length === 1
    ? ownedRosters[0]!.roster_id
    : await options.prompt.select({
        label: `Roster in ${league.name}`,
        choices: ownedRosters.map((roster) => ({
          value: roster.roster_id,
          label: `Roster ${roster.roster_id}`,
          description: `${roster.players?.length ?? 0} players`,
        })),
      });
  const selectedRoster = ownedRosters.find(
    (roster) => roster.roster_id === selectedRosterId,
  );
  if (!selectedRoster) {
    throw new SetupWizardError('Select one listed Sleeper roster.');
  }

  const profile: SebSetupProfile = {
    schemaVersion: SETUP_PROFILE_SCHEMA_VERSION,
    updatedAt: (options.now ?? (() => new Date()))().toISOString(),
    sleeper: {
      userId: account.user.user_id,
      username: account.user.username ?? username.trim(),
    },
    defaults: {
      season: account.season,
      leagueId: league.league_id,
      leagueName: league.name,
      rosterId: selectedRoster.roster_id,
    },
  };
  await options.store.save(profile);
  return profile;
}

export function applySetupProfile(
  profile: SebSetupProfile,
  session: SessionState,
): void {
  session.user = profile.sleeper.username;
  session.season = profile.defaults.season;
  session.leagueId = profile.defaults.leagueId;
  session.rosterId = profile.defaults.rosterId;
}

export async function buildSetupProfile(
  options: {
    leagueId?: string;
    now?: () => Date;
    rosterId?: number;
    season?: number;
    sleeper: SleeperSetupDiscovery;
    username: string;
  },
): Promise<{
  account: DiscoveredSleeperAccount;
  leagues: SleeperLeague[];
  ownedRosters: SleeperRoster[];
  profile: SebSetupProfile | null;
  selectedLeague: SleeperLeague | null;
}> {
  const account = await discoverSleeperAccount(
    options.sleeper,
    options.username,
    options.season,
  );
  const selectedLeague = options.leagueId
    ? account.leagues.find((league) => league.league_id === options.leagueId) ?? null
    : account.leagues.length === 1 ? account.leagues[0]! : null;
  if (!selectedLeague) {
    return { account, leagues: account.leagues, ownedRosters: [], profile: null, selectedLeague: null };
  }
  const ownedRosters = await discoverOwnedRosters(
    options.sleeper,
    selectedLeague.league_id,
    account.user.user_id,
  );
  const selectedRoster = options.rosterId
    ? ownedRosters.find((roster) => roster.roster_id === options.rosterId) ?? null
    : ownedRosters.length === 1 ? ownedRosters[0]! : null;
  const profile = selectedRoster ? {
    schemaVersion: SETUP_PROFILE_SCHEMA_VERSION,
    updatedAt: (options.now ?? (() => new Date()))().toISOString(),
    sleeper: {
      userId: account.user.user_id,
      username: account.user.username ?? options.username.trim(),
    },
    defaults: {
      season: account.season,
      leagueId: selectedLeague.league_id,
      leagueName: selectedLeague.name,
      rosterId: selectedRoster.roster_id,
    },
  } satisfies SebSetupProfile : null;
  return { account, leagues: account.leagues, ownedRosters, profile, selectedLeague };
}

function validateUsername(value: string): string {
  const error = usernameError(value);
  if (error) {
    throw new SetupWizardError(error);
  }
  return value.trim();
}

function usernameError(value: string): string | null {
  return /^[A-Za-z0-9_.-]{1,100}$/.test(value.trim())
    ? null
    : 'Use 1 through 100 letters, numbers, periods, underscores, or hyphens.';
}

function parseSeason(value: string | undefined): number {
  const season = Number(value);
  if (!Number.isInteger(season) || season < 1999 || season > 2100) {
    throw new SetupWizardError('Sleeper returned an invalid NFL season.');
  }
  return season;
}

function seasonError(value: string): string | null {
  const season = Number(value.trim());
  return Number.isInteger(season) && season >= 1999 && season <= 2100
    ? null
    : 'Use a four-digit NFL season from 1999 through 2100.';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
