import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { logger } from '../logger.mjs';
import { runInTransaction } from './database.mjs';

/**
 * Journal entries are stored compressed: each entry's raw journal line is deflated against a
 * dictionary of typical journal text, which shrinks the entries about four times (small JSON lines
 * barely compress on their own). Stored values are one of:
 * - a string: an entry stored before compression existed, kept as-is until it's compacted;
 * - bytes: [dictionary id, ...deflated line]. Dictionary id 0 means no dictionary (used until the
 *   database holds enough entries to build one); other ids are rows of entry_dictionaries.
 * A dictionary is never changed or deleted once stored, because entries depend on it.
 */

const COMPRESSION_LEVEL = 6;
/**
 * Deflate can use up to 32 KB, but decompressing gets about twice as slow from 16 KB on (which
 * matters when stats are rebuilt from every entry); 12 KB keeps most of the size benefit.
 */
const DICTIONARY_BYTES = 12 * 1024;
const MAX_SAMPLE_BYTES = 2048;
const TRAINING_SAMPLE_COUNT = 8000;
/** Below this many entries there isn't enough variety to build a good dictionary yet. */
const MIN_TRAINING_ENTRY_COUNT = 20000;
const COMPACTION_CHUNK_SIZE = 5000;
const COMPACTED_THROUGH_KEY = 'entries_compacted_through';
const VACUUM_DUE_KEY = 'vacuum_due';
/** Rewriting this many entries leaves enough slack in the file to be worth a VACUUM. */
const VACUUM_AFTER_COMPRESSED_COUNT = 10000;

const codecs = new WeakMap();

/**
 * The entry codec for a database connection (one per connection, shared by everything using it so a
 * newly built dictionary is used everywhere at once).
 * @param {import('node:sqlite').DatabaseSync} database
 */
export function getEntryCodec(database) {
  let codec = codecs.get(database);
  if (!codec) {
    codec = createEntryCodec(database);
    codecs.set(database, codec);
  }
  return codec;
}

/**
 * Bumped when every dictionary is deleted (a database reset): each connection's codec then forgets
 * the dictionaries it has loaded, as new ones will reuse their ids.
 */
let dictionaryGeneration = 0;

/** After every stored dictionary is deleted: makes every connection's codec forget its own. */
export function forgetEntryDictionaries() {
  dictionaryGeneration += 1;
}

function createEntryCodec(database) {
  const selectDictionary = database.prepare('SELECT dictionary FROM entry_dictionaries WHERE id = ?');
  const selectNewestDictionary = database.prepare('SELECT id, dictionary FROM entry_dictionaries ORDER BY id DESC LIMIT 1');
  const dictionaries = new Map();
  let currentDictionaryId = 0;
  let loadedGeneration = dictionaryGeneration;

  function forgetIfStale() {
    if (loadedGeneration === dictionaryGeneration) return;
    loadedGeneration = dictionaryGeneration;
    dictionaries.clear();
    currentDictionaryId = 0;
    loadNewestDictionary();
  }

  function loadNewestDictionary() {
    forgetIfStale();
    const row = selectNewestDictionary.get();
    if (!row) return;
    dictionaries.set(row.id, Buffer.from(row.dictionary));
    currentDictionaryId = row.id;
  }

  function getDictionary(dictionaryId) {
    let dictionary = dictionaries.get(dictionaryId);
    if (!dictionary) {
      const row = selectDictionary.get(dictionaryId);
      if (!row) throw new Error(`Journal entry dictionary ${dictionaryId} is missing from the database`);
      dictionary = Buffer.from(row.dictionary);
      dictionaries.set(dictionaryId, dictionary);
    }
    return dictionary;
  }

  loadNewestDictionary();

  return {
    /** The dictionary new entries are compressed with (0: none yet). */
    get dictionaryId() {
      forgetIfStale();
      return currentDictionaryId;
    },
    loadNewestDictionary,

    /**
     * Compresses a raw journal line for storage. A line that UTF-8 can't represent exactly (a
     * broken surrogate pair) is stored as the original string, so nothing is ever changed.
     * @param {string} text
     * @returns {Uint8Array | string}
     */
    encode(text) {
      forgetIfStale();
      const bytes = Buffer.from(text, 'utf8');
      if (bytes.toString('utf8') !== text) return text;
      const options = { level: COMPRESSION_LEVEL };
      if (currentDictionaryId) options.dictionary = getDictionary(currentDictionaryId);
      const compressed = deflateRawSync(bytes, options);
      const stored = new Uint8Array(compressed.length + 1);
      stored[0] = currentDictionaryId;
      stored.set(compressed, 1);
      return stored;
    },

    /**
     * The raw journal line for a stored value.
     * @param {Uint8Array | string} stored
     * @returns {string}
     */
    decode(stored) {
      if (typeof stored === 'string') return stored;
      forgetIfStale();
      const dictionaryId = stored[0];
      const compressed = stored.subarray(1);
      const text = dictionaryId === 0
        ? inflateRawSync(compressed)
        : inflateRawSync(compressed, { dictionary: getDictionary(dictionaryId) });
      return text.toString('utf8');
    },
  };
}

/**
 * Makes the stored entries readable as text in SQL on this connection (for the raw SQL tool): adds
 * an entry_text(data) function and a temporary journal_entries view, which hides the stored table
 * for unqualified names, with data as the raw journal line. Queries like
 * json_extract(data, '$.TotalReward') work as they always did.
 * @param {import('node:sqlite').DatabaseSync} database
 */
export function exposeEntryTextInSql(database) {
  const codec = getEntryCodec(database);
  database.function('entry_text', { deterministic: true }, (stored) => (stored == null ? null : codec.decode(stored)));
  database.exec(`
    CREATE TEMP VIEW IF NOT EXISTS journal_entries AS
      SELECT id, journal_file_id, commander_id, line_number, timestamp, event, entry_text(data) AS data
      FROM main.journal_entries;
  `);
}

/**
 * Compresses entries stored before compression existed or before the dictionary was built, building
 * the dictionary first once there are enough entries. Every rewritten entry is decompressed and
 * compared with the original before it's saved; an entry that doesn't match exactly is left as it
 * was. Progress is saved per chunk, so an interrupted run carries on where it stopped. Yields between
 * chunks so the server stays responsive.
 * @param {import('node:sqlite').DatabaseSync} database
 * @param {object} [options]
 * @param {number} [options.minTrainingEntryCount]
 * @param {number} [options.chunkSize]
 * @param {(progress: { checkedCount: number, totalCount: number, compressedCount: number }) => void} [options.onProgress]
 *   called after each chunk
 * @returns {Promise<{ compressedCount: number, keptCount: number }>}
 */
export async function compactJournalEntries(database, { minTrainingEntryCount = MIN_TRAINING_ENTRY_COUNT, chunkSize = COMPACTION_CHUNK_SIZE, onProgress } = {}) {
  const codec = getEntryCodec(database);
  const compactedThroughId = Number(readStorageState(database, COMPACTED_THROUGH_KEY) ?? 0);
  const maxEntryId = database.prepare('SELECT COALESCE(MAX(id), 0) AS maxEntryId FROM journal_entries').get().maxEntryId;
  const result = { compressedCount: 0, keptCount: 0 };
  if (maxEntryId <= compactedThroughId) return result;

  if (!codec.dictionaryId) {
    const entryCount = database.prepare('SELECT COUNT(*) AS entryCount FROM journal_entries').get().entryCount;
    if (entryCount < minTrainingEntryCount) return result;
    buildDictionary(database, codec, maxEntryId);
  }

  const selectChunk = database.prepare('SELECT id, data FROM journal_entries WHERE id > ? AND id <= ? ORDER BY id');
  const updateEntry = database.prepare('UPDATE journal_entries SET data = ? WHERE id = ?');
  const totalCount = maxEntryId - compactedThroughId;
  let nextReportAt = Date.now() + 10_000;
  let isFirstChunk = true;

  for (let chunkStartId = compactedThroughId; chunkStartId < maxEntryId; chunkStartId += chunkSize) {
    const chunkEndId = Math.min(chunkStartId + chunkSize, maxEntryId);
    runInTransaction(database, () => {
      for (const entry of selectChunk.all(chunkStartId, chunkEndId)) {
        if (typeof entry.data !== 'string' && entry.data[0] === codec.dictionaryId) continue;
        const text = codec.decode(entry.data);
        const encoded = codec.encode(text);
        if (typeof encoded === 'string' || codec.decode(encoded) !== text) {
          result.keptCount += 1;
          continue;
        }
        updateEntry.run(encoded, entry.id);
        result.compressedCount += 1;
      }
      writeStorageState(database, COMPACTED_THROUGH_KEY, chunkEndId);
    });

    if (isFirstChunk && result.compressedCount > 0) {
      logger.info(`Compressing stored journal entries (one-time; up to ${totalCount.toLocaleString()} entries)...`);
    }
    isFirstChunk = false;
    onProgress?.({ checkedCount: chunkEndId - compactedThroughId, totalCount, compressedCount: result.compressedCount });
    if (Date.now() >= nextReportAt) {
      logger.info(`  ...checked ${(chunkEndId - compactedThroughId).toLocaleString()}/${totalCount.toLocaleString()} entries`);
      nextReportAt = Date.now() + 10_000;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }

  if (result.compressedCount >= VACUUM_AFTER_COMPRESSED_COUNT) writeStorageState(database, VACUUM_DUE_KEY, 1);
  if (result.compressedCount > 0) {
    logger.info(`Compressed ${result.compressedCount.toLocaleString()} journal entries.`);
  }
  if (result.keptCount > 0) {
    logger.warn(`${result.keptCount.toLocaleString()} journal entries couldn't be compressed exactly and were left as they were.`);
  }
  return result;
}

/**
 * Builds the dictionary from a spread of stored entries: a mid-sized example of each event type,
 * with the event types taking the most space last (deflate finds the nearest matches cheapest).
 */
function buildDictionary(database, codec, maxEntryId) {
  const selectEntry = database.prepare('SELECT event, data FROM journal_entries WHERE id >= ? ORDER BY id LIMIT 1');
  const samplesByEvent = new Map();
  const step = Math.max(1, Math.floor(maxEntryId / TRAINING_SAMPLE_COUNT));
  for (let entryId = 1; entryId <= maxEntryId; entryId += step) {
    const entry = selectEntry.get(entryId);
    if (!entry) break;
    const text = codec.decode(entry.data);
    const samples = samplesByEvent.get(entry.event) ?? { texts: [], byteCount: 0 };
    samples.texts.push(text);
    samples.byteCount += text.length;
    samplesByEvent.set(entry.event, samples);
  }

  const dictionaryText = [...samplesByEvent.values()]
    .sort((first, second) => first.byteCount - second.byteCount)
    .map((samples) => samples.texts[samples.texts.length >> 1].slice(0, MAX_SAMPLE_BYTES))
    .join('');
  const dictionary = Buffer.from(dictionaryText, 'utf8').subarray(-DICTIONARY_BYTES);

  database.prepare('INSERT INTO entry_dictionaries (dictionary, created_at) VALUES (?, ?)').run(dictionary, new Date().toISOString());
  codec.loadNewestDictionary();
  if (codec.dictionaryId > 255) throw new Error('Too many journal entry dictionaries');
  logger.debug(`Built journal entry dictionary ${codec.dictionaryId} (${dictionary.length} bytes, ${samplesByEvent.size} event types)`);
}

/**
 * Rewrites the database file when compaction has rewritten many entries, or much of the file is
 * free pages. SQLite reuses the space freed by smaller entries but never shrinks the file on its own.
 * Needs free disk space about the size of the compacted database; if that fails the database is
 * left exactly as it was and it's tried again next start.
 * @param {import('node:sqlite').DatabaseSync} database
 * @returns {boolean} whether the file was rewritten
 */
export function vacuumIfDue(database, { minFreeBytes = 50 * 1024 * 1024, minFreeShare = 0.25 } = {}) {
  const pageSize = database.prepare('PRAGMA page_size').get().page_size;
  const pageCount = database.prepare('PRAGMA page_count').get().page_count;
  const freePageCount = database.prepare('PRAGMA freelist_count').get().freelist_count;
  const hasMuchFreeSpace = freePageCount * pageSize >= minFreeBytes && freePageCount >= pageCount * minFreeShare;
  if (readStorageState(database, VACUUM_DUE_KEY) !== '1' && !hasMuchFreeSpace) return false;

  const toMegabytes = (pages) => `${Math.round((pages * pageSize) / 1024 / 1024).toLocaleString()} MB`;
  logger.info(`Shrinking the database file (${toMegabytes(pageCount)}); this can take a minute...`);
  try {
    database.exec('VACUUM');
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    database.prepare('DELETE FROM storage_state WHERE key = ?').run(VACUUM_DUE_KEY);
    logger.info(`Database file is now ${toMegabytes(database.prepare('PRAGMA page_count').get().page_count)}.`);
    return true;
  } catch (error) {
    logger.warn(`Couldn't shrink the database file (${error.message}); it's unchanged and will be tried again next start.`);
    return false;
  }
}

function readStorageState(database, key) {
  return database.prepare('SELECT value FROM storage_state WHERE key = ?').get(key)?.value ?? null;
}

function writeStorageState(database, key, value) {
  database.prepare(`
    INSERT INTO storage_state (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}
