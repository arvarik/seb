import { loadEnvFile } from 'node:process';

const CWD_ENVIRONMENT_DENYLIST = [
  'OPENAI_COMPATIBLE_BASE_URL',
  'SEB_CONFIG_HOME',
  'SEB_DEVTOOLS',
  'SEB_HISTORY_FILE',
  'SEB_MODEL',
  'SEB_MODEL_SETTINGS_FILE',
  'SEB_MODEL_PROVIDER',
  'SEB_PROFILE_FILE',
  'SEB_PROVIDER',
  'XDG_CONFIG_HOME',
] as const;

export interface LocalEnvironmentLoadOptions {
  environment?: NodeJS.ProcessEnv;
  load?: () => void;
}

/** Loads a current-directory .env file without trusting security boundaries from it. */
export function loadSafeLocalEnvironment(
  options: LocalEnvironmentLoadOptions = {},
): readonly string[] {
  const environment = options.environment ?? process.env;
  const priorValues = new Map(
    CWD_ENVIRONMENT_DENYLIST.map((name) => [name, environment[name]]),
  );
  try {
    (options.load ?? loadEnvFile)();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const ignored: string[] = [];
  for (const name of CWD_ENVIRONMENT_DENYLIST) {
    if (priorValues.get(name) !== undefined || environment[name] === undefined) {
      continue;
    }
    delete environment[name];
    ignored.push(name);
  }
  return ignored;
}

export function formatIgnoredLocalEnvironment(
  ignored: readonly string[],
): string | null {
  if (ignored.length === 0) return null;
  return `Seb ignored ${ignored.join(', ')} from the current-directory .env file. Set these values in the shell or use seb configure.\n`;
}
