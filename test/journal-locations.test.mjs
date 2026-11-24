import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaultJournalDirectories, findJournalDirectories, parseLibraryFolders, windowsStyleJournalDirectory } from '../src/journals/journal-locations.mjs';

const GAME = ['Saved Games', 'Frontier Developments', 'Elite Dangerous'];
const PROTON = ['steamapps', 'compatdata', '359320', 'pfx', 'drive_c', 'users', 'steamuser', ...GAME];

function withHome(run) {
  const home = mkdtempSync(path.join(tmpdir(), 'edjt-home-'));
  try {
    return run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Makes a journal folder, with one journal last written at the given time (seconds) if any. */
function journalFolder(directory, writtenAt) {
  mkdirSync(directory, { recursive: true });
  if (writtenAt !== undefined) {
    const file = path.join(directory, 'Journal.2026-11-20T120000.01.log');
    writeFileSync(file, '{}\n');
    utimesSync(file, writtenAt, writtenAt);
  }
  return directory;
}

function libraryFoldersVdf(steam, libraries) {
  mkdirSync(path.join(steam, 'steamapps'), { recursive: true });
  const entries = libraries.map((library, index) => `\t"${index}"\n\t{\n\t\t"path"\t\t"${library.replace(/\\/g, '\\\\')}"\n\t}\n`).join('');
  writeFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders"\n{\n${entries}}\n`);
}

test('journal locations: libraryfolders.vdf paths, with its escapes', () => {
  const text = '"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"/home/player/.local/share/Steam"\n\t\t"label"\t\t""\n\t}\n'
    + '\t"1"\n\t{\n\t\t"path"\t\t"/mnt/games/My \\"Steam\\" \\\\ Library"\n\t}\n}\n';
  assert.deepEqual(parseLibraryFolders(text), ['/home/player/.local/share/Steam', '/mnt/games/My "Steam" \\ Library']);
});

test('journal locations: Proton folders in any Steam install and library, Wine prefixes, and the home folder', () => withHome((home) => {
  const nativeSteam = path.join(home, '.local', 'share', 'Steam');
  const otherLibrary = path.join(home, 'Games', 'Steam Library 2');
  libraryFoldersVdf(nativeSteam, [nativeSteam, otherLibrary]);
  const proton = journalFolder(path.join(otherLibrary, ...PROTON), 300);
  const snap = journalFolder(path.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam', ...PROTON), 100);
  const heroic = journalFolder(path.join(home, 'Games', 'Heroic', 'Prefixes', 'default', 'Elite Dangerous', 'pfx', 'drive_c', 'users', 'player', ...GAME), 200);
  const lutris = journalFolder(path.join(home, 'Games', 'elite-dangerous', 'drive_c', 'users', 'player', ...GAME));
  const homeFolder = journalFolder(windowsStyleJournalDirectory(home));

  const found = findJournalDirectories({ home });
  assert.deepEqual(found.map((folder) => folder.directory).sort(), [proton, snap, heroic, lutris, homeFolder].sort());
  assert.equal(found.find((folder) => folder.directory === lutris).latestJournalAt, null);

  // Every folder with journals is read, the most recently played first; empty ones aren't.
  assert.deepEqual(defaultJournalDirectories({ home, platform: 'linux' }), [proton, heroic, snap]);
}));

test('journal locations: with no journals anywhere, the first folder found; with nothing, none', () => withHome((home) => {
  assert.deepEqual(defaultJournalDirectories({ home, platform: 'linux' }), []);
  assert.deepEqual(defaultJournalDirectories({ home, platform: 'win32' }), []);
  const flatpak = journalFolder(path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam', ...PROTON));
  assert.deepEqual(defaultJournalDirectories({ home, platform: 'linux' }), [flatpak]);
  // Windows only uses its own folder.
  journalFolder(windowsStyleJournalDirectory(home));
  assert.deepEqual(defaultJournalDirectories({ home, platform: 'win32' }), [windowsStyleJournalDirectory(home)]);
}));
