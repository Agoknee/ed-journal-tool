import { Router } from 'express';
import { getDatabaseStats } from '../../database/database-maintenance.mjs';

/** What has to be typed to reset the database (the dashboard asks for it too). */
export const RESET_CONFIRMATION = 'RESET';

/**
 * The Settings page's Database section.
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.database
 * @param {string} options.databasePath
 * @param {{ busyReason: () => string | null, reset: (options: { keepCopy?: boolean }) => Promise<{ copy: object | null }> }} options.databaseReset
 * @param {(request, response) => Promise<boolean>} options.checkCurrentPassword  sends the refusal itself
 */
export function createDatabaseRoutes({ database, databasePath, databaseReset, checkCurrentPassword }) {
  const router = Router();

  // GET /api/database -> sizes on disk, what it holds, and whether it can be reset now
  router.get('/', (request, response) => {
    response.json({ ...getDatabaseStats(database, databasePath), resetBlockedReason: databaseReset.busyReason(), resetConfirmation: RESET_CONFIRMATION });
  });

  // POST /api/database/reset { confirmation: "RESET", keepCopy?, currentPassword? } -> deletes
  // everything stored (after keeping a copy of the database beside it, with keepCopy), then reads
  // the journals again. From another device the password is needed too.
  router.post('/reset', async (request, response) => {
    if (request.body?.confirmation !== RESET_CONFIRMATION) {
      response.status(400).json({ error: `Type ${RESET_CONFIRMATION} to confirm.` });
      return;
    }
    if (!(await checkCurrentPassword(request, response))) return;
    const busyReason = databaseReset.busyReason();
    if (busyReason) {
      response.status(409).json({ error: busyReason });
      return;
    }
    try {
      const { copy } = await databaseReset.reset({ keepCopy: request.body?.keepCopy === true });
      response.json({ isReset: true, copy });
    } catch (error) {
      // A copy that couldn't be made (no room, say): nothing was deleted.
      if (!error.status) throw error;
      response.status(error.status).json({ error: error.message });
    }
  });

  return router;
}
