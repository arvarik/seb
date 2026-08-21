import { readFile } from 'node:fs/promises';

const projectUrl = new URL('../', import.meta.url);
const packageJson = await readJson(new URL('package.json', projectUrl));
const packageLock = await readJson(new URL('package-lock.json', projectUrl));
const changelog = await readFile(new URL('CHANGELOG.md', projectUrl), 'utf8');
const environmentExample = await readFile(new URL('.env.example', projectUrl), 'utf8');
const versionGuide = await readFile(new URL('docs/VERSIONING.md', projectUrl), 'utf8');
const version = packageJson.version;
const errors = [];

if (typeof version !== 'string' || !isSemanticVersion(version)) {
  errors.push('package.json must contain a valid semantic version.');
}
if (packageLock.version !== version) {
  errors.push('package-lock.json must match the package.json version.');
}
if (packageLock.packages?.['']?.version !== version) {
  errors.push('The root package-lock.json entry must match package.json.');
}
if (!changelog.includes(`## [${version}] - `)) {
  errors.push(`CHANGELOG.md must contain a ${version} release heading.`);
}
if (!environmentExample.includes(`NWS_USER_AGENT=seb/${version} `)) {
  errors.push('.env.example must use the package version in NWS_USER_AGENT.');
}
if (!versionGuide.includes(`The current version is \`${version}\`.`)) {
  errors.push('docs/VERSIONING.md must contain the package version.');
}

if (errors.length > 0) {
  for (const error of errors) {
    process.stderr.write(`Version check failed: ${error}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`Version ${version} is consistent.\n`);
}

async function readJson(url) {
  return JSON.parse(await readFile(url, 'utf8'));
}

function isSemanticVersion(value) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
    value,
  );
}
