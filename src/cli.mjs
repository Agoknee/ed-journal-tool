import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const projectRootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const defaultJournalDirectory = path.join(
  process.env.USERPROFILE ?? process.env.HOME ?? '.',
  'Saved Games/Frontier Developments/Elite Dangerous',
);

const defaultDatabasePath = path.join(projectRootPath, 'data', 'journals.db');

/**
 * Parses command-line options.
 * @returns {{ port: number, bind: string, debug: boolean, journaldir: string, database: string, rebuildStats: boolean }}
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
      default: defaultJournalDirectory,
      describe: 'Elite Dangerous journal directory',
    })
    .option('database', {
      type: 'string',
      default: defaultDatabasePath,
      describe: 'Path to the SQLite database file',
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
    .version()
    .alias('version', 'v')
    .strict()
    .parseSync();
}

export { projectRootPath };
