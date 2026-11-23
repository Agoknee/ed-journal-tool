import { Router } from 'express';
import { openReadOnlyDatabase } from '../../database/database.mjs';
import { exposeEntryTextInSql } from '../../database/entry-compression.mjs';

const MAX_RESULT_ROWS = 1000;

/**
 * Raw SQL query tool. Queries run on a separate read-only connection, so they can't modify data.
 * @param {string} databasePath
 * @param {import('node:sqlite').DatabaseSync} database  main connection, used to list the schema
 */
export function createSqlRoutes(databasePath, database) {
  const router = Router();
  const readOnlyDatabase = openReadOnlyDatabase(databasePath);
  exposeEntryTextInSql(readOnlyDatabase);

  // GET /api/sql/schema -> tables/views and their columns
  router.get('/schema', (request, response) => {
    const schemaObjects = database.prepare(`
      SELECT name, type FROM sqlite_schema
      WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all();
    const tables = schemaObjects.map((schemaObject) => ({
      ...schemaObject,
      columns: database.prepare(`SELECT name, type FROM pragma_table_info(?)`).all(schemaObject.name),
    }));
    response.json({ tables });
  });

  // POST /api/sql { query: "SELECT ..." }
  router.post('/', (request, response) => {
    const queryText = typeof request.body?.query === 'string' ? request.body.query.trim() : '';
    if (!queryText) {
      response.status(400).json({ error: 'A "query" string is required.' });
      return;
    }

    const startTime = performance.now();
    try {
      const statement = readOnlyDatabase.prepare(queryText);
      statement.setReadBigInts(true);

      const columns = statement.columns().map((column) => column.name);
      const rows = [];
      let isTruncated = false;
      for (const row of statement.iterate()) {
        if (rows.length >= MAX_RESULT_ROWS) {
          isTruncated = true;
          break;
        }
        rows.push(columns.map((columnName) => toJsonSafeValue(row[columnName])));
      }

      response.json({ columns, rows, rowCount: rows.length, isTruncated, maxRows: MAX_RESULT_ROWS, elapsedMs: Math.round(performance.now() - startTime) });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  /** Closes the read-only connection (for tests; the app's process exit closes it otherwise). */
  router.closeDatabase = () => readOnlyDatabase.close();
  return router;
}

function toJsonSafeValue(value) {
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (value instanceof Uint8Array) return `<blob ${value.byteLength} bytes>`;
  return value;
}
