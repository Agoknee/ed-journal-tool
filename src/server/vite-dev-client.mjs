import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from '../logger.mjs';

/**
 * Serves the dashboard from client source through the Vite dev server in middleware mode, so the
 * dashboard and API share one port and client changes hot-reload. Vite is loaded from the client's
 * own dependencies, which keeps it out of the server bundle used for standalone executables.
 * @param {import('express').Express} app
 * @param {{ clientRootPath: string, httpServer: import('node:http').Server }} options
 * @returns {Promise<import('vite').ViteDevServer>}
 */
export async function serveClientWithVite(app, { clientRootPath, httpServer }) {
  const clientPackageJsonPath = path.join(clientRootPath, 'package.json');
  if (!existsSync(clientPackageJsonPath)) {
    throw new Error(`Client source not found at "${clientRootPath}"; --dev-client needs the project's client directory.`);
  }

  let viteModulePath;
  try {
    viteModulePath = createRequire(clientPackageJsonPath).resolve('vite');
  } catch {
    throw new Error('Vite is not installed for the client. Run "npm run client:install" first.');
  }

  const { createServer: createViteServer } = await import(pathToFileURL(viteModulePath).href);
  const viteServer = await createViteServer({
    root: clientRootPath,
    configFile: path.join(clientRootPath, 'vite.config.js'),
    appType: 'spa',
    server: { middlewareMode: true, ws: { server: httpServer } },
  });
  app.use(viteServer.middlewares);
  logger.info('Serving the dashboard from client source with Vite (hot reload enabled).');
  return viteServer;
}
