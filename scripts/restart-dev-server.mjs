/**
 * Restarts the development server (`npm run restart`): stops every running `node src/index.mjs`
 * of this checkout, whoever started it (`npm start` in a terminal, or Claude), and starts it again
 * in the background with the same options, its output appended to a log.
 *
 *   npm run restart                  the options it was running with (--dev-client if none was)
 *   npm run restart -- --debug ...   these options instead
 *
 * The log is %TEMP%\edjt-dev\dev-server.log (/tmp/edjt-dev on Linux), so
 * `Get-Content $env:TEMP\edjt-dev\dev-server.log -Wait -Tail 100` follows it across restarts.
 *
 * On Windows the new copy is started through WMI (Win32_Process.Create, window hidden): it isn't a
 * child of this script or of the terminal (or Claude session) that ran it, so it keeps running when
 * they close, and no blank console window appears. It's stopped with `taskkill /T /F` (there's no
 * Ctrl+C to send to another console), which takes its tray icon and Vite's esbuild with it; SQLite
 * keeps the database consistent through that. On Linux it gets SIGTERM, so it shuts down cleanly.
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 4267;
const STOP_TIMEOUT_MS = 15 * 1000;
const START_TIMEOUT_MS = 60 * 1000;

const isWindows = process.platform === 'win32';
const projectRootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entryPointPath = path.join(projectRootPath, 'src', 'index.mjs');
const logDirectoryPath = path.join(os.tmpdir(), 'edjt-dev');
const logPath = path.join(logDirectoryPath, 'dev-server.log');
const powerShellPath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const runningServers = findRunningServers();
const givenArgs = process.argv.slice(2);
// The options of the copy being replaced, without the log file (this script picks that).
const serverArgs = givenArgs.length > 0
  ? givenArgs
  : withoutLogFile(runningServers[0]?.args ?? ['--dev-client']);
const port = portFrom(serverArgs);
// Where to check it answers: what it's bound to, unless that's every interface.
const bindHost = optionValue(serverArgs, /^(?:--bind|-b)(?:=(.*))?$/);
const checkHost = !bindHost || bindHost === '0.0.0.0' || bindHost === '::' ? '127.0.0.1' : bindHost;

for (const server of runningServers) {
  console.log(`Stopping the server (process ${server.processId}: ${server.args.join(' ') || 'no options'})`);
  stopProcess(server.processId);
}
if (runningServers.length > 0 && !(await waitFor(async () => !(await isPortAnswering(port)), STOP_TIMEOUT_MS))) {
  console.error(`Port ${port} still answers ${STOP_TIMEOUT_MS / 1000}s after stopping the server; something else may be using it.`);
  process.exit(1);
}
if (runningServers.length === 0 && await isPortAnswering(port)) {
  console.error(`Port ${port} is in use, but not by a "node src/index.mjs" of ${projectRootPath} (an installed EDJT?). Stop that first.`);
  process.exit(1);
}

mkdirSync(logDirectoryPath, { recursive: true });
// The cmd that was appending the old copy's output to the log holds it open for a moment after
// that copy is stopped.
const marker = `\n===== ${runningServers.length > 0 ? 'restarted' : 'started'} ${new Date().toLocaleString()} =====\n`;
if (!(await waitFor(() => tryAppend(logPath, marker), STOP_TIMEOUT_MS))) {
  console.error(`The log is still in use by another program: ${logPath}`);
  process.exit(1);
}
console.log(`Starting: node src/index.mjs ${serverArgs.join(' ')}`);
startServer(serverArgs);

if (await waitFor(() => isPortAnswering(port), START_TIMEOUT_MS)) {
  console.log(`Running at http://localhost:${port}/ (log: ${logPath})`);
} else {
  console.error(`It didn't answer on port ${port} within ${START_TIMEOUT_MS / 1000}s. See the log: ${logPath}`);
  process.exit(1);
}

/**
 * The running `node src/index.mjs` processes of this checkout, and the options each was given.
 * @returns {{ processId: number, args: string[] }[]}
 */
function findRunningServers() {
  const processes = isWindows ? windowsNodeProcesses() : linuxProcesses();
  const servers = [];
  for (const { processId, commandLine, workingDirectory } of processes) {
    if (processId === process.pid) continue;
    // `npm start` runs it as the relative src/index.mjs from the project folder; other ways may
    // give a full path. A relative one is taken as relative to this checkout where the working
    // folder isn't known (Windows doesn't say).
    const entryIndex = commandLine.findIndex((token, index) => index > 0
      && path.resolve(workingDirectory ?? projectRootPath, token).toLowerCase() === entryPointPath.toLowerCase());
    if (entryIndex === -1) continue;
    servers.push({ processId, args: commandLine.slice(entryIndex + 1) });
  }
  return servers;
}

/** @returns {{ processId: number, commandLine: string[] }[]} */
function windowsNodeProcesses() {
  const output = runPowerShell(`
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Select-Object ProcessId, CommandLine |
      ConvertTo-Json -Compress
  `);
  if (!output.trim()) return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed])
    .filter((entry) => entry.CommandLine)
    .map((entry) => ({ processId: entry.ProcessId, commandLine: splitWindowsCommandLine(entry.CommandLine) }));
}

/** @returns {{ processId: number, commandLine: string[], workingDirectory: string }[]} */
function linuxProcesses() {
  const processes = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const commandLine = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (!commandLine.some((token) => token.endsWith('index.mjs'))) continue;
      processes.push({ processId: Number(name), commandLine, workingDirectory: readlinkSync(`/proc/${name}/cwd`) });
    } catch {
      // Gone already, or someone else's.
    }
  }
  return processes;
}

/**
 * A Windows command line split into arguments: spaces separate them except inside double quotes.
 * Enough for node's command lines; the full rules (backslashes before quotes) aren't needed.
 */
function splitWindowsCommandLine(commandLine) {
  const tokens = [];
  let current = '';
  let isQuoted = false;
  let hasToken = false;
  for (const character of commandLine) {
    if (character === '"') {
      isQuoted = !isQuoted;
      hasToken = true;
    } else if (/\s/.test(character) && !isQuoted) {
      if (hasToken) tokens.push(current);
      current = '';
      hasToken = false;
    } else {
      current += character;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

function withoutLogFile(args) {
  const kept = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--log-file') index++;
    else if (!args[index].startsWith('--log-file=')) kept.push(args[index]);
  }
  return kept;
}

function portFrom(args) {
  return Number(optionValue(args, /^(?:--port|-p)(?:=(.*))?$/)) || DEFAULT_PORT;
}

/** The value of an option given as `--name value` or `--name=value` (the last one wins, as in yargs). */
function optionValue(args, pattern) {
  let value;
  for (let index = 0; index < args.length; index++) {
    const match = pattern.exec(args[index]);
    if (match) value = match[1] ?? args[index + 1];
  }
  return value;
}

function stopProcess(processId) {
  try {
    if (isWindows) execFileSync('taskkill', ['/PID', String(processId), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(processId, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

function startServer(args) {
  if (isWindows) {
    // cmd does the appending to the log (WMI can't redirect output). /s: the outer quotes are
    // removed and the rest kept as it is.
    const command = [process.execPath, 'src\\index.mjs', ...args, '--log-file', logPath].map(quoteForCmd).join(' ');
    const processId = runPowerShell(`
      $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
      $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $env:EDJT_RESTART_COMMAND
        CurrentDirectory = $env:EDJT_RESTART_DIRECTORY
        ProcessStartupInformation = $startup
      }
      if ($result.ReturnValue -ne 0) { throw "Win32_Process.Create failed with $($result.ReturnValue)" }
      $result.ProcessId
    `, {
      EDJT_RESTART_COMMAND: `cmd.exe /d /s /c "${command} >> ${quoteForCmd(logPath)} 2>&1"`,
      EDJT_RESTART_DIRECTORY: projectRootPath,
    }).trim();
    console.log(`Started (cmd process ${processId})`);
  } else {
    const logFile = openSync(logPath, 'a');
    const child = spawn(process.execPath, [entryPointPath, ...args], {
      cwd: projectRootPath,
      detached: true,
      stdio: ['ignore', logFile, logFile],
    });
    child.unref();
    console.log(`Started (process ${child.pid})`);
  }
}

function quoteForCmd(argument) {
  return /^[\w\-.:\\/=]+$/.test(argument) ? argument : `"${argument}"`;
}

/**
 * Runs a PowerShell script, given on stdin (not -EncodedCommand, which antivirus treats as
 * suspicious, and not as an argument, which Windows PowerShell's quoting mangles). Values go in
 * through environment variables, for the same reason. Wrapped in one block so 'Stop' stops it.
 */
function runPowerShell(script, environment = {}) {
  if (!existsSync(powerShellPath)) throw new Error(`PowerShell not found at ${powerShellPath}`);
  return execFileSync(powerShellPath, ['-NoProfile', '-NonInteractive', '-Command', '-'], {
    input: `& {\n$ErrorActionPreference = 'Stop'\n${script}\n}\n\n`,
    env: { ...process.env, ...environment },
    encoding: 'utf8',
    windowsHide: true,
  });
}

function tryAppend(filePath, text) {
  try {
    appendFileSync(filePath, text);
    return true;
  } catch (error) {
    if (error.code === 'EBUSY' || error.code === 'EPERM') return false;
    throw error;
  }
}

function isPortAnswering(portNumber) {
  return new Promise((resolve) => {
    const socket = net.connect({ port: portNumber, host: checkHost });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
