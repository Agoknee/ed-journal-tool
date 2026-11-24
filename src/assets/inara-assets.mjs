/**
 * The game artwork the dashboard shows (rank and navy insignia, Powerplay and engineer portraits,
 * and Inara's icon font), downloaded from inara.cz into the app's data folder the first time EDJT
 * runs, and served from there at /inara. The files aren't in the repository or the builds, as
 * they may not be redistributed; each install fetches its own copy. Files already there are
 * skipped, so later runs download nothing (unless some are missing). Set EDJT_SKIP_INARA_ASSETS=1
 * to skip downloading.
 */
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const INARA = 'https://inara.cz';
// A plain client name: no personal details.
const USER_AGENT = 'ed-journal-tool asset fetch';
const PARALLEL_DOWNLOADS = 4;
const TIMEOUT_MS = 20_000;
const ATTEMPTS = 3;

/** Every file the dashboard uses: where it's kept (under the asset folder), and where it comes from on Inara. */
export function listInaraAssets() {
  const assets = [];
  // Pilots' Federation ranks (Combat, Trade, Exploration, CQC, Mercenary, Exobiology), each rank 0-13.
  for (const rankType of [1, 2, 3, 4, 5, 6]) {
    for (let rankIndex = 0; rankIndex <= 13; rankIndex++) {
      assets.push({ file: `ranks/${rankType}-${rankIndex}.png`, url: `${INARA}/images/ranks/${rankType}/${rankIndex}.png` });
    }
  }
  // The Imperial (12) and Federal (13) navy emblems.
  for (const navy of [12, 13]) assets.push({ file: `ranks/${navy}-0.png`, url: `${INARA}/images/ranks/${navy}/0.png` });
  // Powerplay leaders' portraits (6 is no longer used).
  for (const power of [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13]) {
    assets.push({ file: `powers/${power}.jpg`, url: `${INARA}/sites/elite/images/powers/${power}.jpg` });
  }
  // Engineers' portraits (Inara's "g" versions).
  for (let engineer = 1; engineer <= 38; engineer++) {
    assets.push({ file: `engineers/${engineer}.jpg`, url: `${INARA}/sites/elite/images/engineers/${engineer}g.jpg` });
  }
  // The icon font (material grades, component types).
  assets.push({ file: 'fonts/fontello.woff2', url: `${INARA}/sites/general/fonts/fontello.woff2` });
  return assets;
}

async function exists(filePath) {
  try {
    return (await stat(filePath)).size > 0;
  } catch {
    return false;
  }
}

/** Downloads one file, retrying a couple of times; it's only written in place once complete. */
async function download(directory, { file, url }, fetchImpl) {
  const target = path.join(directory, file);
  let lastError = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') ?? '';
      if (!/^(image|font)\/|octet-stream|woff/.test(contentType)) throw new Error(`unexpected content type "${contentType}"`);
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length === 0) throw new Error('empty response');
      await mkdir(path.dirname(target), { recursive: true });
      const partial = `${target}.partial`;
      await writeFile(partial, body);
      await rename(partial, target);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError;
}

/**
 * Downloads whichever artwork files aren't in the folder yet. Never throws: with Inara unreachable
 * it stops after the first file and says so (the dashboard does without those pictures).
 * @param {object} options
 * @param {string} options.directory  where the files go (served at /inara)
 * @param {boolean} [options.force]   download every file again
 * @param {{ info: Function, warn: Function }} [options.log]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {{ file: string, url: string }[]} [options.assets]
 * @returns {Promise<{ total: number, downloaded: number, failed: { file: string, reason: string }[], wasSkipped: boolean, isUnreachable: boolean }>}
 */
export async function ensureInaraAssets({ directory, force = false, log = console, fetchImpl = fetch, assets = listInaraAssets() }) {
  const result = { total: assets.length, downloaded: 0, failed: [], wasSkipped: false, isUnreachable: false };
  if (process.env.EDJT_SKIP_INARA_ASSETS) {
    result.wasSkipped = true;
    return result;
  }
  const missing = [];
  for (const asset of assets) if (force || !(await exists(path.join(directory, asset.file)))) missing.push(asset);
  if (missing.length === 0) return result;

  log.info(`Downloading ${missing.length} of ${assets.length} rank, Powerplay and engineer images from inara.cz into "${directory}"...`);
  // One file first: if that fails (offline, Inara down), stop rather than wait on every other file.
  const [first, ...rest] = missing;
  try {
    await download(directory, first, fetchImpl);
    result.downloaded += 1;
  } catch (error) {
    result.isUnreachable = true;
    result.failed.push({ file: first.file, reason: error.message });
    log.warn(`Couldn't download images from inara.cz (${error.message}); the dashboard does without them until the next start.`);
    return result;
  }

  const queue = [...rest];
  await Promise.all(Array.from({ length: PARALLEL_DOWNLOADS }, async () => {
    for (let asset = queue.shift(); asset; asset = queue.shift()) {
      try {
        await download(directory, asset, fetchImpl);
        result.downloaded += 1;
      } catch (error) {
        result.failed.push({ file: asset.file, reason: error.message });
      }
    }
  }));

  if (result.failed.length === 0) {
    log.info(`Downloaded ${result.downloaded} images from inara.cz.`);
  } else {
    const examples = result.failed.slice(0, 3).map((failure) => `${failure.file} (${failure.reason})`).join(', ');
    log.warn(`Downloaded ${result.downloaded} images from inara.cz; ${result.failed.length} couldn't be (${examples}${result.failed.length > 3 ? ', ...' : ''}). They'll be tried again next start.`);
  }
  return result;
}
