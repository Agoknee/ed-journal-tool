/**
 * Builds the self-extracting Linux installer: the shell script in linux-installer.sh, with the app's
 * details filled in and its files appended as a gzipped tar archive. Run as the user (no root needed),
 * it installs the per-user way:
 *
 * - the executable in ~/.local/bin,
 * - the icon in ~/.local/share/icons/hicolor/512x512/apps,
 * - a menu entry in ~/.local/share/applications (honouring XDG_DATA_HOME),
 *
 * The program finds the game's journal folders itself each time it starts (journals/journal-locations.mjs),
 * so it's only given a folder when one is set with --journaldir (remembered for updates).
 *
 * Optionally (--service; off unless asked for) it's also set up as a systemd user service, so it runs
 * in the background from login, whatever's on screen: on a Steam Deck that's Game Mode too, where the
 * desktop menu entry can't be used. The menu entry then opens the dashboard instead of starting a
 * second copy. `--no-service` turns that off again; an update keeps whatever was chosen.
 *
 * `--uninstall` removes all of it, keeping the app's data (the database).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const PAYLOAD_MARKER = '__EDJT_PAYLOAD_BELOW__';
const SCRIPT_TEMPLATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'linux-installer.sh');

/**
 * @param {object} options
 * @param {string} options.outputPath
 * @param {string} options.binaryPath   the packaged Linux executable
 * @param {string} options.iconPath     a 512x512 PNG
 * @param {string} options.appId        e.g. "ed-journal-tool" (file names)
 * @param {string} options.appName      e.g. "ED Journal Tool"
 * @param {string} options.appVersion
 * @param {string} options.appDescription
 */
export function writeLinuxInstaller({ outputPath, binaryPath, iconPath, appId, appName, appVersion, appDescription }) {
  const payload = gzipSync(createTar([
    { name: appId, data: readFileSync(binaryPath), mode: 0o755 },
    { name: `${appId}.png`, data: readFileSync(iconPath), mode: 0o644 },
  ]), { level: 9 });
  const script = installerScript({ APP_ID: appId, APP_NAME: appName, APP_VERSION: appVersion, APP_COMMENT: appDescription });
  // The script ends with the marker line; the archive follows it byte for byte.
  writeFileSync(outputPath, Buffer.concat([Buffer.from(script, 'utf8'), payload]), { mode: 0o755 });
}

/**
 * linux-installer.sh with its placeholders filled in: '@NAME@' (in single quotes, as a shell value)
 * becomes the value shell-quoted, and a bare @NAME@ (in comments) the value as it is.
 */
export function installerScript(values) {
  let script = readFileSync(SCRIPT_TEMPLATE_PATH, 'utf8').replace(/\r\n/g, '\n');
  const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  for (const [name, value] of Object.entries(values)) {
    if (/[\n\r]/.test(String(value))) throw new Error(`Installer value ${name} can't have a line break`);
    script = script.replaceAll(`'@${name}@'`, () => shellQuote(value)).replaceAll(`@${name}@`, () => String(value));
  }
  const leftOver = script.match(/@[A-Z_]+@/);
  if (leftOver) throw new Error(`linux-installer.sh has a placeholder with no value: ${leftOver[0]}`);
  if (!script.endsWith(`\n${PAYLOAD_MARKER}\n`)) throw new Error(`linux-installer.sh must end with the line ${PAYLOAD_MARKER}`);
  return script;
}

/** A minimal POSIX (ustar) tar archive of regular files. */
function createTar(files) {
  const blocks = [];
  const mtime = Math.floor(Date.now() / 1000);
  for (const { name, data, mode } of files) {
    const header = Buffer.alloc(512);
    const field = (value, offset, length) => header.write(value, offset, length, 'ascii');
    const octal = (value, offset, length) => field(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length);
    field(name, 0, 100);
    octal(mode, 100, 8);
    octal(0, 108, 8); // uid
    octal(0, 116, 8); // gid
    octal(data.length, 124, 12);
    octal(mtime, 136, 12);
    field('        ', 148, 8); // checksum, counted as spaces while it's worked out
    field('0', 156, 1); // regular file
    field('ustar\0', 257, 6);
    field('00', 263, 2);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    field(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(header, data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024)); // end of archive
  return Buffer.concat(blocks);
}
