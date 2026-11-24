/**
 * Checks that package.json's version is higher than the last release's, which is the highest
 * "v<version>" tag, and that package-lock.json agrees with it (npm version changes both). Run by
 * the pull request checks; exits 1 with a message saying what to change.
 *
 *   node scripts/check-version.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (name) => JSON.parse(readFileSync(path.join(projectRootPath, name), 'utf8'));

/** "1.2.3" or "1.2.3-beta.1" as comparable parts; null when it isn't a version. */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text).trim());
  if (!match) return null;
  return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] ? match[4].split('.') : [] };
}

/** Negative, zero or positive, as a is lower than, the same as or higher than b (semver order). */
export function compareVersions(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  }
  // A prerelease comes before its release: 1.0.0-beta < 1.0.0.
  if (!a.prerelease.length || !b.prerelease.length) return b.prerelease.length - a.prerelease.length;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const [x, y] = [a.prerelease[index], b.prerelease[index]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const [isNumberX, isNumberY] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (isNumberX && isNumberY && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (isNumberX !== isNumberY) return isNumberX ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** The highest "v<version>" tag, or null before the first release. */
export function lastReleaseTag() {
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: projectRootPath, encoding: 'utf8' })
    .split('\n').map((tag) => tag.trim()).filter((tag) => parseVersion(tag));
  tags.sort((a, b) => compareVersions(parseVersion(b), parseVersion(a)));
  return tags[0] ?? null;
}

function fail(message) {
  console.log(`::error file=package.json::${message}`);
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version } = readJson('package.json');
  const lock = readJson('package-lock.json');
  const parsed = parseVersion(version);
  if (!parsed) fail(`"${version}" in package.json isn't a version like 1.2.3.`);
  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    fail(`package-lock.json has version ${lock.version}, not ${version}: change the version with "npm version", which sets both.`);
  }

  const tag = lastReleaseTag();
  if (!tag) {
    console.log(`Version ${version}; there's no release yet, so any version will do.`);
  } else if (compareVersions(parsed, parseVersion(tag)) <= 0) {
    fail(`The version is ${version}, and the last release is ${tag}: raise it (npm version patch, minor or major) for this to be released.`);
  } else {
    console.log(`Version ${version}, after the last release ${tag}.`);
  }
}
