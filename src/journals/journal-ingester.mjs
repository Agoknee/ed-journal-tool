import { createHash } from 'node:crypto';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { runInTransaction } from '../database/database.mjs';
import { getEntryCodec } from '../database/entry-compression.mjs';
import { logger } from '../logger.mjs';
import { checkStoredEntryOrderOnce, isStoredOutOfOrder, noteLateJournal, restoreEntryOrderIfNeeded } from './entry-order.mjs';
import { compareJournalFileNames, getJournalSortKey, isJournalFileName, isLegacyGameVersion } from './journal-files.mjs';
import { readJournalLines } from './journal-reader.mjs';

/** A file that hasn't been modified for this long is assumed to be finished. */
const SETTLED_AFTER_MS = 2 * 60 * 1000;

/** An unclosed journal modified within this window may still be in use by the game. */
const ACTIVE_WINDOW_MS = 60 * 60 * 1000;

/** How much of a file is read to find its first entry (the Fileheader line is a few hundred bytes). */
const HEADER_READ_BYTES = 64 * 1024;

const COMMANDER_IDENTITY_EVENTS = new Set(['Commander', 'LoadGame', 'NewCommander']);
const FILE_CLOSING_EVENTS = new Set(['Shutdown', 'Continued']);

/**
 * Reads journal files into the database, tracking how far each file has been read
 * and which commander it belongs to. Journal files are only ever opened read-only.
 *
 * Journals can come from several folders (another computer's, synced; another Windows user's). A
 * journal is identified by its folder and file name. The same journal in two folders (a synced
 * copy) is caught as a copy by its first entry, as a copy under another name is. Journals read
 * before folders were recorded have folder '' and are claimed by the first folder found to hold them.
 */
export class JournalIngester {
  /**
   * @param {object} options
   * @param {import('node:sqlite').DatabaseSync} options.database
   * @param {string[]} [options.journalDirectories]
   * @param {string} [options.journalDirectory]  a single folder (the same as journalDirectories: [it])
   */
  constructor({ database, journalDirectories, journalDirectory }) {
    this.database = database;
    this.journalDirectories = normalizeJournalDirectories(journalDirectories ?? [journalDirectory]);
    this.statements = prepareStatements(database);
    this.backfillHeaderHashes();
    checkStoredEntryOrderOnce(database);
  }

  /**
   * The journal files in every journal folder, oldest first. A folder that can't be read (a synced
   * or network folder that's unavailable, say) is left out and listed in unreadableDirectories.
   * @returns {Promise<{ files: { directory: string, fileName: string }[], unreadableDirectories: string[] }>}
   */
  async listJournalFiles() {
    const files = [];
    const unreadableDirectories = [];
    for (const directory of this.journalDirectories) {
      let directoryEntries;
      try {
        directoryEntries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        logger.warn(`Can't read journal folder "${directory}" (${error.code ?? error.message}); its journals are left as they were.`);
        unreadableDirectories.push(directory);
        continue;
      }
      for (const directoryEntry of directoryEntries) {
        if (directoryEntry.isFile() && isJournalFileName(directoryEntry.name)) files.push({ directory, fileName: directoryEntry.name });
      }
    }
    files.sort((first, second) => compareJournalFileNames(first.fileName, second.fileName) || first.directory.localeCompare(second.directory));
    return { files, unreadableDirectories };
  }

  /** A journal's name for log messages: with its folder when there's more than one folder. */
  describeFile(directory, fileName) {
    return this.journalDirectories.length > 1 && directory ? `${fileName}" in "${directory}` : fileName;
  }

  /**
   * The stored record for a journal file, creating it if needed. A journal read before folders
   * were recorded (folder '') is claimed for this folder.
   */
  findOrCreateFileRecord(directory, fileName) {
    const fileRecord = this.statements.selectFile.get(directory, fileName);
    if (fileRecord) return fileRecord;
    const unplacedRecord = this.statements.selectFile.get('', fileName);
    if (unplacedRecord) this.statements.setFileDirectory.run(directory, unplacedRecord.id);
    else this.statements.insertFile.run(directory, fileName, getJournalSortKey(fileName));
    return this.statements.selectFile.get(directory, fileName);
  }

  /**
   * Reads any new data from a journal file.
   * @param {string} directory  one of the journal folders
   * @param {string} fileName
   * @param {{ skipUnparseable?: boolean }} [options]
   * @returns {Promise<{ hasChanged: boolean, newEntryCount: number, needsRetry: boolean, requiresStatsRebuild: boolean }>}
   */
  async processFile(directory, fileName, { skipUnparseable = false } = {}) {
    const result = { hasChanged: false, newEntryCount: 0, needsRetry: false, requiresStatsRebuild: false };
    const filePath = path.join(directory, fileName);
    const fileLabel = this.describeFile(directory, fileName);

    let fileStats;
    try {
      // lstat: a link named like a journal is never followed (the directory scan skips links too).
      fileStats = await lstat(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.markFileMissing(directory, fileName);
        return result;
      }
      throw error;
    }

    if (!fileStats.isFile()) return result;

    const fileSize = fileStats.size;
    const modifiedMs = Math.trunc(fileStats.mtimeMs);
    const isSettled = Date.now() - modifiedMs > SETTLED_AFTER_MS;

    let fileRecord = this.findOrCreateFileRecord(directory, fileName);
    if (fileRecord.is_missing) {
      this.statements.setFileMissing.run(0, fileRecord.id);
      fileRecord = this.statements.selectFileById.get(fileRecord.id);
    }

    const isUnchanged = fileRecord.file_size === fileSize && fileRecord.modified_ms === modifiedMs;
    const hasUnreadTail = fileRecord.status === 'ok' && fileRecord.bytes_read < fileSize;
    const isAwaitingCommander = fileRecord.status === 'pending';
    // A copy whose original has since gone from its folder was really a move (see readUnassignedFile).
    const isCopyOfMissingJournal = fileRecord.status === 'duplicate' && fileRecord.header_hash
      && Boolean(this.statements.selectMissingOriginal.get(fileRecord.header_hash, fileRecord.commander_id, fileRecord.id));
    if (isUnchanged && !hasUnreadTail && !isAwaitingCommander && !isCopyOfMissingJournal && !skipUnparseable) return result;

    // A journal is identified by its first entry (the Fileheader, stamped with the second the game
    // started it). A different first entry means a different journal was saved under this name.
    const headerHash = await readHeaderHash(filePath);
    if (headerHash && fileRecord.header_hash && headerHash !== fileRecord.header_hash && fileRecord.status !== 'pending') {
      logger.warn(`Journal file "${fileLabel}" was replaced by a different journal; re-reading it from the start.`);
      if (fileRecord.status === 'ok') result.requiresStatsRebuild = true;
      this.resetFile(fileRecord.id);
      fileRecord = this.statements.selectFileById.get(fileRecord.id);
    }
    if (headerHash && headerHash !== fileRecord.header_hash) {
      this.statements.updateHeaderHash.run(headerHash, fileRecord.id);
      fileRecord = { ...fileRecord, header_hash: headerHash };
    }

    // A file that shrank was rewritten; start over.
    if (fileRecord.status === 'ok' && fileSize < fileRecord.bytes_read) {
      logger.warn(`Journal file "${fileLabel}" shrank; re-reading it from the start.`);
      this.resetFile(fileRecord.id);
      fileRecord = this.statements.selectFileById.get(fileRecord.id);
      result.requiresStatsRebuild = true;
    }

    const readOptions = { endOffset: fileSize, isSettled, skipUnparseable };
    if (fileRecord.status === 'ok') {
      Object.assign(result, await this.readAssignedFile(fileRecord, filePath, readOptions));
    } else {
      const unassignedResult = await this.readUnassignedFile(fileRecord, filePath, readOptions);
      // A journal moved here: its original record now points here, so carry on reading it from
      // where it had got to.
      if (unassignedResult.wasMoved) return { ...(await this.processFile(directory, fileName, { skipUnparseable })), hasChanged: true };
      Object.assign(result, unassignedResult);
    }

    this.statements.updateFileSize.run(fileSize, modifiedMs, fileRecord.id);
    result.hasChanged = true;
    return result;
  }

  /** Reads new lines from a file already associated with a commander. */
  async readAssignedFile(fileRecord, filePath, readOptions) {
    const readResult = await readJournalLines(filePath, {
      ...readOptions,
      startOffset: fileRecord.bytes_read,
      startLineNumber: fileRecord.line_count,
    });

    const commanderRecord = this.statements.selectCommanderById.get(fileRecord.commander_id);
    const conflictingIdentity = readResult.parsedLines
      .map(({ journalEntry }) => getCommanderIdentity(journalEntry))
      .find((identity) => identity && !isSameCommander(identity, commanderRecord));

    if (conflictingIdentity) {
      const reason = `Multiple commanders in file: ${commanderRecord.name}, ${conflictingIdentity.name}`;
      logger.warn(`Journal file "${this.describeFile(fileRecord.directory, fileRecord.file_name)}" flagged as corrupt. ${reason}`);
      this.resetFile(fileRecord.id);
      this.statements.updateFileStatus.run('corrupt', reason, null, fileRecord.id);
      return { newEntryCount: 0, needsRetry: false, requiresStatsRebuild: true };
    }

    runInTransaction(this.database, () => {
      this.storeEntries(fileRecord, commanderRecord.id, readResult);
    });

    return { newEntryCount: readResult.parsedLines.length, needsRetry: readResult.isBlockedByBadLine };
  }

  /** Reads a whole file that has no commander yet, and assigns it if exactly one commander is found. */
  async readUnassignedFile(fileRecord, filePath, readOptions) {
    const readResult = await readJournalLines(filePath, { ...readOptions, startOffset: 0, startLineNumber: 0 });
    const commanderIdentities = getDistinctCommanderIdentities(readResult.parsedLines.map((line) => line.journalEntry));
    const fileDetails = summarizeFileDetails(readResult.parsedLines, {});

    if (commanderIdentities.length > 1) {
      const reason = `Multiple commanders in file: ${commanderIdentities.map((identity) => identity.name).join(', ')}`;
      this.statements.updateFileStatus.run('corrupt', reason, null, fileRecord.id);
      this.updateUnassignedFileDetails(fileRecord.id, readResult, fileDetails);
      logger.debug(`Journal file "${this.describeFile(fileRecord.directory, fileRecord.file_name)}" flagged as corrupt. ${reason}`);
      return { newEntryCount: 0, needsRetry: false };
    }

    if (commanderIdentities.length === 0) {
      const isFinished = readOptions.isSettled || fileDetails.isClosed;
      const [status, reason] = isFinished
        ? ['corrupt', 'No commander information (Commander/LoadGame event) found']
        : ['pending', 'Waiting for commander information'];
      this.statements.updateFileStatus.run(status, reason, null, fileRecord.id);
      this.updateUnassignedFileDetails(fileRecord.id, readResult, fileDetails);
      return { newEntryCount: 0, needsRetry: readResult.isBlockedByBadLine };
    }

    let originalFile = null;
    let wasMoved = false;
    runInTransaction(this.database, () => {
      const commanderId = this.upsertCommander(commanderIdentities[0]);
      // The same journal already read for this commander (one still in its folder first).
      originalFile = fileRecord.header_hash ? this.statements.selectSameJournal.get(fileRecord.header_hash, commanderId, fileRecord.id) : null;
      if (originalFile?.is_missing) {
        // The original is no longer where it was, so this is it, moved or renamed (its folder
        // renamed, say): the original's record takes this place, keeping its entries and how far
        // it had been read, and this one goes.
        this.statements.deleteFileEventCounts.run(fileRecord.id);
        this.statements.deleteEntriesForFile.run(fileRecord.id);
        this.statements.deleteFile.run(fileRecord.id);
        this.statements.moveFile.run(fileRecord.directory, fileRecord.file_name, getJournalSortKey(fileRecord.file_name), originalFile.id);
        wasMoved = true;
        return;
      }
      if (originalFile) {
        const originalLabel = originalFile.directory && originalFile.directory !== fileRecord.directory
          ? `${originalFile.file_name} (in ${originalFile.directory})`
          : originalFile.file_name;
        this.statements.updateFileStatus.run('duplicate', `Same journal as ${originalLabel}`, commanderId, fileRecord.id);
        this.updateUnassignedFileDetails(fileRecord.id, readResult, fileDetails);
        return;
      }
      this.statements.updateFileStatus.run('ok', null, commanderId, fileRecord.id);
      this.storeEntries({ ...fileRecord, bytes_read: 0, line_count: 0, entry_count: 0, skipped_line_count: 0 }, commanderId, readResult);
    });
    if (wasMoved) {
      const isOtherFolder = originalFile.directory !== fileRecord.directory;
      const describe = (file) => (isOtherFolder && file.directory ? `${file.file_name}" in "${file.directory}` : file.file_name);
      logger.info(`Journal file "${describe(originalFile)}" was moved to "${describe(fileRecord)}"; reading carries on from there.`);
      return { newEntryCount: 0, needsRetry: false, wasMoved: true };
    }
    if (originalFile) {
      logger.info(`Journal file "${this.describeFile(fileRecord.directory, fileRecord.file_name)}" is a copy of "${this.describeFile(originalFile.directory, originalFile.file_name)}"; its entries aren't stored again.`);
      return { newEntryCount: 0, needsRetry: false };
    }
    logger.debug(`Journal file "${this.describeFile(fileRecord.directory, fileRecord.file_name)}" assigned to CMDR ${commanderIdentities[0].name}`);
    if (isStoredOutOfOrder(this.database, fileRecord.id)) {
      logger.info(`Journal file "${this.describeFile(fileRecord.directory, fileRecord.file_name)}" is older than journals already read; entries will be put back in time order.`);
      noteLateJournal(this.database, this.statements.selectFileById.get(fileRecord.id).first_timestamp);
    }

    return { newEntryCount: readResult.parsedLines.length, needsRetry: readResult.isBlockedByBadLine };
  }

  storeEntries(fileRecord, commanderId, readResult) {
    const codec = getEntryCodec(this.database);
    const eventCounts = new Map();
    for (const { lineNumber, journalEntry, rawLine } of readResult.parsedLines) {
      const { changes } = this.statements.insertEntry.run(
        fileRecord.id,
        commanderId,
        lineNumber,
        journalEntry.timestamp ?? null,
        journalEntry.event,
        codec.encode(rawLine),
      );
      if (changes) eventCounts.set(journalEntry.event, (eventCounts.get(journalEntry.event) ?? 0) + 1);
    }
    for (const [eventName, entryCount] of eventCounts) this.statements.addFileEventCount.run(fileRecord.id, eventName, entryCount);

    const fileDetails = summarizeFileDetails(readResult.parsedLines, fileRecord);
    this.statements.updateFileProgress.run({
      fileId: fileRecord.id,
      bytesRead: fileRecord.bytes_read + readResult.bytesConsumed,
      lineCount: fileRecord.line_count + readResult.linesConsumed,
      entryCount: fileRecord.entry_count + readResult.parsedLines.length,
      skippedLineCount: fileRecord.skipped_line_count + readResult.skippedLineCount,
      ...fileDetails,
    });

    if (fileDetails.lastTimestamp) {
      this.statements.updateCommanderSeen.run(fileDetails.firstTimestamp, fileDetails.lastTimestamp, commanderId);
    }
  }

  updateUnassignedFileDetails(fileId, readResult, fileDetails) {
    this.statements.updateFileProgress.run({
      fileId,
      bytesRead: readResult.bytesConsumed,
      lineCount: readResult.linesConsumed,
      entryCount: 0,
      skippedLineCount: readResult.skippedLineCount,
      ...fileDetails,
    });
  }

  upsertCommander(identity) {
    const commanderKey = getCommanderKey(identity);
    let commanderRecord = this.statements.selectCommanderByKey.get(commanderKey);

    // Upgrade a name-only commander record once their FID is known.
    if (!commanderRecord && identity.fid) {
      commanderRecord = this.statements.selectCommanderByKey.get(`name:${identity.name}`);
      if (commanderRecord) this.statements.updateCommanderKey.run(commanderKey, identity.fid, commanderRecord.id);
    }

    if (!commanderRecord) {
      this.statements.insertCommander.run(commanderKey, identity.fid, identity.name);
      commanderRecord = this.statements.selectCommanderByKey.get(commanderKey);
      logger.info(`Found new commander: CMDR ${identity.name}`);
    } else if (commanderRecord.name !== identity.name) {
      this.statements.updateCommanderName.run(identity.name, commanderRecord.id);
    }

    return commanderRecord.id;
  }

  /**
   * Puts stored entries back in time order if older journals were read after newer ones.
   * @returns {boolean} whether entries moved, in which case all stats need rebuilding
   */
  restoreEntryOrderIfNeeded() {
    return restoreEntryOrderIfNeeded(this.database);
  }

  /**
   * Flags journals no longer in their journal folder (and clears the flag for ones that are back).
   * Their entries and stats are kept, so tidying up old journals doesn't lose history. Each
   * journal is checked against its own folder only; a folder that couldn't be read leaves its
   * journals as they were, and one no longer configured counts its journals as missing. Journals
   * not yet placed in a folder count as present while some folder has a file by that name (it's
   * claimed when that file is read).
   * @param {{ files: { directory: string, fileName: string }[], unreadableDirectories?: string[] }} listing
   */
  markMissingFiles({ files, unreadableDirectories = [] }) {
    const presentKeys = new Set(files.map((file) => fileKey(file.directory, file.fileName)));
    const presentNames = new Set(files.map((file) => file.fileName));
    const unreadable = new Set(unreadableDirectories);
    runInTransaction(this.database, () => {
      for (const file of this.statements.selectFileMissingFlags.all()) {
        if (unreadable.has(file.directory)) continue;
        const isPresent = file.directory === '' ? presentNames.has(file.file_name) : presentKeys.has(fileKey(file.directory, file.file_name));
        const isMissing = isPresent ? 0 : 1;
        if (isMissing !== file.is_missing) this.statements.setFileMissing.run(isMissing, file.id);
      }
    });
  }

  /**
   * Flags one journal as no longer in its journal folder.
   * @returns {boolean} whether it was newly flagged
   */
  markFileMissing(directory, fileName) {
    const fileRecord = this.statements.selectFile.get(directory, fileName);
    if (!fileRecord || fileRecord.is_missing) return false;
    this.statements.setFileMissing.run(1, fileRecord.id);
    return true;
  }

  /** Journals read before files had a fingerprint get one from their stored first entry. */
  backfillHeaderHashes() {
    const files = this.statements.selectFilesWithoutHeaderHash.all();
    if (files.length === 0) return;
    const codec = getEntryCodec(this.database);
    runInTransaction(this.database, () => {
      for (const file of files) {
        const firstEntry = this.statements.selectFirstEntry.get(file.id);
        if (firstEntry) this.statements.updateHeaderHash.run(hashHeaderLine(codec.decode(firstEntry.data)), file.id);
      }
    });
  }

  /** Removes all stored entries for a file and returns it to an unassigned state. */
  resetFile(fileId) {
    runInTransaction(this.database, () => {
      this.statements.deleteEntriesForFile.run(fileId);
      this.statements.deleteFileEventCounts.run(fileId);
      this.statements.resetFile.run(fileId);
    });
  }

  /**
   * Recalculates which journal files are currently being written by the game.
   * A file is active when it hasn't been closed (Shutdown/Continued), was modified recently,
   * and is the newest file for its commander (or hasn't been assigned to a commander yet).
   * @returns {{ activeFileIds: number[], staleFiles: { directory: string, fileName: string }[] }}
   */
  refreshActiveFiles() {
    const recentCutoffMs = Date.now() - ACTIVE_WINDOW_MS;
    const candidateFiles = this.statements.selectActiveCandidates.all(recentCutoffMs);

    const newestFileByCommander = new Map();
    const activeFileIds = [];
    for (const candidateFile of candidateFiles) {
      if (candidateFile.status === 'pending') {
        activeFileIds.push(candidateFile.id);
        continue;
      }
      const currentNewest = newestFileByCommander.get(candidateFile.commander_id);
      if (!currentNewest || candidateFile.sort_key > currentNewest.sort_key) {
        newestFileByCommander.set(candidateFile.commander_id, candidateFile);
      }
    }
    activeFileIds.push(...[...newestFileByCommander.values()].map((file) => file.id));

    runInTransaction(this.database, () => {
      this.statements.clearActiveFlags.run();
      for (const fileId of activeFileIds) this.statements.setActiveFlag.run(fileId);
    });

    // Pending files that stopped changing need re-checking so they can be flagged as corrupt.
    const staleFiles = this.statements
      .selectStalePendingFiles.all(Date.now() - SETTLED_AFTER_MS)
      .map((file) => ({ directory: file.directory, fileName: file.file_name }));

    return { activeFileIds: activeFileIds.sort((first, second) => first - second), staleFiles };
  }

  /** The journal files the game is writing to now. */
  getActiveFiles() {
    return this.statements.selectActiveFiles.all().map((file) => ({ directory: file.directory, fileName: file.file_name }));
  }
}

/**
 * A fingerprint of a journal file's first entry, or null if it has no complete entry yet.
 * @param {string} filePath
 */
async function readHeaderHash(filePath) {
  const fileHandle = await open(filePath, 'r');
  let buffer;
  try {
    buffer = Buffer.alloc(HEADER_READ_BYTES);
    const { bytesRead } = await fileHandle.read(buffer, 0, HEADER_READ_BYTES, 0);
    buffer = buffer.subarray(0, bytesRead);
  } finally {
    await fileHandle.close();
  }
  // The same rule as the reader: the first complete line that parses as a journal entry.
  let position = 0;
  for (;;) {
    const newlineIndex = buffer.indexOf(0x0a, position);
    if (newlineIndex === -1) return null;
    const lineText = buffer.toString('utf8', position, newlineIndex).trim();
    position = newlineIndex + 1;
    if (!lineText) continue;
    try {
      if (typeof JSON.parse(lineText)?.event === 'string') return hashHeaderLine(lineText);
    } catch {
      // not an entry; keep looking
    }
  }
}

/** A key for a journal file: its folder and name. */
export function fileKey(directory, fileName) {
  return `${directory}|${fileName}`;
}

/**
 * The journal folders, as absolute paths, without repeats (paths differing only in letter case
 * count as the same folder on Windows).
 * @param {(string|undefined)[]} directories
 */
export function normalizeJournalDirectories(directories) {
  const seen = new Set();
  const normalized = [];
  for (const directory of directories) {
    if (!directory) continue;
    const resolved = path.resolve(directory);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(resolved);
  }
  return normalized;
}

function hashHeaderLine(lineText) {
  return createHash('sha1').update(lineText).digest('hex');
}

function getCommanderIdentity(journalEntry) {
  if (!COMMANDER_IDENTITY_EVENTS.has(journalEntry.event)) return null;
  const name = journalEntry.event === 'LoadGame' ? journalEntry.Commander : journalEntry.Name;
  if (!name) return null;
  return { fid: journalEntry.FID ?? null, name };
}

function getCommanderKey(identity) {
  return identity.fid ? identity.fid : `name:${identity.name}`;
}

function isSameCommander(identity, commanderRecord) {
  if (identity.fid && commanderRecord.fid) return identity.fid === commanderRecord.fid;
  return identity.name === commanderRecord.name;
}

/** Collapses identities so that a name-only identity matching a known FID's name isn't counted twice. */
function getDistinctCommanderIdentities(journalEntries) {
  const identitiesByKey = new Map();
  for (const journalEntry of journalEntries) {
    const identity = getCommanderIdentity(journalEntry);
    if (identity) identitiesByKey.set(getCommanderKey(identity), identity);
  }

  const identities = [...identitiesByKey.values()];
  const namesWithFid = new Set(identities.filter((identity) => identity.fid).map((identity) => identity.name));
  return identities.filter((identity) => identity.fid || !namesWithFid.has(identity.name));
}

/** Pulls file-level details (header info, timestamps, closed state) from parsed lines. */
function summarizeFileDetails(parsedLines, fileRecord) {
  const fileDetails = {
    firstTimestamp: fileRecord.first_timestamp ?? null,
    lastTimestamp: fileRecord.last_timestamp ?? null,
    gameVersion: fileRecord.game_version ?? null,
    gameBuild: fileRecord.game_build ?? null,
    filePart: fileRecord.file_part ?? null,
    isOdyssey: fileRecord.is_odyssey ?? null,
    isLegacy: fileRecord.is_legacy ?? 0,
    isClosed: fileRecord.is_closed ?? 0,
  };

  for (const { journalEntry } of parsedLines) {
    if (journalEntry.timestamp) {
      fileDetails.firstTimestamp ??= journalEntry.timestamp;
      fileDetails.lastTimestamp = journalEntry.timestamp;
    }
    if (journalEntry.event === 'Fileheader') {
      fileDetails.gameVersion = journalEntry.gameversion ?? null;
      fileDetails.gameBuild = journalEntry.build?.trim() ?? null;
      fileDetails.filePart = journalEntry.part ?? null;
      fileDetails.isOdyssey = journalEntry.Odyssey === undefined ? null : Number(Boolean(journalEntry.Odyssey));
      fileDetails.isLegacy = isLegacyGameVersion(fileDetails.gameVersion) ? 1 : 0;
    }
    if (FILE_CLOSING_EVENTS.has(journalEntry.event)) fileDetails.isClosed = 1;
  }

  return fileDetails;
}

function prepareStatements(database) {
  return {
    selectFile: database.prepare('SELECT * FROM journal_files WHERE directory = ? AND file_name = ?'),
    selectFileById: database.prepare('SELECT * FROM journal_files WHERE id = ?'),
    insertFile: database.prepare('INSERT INTO journal_files (directory, file_name, sort_key) VALUES (?, ?, ?)'),
    setFileDirectory: database.prepare('UPDATE journal_files SET directory = ? WHERE id = ?'),
    updateFileSize: database.prepare(`
      UPDATE journal_files
      SET file_size = ?, modified_ms = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `),
    updateFileStatus: database.prepare('UPDATE journal_files SET status = ?, status_reason = ?, commander_id = ? WHERE id = ?'),
    updateHeaderHash: database.prepare('UPDATE journal_files SET header_hash = ? WHERE id = ?'),
    selectSameJournal: database.prepare(`
      SELECT id, directory, file_name, is_missing FROM journal_files
      WHERE header_hash = ? AND commander_id = ? AND id != ? AND status = 'ok'
      ORDER BY is_missing, id LIMIT 1
    `),
    selectMissingOriginal: database.prepare(`
      SELECT id FROM journal_files
      WHERE header_hash = ? AND commander_id = ? AND id != ? AND status = 'ok' AND is_missing = 1
      LIMIT 1
    `),
    moveFile: database.prepare('UPDATE journal_files SET directory = ?, file_name = ?, sort_key = ?, is_missing = 0 WHERE id = ?'),
    deleteFile: database.prepare('DELETE FROM journal_files WHERE id = ?'),
    selectFilesWithoutHeaderHash: database.prepare("SELECT id FROM journal_files WHERE header_hash IS NULL AND status = 'ok'"),
    selectFirstEntry: database.prepare('SELECT data FROM journal_entries WHERE journal_file_id = ? ORDER BY line_number LIMIT 1'),
    selectFileMissingFlags: database.prepare('SELECT id, directory, file_name, is_missing FROM journal_files'),
    setFileMissing: database.prepare('UPDATE journal_files SET is_missing = ?1, is_active = is_active * (1 - ?1) WHERE id = ?2'),
    updateFileProgress: database.prepare(`
      UPDATE journal_files SET
        bytes_read = :bytesRead,
        line_count = :lineCount,
        entry_count = :entryCount,
        skipped_line_count = :skippedLineCount,
        first_timestamp = :firstTimestamp,
        last_timestamp = :lastTimestamp,
        game_version = :gameVersion,
        game_build = :gameBuild,
        file_part = :filePart,
        is_odyssey = :isOdyssey,
        is_legacy = :isLegacy,
        is_closed = :isClosed
      WHERE id = :fileId
    `),
    resetFile: database.prepare(`
      UPDATE journal_files SET
        status = 'pending', status_reason = NULL, commander_id = NULL,
        bytes_read = 0, line_count = 0, entry_count = 0, skipped_line_count = 0,
        first_timestamp = NULL, last_timestamp = NULL, is_closed = 0
      WHERE id = ?
    `),
    deleteEntriesForFile: database.prepare('DELETE FROM journal_entries WHERE journal_file_id = ?'),
    deleteFileEventCounts: database.prepare('DELETE FROM journal_file_events WHERE journal_file_id = ?'),
    addFileEventCount: database.prepare(`
      INSERT INTO journal_file_events (journal_file_id, event, entry_count) VALUES (?, ?, ?)
      ON CONFLICT (journal_file_id, event) DO UPDATE SET entry_count = entry_count + excluded.entry_count
    `),
    insertEntry: database.prepare(`
      INSERT OR IGNORE INTO journal_entries (journal_file_id, commander_id, line_number, timestamp, event, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    selectCommanderById: database.prepare('SELECT * FROM commanders WHERE id = ?'),
    selectCommanderByKey: database.prepare('SELECT * FROM commanders WHERE commander_key = ?'),
    insertCommander: database.prepare('INSERT INTO commanders (commander_key, fid, name) VALUES (?, ?, ?)'),
    updateCommanderKey: database.prepare('UPDATE commanders SET commander_key = ?, fid = ? WHERE id = ?'),
    updateCommanderName: database.prepare('UPDATE commanders SET name = ? WHERE id = ?'),
    updateCommanderSeen: database.prepare(`
      UPDATE commanders SET
        first_seen = CASE WHEN first_seen IS NULL OR first_seen > ?1 THEN ?1 ELSE first_seen END,
        last_seen = CASE WHEN last_seen IS NULL OR last_seen < ?2 THEN ?2 ELSE last_seen END
      WHERE id = ?3
    `),
    selectActiveCandidates: database.prepare(`
      SELECT id, commander_id, status, sort_key FROM journal_files
      WHERE is_closed = 0 AND is_legacy = 0 AND is_missing = 0 AND status IN ('ok', 'pending') AND modified_ms >= ?
    `),
    selectStalePendingFiles: database.prepare("SELECT directory, file_name FROM journal_files WHERE status = 'pending' AND is_missing = 0 AND directory != '' AND modified_ms < ?"),
    clearActiveFlags: database.prepare('UPDATE journal_files SET is_active = 0 WHERE is_active = 1'),
    setActiveFlag: database.prepare('UPDATE journal_files SET is_active = 1 WHERE id = ?'),
    selectActiveFiles: database.prepare("SELECT directory, file_name FROM journal_files WHERE is_active = 1 AND directory != ''"),
  };
}
