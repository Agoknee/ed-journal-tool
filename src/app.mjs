import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { appVersion, parseCommandLineOptions, projectRootPath } from './cli.mjs';
import { TickMonitor } from './bgs-ticks.mjs';
import { ClockMonitor } from './clock-check.mjs';
import { openDatabase } from './database/database.mjs';
import { EventHub } from './events/event-hub.mjs';
import { JournalIngester } from './journals/journal-ingester.mjs';
import { JournalMonitor } from './journals/journal-monitor.mjs';
import { StatusMonitor } from './journals/status-monitor.mjs';
import { logger } from './logger.mjs';
import { createServer, serveBuiltClient } from './server/server.mjs';
import { serveClientWithVite } from './server/vite-dev-client.mjs';
import { statModules } from './stats/index.mjs';
import { StatsEngine } from './stats/stats-engine.mjs';

/** Starts the journal monitor, stats engine and web server. */
export async function startApp() {
  // Parsed first so --help and --version print only their own output.
  const options = parseCommandLineOptions();
  logger.setDebug(options.debug);
  logger.info(`Starting ED Journal Tool v${appVersion} - CTRL+C to exit...`);

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
  const clockMonitor = new ClockMonitor({ eventHub });
  const tickMonitor = new TickMonitor({ database, eventHub });
  const statusMonitor = new StatusMonitor({ database, journalDirectory: options.journaldir, eventHub });

  const app = createServer({
    database,
    databasePath,
    statsEngine,
    journalMonitor,
    clockMonitor,
    statusMonitor,
    eventHub,
    journalDirectory: options.journaldir,
  });

  const httpServer = http.createServer(app);
  const clientRootPath = path.join(projectRootPath, 'client');
  let viteServer = null;
  if (options.devClient) {
    try {
      viteServer = await serveClientWithVite(app, { clientRootPath, httpServer });
    } catch (error) {
      logger.error(`Could not start the Vite dev client: ${error.message}`);
      process.exit(1);
    }
  } else {
    serveBuiltClient(app, path.join(clientRootPath, 'dist'));
  }

  httpServer.on('error', (error) => {
    logger.error(`Web server failed to start: ${error.message}`);
    process.exit(1);
  });
  httpServer.listen(options.port, options.bind, () => {
    const displayHost = options.bind === '0.0.0.0' ? 'localhost' : options.bind;
    logger.info(`Dashboard and API available at http://${displayHost}:${options.port} (bound to ${options.bind})`);
  });

  clockMonitor.start();
  tickMonitor.start();
  await journalMonitor.scanJournalDirectory();
  journalMonitor.start();
  statusMonitor.start();

  let isShuttingDown = false;
  async function shutDown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info('Shutting down...');
    await journalMonitor.stop();
    clockMonitor.stop();
    tickMonitor.stop();
    statusMonitor.stop();
    await viteServer?.close();
    httpServer.closeAllConnections();
    httpServer.close();
    database.close();
    process.exit(0);
  }
  process.on('SIGINT', shutDown);
  process.on('SIGTERM', shutDown);
}
