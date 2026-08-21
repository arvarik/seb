import { createRequire } from 'node:module';

const packageJson = createRequire(import.meta.url)('../package.json') as {
  version: string;
};

export const SEB_VERSION = packageJson.version;
export const SEB_USER_AGENT = `seb/${SEB_VERSION} (+https://github.com/arvarik/seb)`;
