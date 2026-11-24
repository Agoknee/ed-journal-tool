import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { logger } from '../logger.mjs';
import { createBgsAdjustmentRoutes } from './routes/bgs-adjustment-routes.mjs';
import { createEventRoutes } from './routes/event-routes.mjs';
import { createJournalRoutes } from './routes/journal-routes.mjs';
import { createNoteRoutes } from './routes/note-routes.mjs';
import { createSqlRoutes } from './routes/sql-routes.mjs';

/**
 * Creates the Express app serving the API at /api. The dashboard is added afterwards with
 * serveBuiltClient, or serveClientWithVite (vite-dev-client.mjs) for development.
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.database
 * @param {string} options.databasePath
 * @param {import('../stats/stats-engine.mjs').StatsEngine} options.statsEngine
 * @param {import('../journals/journal-monitor.mjs').JournalMonitor} options.journalMonitor
 * @param {import('../journals/status-monitor.mjs').StatusMonitor} options.statusMonitor
 * @param {import('../events/event-hub.mjs').EventHub} options.eventHub
 * @param {string[]} options.journalDirectories
 * @param {string} [options.inaraAssetDirectory]  where the downloaded Inara artwork is, served at /inara
 */
export function createServer({ database, databasePath, statsEngine, journalMonitor, clockMonitor, statusMonitor, eventHub, journalDirectories, inaraAssetDirectory }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  if (logger.isDebugEnabled) {
    app.use('/api', (request, response, next) => {
      const startTime = Date.now();
      response.on('finish', () => logger.debug(`${request.method} ${request.originalUrl} ${response.statusCode} ${Date.now() - startTime}ms`));
      next();
    });
  }

  const apiRouter = express.Router();

  apiRouter.get('/status', (request, response) => {
    response.json({
      journalDirectories,
      databasePath,
      startedAt: serverStartedAt,
      scan: journalMonitor.scanProgress,
      clock: clockMonitor.status,
      statModules: statsEngine.getModuleSummaries(),
    });
  });

  // GET /api/ship-status -> { commanders: [...] }: the live ship state from the game's Status.json,
  // for each playing commander its writes have been matched to
  apiRouter.get('/ship-status', (request, response) => {
    response.json(statusMonitor.getStatus());
  });

  apiRouter.use('/', createJournalRoutes(database, { journalDirectories }));
  apiRouter.use('/sql', createSqlRoutes(databasePath, database));
  apiRouter.use('/events', createEventRoutes(eventHub));
  apiRouter.use('/', createNoteRoutes(database, eventHub));
  apiRouter.use('/bgs-adjustments', createBgsAdjustmentRoutes(database, eventHub));

  // GET /api/stats -> registered stat modules
  apiRouter.get('/stats', (request, response) => {
    response.json({ modules: statsEngine.getModuleSummaries() });
  });

  // POST /api/stats/rebuild { module?: "travel" } -> clear and rebuild stats from stored entries
  apiRouter.post('/stats/rebuild', async (request, response) => {
    const moduleName = request.body?.module || undefined;
    logger.info(`Rebuilding ${moduleName ? `"${moduleName}"` : 'all'} stats (requested via API)...`);
    await statsEngine.rebuild(moduleName);
    response.json({ rebuilt: moduleName ?? 'all', modules: statsEngine.getModuleSummaries() });
  });

  for (const statModule of statsEngine.statModules) {
    apiRouter.use(`/stats/${statModule.name}`, statModule.createRouter(database));
  }

  apiRouter.use((request, response) => {
    response.status(404).json({ error: `Unknown API route: ${request.method} ${request.originalUrl}` });
  });

  // Express 5 forwards rejected promises here.
  apiRouter.use((error, request, response, _next) => {
    logger.error(`API error on ${request.method} ${request.originalUrl}:`, error);
    response.status(error.status ?? 500).json({ error: error.message });
  });

  app.use('/api', apiRouter);

  // The Inara artwork, downloaded into the data folder on first run (assets/inara-assets.mjs). A
  // file that isn't there (yet) is a plain 404, so the dashboard hides that picture; it never falls
  // through to the dashboard's own pages.
  if (inaraAssetDirectory) {
    app.use('/inara', express.static(inaraAssetDirectory, { maxAge: '1d', index: false }), (request, response) => response.status(404).end());
  }
  return app;
}

const serverStartedAt = new Date().toISOString();

/** Serves the built dashboard (client/dist), falling back to index.html for client-side routes. */
export function serveBuiltClient(app, clientDistPath) {
  const indexHtmlPath = path.join(clientDistPath, 'index.html');
  if (!existsSync(indexHtmlPath)) {
    logger.warn(`Dashboard client not built (missing ${indexHtmlPath}). Run "npm run build" to build it.`);
    app.get('/{*path}', (request, response) => {
      response.type('text').send('Dashboard client has not been built. Run "npm run build" in the project directory, then restart.');
    });
    return;
  }

  app.use(express.static(clientDistPath, { index: false }));
  app.get('/{*path}', (request, response) => response.sendFile(indexHtmlPath));
}
