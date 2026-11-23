import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { runInTransaction } from '../database/database.mjs';
import { getEntryCodec } from '../database/entry-compression.mjs';
import { logger } from '../logger.mjs';
import { compareJournalFileNames, getJournalSortKey, isJournalFileName, isLegacyGameVersion } from './journal-files.mjs';
import { readJournalLines } from './journal-reader.mjs';

/** A file that hasn't been modified for this long is assumed to be finished. */
const SETTLED_AFTER_MS = 2 * 60 * 1000;

/** An unclosed journal modified within this window may still be in use by the game. */
const ACTIVE_WINDOW_MS = 60 * 60 * 1000;

const COMMANDER_IDENTITY_EVENTS = new Set(['Commander', 'LoadGame', 'NewCommander']);
const FILE_CLOSING_EVENTS = new Set(['Shutdown', 'Continued']);

/**
 * Reads journal files into the database, tracking how far each file has been read
 * and which commander it belongs to. Journal files are only ever opened read-only.
 */
export class JournalIngester {
  /**
   * @param {object} options
   * @param {import('node:sqlite').DatabaseSync} options.database
   * @param {string} options.journalDirectory
   */
  constructor({ database, journalDirectory }) {
    this.database = database;
    this.journalDirectory = journalDirectory;
    this.statements = prepareStatements(database);
  }

  async listJournalFileNames() {
    const directoryEntries = await readdir(this.journalDirectory, { withFileTypes: true });
    return directoryEntries
      .filter((directoryEntry) => directoryEntry.isFile() && isJournalFileName(directoryEntry.name))
      .map((directoryEntry) => directoryEntry.name)
      .sort(compareJournalFileNames);
  }

  /**
   * Reads any new data from a journal file.
   * @param {string} fileName
   * @param {{ skipUnparseable?: boolean }} [options]
   * @returns {Promise<{ hasChanged: boolean, newEntryCount: number, needsRetry: boolean, requiresStatsRebuild: boolean }>}
   */
  async processFile(fileName, { skipUnparseable = false } = {}) {
    const result = { hasChanged: false, newEntryCount: 0, needsRetry: false, requiresStatsRebuild: false };
    const filePath = path.join(this.journalDirectory, fileName);

    let fileStats;
    try {
      fileStats = await stat(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') return result;
      throw error;
    }

    const fileSize = fileStats.size;
    const modifiedMs = Math.trunc(fileStats.mtimeMs);
    const isSettled = Date.now() - modifiedMs > SETTLED_AFTER_MS;

    let fileRecord = this.statements.selectFileByName.get(fileName);
    if (!fileRecord) {
      this.statements.insertFile.run(fileName, getJournalSortKey(fileName));
      fileRecord = this.statements.selectFileByName.get(fileName);
    }

    const isUnchanged = fileRecord.file_size === fileSize && fileRecord.modified_ms === modifiedMs;
    const hasUnreadTail = fileRecord.status === 'ok' && fileRecord.bytes_read < fileSize;
    const isAwaitingCommander = fileRecord.status === 'pending';
    if (isUnchanged && !hasUnreadTail && !isAwaitingCommander && !skipUnparseable) return result;

    // A file that shrank was rewritten; start over.
    if (fileRecord.status === 'ok' && fileSize < fileRecord.bytes_read) {
      logger.warn(`Journal file "${fileName}" shrank; re-reading it from the start.`);
      this.resetFile(fileRecord.id);
      fileRecord = this.statements.selectFileByName.get(fileName);
      result.requiresStatsRebuild = true;
    }

    const readOptions = { endOffset: fileSize, isSettled, skipUnparseable };
    if (fileRecord.status === 'ok') {
      Object.assign(result, await this.readAssignedFile(fileRecord, filePath, readOptions));
    } else {
      Object.assign(result, await this.readUnassignedFile(fileRecord, filePath, readOptions));
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
      logger.warn(`Journal file "${fileRecord.file_name}" flagged as corrupt. ${reason}`);
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
      logger.debug(`Journal file "${fileRecord.file_name}" flagged as corrupt. ${reason}`);
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

    runInTransaction(this.database, () => {
      const commanderId = this.upsertCommander(commanderIdentities[0]);
      this.statements.updateFileStatus.run('ok', null, commanderId, fileRecord.id);
      this.storeEntries({ ...fileRecord, bytes_read: 0, line_count: 0, entry_count: 0, skipped_line_count: 0 }, commanderId, readResult);
    });
    logger.debug(`Journal file "${fileRecord.file_name}" assigned to CMDR ${commanderIdentities[0].name}`);

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
   * @returns {{ activeFileIds: number[], staleFileNames: string[] }}
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
    const staleFileNames = this.statements
      .selectStalePendingFiles.all(Date.now() - SETTLED_AFTER_MS)
      .map((file) => file.file_name);

    return { activeFileIds: activeFileIds.sort((first, second) => first - second), staleFileNames };
  }

  getActiveFileNames() {
    return this.statements.selectActiveFileNames.all().map((file) => file.file_name);
  }
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
    selectFileByName: database.prepare('SELECT * FROM journal_files WHERE file_name = ?'),
    insertFile: database.prepare('INSERT INTO journal_files (file_name, sort_key) VALUES (?, ?)'),
    updateFileSize: database.prepare(`
      UPDATE journal_files
      SET file_size = ?, modified_ms = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `),
    updateFileStatus: database.prepare('UPDATE journal_files SET status = ?, status_reason = ?, commander_id = ? WHERE id = ?'),
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
      WHERE is_closed = 0 AND is_legacy = 0 AND status IN ('ok', 'pending') AND modified_ms >= ?
    `),
    selectStalePendingFiles: database.prepare("SELECT file_name FROM journal_files WHERE status = 'pending' AND modified_ms < ?"),
    clearActiveFlags: database.prepare('UPDATE journal_files SET is_active = 0 WHERE is_active = 1'),
    setActiveFlag: database.prepare('UPDATE journal_files SET is_active = 1 WHERE id = ?'),
    selectActiveFileNames: database.prepare('SELECT file_name FROM journal_files WHERE is_active = 1'),
  };
}
