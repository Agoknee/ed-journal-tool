import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// During development (npm run client:dev), API requests are proxied to the running server.
const apiServerUrl = process.env.API_SERVER_URL ?? 'http://localhost:4267';

// The app version comes from the server's package.json, shown in the page title and sidebar.
const { version: appVersion } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** Replaces %APP_VERSION% in index.html. */
const appVersionHtmlPlugin = {
  name: 'app-version-html',
  transformIndexHtml: (html) => html.replaceAll('%APP_VERSION%', appVersion),
};

export default defineConfig({
  plugins: [react(), appVersionHtmlPlugin],
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  server: {
    proxy: {
      '/api': { target: apiServerUrl, changeOrigin: true },
    },
  },
});
