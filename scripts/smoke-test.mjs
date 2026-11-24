/**
 * Starts a built executable and checks that it works: the API answers with package.json's version
 * and the dashboard is served. It runs on a free port, with a new database and an empty journal
 * folder in a temporary folder, and without downloading the Inara images. Used by the build
 * workflow; exits 1 (with the app's output) when something's wrong.
 *
 *   node scripts/smoke-test.mjs <executable> [more options for it]
 *
 * EDJT_EXPECTED_VERSION, when set, is the version expected in place of package.json's (for a build
 * whose version had the commit added).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STARTUP_TIMEOUT_MS = 60 * 1000;

const projectRootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.env.EDJT_EXPECTED_VERSION
  || JSON.parse(readFileSync(path.join(projectRootPath, 'package.json'), 'utf8')).version;
const [executablePath, ...extraArgs] = process.argv.slice(2);
if (!executablePath) {
  console.error('Usage: node scripts/smoke-test.mjs <executable> [more options for it]');
  process.exit(1);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

const workDirectory = mkdtempSync(path.join(os.tmpdir(), 'edjt-smoke-'));
const journalDirectory = mkdtempSync(path.join(workDirectory, 'journals-'));
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const args = [
  '--port', String(port), '--bind', '127.0.0.1',
  '--database', path.join(workDirectory, 'journals.db'),
  '--journaldir', journalDirectory,
  '--no-download-images',
  ...extraArgs,
];
console.log(`Starting ${executablePath} ${args.join(' ')}`);
const app = spawn(path.resolve(executablePath), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let output = '';
app.stdout.on('data', (chunk) => { output += chunk; });
app.stderr.on('data', (chunk) => { output += chunk; });
let exitCode = null;
app.on('exit', (code) => { exitCode = code ?? -1; });
app.on('error', (error) => {
  output += `Couldn't start it: ${error.message}\n`;
  exitCode = -1;
});

async function check() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let status = null;
  while (!status) {
    if (exitCode !== null) throw new Error(`it exited (code ${exitCode}) before answering`);
    if (Date.now() > deadline) throw new Error(`no answer from ${baseUrl} within ${STARTUP_TIMEOUT_MS / 1000}s`);
    try {
      const response = await fetch(`${baseUrl}/api/status`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) status = await response.json();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (status.version !== version) throw new Error(`/api/status says version ${status.version}, not ${version}`);
  if (!status.journalDirectories?.includes(journalDirectory)) throw new Error(`/api/status lists the journal folders ${JSON.stringify(status.journalDirectories)}`);

  const dashboard = await fetch(baseUrl);
  const html = await dashboard.text();
  if (!dashboard.ok || !/<div id="root">/.test(html)) throw new Error(`the dashboard isn't served (HTTP ${dashboard.status})`);

  const commanders = await fetch(`${baseUrl}/api/commanders`);
  if (!commanders.ok) throw new Error(`/api/commanders answered HTTP ${commanders.status}`);
}

let failure = null;
try {
  await check();
} catch (error) {
  failure = error;
}
app.kill();
await new Promise((resolve) => (exitCode !== null ? resolve() : app.on('exit', resolve)));
rmSync(workDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });

if (failure) {
  console.log(`----- its output -----\n${output.trim()}\n----------------------`);
  console.log(`::error::The smoke test of ${executablePath} failed: ${failure.message}`);
  process.exit(1);
}
console.log(`${executablePath} works: version ${version}, API and dashboard answering.`);
