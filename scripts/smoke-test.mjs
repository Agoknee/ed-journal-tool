/**
 * Starts a built executable as on a new system and checks that it works: the API answers with
 * package.json's version, and the dashboard is served. Used by the build workflow; exits 1 (with
 * the app's output) when something's wrong.
 *
 *   node scripts/smoke-test.mjs [--background] <executable> [more options for it]
 *
 * "A new system": its data folder (%LOCALAPPDATA% on Windows, the home folder elsewhere) is a
 * temporary folder that doesn't exist yet, so the default database, the log and the rest are all
 * written there for the first time. It runs on a free port, with an empty journal folder, and
 * without downloading the Inara images.
 *
 * --background: the Windows executable started as it is double-clicked (no --console): the copy
 * started exits once the hidden one it starts is up, which logs to the data folder. The hidden copy
 * is stopped afterwards.
 *
 * EDJT_EXPECTED_VERSION, when set, is the version expected in place of package.json's (for a build
 * whose version had the commit added).
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STARTUP_TIMEOUT_MS = 60 * 1000;

const projectRootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.env.EDJT_EXPECTED_VERSION
  || JSON.parse(readFileSync(path.join(projectRootPath, 'package.json'), 'utf8')).version;
let commandLine = process.argv.slice(2);
const isBackground = commandLine[0] === '--background';
if (isBackground) commandLine = commandLine.slice(1);
const [executablePath, ...extraArgs] = commandLine;
if (!executablePath) {
  console.error('Usage: node scripts/smoke-test.mjs [--background] <executable> [more options for it]');
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
// Not created: the app has to make it, as on a new system.
const newSystemDirectory = path.join(workDirectory, 'new-system');
const env = process.platform === 'win32'
  ? { ...process.env, LOCALAPPDATA: newSystemDirectory }
  : { ...process.env, HOME: newSystemDirectory };
const dataDirectory = process.platform === 'win32'
  ? path.join(newSystemDirectory, 'edjt')
  : path.join(newSystemDirectory, '.local', 'share', 'edjt');

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const args = [
  '--port', String(port), '--bind', '127.0.0.1',
  '--journaldir', journalDirectory,
  '--no-download-images',
  ...extraArgs,
];
console.log(`Starting ${executablePath} ${args.join(' ')}${isBackground ? ' (in the background)' : ''}, with the data folder ${dataDirectory}`);
const app = spawn(path.resolve(executablePath), args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
    // In the background, the copy started exits (0) once the hidden one is up; that's how it should be.
    const hasFailed = exitCode !== null && !(isBackground && exitCode === 0);
    if (hasFailed) throw new Error(`it exited (code ${exitCode}) before answering`);
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
  const expectedDatabasePath = path.join(dataDirectory, 'journals.db');
  if (path.resolve(status.databasePath ?? '') !== expectedDatabasePath) throw new Error(`the database is "${status.databasePath}", not "${expectedDatabasePath}"`);

  const dashboard = await fetch(baseUrl);
  const html = await dashboard.text();
  if (!dashboard.ok || !/<div id="root">/.test(html)) throw new Error(`the dashboard isn't served (HTTP ${dashboard.status})`);

  const commanders = await fetch(`${baseUrl}/api/commanders`);
  if (!commanders.ok) throw new Error(`/api/commanders answered HTTP ${commanders.status}`);

  if (isBackground && !existsSync(path.join(dataDirectory, 'edjt.log'))) throw new Error(`there's no log in ${dataDirectory}`);
}

/** Stops the hidden copy, found by the port it listens on (this script didn't start it itself). */
function stopBackgroundCopy() {
  try {
    const listening = execFileSync('netstat.exe', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
      .split('\n').map((line) => line.trim().split(/\s+/))
      .find((columns) => columns[1] === `127.0.0.1:${port}` && columns[3] === 'LISTENING');
    if (listening) execFileSync('taskkill.exe', ['/F', '/PID', listening[4]], { stdio: 'ignore' });
  } catch {
    // Not running.
  }
}

let failure = null;
try {
  await check();
} catch (error) {
  failure = error;
}
if (isBackground) {
  if (failure) {
    try {
      output += `\n----- ${path.join(dataDirectory, 'edjt.log')} -----\n${readFileSync(path.join(dataDirectory, 'edjt.log'), 'utf8')}`;
    } catch {
      // No log.
    }
  }
  stopBackgroundCopy();
}
app.kill();
await new Promise((resolve) => (exitCode !== null ? resolve() : app.on('exit', resolve)));
rmSync(workDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });

if (failure) {
  console.log(`----- its output -----\n${output.trim()}\n----------------------`);
  console.log(`::error::The smoke test of ${executablePath} failed: ${failure.message}`);
  process.exit(1);
}
console.log(`${executablePath} works on a new system${isBackground ? ', in the background' : ''}: version ${version}, API and dashboard answering.`);
