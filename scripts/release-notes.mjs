/**
 * Writes the release notes in Markdown: every commit since the last release (the highest
 * "v<version>" tag), newest first, or every commit for the first release.
 *
 *   node scripts/release-notes.mjs <output file> [the new tag]
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastReleaseTag } from './check-version.mjs';

const projectRootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [outputPath, newTag] = process.argv.slice(2);
if (!outputPath) {
  console.error('Usage: node scripts/release-notes.mjs <output file> [the new tag]');
  process.exit(1);
}

const git = (...args) => execFileSync('git', args, { cwd: projectRootPath, encoding: 'utf8' });

// A unit separator can't be in a commit subject, so each line splits cleanly.
const previousTag = lastReleaseTag();
const commits = git('log', '--no-merges', '--format=%h%x1f%s', ...(previousTag ? [`${previousTag}..HEAD`] : ['HEAD']))
  .split('\n').filter(Boolean)
  .map((line) => {
    const [hash, subject] = line.split('\x1f');
    return { hash, subject: subject.trim() };
  });

const repository = process.env.GITHUB_REPOSITORY;
const lines = [previousTag ? `## Changes since ${previousTag}` : '## Changes', ''];
for (const { hash, subject } of commits) lines.push(`- ${subject} (${hash})`);
if (commits.length === 0) lines.push('- No changes since the last release.');
if (previousTag && newTag && repository) {
  lines.push('', `**Full history:** https://github.com/${repository}/compare/${previousTag}...${newTag}`);
}
lines.push(
  '',
  '## Downloads',
  '',
  '- **Windows:** the `.exe`. Run it; it starts in the background with an icon in the system tray.',
  '- **Linux (including Steam Deck):** the `-install.sh`. Run `sh ed-journal-tool-*-install.sh` (add `--help` for its options).',
  '- `SHA256SUMS.txt` has the checksums.',
  ...(repository ? [
    '',
    `To check that a download was built here, from this release's commit: \`gh attestation verify <file> --repo ${repository}\``,
  ] : []),
);
writeFileSync(outputPath, `${lines.join('\n')}\n`);
console.log(`Release notes: ${commits.length} ${commits.length === 1 ? 'change' : 'changes'}${previousTag ? ` since ${previousTag}` : ''}.`);
