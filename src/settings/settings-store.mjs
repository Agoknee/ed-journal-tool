/**
 * The app's settings, kept in settings.json in the data folder (beside the database, not in it: the
 * dashboard's SQL tool can read every table, and deleting journals.db to start afresh shouldn't
 * lose them).
 *
 * Two kinds:
 * - Settings people change on the Settings page, defined in SETTING_DEFINITIONS (a default and a
 *   check for each). These are what GET /api/settings returns and PATCH /api/settings changes.
 * - The app's own: the password hash and the key session cookies are signed with (see
 *   server/auth.mjs). These never leave the server.
 *
 * The file is rewritten whole on each change (written beside it and renamed over it, so it's never
 * half-written), readable only by the user on Linux and macOS.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDirectoryPath } from '../data-paths.mjs';
import { logger } from '../logger.mjs';

export const settingsFilePath = path.join(dataDirectoryPath, 'settings.json');

/**
 * Settings shown on the Settings page. Each has a default and a check that returns an error
 * message, or null when the value is fine. Add new ones here; the client reads their values from
 * GET /api/settings.
 * @type {Record<string, { default: unknown, validate: (value: unknown) => string | null }>}
 */
export const SETTING_DEFINITIONS = {};

export class SettingsStore {
  /**
   * @param {object} [options]
   * @param {string} [options.filePath]
   * @param {typeof SETTING_DEFINITIONS} [options.definitions]
   */
  constructor({ filePath = settingsFilePath, definitions = SETTING_DEFINITIONS } = {}) {
    this.filePath = filePath;
    this.definitions = definitions;
    this.data = { settings: {}, internal: {} };
    if (existsSync(filePath)) {
      try {
        const stored = JSON.parse(readFileSync(filePath, 'utf8'));
        this.data = { settings: stored.settings ?? {}, internal: stored.internal ?? {} };
      } catch (error) {
        // Not overwritten until something changes, so it can still be fixed by hand.
        logger.error(`Couldn't read the settings in "${filePath}" (${error.message}); using the defaults.`);
      }
    }
  }

  /** The Settings page's settings, defaults filled in. */
  getSettings() {
    return Object.fromEntries(Object.entries(this.definitions)
      .map(([key, definition]) => [key, this.data.settings[key] ?? definition.default]));
  }

  /**
   * Changes Settings page settings. Nothing is changed if any value is unknown or invalid.
   * @param {Record<string, unknown>} changes
   * @returns {{ settings?: Record<string, unknown>, errors?: Record<string, string> }}
   */
  updateSettings(changes) {
    const errors = {};
    for (const [key, value] of Object.entries(changes ?? {})) {
      const definition = this.definitions[key];
      const error = definition ? definition.validate(value) : 'There is no such setting.';
      if (error) errors[key] = error;
    }
    if (Object.keys(errors).length > 0) return { errors };
    this.data.settings = { ...this.data.settings, ...changes };
    this.save();
    return { settings: this.getSettings() };
  }

  /** One of the app's own values (never sent to the dashboard). */
  getInternal(key) {
    return this.data.internal[key];
  }

  /** Changes the app's own values; undefined removes one. */
  setInternal(changes) {
    const internal = { ...this.data.internal, ...changes };
    for (const [key, value] of Object.entries(internal)) if (value === undefined) delete internal[key];
    this.data.internal = internal;
    this.save();
  }

  save() {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
  }
}
