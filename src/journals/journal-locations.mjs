/**
 * Finds the game's journal folders when --journaldir isn't given.
 *
 * On Windows that's "Saved Games/Frontier Developments/Elite Dangerous" in the user folder. On Linux
 * the game runs in a Wine prefix, where that folder is under drive_c/users/<user>/:
 *
 * - Steam (Proton): <library>/steamapps/compatdata/359320/pfx/drive_c/users/steamuser/..., in any
 *   Steam library: Valve's package, Debian's, Flatpak or Snap, plus the libraries each one lists in
 *   its libraryfolders.vdf (games on other drives).
 * - Heroic, Lutris, Bottles or plain Wine (the Epic or Frontier versions): a prefix somewhere under
 *   the usual game folders, found by looking for drive_c a few folders deep.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isJournalFileName } from './journal-files.mjs';

const GAME_FOLDER = ['Saved Games', 'Frontier Developments', 'Elite Dangerous'];
const STEAM_APP_ID = '359320';
const PROTON_JOURNALS = ['steamapps', 'compatdata', STEAM_APP_ID, 'pfx', 'drive_c', 'users', 'steamuser', ...GAME_FOLDER];

// How deep under each of these to look for a Wine prefix's drive_c (Heroic's is
// ~/Games/Heroic/Prefixes/default/<game>/pfx/drive_c), and how many folders to look in at most.
const PREFIX_SEARCH_DEPTH = 6;
const PREFIX_SEARCH_FOLDER_LIMIT = 5000;

/** Where Windows keeps the journals: the default when nothing else is found. */
export function windowsStyleJournalDirectory(home = homeDirectory()) {
  return path.join(home, ...GAME_FOLDER);
}

/**
 * The journal folders to read by default, most recently played first: on Linux every folder found
 * that has journals in it (else the first one found that exists at all), on Windows the usual one
 * if it's there. Empty when there's none (the game not installed or not run yet).
 * @param {{ home?: string, platform?: string }} [options]
 * @returns {string[]}
 */
export function defaultJournalDirectories({ home = homeDirectory(), platform = process.platform } = {}) {
  if (platform === 'win32') {
    const usual = windowsStyleJournalDirectory(home);
    return isDirectory(usual) ? [usual] : [];
  }
  const found = findJournalDirectories({ home });
  const withJournals = found.filter((folder) => folder.latestJournalAt !== null)
    .sort((a, b) => b.latestJournalAt - a.latestJournalAt);
  if (withJournals.length > 0) return withJournals.map((folder) => folder.directory);
  return found.slice(0, 1).map((folder) => folder.directory);
}

/** Where the default journal folders are looked for, for messages. */
export function describeJournalSearch(platform = process.platform) {
  return platform === 'win32'
    ? `"${windowsStyleJournalDirectory()}"`
    : 'Steam (Proton), Heroic, Lutris, Bottles and Wine folders, and "~/Saved Games/Frontier Developments/Elite Dangerous"';
}

/**
 * Every existing journal folder found in the usual places, with when its newest journal was
 * written (null when it has none).
 * @param {{ home?: string }} [options]
 * @returns {{ directory: string, source: string, latestJournalAt: number | null }[]}
 */
export function findJournalDirectories({ home = homeDirectory() } = {}) {
  const results = [];
  const seen = new Set();
  const add = (directory, source) => {
    if (!isDirectory(directory)) return;
    const key = realPath(directory);
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ directory, source, latestJournalAt: latestJournalTime(directory) });
  };

  for (const library of steamLibraries(home)) add(path.join(library, ...PROTON_JOURNALS), 'Steam (Proton)');
  for (const driveC of findWinePrefixDrives(home)) {
    for (const user of listDirectories(path.join(driveC, 'users'))) add(path.join(driveC, 'users', user, ...GAME_FOLDER), 'Wine prefix');
  }
  add(windowsStyleJournalDirectory(home), 'home folder');
  return results;
}

/** Steam's own folders (native, Debian's package, Flatpak, Snap) and the libraries they list. */
export function steamLibraries(home) {
  const steamFolders = [
    ['.steam', 'steam'],
    ['.steam', 'root'],
    ['.local', 'share', 'Steam'],
    ['.steam', 'debian-installation'],
    ['.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'],
    ['.var', 'app', 'com.valvesoftware.Steam', '.steam', 'steam'],
    ['snap', 'steam', 'common', '.local', 'share', 'Steam'],
    ['snap', 'steam', 'common', '.steam', 'steam'],
  ].map((parts) => path.join(home, ...parts));

  const libraries = [];
  const seen = new Set();
  const add = (library) => {
    if (!isDirectory(library)) return;
    const key = realPath(library);
    if (seen.has(key)) return;
    seen.add(key);
    libraries.push(library);
  };
  for (const steam of steamFolders) {
    if (!isDirectory(steam)) continue;
    add(steam);
    for (const library of readLibraryFolders(path.join(steam, 'steamapps', 'libraryfolders.vdf'))) add(library);
  }
  return libraries;
}

/** The "path" values in a libraryfolders.vdf (its strings escape \ and " with a backslash). */
export function parseLibraryFolders(text) {
  const paths = [];
  for (const match of text.matchAll(/^\s*"path"\s+"((?:[^"\\]|\\.)*)"\s*$/gm)) {
    paths.push(match[1].replace(/\\(.)/g, '$1'));
  }
  return paths;
}

function readLibraryFolders(vdfPath) {
  try {
    return parseLibraryFolders(readFileSync(vdfPath, 'utf8'));
  } catch {
    return [];
  }
}

/** The drive_c folders of the Wine prefixes under the usual game folders. */
function findWinePrefixDrives(home) {
  const roots = [
    ['Games'],
    ['.wine'],
    ['.local', 'share', 'wineprefixes'],
    ['.local', 'share', 'lutris'],
    ['.local', 'share', 'bottles', 'bottles'],
    ['.var', 'app', 'com.heroicgameslauncher.hgl'],
    ['.var', 'app', 'net.lutris.Lutris'],
    ['.var', 'app', 'com.usebottles.bottles', 'data', 'bottles', 'bottles'],
    ['.config', 'heroic'],
  ].map((parts) => path.join(home, ...parts));

  const drives = [];
  let budget = PREFIX_SEARCH_FOLDER_LIMIT;
  const visit = (folder, depth) => {
    if (budget-- <= 0) return;
    for (const name of listDirectories(folder)) {
      const child = path.join(folder, name);
      if (name === 'drive_c') {
        drives.push(child);
      } else if (depth < PREFIX_SEARCH_DEPTH && name !== 'steamapps' && !name.startsWith('.')) {
        visit(child, depth + 1);
      }
    }
  };
  for (const root of roots) {
    if (path.basename(root) === '.wine' && isDirectory(path.join(root, 'drive_c'))) {
      drives.push(path.join(root, 'drive_c'));
    } else if (isDirectory(root)) {
      visit(root, 1);
    }
  }
  return drives;
}

function latestJournalTime(directory) {
  let latest = null;
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!isJournalFileName(name)) continue;
    try {
      const modified = statSync(path.join(directory, name)).mtimeMs;
      if (latest === null || modified > latest) latest = modified;
    } catch {
      // gone since the listing
    }
  }
  return latest;
}

function listDirectories(folder) {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(path.join(folder, entry.name))))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function isDirectory(folder) {
  try {
    return statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

function realPath(folder) {
  try {
    return realpathSync(folder);
  } catch {
    return path.resolve(folder);
  }
}

function homeDirectory() {
  return process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
}
