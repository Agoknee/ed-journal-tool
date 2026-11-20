/**
 * Bundles the server (src/) and its dependencies into one CommonJS file for yao-pkg.
 * The client is not bundled here; `npm run dist` packages its built output (client/dist) as assets.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(projectRootPath, 'src', 'index.mjs')],
  outfile: path.join(projectRootPath, 'build', 'ed-journal-tool.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  // import.meta isn't available in CommonJS; point import.meta.url at the bundle file instead.
  define: { 'import.meta.url': 'bundledImportMetaUrl' },
  banner: { js: "const bundledImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  logLevel: 'info',
});
