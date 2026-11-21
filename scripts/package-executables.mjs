/**
 * Packages the bundled server (from bundle-server.mjs) and the built client (client/dist) into
 * executables with yao-pkg, one per target in the "pkg" section of package.json:
 *
 * - dist/ed-journal-tool-<version>.exe: built from a copy of the Node.js binary whose icon and
 *   version details are replaced, so Windows shows "ED Journal Tool" and the app version.
 * - dist/ed-journal-tool-<version> (Linux), plus ed-journal-tool.desktop and ed-journal-tool.png
 *   for a desktop menu entry.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec as runPkg } from '@yao-pkg/pkg';
import { need as fetchNodeBinary } from '@yao-pkg/pkg-fetch';
import * as ResEdit from 'resedit';

const APP_NAME = 'ED Journal Tool';
const APP_ID = 'ed-journal-tool';

const projectRootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = path.join(projectRootPath, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const { version: appVersion, description: appDescription } = packageJson;

const bundlePath = path.join(projectRootPath, 'build', `${APP_ID}.cjs`);
const buildDirectoryPath = path.join(projectRootPath, 'build');
const distDirectoryPath = path.join(projectRootPath, 'dist');
const packagingAssetsPath = path.join(projectRootPath, 'packaging');
const executableBaseName = `${APP_ID}-${appVersion}`;

mkdirSync(distDirectoryPath, { recursive: true });
for (const target of packageJson.pkg.targets) {
  const [nodeRange, platform, arch] = target.split('-');
  if (platform === 'win') {
    await packageWindowsExecutable({ target, nodeRange, platform, arch });
  } else {
    await packageExecutable(target, path.join(distDirectoryPath, executableBaseName));
    if (platform === 'linux') writeLinuxDesktopEntry(executableBaseName);
  }
}

function packageExecutable(target, outputPath) {
  return runPkg([
    bundlePath,
    '--config', packageJsonPath,
    '--targets', target,
    '--output', outputPath,
    // Bytecode can't be generated for Linux when building on Windows, so ship plain (bundled) JavaScript.
    '--no-bytecode', '--public', '--public-packages', '*',
  ]);
}

/** Packages the Windows target from a Node.js binary carrying the app's icon and version details. */
async function packageWindowsExecutable({ target, nodeRange, platform, arch }) {
  const nodeBinaryPath = await fetchNodeBinary({ nodeRange, platform, arch });
  const customizedBinaryPath = path.join(buildDirectoryPath, `node-${target}.exe`);
  writeCustomizedWindowsBinary(nodeBinaryPath, customizedBinaryPath);

  // PKG_NODE_PATH makes pkg use this binary instead of the one it fetches.
  process.env.PKG_NODE_PATH = customizedBinaryPath;
  try {
    await packageExecutable(target, path.join(distDirectoryPath, `${executableBaseName}.exe`));
  } finally {
    delete process.env.PKG_NODE_PATH;
  }
}

function writeCustomizedWindowsBinary(sourcePath, outputPath) {
  // The Node.js signature can't stay valid once resources change, so it's dropped.
  const executable = ResEdit.NtExecutable.from(readFileSync(sourcePath), { ignoreCert: true });
  const resources = ResEdit.NtExecutableResource.from(executable);

  const iconFile = ResEdit.Data.IconFile.from(readFileSync(path.join(packagingAssetsPath, 'edjt.ico')));
  for (const iconGroup of ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries)) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      resources.entries, iconGroup.id, iconGroup.lang, iconFile.icons.map((icon) => icon.data),
    );
  }

  const [major, minor, patch] = appVersion.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (const versionInfo of ResEdit.Resource.VersionInfo.fromEntries(resources.entries)) {
    versionInfo.setFileVersion(major, minor, patch, 0);
    versionInfo.setProductVersion(major, minor, patch, 0);
    for (const language of versionInfo.getAvailableLanguages()) {
      versionInfo.setStringValues(language, {
        FileDescription: APP_NAME,
        ProductName: APP_NAME,
        FileVersion: appVersion,
        ProductVersion: appVersion,
      });
      versionInfo.removeStringValue(language, 'LegalCopyright');
    }
    versionInfo.outputToResourceEntries(resources.entries);
  }

  resources.outputResource(executable);
  writeFileSync(outputPath, Buffer.from(executable.generate()));
}

/**
 * Writes a freedesktop.org menu entry and its icon next to the Linux executable. They expect the usual
 * per-user install: the executable on PATH (e.g. ~/.local/bin), the icon in
 * ~/.local/share/icons/hicolor/256x256/apps and the entry in ~/.local/share/applications.
 */
function writeLinuxDesktopEntry(executableName) {
  copyFileSync(path.join(packagingAssetsPath, `${APP_ID}.png`), path.join(distDirectoryPath, `${APP_ID}.png`));
  const desktopEntryLines = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${APP_NAME}`,
    `Comment=${appDescription}`,
    `Exec=${executableName}`,
    `Icon=${APP_ID}`,
    // The app is a console server; the terminal shows its log and closing it stops the server.
    'Terminal=true',
    'Categories=Game;Utility;',
    `X-AppVersion=${appVersion}`,
    '',
  ];
  writeFileSync(path.join(distDirectoryPath, `${APP_ID}.desktop`), desktopEntryLines.join('\n'));
}
