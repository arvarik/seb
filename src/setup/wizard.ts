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
  sleeper: Pick<SleeperSetupDiscovery, 'getNflState'>;
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

  const nflState = await options.sleeper.getNflState();
  const profile = createSetupProfile(
    parseSeason(nflState.season),
    options.now?.(),
  );
  await options.store.save(profile);
  return profile;
}

export function createSetupProfile(
  season: number,
  now = new Date(),
): SebSetupProfile {
  if (!Number.isInteger(season) || season < 1999 || season > 2100) {
    throw new SetupWizardError('The default NFL season is invalid.');
  }
  return {
    schemaVersion: SETUP_PROFILE_SCHEMA_VERSION,
    updatedAt: now.toISOString(),
    defaults: { season },
  };
}

export function applySetupProfile(
  profile: SebSetupProfile,
  session: SessionState,
): void {
  session.season = profile.defaults.season;
  session.seasonType = null;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
