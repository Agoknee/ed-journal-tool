/**
 * The Windows tray icon: a hidden PowerShell process (Windows PowerShell 5.1 is on every Windows 10
 * and 11) showing a NotifyIcon with "Open Dashboard", "Show Log" and "Quit". See tray.ps1.mjs.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { logger } from '../logger.mjs';
import { TRAY_SCRIPT } from './tray.ps1.mjs';

const POWERSHELL_PATH = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/**
 * Shows the tray icon. Its process removes the icon and exits by itself once this one is gone.
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.dashboardUrl
 * @param {string | null} [options.logPath]   for "Show Log"
 * @param {string} [options.iconPath]         an .ico; else the executable's own icon
 * @param {string | null} [options.notification]  shown when the icon appears
 * @param {() => void} options.onQuit
 * @param {() => void} [options.onFailure]    the icon couldn't be shown (or its process ended)
 * @returns {{ process: import('node:child_process').ChildProcess }}
 */
export function startTrayIcon({ title, dashboardUrl, logPath = null, iconPath = '', notification = null, onQuit, onFailure = () => {} }) {
  const encodedScript = Buffer.from(TRAY_SCRIPT, 'utf16le').toString('base64');
  const trayProcess = spawn(POWERSHELL_PATH, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encodedScript], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      EDJT_TRAY_TITLE: title,
      EDJT_TRAY_URL: dashboardUrl,
      EDJT_TRAY_LOG: logPath ?? '',
      EDJT_TRAY_ICON: iconPath,
      EDJT_TRAY_EXE: process.execPath,
      EDJT_TRAY_PARENT_PID: String(process.pid),
      EDJT_TRAY_NOTIFY: notification ?? '',
    },
  });

  let hasQuit = false;
  let errorOutput = '';
  readline.createInterface({ input: trayProcess.stdout }).on('line', (line) => {
    if (line === 'ready') logger.debug('Tray icon shown.');
    if (line === 'quit') {
      hasQuit = true;
      logger.info('Quit from the tray icon.');
      onQuit();
    }
  });
  trayProcess.stderr.on('data', (chunk) => { errorOutput += chunk; });
  trayProcess.on('error', (error) => {
    logger.warn(`Couldn't show the tray icon: ${error.message}`);
    onFailure();
  });
  trayProcess.on('exit', (code) => {
    if (hasQuit) return;
    logger.warn(`The tray icon closed (exit code ${code})${errorOutput.trim() ? `: ${errorOutput.trim().split('\n')[0]}` : ''}`);
    onFailure();
  });
  return { process: trayProcess };
}
