/**
 * Packages the bundled server (from bundle-server.mjs) and the built client (client/dist) into
 * Linux and Windows executables with yao-pkg, named with the package.json version:
 * dist/ed-journal-tool-<version>-linux and dist/ed-journal-tool-<version>-win.exe.
 * Targets and assets come from the "pkg" section of package.json.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec as runPkg } from '@yao-pkg/pkg';

const projectRootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = path.join(projectRootPath, 'package.json');
const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

await runPkg([
  path.join(projectRootPath, 'build', 'ed-journal-tool.cjs'),
  '--config', packageJsonPath,
  '--output', path.join(projectRootPath, 'dist', `ed-journal-tool-${version}`),
  // Bytecode can't be generated for Linux when building on Windows, so ship plain (bundled) JavaScript.
  '--no-bytecode', '--public', '--public-packages', '*',
]);
