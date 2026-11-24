import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** App data lives in %LOCALAPPDATA%\edjt (~/.local/share/edjt where LOCALAPPDATA isn't set, e.g. Linux). */
export const dataDirectoryPath = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'edjt');

/**
 * Creates the data folder (and the folders above it) if it isn't there yet, as on a new system:
 * done at startup, before anything is written there.
 */
export function ensureDataDirectory() {
  mkdirSync(dataDirectoryPath, { recursive: true });
}

/** Where the Inara artwork is downloaded to (src/assets/inara-assets.mjs) and served from (/inara). */
export const inaraAssetDirectory = path.join(dataDirectoryPath, 'inara');
