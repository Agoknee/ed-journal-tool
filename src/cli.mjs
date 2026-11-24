import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

/** In the standalone executable, this is the read-only bundled copy holding package.json and client/dist. */
const projectRootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** App data lives in %LOCALAPPDATA%edjt (~/.local/share/edjt where LOCALAPPDATA isn't set, e.g. Linux). */
const dataDirectoryPath = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'edjt');

const { version: appVersion } = JSON.parse(readFileSync(path.join(projectRootPath, 'package.json'), 'utf8'));

const defaultJournalDirectory = path.join(
  process.env.USERPROFILE ?? process.env.HOME ?? '.',
  'Saved Games/Frontier Developments/Elite Dangerous',
);

const defaultDatabasePath = path.join(dataDirectoryPath, 'journals.db');

// Several journal folders can be given in one -j value: ";" separates them everywhere, and ":" too
// where paths can't contain it (not Windows, where it's in drive letters).
const JOURNAL_DIRECTORY_SEPARATOR = process.platform === 'win32' ? /;/ : /[;:]/;
const JOURNAL_DIRECTORY_SEPARATOR_LABEL = process.platform === 'win32' ? ';' : '; or :';

/**
 * The journal folders from the -j values: split on the separators, made absolute, without blanks
 * or repeats (letter case aside on Windows).
 * @param {string[]} values
 * @returns {string[]}
 */
export function splitJournalDirectories(values) {
  const seen = new Set();
  const directories = [];
  for (const value of [values].flat()) {
    for (const part of String(value ?? '').split(JOURNAL_DIRECTORY_SEPARATOR)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const resolved = path.resolve(trimmed);
      const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      if (seen.has(key)) continue;
      seen.add(key);
      directories.push(resolved);
    }
  }
  if (directories.length === 0) throw new Error('No journal folder given for --journaldir');
  return directories;
}

/**
 * Parses command-line options.
 * @returns {{ port: number, bind: string, debug: boolean, journaldir: string[], database: string, devClient: boolean, rebuildStats: boolean }}
 */
export function parseCommandLineOptions(argv = process.argv) {
  return yargs(hideBin(argv))
    .scriptName('ed-journal-monitor')
    .usage('$0 [options]\n\nMonitors Elite Dangerous journal files and serves stats through an API and dashboard.')
    .option('port', {
      alias: 'p',
      type: 'number',
      default: 4267,
      describe: 'Port for the web server',
    })
    .option('bind', {
      alias: 'b',
      type: 'string',
      default: '0.0.0.0',
      describe: 'Host/IP address for the web server to bind to (default: all interfaces)',
    })
    .option('debug', {
      alias: 'd',
      type: 'boolean',
      default: false,
      describe: 'Enable debug mode (verbose logging)',
    })
    .option('journaldir', {
      alias: 'j',
      type: 'string',
      array: true,
      default: [defaultJournalDirectory],
      defaultDescription: '"Saved Games/Frontier Developments/Elite Dangerous" in your user folder',
      describe: `Elite Dangerous journal folder. Repeat it (-j A -j B), or separate folders with "${JOURNAL_DIRECTORY_SEPARATOR_LABEL}", to read several (e.g. one synced from another computer)`,
      coerce: splitJournalDirectories,
    })
    .option('database', {
      type: 'string',
      default: defaultDatabasePath,
      describe: 'Path to the SQLite database file',
    })
    .option('dev-client', {
      type: 'boolean',
      default: false,
      describe: 'Serve the dashboard from client source with the Vite dev server (hot reload) instead of client/dist',
    })
    .option('rebuild-stats', {
      type: 'boolean',
      default: false,
      describe: 'Clear and rebuild all parsed stats from stored journal entries on launch',
    })
    .check((options) => {
      if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
        throw new Error('Port must be an integer between 1 and 65535');
      }
      return true;
    })
    .help()
    .alias('help', 'h')
    .version(appVersion)
    .alias('version', 'v')
    .strict()
    .parseSync();
}

export { appVersion, projectRootPath };
