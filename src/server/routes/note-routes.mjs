import { Router } from 'express';

export const MAX_NOTE_LENGTH = 200;

/**
 * Notes the user keeps per carrier or per commander. The carriers stats API includes them as
 * `note` on each carrier and `commanderNote` on each commander status.
 *
 * PUT /api/carrier-notes/:carrierId { note }     (carrierId is the carrier's market id)
 * PUT /api/commander-notes/:commanderId { note }
 * An empty note removes it.
 * @param {import('node:sqlite').DatabaseSync} database
 * @param {import('../../events/event-hub.mjs').EventHub} eventHub
 */
export function createNoteRoutes(database, eventHub) {
  const router = Router();
  router.use('/carrier-notes', createNoteRouter(database, eventHub, { tableName: 'carrier_notes', idColumn: 'carrier_id' }));
  router.use('/commander-notes', createNoteRouter(database, eventHub, {
    tableName: 'commander_notes',
    idColumn: 'commander_id',
    existsSql: 'SELECT 1 FROM commanders WHERE id = ?',
  }));
  return router;
}

/** Table and column names are fixed by createNoteRoutes, never taken from requests. */
function createNoteRouter(database, eventHub, { tableName, idColumn, existsSql }) {
  const router = Router();
  const upsertNote = database.prepare(`
    INSERT INTO ${tableName} (${idColumn}, note, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (${idColumn}) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at
  `);
  const deleteNote = database.prepare(`DELETE FROM ${tableName} WHERE ${idColumn} = ?`);
  const selectExists = existsSql ? database.prepare(existsSql) : null;

  router.put('/:id', (request, response) => {
    const id = Number(request.params.id);
    const note = typeof request.body?.note === 'string' ? request.body.note.trim() : null;
    if (!Number.isSafeInteger(id) || id <= 0) return response.status(400).json({ error: 'Invalid id.' });
    if (selectExists && !selectExists.get(id)) return response.status(404).json({ error: 'Not found.' });
    if (note === null) return response.status(400).json({ error: 'note must be a string.' });
    if (note.length > MAX_NOTE_LENGTH) return response.status(400).json({ error: `Notes are limited to ${MAX_NOTE_LENGTH} characters.` });

    if (note) upsertNote.run(id, note, new Date().toISOString());
    else deleteNote.run(id);
    eventHub.publish('notes', { [idColumn]: id });
    response.json({ id, note: note || null });
  });

  return router;
}
