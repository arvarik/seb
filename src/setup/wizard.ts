import type {
  SleeperLeague,
  SleeperNflState,
  SleeperRoster,
  SleeperUser,
} from '../sleeper/types.js';
import type { SessionState } from '../interactive/session.js';
import { normalizeSessionSeasonType } from '../interactive/session.js';
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
  store: SetupProfileStore;
  username?: string;
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

  const profile = createSetupProfile(
    options.username ?? options.environment.SEB_SLEEPER_USER ?? null,
    options.now?.(),
  );
  await options.store.save(profile);
  return profile;
}

export function createSetupProfile(
  username: string | null = null,
  now = new Date(),
): SebSetupProfile {
  const normalizedUsername = username === null ? null : validateUsername(username);
  return {
    schemaVersion: SETUP_PROFILE_SCHEMA_VERSION,
    sleeper: normalizedUsername ? { username: normalizedUsername } : null,
    updatedAt: now.toISOString(),
  };
}

export function applySetupProfile(
  profile: SebSetupProfile,
  session: SessionState,
): void {
  disconnectSleeperSession(session);
  if (profile.sleeper) {
    session.user = profile.sleeper.username;
    session.mode = 'fantasy';
  }
}

export async function refreshAutomaticSession(
  sleeper: SleeperSetupDiscovery,
  session: SessionState,
  username = session.user,
): Promise<void> {
  const nflState = await sleeper.getNflState();
  session.season = parseSeason(nflState.season);
  session.leagueSeason = parseSeason(nflState.league_season ?? nflState.season);
  session.seasonType = normalizeSessionSeasonType(nflState.season_type);
  session.week = resolveCurrentNflWeek(nflState);
  if (username) {
    await connectSleeperSession(sleeper, session, username);
  }
}

export async function connectSleeperSession(
  sleeper: SleeperSetupDiscovery,
  session: SessionState,
  username: string,
): Promise<void> {
  try {
    const account = await discoverSleeperAccount(
      sleeper,
      username,
      session.leagueSeason,
    );
    const leagues = await Promise.all(account.leagues.map(async (league) => {
      try {
        const rosters = await discoverOwnedRosters(
          sleeper,
          league.league_id,
          account.user.user_id,
        );
        return {
          deadlines: leagueDeadlines(league),
          leagueId: league.league_id,
          name: league.name,
          rosterIds: rosters.map((roster) => roster.roster_id),
          status: league.status,
          warning: null,
        };
      } catch (error) {
        return {
          deadlines: leagueDeadlines(league),
          leagueId: league.league_id,
          name: league.name,
          rosterIds: [],
          status: league.status,
          warning: errorMessage(error),
        };
      }
    }));
    const warningCount = leagues.filter((league) => league.warning).length;
    session.accountError = warningCount > 0
      ? `${warningCount} league roster refresh${warningCount === 1 ? '' : 'es'} failed.`
      : null;
    session.accountStatus = 'ready';
    session.leagues = leagues;
    session.leagueOptions = leagues.map((league) => league.leagueId);
    session.mode = 'fantasy';
    session.user = account.user.username ?? username;
    session.userId = account.user.user_id;
    selectAutomaticLeague(session);
  } catch (error) {
    session.accountError = errorMessage(error);
    session.accountStatus = 'error';
    session.leagues = [];
    session.leagueOptions = [];
    session.leagueId = null;
    session.rosterId = null;
    session.rosterOptions = [];
    session.user = username.trim();
    session.userId = null;
    throw error;
  }
}

export function disconnectSleeperSession(session: SessionState): void {
  session.accountError = null;
  session.accountStatus = 'disconnected';
  session.leagueId = null;
  session.leagues = [];
  session.leagueOptions = [];
  session.mode = 'explore';
  session.rosterId = null;
  session.rosterOptions = [];
  session.user = null;
  session.userId = null;
}

export function focusSessionLeague(
  session: SessionState,
  leagueId: string | null,
): void {
  if (leagueId === null) {
    session.leagueId = null;
    session.rosterId = null;
    session.rosterOptions = [];
    return;
  }
  const league = session.leagues.find((candidate) => candidate.leagueId === leagueId);
  session.leagueId = leagueId;
  session.rosterOptions = league?.rosterIds ?? [];
  session.rosterId = league?.rosterIds.length === 1 ? league.rosterIds[0] ?? null : null;
}

function validateUsername(value: string): string {
  const error = usernameError(value);
  if (error) {
    throw new SetupWizardError(error);
  }
  return value.trim();
}

export function resolveCurrentNflWeek(state: SleeperNflState): number | null {
  for (const value of [state.display_week, state.week, state.leg]) {
    if (Number.isInteger(value) && value !== undefined && value >= 1 && value <= 22) {
      return value;
    }
  }
  return null;
}

function leagueDeadlines(league: SleeperLeague): string[] {
  const deadlines: string[] = [];
  const tradeDeadline = settingInteger(league.settings.trade_deadline, 1, 18);
  const playoffStart = settingInteger(league.settings.playoff_week_start, 1, 18);
  const waiverDays = settingInteger(league.settings.waiver_clear_days, 0, 30);
  const waiverHour = settingInteger(
    league.settings.daily_waivers_hour ?? league.settings.waiver_hour,
    0,
    23,
  );
  if (tradeDeadline) deadlines.push(`Trade deadline: end of NFL Week ${tradeDeadline}`);
  if (playoffStart) deadlines.push(`Fantasy playoffs start: Week ${playoffStart}`);
  if (waiverDays !== null) {
    deadlines.push(`Dropped-player waivers: ${waiverDays} day${waiverDays === 1 ? '' : 's'}`);
  }
  if (waiverHour !== null) {
    deadlines.push(`Waiver processing hour setting: ${String(waiverHour).padStart(2, '0')}:00`);
  }
  return deadlines;
}

function settingInteger(
  value: string | number | boolean | null | undefined,
  minimum: number,
  maximum: number,
): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum
    ? number
    : null;
}

function selectAutomaticLeague(session: SessionState): void {
  const owned = session.leagues.filter((league) => league.rosterIds.length > 0);
  const active = owned.filter((league) => league.status === 'in_season');
  const selected = owned.length === 1
    ? owned[0]
    : active.length === 1
      ? active[0]
      : null;
  focusSessionLeague(session, selected?.leagueId ?? null);
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
