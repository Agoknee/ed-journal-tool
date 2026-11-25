/**
 * The Windows tray icon, with "Open Dashboard", "Show Log" and "Quit".
 *
 * It's shown by a small program of its own (tray.cs.mjs), compiled the first time with the C#
 * compiler that comes with Windows and kept in the data folder, so Windows names the icon
 * "ED Journal Tool". Should that not work, a hidden PowerShell shows it instead (tray.ps1.mjs),
 * which Windows lists as "Windows PowerShell".
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { dataDirectoryPath } from '../data-paths.mjs';
import { logger } from '../logger.mjs';
import { TRAY_PROGRAM } from './tray.cs.mjs';
import { TRAY_SCRIPT } from './tray.ps1.mjs';

const WINDOWS_PATH = process.env.SystemRoot ?? 'C:\\Windows';
const POWERSHELL_PATH = path.join(WINDOWS_PATH, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CSC_PATH = path.join(WINDOWS_PATH, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

// Always the same path: Windows keeps a tray icon's settings (shown or hidden) by its program's path.
const TRAY_DIRECTORY = path.join(dataDirectoryPath, 'tray');
const TRAY_PROGRAM_PATH = path.join(TRAY_DIRECTORY, 'edjt-tray.exe');
const TRAY_ICON_PATH = path.join(TRAY_DIRECTORY, 'edjt.ico');
const TRAY_STAMP_PATH = path.join(TRAY_DIRECTORY, 'edjt-tray.stamp');

/**
 * The tray program, compiled when it's missing or its source or icon changed.
 * @param {string} iconPath
 * @returns {Promise<{ programPath: string, iconPath: string }>}
 */
async function trayProgram(iconPath) {
  const icon = iconPath && existsSync(iconPath) ? readFileSync(iconPath) : null;
  const stamp = createHash('sha256').update(TRAY_PROGRAM).update(icon ?? '').digest('hex');
  const usableIconPath = icon ? TRAY_ICON_PATH : '';
  const currentStamp = await readFile(TRAY_STAMP_PATH, 'utf8').catch(() => '');
  if (currentStamp === stamp && existsSync(TRAY_PROGRAM_PATH)) return { programPath: TRAY_PROGRAM_PATH, iconPath: usableIconPath };

  await mkdir(TRAY_DIRECTORY, { recursive: true });
  const sourcePath = path.join(TRAY_DIRECTORY, 'edjt-tray.cs');
  const newProgramPath = path.join(TRAY_DIRECTORY, `edjt-tray.${process.pid}.exe`);
  await writeFile(sourcePath, TRAY_PROGRAM);
  if (icon) await writeFile(TRAY_ICON_PATH, icon);
  try {
    await promisify(execFile)(CSC_PATH, [
      '/nologo', '/target:winexe', '/optimize+', `/out:${newProgramPath}`,
      ...(icon ? [`/win32icon:${TRAY_ICON_PATH}`] : []),
      '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
      sourcePath,
    ], { windowsHide: true });
    // Fails while another copy of the app has the old one running: that one does for now.
    await rename(newProgramPath, TRAY_PROGRAM_PATH);
    await writeFile(TRAY_STAMP_PATH, stamp);
    logger.debug(`Compiled the tray icon program "${TRAY_PROGRAM_PATH}".`);
  } catch (error) {
    await rm(newProgramPath, { force: true });
    if (!existsSync(TRAY_PROGRAM_PATH)) throw error;
    logger.debug(`Couldn't update the tray icon program (${error.message.trim().split('\n')[0]}); using the one there.`);
  } finally {
    await rm(sourcePath, { force: true });
  }
  return { programPath: TRAY_PROGRAM_PATH, iconPath: usableIconPath };
}

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
 * @returns {Promise<{ process: import('node:child_process').ChildProcess }>}
 */
export async function startTrayIcon({ title, dashboardUrl, logPath = null, iconPath = '', notification = null, onQuit, onFailure = () => {} }) {
  let command;
  let args;
  let script = null;
  let shownIconPath = iconPath;
  try {
    const program = await trayProgram(iconPath);
    command = program.programPath;
    args = [];
    shownIconPath = program.iconPath;
  } catch (error) {
    logger.debug(`Couldn't compile the tray icon program, so PowerShell shows it: ${error.message.trim().split('\n')[0]}`);
    // The script goes in on stdin rather than with -EncodedCommand, which antivirus treats as
    // suspicious. PowerShell runs stdin a statement at a time, so it's wrapped in one block (ended
    // by the blank line): otherwise $ErrorActionPreference = 'Stop' wouldn't stop the lines after
    // a failure. No -ExecutionPolicy: it only applies to script files.
    command = POWERSHELL_PATH;
    args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', '-'];
    script = `& {\n${TRAY_SCRIPT}\n}\n\n`;
  }

  const trayProcess = spawn(command, args, {
    windowsHide: true,
    stdio: [script === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      EDJT_TRAY_TITLE: title,
      EDJT_TRAY_URL: dashboardUrl,
      EDJT_TRAY_LOG: logPath ?? '',
      EDJT_TRAY_ICON: shownIconPath,
      EDJT_TRAY_EXE: process.execPath,
      EDJT_TRAY_PARENT_PID: String(process.pid),
      EDJT_TRAY_NOTIFY: notification ?? '',
    },
  });

  if (script !== null) {
    trayProcess.stdin.on('error', () => {}); // a PowerShell that didn't start: reported by 'error' below
    trayProcess.stdin.end(script);
  }

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
