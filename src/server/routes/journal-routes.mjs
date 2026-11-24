import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { getEntryCodec } from '../../database/entry-compression.mjs';
import { isJournalFileName } from '../../journals/journal-files.mjs';
import { normalizeJournalDirectories } from '../../journals/journal-ingester.mjs';
import {
  SqlFilter, addStandardFilters, getCommanderIdFilter, getOrderByClause, getPagination, runPaginatedQuery,
} from '../../stats/query-helpers.mjs';

/** Larger than any real journal; the raw view reads the whole file. */
const MAX_RAW_FILE_BYTES = 64 * 1024 * 1024;
const COMMANDER_IDENTITY_EVENTS = new Set(['Commander', 'LoadGame', 'NewCommander']);

/**
 * Routes for commanders and journal files.
 * @param {import('node:sqlite').DatabaseSync} database
 * @param {{ journalDirectories?: string[], journalDirectory?: string }} [options]  the journal folders (or one)
 */
export function createJournalRoutes(database, { journalDirectories, journalDirectory } = {}) {
  const router = Router();
  const configuredDirectories = normalizeJournalDirectories(journalDirectories ?? [journalDirectory]);

  // GET /api/commanders -> basic commander list (used for commander selectors)
  router.get('/commanders', (request, response) => {
    const commanderRows = database.prepare(`
      SELECT commanders.id, commanders.name, commanders.fid, commanders.first_seen, commanders.last_seen,
        COUNT(journal_files.id) AS journal_file_count,
        COALESCE(SUM(journal_files.entry_count), 0) AS entry_count,
        COALESCE(SUM(journal_files.is_active), 0) AS active_journal_count
      FROM commanders
      LEFT JOIN journal_files ON journal_files.commander_id = commanders.id
      GROUP BY commanders.id
      ORDER BY commanders.name
    `).all();
    response.json({ commanders: commanderRows });
  });

  // GET /api/journals/summary?commander=
  router.get('/journals/summary', (request, response) => {
    const commanderIdFilter = getCommanderIdFilter(request.query);
    const summary = database.prepare(`
      SELECT
        COUNT(*) AS total_files,
        COALESCE(SUM(status = 'ok'), 0) AS ok_files,
        COALESCE(SUM(status = 'pending'), 0) AS pending_files,
        COALESCE(SUM(status = 'corrupt'), 0) AS corrupt_files,
        COALESCE(SUM(status = 'duplicate'), 0) AS duplicate_files,
        COALESCE(SUM(is_missing), 0) AS missing_files,
        COALESCE(SUM(is_active), 0) AS active_files,
        COALESCE(SUM(entry_count), 0) AS total_entries,
        COALESCE(SUM(skipped_line_count), 0) AS skipped_lines,
        COALESCE(SUM(file_size), 0) AS total_bytes,
        MIN(first_timestamp) AS first_timestamp,
        MAX(last_timestamp) AS last_timestamp
      FROM journal_files
      WHERE ?1 IS NULL OR commander_id = ?1
    `).get(commanderIdFilter);

    const activeFiles = database.prepare(`
      SELECT journal_files.id, journal_files.file_name, journal_files.status, journal_files.status_reason, journal_files.last_timestamp,
        journal_files.entry_count, commanders.name AS commander_name
      FROM journal_files LEFT JOIN commanders ON commanders.id = journal_files.commander_id
      WHERE journal_files.is_active = 1 AND (?1 IS NULL OR journal_files.commander_id = ?1)
      ORDER BY journal_files.sort_key DESC
    `).all(commanderIdFilter);

    const topEvents = database.prepare(`
      SELECT journal_file_events.event, SUM(journal_file_events.entry_count) AS entry_count
      FROM journal_file_events JOIN journal_files ON journal_files.id = journal_file_events.journal_file_id
      WHERE ?1 IS NULL OR journal_files.commander_id = ?1
      GROUP BY journal_file_events.event ORDER BY entry_count DESC, journal_file_events.event
    `).all(commanderIdFilter);

    // The journal folders being read, with how many journals each holds (and how many are no
    // longer there). Journals read before folders were recorded that no folder has turned out to
    // hold are counted as unplaced.
    const countsByDirectory = new Map(database.prepare(`
      SELECT directory, COUNT(*) AS file_count, COALESCE(SUM(is_missing), 0) AS missing_count
      FROM journal_files WHERE ?1 IS NULL OR commander_id = ?1 GROUP BY directory
    `).all(commanderIdFilter).map((row) => [row.directory, row]));
    const folders = configuredDirectories.map((directory) => ({
      directory,
      fileCount: countsByDirectory.get(directory)?.file_count ?? 0,
      missingCount: countsByDirectory.get(directory)?.missing_count ?? 0,
    }));
    const unplacedFileCount = countsByDirectory.get('')?.file_count ?? 0;

    response.json({ summary, activeFiles, topEvents, folders, unplacedFileCount });
  });

  // GET /api/journals?commander=&status=ok|pending|corrupt|duplicate|missing&active=true&folder=&search=&period=&sort=&order=&limit=&offset=
  router.get('/journals', (request, response) => {
    const sqlFilter = addStandardFilters(new SqlFilter(), request.query, {
      commanderColumn: 'journal_files.commander_id',
      timestampColumn: 'journal_files.last_timestamp',
      searchColumns: ['journal_files.file_name', 'commanders.name', 'journal_files.status_reason'],
    });
    if (['ok', 'pending', 'corrupt', 'duplicate'].includes(request.query.status)) sqlFilter.add('journal_files.status = ?', request.query.status);
    if (request.query.status === 'missing') sqlFilter.add('journal_files.is_missing = 1');
    if (request.query.active === 'true') sqlFilter.add('journal_files.is_active = 1');
    if (typeof request.query.folder === 'string' && request.query.folder !== '') sqlFilter.add('journal_files.directory = ?', request.query.folder);

    response.json(runPaginatedQuery(database, {
      selectSql: `
        SELECT journal_files.*, commanders.name AS commander_name
        FROM journal_files LEFT JOIN commanders ON commanders.id = journal_files.commander_id
      `,
      sqlFilter,
      orderByClause: getOrderByClause(request.query, {
        file: 'journal_files.sort_key',
        size: 'journal_files.file_size',
        entries: 'journal_files.entry_count',
        lastTimestamp: 'journal_files.last_timestamp',
      }, 'file'),
      pagination: getPagination(request.query),
    }));
  });

  // GET /api/journals/:fileId/entries?event=&order=asc|desc&limit=&offset= (newest first by default)
  router.get('/journals/:fileId/entries', (request, response) => {
    const sqlFilter = new SqlFilter().add('journal_file_id = ?', Number(request.params.fileId));
    if (request.query.event) sqlFilter.add('event = ?', String(request.query.event));

    const pageResult = runPaginatedQuery(database, {
      selectSql: 'SELECT id, line_number, timestamp, event, data FROM journal_entries',
      sqlFilter,
      orderByClause: `ORDER BY line_number ${request.query.order === 'asc' ? 'ASC' : 'DESC'}`,
      pagination: getPagination(request.query),
    });
    const entryCodec = getEntryCodec(database);
    pageResult.rows = pageResult.rows.map((entryRow) => ({ ...entryRow, data: JSON.parse(entryCodec.decode(entryRow.data)) }));
    response.json(pageResult);
  });

  // GET /api/journals/:fileId/raw?filter=problems|commanders&search=&limit=&offset=
  // The file's lines as they are on disk right now (read-only), for files whose entries aren't
  // stored: each line with its event, the commander it names, and why it can't be read.
  router.get('/journals/:fileId/raw', async (request, response) => {
    const journalFile = database.prepare('SELECT directory, file_name FROM journal_files WHERE id = ?').get(Number(request.params.fileId));
    if (!journalFile || !isJournalFileName(journalFile.file_name)) {
      response.status(404).json({ error: 'Unknown journal file.' });
      return;
    }
    // Only from a configured journal folder: the one the ingester recorded for this journal.
    if (!configuredDirectories.includes(journalFile.directory)) {
      response.status(404).json({ error: 'The file is no longer in any of the journal folders.' });
      return;
    }

    // Only a known journal's file, by the folder and name the ingester recorded (never anything
    // from the request), directly in that folder, and only a regular file (links aren't followed).
    const filePath = path.join(journalFile.directory, path.basename(journalFile.file_name));
    let fileStats;
    let fileText;
    try {
      fileStats = await lstat(filePath);
      if (!fileStats.isFile()) {
        response.status(404).json({ error: 'The journal is not a regular file in the journal folder.' });
        return;
      }
      if (fileStats.size > MAX_RAW_FILE_BYTES) {
        response.status(413).json({ error: `The file is too large to show (${Math.round(fileStats.size / 1024 / 1024)} MB).` });
        return;
      }
      fileText = await readFile(filePath, { encoding: 'utf8', flag: 'r' });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      response.status(404).json({ error: 'The file is no longer in the journal folder.' });
      return;
    }

    const lineTexts = fileText.split('\n');
    if (lineTexts.at(-1) === '') lineTexts.pop();
    const lines = lineTexts.map((lineText, index) => describeRawLine(lineText.replace(/\r$/, ''), index + 1));

    const commandersByKey = new Map();
    for (const line of lines) {
      if (!line.commander) continue;
      const key = line.commander.fid ?? `name:${line.commander.name}`;
      const summary = commandersByKey.get(key) ?? { ...line.commander, firstLine: line.line_number, lineCount: 0 };
      summary.lineCount += 1;
      commandersByKey.set(key, summary);
    }

    const search = typeof request.query.search === 'string' ? request.query.search.trim().toLowerCase() : '';
    const filteredLines = lines.filter((line) => {
      if (request.query.filter === 'problems' && !line.problem) return false;
      if (request.query.filter === 'commanders' && !line.commander) return false;
      return !search || line.text.toLowerCase().includes(search);
    });
    const pagination = getPagination(request.query);

    response.json({
      rows: filteredLines.slice(pagination.offset, pagination.offset + pagination.limit),
      total: filteredLines.length,
      ...pagination,
      lineCount: lines.length,
      problemCount: lines.filter((line) => line.problem).length,
      commanders: [...commandersByKey.values()],
      fileSize: fileStats.size,
      modifiedAt: fileStats.mtime.toISOString(),
      readAt: new Date().toISOString(),
      endsMidLine: fileText.length > 0 && !fileText.endsWith('\n'),
    });
  });

  return router;
}

/** One raw journal line: its event and timestamp if it's a journal entry, otherwise why not. */
function describeRawLine(text, lineNumber) {
  const line = { line_number: lineNumber, text, event: null, timestamp: null, commander: null, problem: null };
  if (!text.trim()) return line;
  let journalEntry;
  try {
    journalEntry = JSON.parse(text);
  } catch (error) {
    line.problem = `Not valid JSON (${error.message})`;
    return line;
  }
  if (!journalEntry || typeof journalEntry !== 'object' || typeof journalEntry.event !== 'string') {
    line.problem = 'Not a journal entry (no "event" field)';
    return line;
  }
  line.event = journalEntry.event;
  line.timestamp = typeof journalEntry.timestamp === 'string' ? journalEntry.timestamp : null;
  if (COMMANDER_IDENTITY_EVENTS.has(journalEntry.event)) {
    const name = journalEntry.event === 'LoadGame' ? journalEntry.Commander : journalEntry.Name;
    if (name) line.commander = { name, fid: journalEntry.FID ?? null };
  }
  return line;
}
