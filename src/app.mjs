import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseCommandLineOptions, projectRootPath } from './cli.mjs';
import { openDatabase } from './database/database.mjs';
import { EventHub } from './events/event-hub.mjs';
import { JournalIngester } from './journals/journal-ingester.mjs';
import { JournalMonitor } from './journals/journal-monitor.mjs';
import { logger } from './logger.mjs';
import { createServer } from './server/server.mjs';
import { statModules } from './stats/index.mjs';
import { StatsEngine } from './stats/stats-engine.mjs';

const options = parseCommandLineOptions();
logger.setDebug(options.debug);

if (!existsSync(options.journaldir)) {
  logger.error(`Journal directory not found: "${options.journaldir}". Use --journaldir to set it.`);
  process.exit(1);
}

const databasePath = path.resolve(options.database);
logger.debug(`Opening database "${databasePath}"`);
const database = openDatabase(databasePath);

const eventHub = new EventHub();
const statsEngine = new StatsEngine({ database, statModules, eventHub });
statsEngine.initialize();
if (options.rebuildStats) {
  logger.info('Clearing all stats; they will be rebuilt from stored journal entries.');
  statsEngine.resetAllModules();
}

const ingester = new JournalIngester({ database, journalDirectory: options.journaldir });
const journalMonitor = new JournalMonitor({ ingester, statsEngine, eventHub });

const app = createServer({
  database,
  databasePath,
  statsEngine,
  journalMonitor,
  eventHub,
  journalDirectory: options.journaldir,
  clientDistPath: path.join(projectRootPath, 'client', 'dist'),
});

const httpServer = app.listen(options.port, options.bind, () => {
  const displayHost = options.bind === '0.0.0.0' ? 'localhost' : options.bind;
  logger.info(`Dashboard and API available at http://${displayHost}:${options.port} (bound to ${options.bind})`);
});
httpServer.on('error', (error) => {
  logger.error(`Web server failed to start: ${error.message}`);
  process.exit(1);
});

await journalMonitor.scanJournalDirectory();
journalMonitor.start();

let isShuttingDown = false;
async function shutDown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info('Shutting down...');
  await journalMonitor.stop();
  httpServer.closeAllConnections();
  httpServer.close();
  database.close();
  process.exit(0);
}
process.on('SIGINT', shutDown);
process.on('SIGTERM', shutDown);
