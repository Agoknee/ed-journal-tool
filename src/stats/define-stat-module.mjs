/**
 * @typedef {object} JournalEntry
 * @property {number} id
 * @property {number} journalFileId
 * @property {number} commanderId
 * @property {string} timestamp
 * @property {string} event
 * @property {object} data            the parsed journal line
 *
 * @typedef {object} ModuleState      per-commander key/value storage that persists between runs
 * @property {(key: string) => any} get
 * @property {(key: string, value: any) => void} set
 *
 * @typedef {object} StatModule
 * @property {string} name            unique identifier, also used for the API route: /api/stats/<name>
 * @property {string} title
 * @property {string} description
 * @property {number} version         bump to rebuild the module's tables from scratch
 * @property {string[]} events        journal events the module wants to receive
 * @property {string[]} dependsOn     modules whose tables this module's queries read
 * @property {string} schemaSql       CREATE ... IF NOT EXISTS statements for the module's tables
 * @property {{ type: 'table' | 'view', name: string }[]} ownedObjects  tables/views cleared on rebuild, dropped on removal
 * @property {(database: import('node:sqlite').DatabaseSync) => (entry: JournalEntry, state: ModuleState) => void} createProcessor
 * @property {(database: import('node:sqlite').DatabaseSync) => import('express').Router} createRouter
 */

/**
 * Declares a stat module. Adding a new stat is a matter of writing one of these
 * and listing it in src/stats/index.mjs.
 * @param {Partial<StatModule> & Pick<StatModule, 'name' | 'events' | 'schemaSql' | 'createProcessor' | 'createRouter'>} moduleDefinition
 * @returns {StatModule}
 */
export function defineStatModule(moduleDefinition) {
  return {
    title: moduleDefinition.name,
    description: '',
    version: 1,
    dependsOn: [],
    ownedObjects: [],
    ...moduleDefinition,
  };
}
