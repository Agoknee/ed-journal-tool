import os from 'node:os';
import path from 'node:path';

/** App data lives in %LOCALAPPDATA%\edjt (~/.local/share/edjt where LOCALAPPDATA isn't set, e.g. Linux). */
export const dataDirectoryPath = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'edjt');

/** Where the Inara artwork is downloaded to (src/assets/inara-assets.mjs) and served from (/inara). */
export const inaraAssetDirectory = path.join(dataDirectoryPath, 'inara');
