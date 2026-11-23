/**
 * Test fixture: writes journal files to a temporary folder, ingests them with the real
 * JournalIngester, builds stats with the real StatsEngine and serves the stat module routers, so
 * tests describe behaviour from journal lines to API responses.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDatabase } from '../../src/database/database.mjs';
import { JournalIngester } from '../../src/journals/journal-ingester.mjs';
import { statModules } from '../../src/stats/index.mjs';
import { StatsEngine } from '../../src/stats/stats-engine.mjs';

const SETTLED_AGE_MS = 60 * 60 * 1000;

/** A journal event with a timestamp (ISO, seconds precision). */
export function event(name, fields = {}, timestamp = '2026-01-01T00:00:00Z') {
  return { timestamp, event: name, ...fields };
}

/** Events a game session starts with: Fileheader, Commander and LoadGame. */
export function sessionStart({ commander = 'TESTER', fid = 'F1', gameVersion = '4.2.0.0', credits = 1000, ship = 'sidewinder', shipId = 1, at = '2026-01-01T00:00:00Z' } = {}) {
  return [
    event('Fileheader', { part: 1, Odyssey: true, gameversion: gameVersion, build: 'r1' }, at),
    event('Commander', { FID: fid, Name: commander }, at),
    event('LoadGame', { FID: fid, Commander: commander, Ship: ship, ShipID: shipId, Credits: credits, GameMode: 'Solo' }, at),
  ];
}

export async function createFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'edjt-test-'));
  const journalDirectory = path.join(directory, 'journals');
  mkdirSync(journalDirectory);
  const databasePath = path.join(directory, 'test.db');
  const database = openDatabase(databasePath);
  const ingester = new JournalIngester({ database, journalDirectory });
  const statsEngine = new StatsEngine({ database, statModules, eventHub: { publish() {} } });
  statsEngine.initialize();
  let fileCounter = 0;
  let server = null;

  const fixture = {
    database,
    databasePath,
    statsEngine,
    journalDirectory,
    ingester,

    /** Writes a journal file (current-format name, in order of writing) and returns its name. */
    writeJournal(events, { fileName } = {}) {
      fileCounter += 1;
      const name = fileName ?? `Journal.2026-01-01T${String(fileCounter).padStart(6, '0')}.01.log`;
      const filePath = path.join(journalDirectory, name);
      writeFileSync(filePath, events.map((entry) => JSON.stringify(entry)).join('\r\n') + '\r\n');
      // Old enough to count as finished, so every line is read.
      const settled = new Date(Date.now() - SETTLED_AGE_MS);
      utimesSync(filePath, settled, settled);
      return name;
    },

    /** Ingests every journal file and builds the stats. */
    async build() {
      for (const fileName of await ingester.listJournalFileNames()) await ingester.processFile(fileName);
      await statsEngine.processNewEntries();
    },

    /** GET an API path (e.g. "/api/stats/fleet?commander=1") from the module routers. */
    async get(apiPath) {
      if (!server) {
        const app = express();
        for (const statModule of statModules) app.use(`/api/stats/${statModule.name}`, statModule.createRouter(database));
        await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
      }
      const response = await fetch(`http://127.0.0.1:${server.address().port}${apiPath}`);
      return { status: response.status, body: await response.json() };
    },

    /** The id of a commander by name. */
    commanderId(name = 'TESTER') {
      return database.prepare('SELECT id FROM commanders WHERE name = ?').get(name)?.id;
    },

    async close() {
      if (server) await new Promise((resolve) => server.close(resolve));
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  return fixture;
}
