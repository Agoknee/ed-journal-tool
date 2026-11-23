import { Router } from 'express';
import { getEntryCodec } from '../../database/entry-compression.mjs';
import {
  SqlFilter, addStandardFilters, getCommanderIdFilter, getOrderByClause, getPagination, runPaginatedQuery,
} from '../../stats/query-helpers.mjs';

/**
 * Routes for commanders and journal files.
 * @param {import('node:sqlite').DatabaseSync} database
 */
export function createJournalRoutes(database) {
  const router = Router();

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

    response.json({ summary, activeFiles, topEvents });
  });

  // GET /api/journals?commander=&status=ok|pending|corrupt&active=true&search=&period=&sort=&order=&limit=&offset=
  router.get('/journals', (request, response) => {
    const sqlFilter = addStandardFilters(new SqlFilter(), request.query, {
      commanderColumn: 'journal_files.commander_id',
      timestampColumn: 'journal_files.last_timestamp',
      searchColumns: ['journal_files.file_name', 'commanders.name', 'journal_files.status_reason'],
    });
    if (['ok', 'pending', 'corrupt'].includes(request.query.status)) sqlFilter.add('journal_files.status = ?', request.query.status);
    if (request.query.active === 'true') sqlFilter.add('journal_files.is_active = 1');

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

  return router;
}
