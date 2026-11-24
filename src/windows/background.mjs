/**
 * Running the Windows executable in the background, with the tray icon instead of a console window.
 *
 * Started normally (double-clicked, say), the executable starts a hidden copy of itself, logging to
 * a file, waits for its web server to be up and exits, which closes the console window. If the copy
 * fails to start, the window stays open with the error. Started while one is already running, it
 * opens the dashboard instead.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { dataDirectoryPath } from '../data-paths.mjs';

/** Set in the hidden copy's environment. */
export const BACKGROUND_CHILD_ENV = 'EDJT_BACKGROUND_CHILD';
export const backgroundLogPath = path.join(dataDirectoryPath, 'edjt.log');
const previousLogPath = path.join(dataDirectoryPath, 'edjt.previous.log');

export const isBackgroundChild = () => process.env[BACKGROUND_CHILD_ENV] === '1';

/** Tells the starting copy (if any) that the web server is up, so it can exit. */
export function reportBackgroundReady() {
  if (!isBackgroundChild() || !process.send) return;
  try {
    process.send({ type: 'ready' }, () => process.disconnect?.());
  } catch {
    // The starting copy is already gone (its window was closed).
  }
}

/** Opens a URL in the default browser. */
export function openInBrowser(url) {
  spawn('explorer.exe', [url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/**
 * Starts the hidden copy and waits for it; never returns (exits this process).
 * @param {{ port: number, bind: string, dashboardUrl: string, appName: string }} options
 */
export async function launchInBackground({ port, bind, dashboardUrl, appName }) {
  if (await isAlreadyRunning(port, bind)) {
    console.log(`${appName} is already running; opening the dashboard (${dashboardUrl}).`);
    openInBrowser(dashboardUrl);
    process.exit(0);
  }

  // The last run's log is kept beside this one.
  if (existsSync(backgroundLogPath)) {
    rmSync(previousLogPath, { force: true });
    renameSync(backgroundLogPath, previousLogPath);
  }
  const logFile = openSync(backgroundLogPath, 'a');

  console.log(`Starting ${appName} in the background (look for its icon in the system tray)...`);
  // A packaged executable started from itself runs as plain node, so it's given the app's entry
  // script (argv[1], inside the executable) first, as node would be.
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFile, logFile, 'ipc'],
    env: { ...process.env, [BACKGROUND_CHILD_ENV]: '1' },
  });
  closeSync(logFile);

  const outcome = await new Promise((resolve) => {
    child.once('message', (message) => { if (message?.type === 'ready') resolve({ isReady: true }); });
    child.once('exit', (code) => resolve({ isReady: false, code }));
    child.once('error', (error) => resolve({ isReady: false, error }));
  });

  if (outcome.isReady) {
    child.unref();
    child.disconnect?.();
    console.log(`${appName} is running. The dashboard is at ${dashboardUrl}; quit it from its tray icon.`);
    process.exit(0);
  }

  console.error(`\n${appName} couldn't start${outcome.error ? `: ${outcome.error.message}` : ` (exit code ${outcome.code})`}. Its log:\n`);
  try {
    console.error(readFileSync(backgroundLogPath, 'utf8').split('\n').slice(-25).join('\n'));
  } catch {
    // no log
  }
  console.error('Press Enter to close this window.');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(1));
}

/** Whether an EDJT already answers on this port. */
async function isAlreadyRunning(port, bind) {
  const host = bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind;
  try {
    const response = await fetch(`http://${host}:${port}/api/status`, { signal: AbortSignal.timeout(1500) });
    const body = await response.json();
    return Array.isArray(body?.journalDirectories);
  } catch {
    return false;
  }
}
