/**
 * Adds a commit to package.json's version as build details (0.2.0 → 0.2.0+abc1234), for builds
 * that aren't releases (see .github/workflows/build.yml). Prints the new version. Leaves
 * package-lock.json alone: the build doesn't read its version.
 *
 *   node scripts/add-commit-to-version.mjs <commit>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const commit = process.argv[2]?.trim();
if (!/^[0-9a-f]{4,40}$/i.test(commit ?? '')) {
  console.error('Usage: node scripts/add-commit-to-version.mjs <commit>');
  process.exit(1);
}

const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const text = readFileSync(packageJsonPath, 'utf8');
const packageJson = JSON.parse(text);
// Without build details it had already, so running it twice doesn't add the commit twice.
packageJson.version = `${packageJson.version.replace(/\+.*$/, '')}+${commit.slice(0, 7).toLowerCase()}`;
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
console.log(packageJson.version);
