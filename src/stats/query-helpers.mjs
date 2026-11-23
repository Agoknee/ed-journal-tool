/**
 * Shared helpers for building filtered, paginated SQL queries from API query strings.
 */
import { toJournalTimestamp } from '../journals/journal-timestamp.mjs';

const PERIOD_DURATIONS_MS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
  '1y': 365 * 24 * 60 * 60 * 1000,
};

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;

/**
 * Collects SQL WHERE conditions and their parameters.
 */
export class SqlFilter {
  constructor() {
    this.conditions = [];
    this.parameters = [];
  }

  add(condition, ...parameters) {
    this.conditions.push(condition);
    this.parameters.push(...parameters);
    return this;
  }

  get whereClause() {
    return this.conditions.length > 0 ? `WHERE ${this.conditions.join(' AND ')}` : '';
  }
}

/**
 * Reads the commander filter (?commander=<id>). Missing or "all" means every commander.
 * @returns {number | null}
 */
export function getCommanderIdFilter(query) {
  const commanderValue = query.commander;
  if (commanderValue === undefined || commanderValue === '' || commanderValue === 'all') return null;
  const commanderId = Number(commanderValue);
  return Number.isInteger(commanderId) ? commanderId : null;
}

/**
 * Reads a time range from ?period=24h|7d|30d|90d|1y or ?from=<iso>&to=<iso>.
 * @returns {{ fromTimestamp: string | null, toTimestamp: string | null }}
 */
export function getTimeRangeFilter(query) {
  let fromTimestamp = parseTimestamp(query.from);
  const toTimestamp = parseTimestamp(query.to, { isEndOfRange: true });

  const periodDurationMs = PERIOD_DURATIONS_MS[query.period];
  if (periodDurationMs) fromTimestamp = new Date(Date.now() - periodDurationMs).toISOString();

  return { fromTimestamp, toTimestamp };
}

/**
 * Adds the standard commander, time range and text search conditions.
 * @param {SqlFilter} sqlFilter
 * @param {object} query            Express request query
 * @param {object} columns
 * @param {string} [columns.commanderColumn]
 * @param {string} [columns.timestampColumn]
 * @param {string[]} [columns.searchColumns]
 */
export function addStandardFilters(sqlFilter, query, { commanderColumn, timestampColumn, searchColumns = [] }) {
  const commanderId = getCommanderIdFilter(query);
  if (commanderColumn && commanderId !== null) sqlFilter.add(`${commanderColumn} = ?`, commanderId);

  if (timestampColumn) {
    const { fromTimestamp, toTimestamp } = getTimeRangeFilter(query);
    if (fromTimestamp) sqlFilter.add(`${timestampColumn} >= ?`, toJournalTimestamp(fromTimestamp));
    if (toTimestamp) sqlFilter.add(`${timestampColumn} <= ?`, toJournalTimestamp(toTimestamp));
  }

  const searchText = typeof query.search === 'string' ? query.search.trim() : '';
  if (searchText && searchColumns.length > 0) {
    const likePattern = `%${escapeLikePattern(searchText)}%`;
    const searchConditions = searchColumns.map((column) => `${column} LIKE ? ESCAPE '\\'`);
    sqlFilter.add(`(${searchConditions.join(' OR ')})`, ...searchColumns.map(() => likePattern));
  }

  return sqlFilter;
}

/** @returns {{ limit: number, offset: number }} */
export function getPagination(query) {
  const requestedLimit = Number.parseInt(query.limit, 10);
  const requestedOffset = Number.parseInt(query.offset, 10);
  return {
    limit: Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE,
    offset: Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0,
  };
}

/**
 * Returns the ORDER BY clause for a whitelisted sort column (?sort=<key>&order=asc|desc).
 * @param {object} query
 * @param {Record<string, string>} sortableColumns  API sort key -> SQL expression
 * @param {string} defaultSortKey
 */
export function getOrderByClause(query, sortableColumns, defaultSortKey) {
  const sortExpression = sortableColumns[query.sort] ?? sortableColumns[defaultSortKey];
  const sortDirection = String(query.order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${sortExpression} ${sortDirection}`;
}

/**
 * Runs a paginated query and returns { rows, total, limit, offset }.
 * @param {import('node:sqlite').DatabaseSync} database
 * @param {object} options
 * @param {string} options.selectSql  SELECT ... FROM ... (no WHERE)
 * @param {SqlFilter} options.sqlFilter
 * @param {string} options.orderByClause
 * @param {{ limit: number, offset: number }} options.pagination
 */
export function runPaginatedQuery(database, { selectSql, sqlFilter, orderByClause, pagination }) {
  const { total } = database
    .prepare(`SELECT COUNT(*) AS total FROM (${selectSql} ${sqlFilter.whereClause})`)
    .get(...sqlFilter.parameters);

  const rows = database
    .prepare(`${selectSql} ${sqlFilter.whereClause} ${orderByClause} LIMIT ? OFFSET ?`)
    .all(...sqlFilter.parameters, pagination.limit, pagination.offset);

  return { rows, total, ...pagination };
}

/** Parses JSON text columns in query result rows. */
export function parseJsonColumns(rows, columnNames) {
  return rows.map((row) => {
    const parsedRow = { ...row };
    for (const columnName of columnNames) {
      if (typeof parsedRow[columnName] === 'string') parsedRow[columnName] = JSON.parse(parsedRow[columnName]);
    }
    return parsedRow;
  });
}

/** Converts an ISO timestamp to the journal's "YYYY-MM-DDTHH:MM:SSZ" format so string comparisons work. */
function parseTimestamp(value, { isEndOfRange = false } = {}) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  const parsedDate = new Date(isDateOnly ? `${value.trim()}T${isEndOfRange ? '23:59:59' : '00:00:00'}Z` : value);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate.toISOString();
}

function escapeLikePattern(text) {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** The total of a numeric property over rows (missing or non-numeric values count as 0). */
export function sumBy(rows, propertyName) {
  return rows.reduce((total, row) => total + (Number(row[propertyName]) || 0), 0);
}

/**
 * The one commander a request is for (?commander=<id>). When it names none (or "all"), answers
 * 400 and returns null, so a route can stop there.
 */
export function requireCommanderId(request, response) {
  const commanderId = getCommanderIdFilter(request.query);
  if (commanderId === null) response.status(400).json({ error: 'Choose a commander' });
  return commanderId;
}
