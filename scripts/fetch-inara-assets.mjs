#!/usr/bin/env node
/**
 * Downloads the Inara artwork (rank and navy insignia, Powerplay and engineer portraits, the icon
 * font) into the app's data folder, as EDJT does on its first run. Useful to fetch them ahead of
 * time or again: `npm run fetch-assets` (files already there are skipped; --force fetches them
 * all again; --dir=<folder> puts them elsewhere).
 */
import path from 'node:path';
import { ensureInaraAssets } from '../src/assets/inara-assets.mjs';
import { inaraAssetDirectory } from '../src/data-paths.mjs';

const directoryOption = process.argv.find((argument) => argument.startsWith('--dir='));
const directory = directoryOption ? path.resolve(directoryOption.slice('--dir='.length)) : inaraAssetDirectory;
const log = { info: (message) => console.log(`[inara assets] ${message}`), warn: (message) => console.warn(`[inara assets] ${message}`) };

const result = await ensureInaraAssets({ directory, force: process.argv.includes('--force'), log });
if (result.wasSkipped) log.info('skipped (EDJT_SKIP_INARA_ASSETS is set).');
else if (result.downloaded === 0 && result.failed.length === 0) log.info(`all ${result.total} files are already in "${directory}".`);
