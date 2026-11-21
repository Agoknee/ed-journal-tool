import { logger } from './logger.mjs';

/**
 * The BGS "tick" is when the game applies everyone's background simulation activity, roughly once a
 * day. Journals don't record it, so this polls the same community tick source BGS-Tally uses and
 * saves every tick it sees. BGS activity is grouped by the periods between saved ticks. Nothing is
 * sent besides the request itself.
 */
const TICK_URL = 'http://tick.infomancer.uk/galtick.json';
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

/** "2026-11-20T16:52:46.000Z" -> "2026-11-20T16:52:46Z", the journals' timestamp format. */
function toJournalTimestamp(isoTimestamp) {
  return new Date(isoTimestamp).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class TickMonitor {
  /** @param {{ database: import('node:sqlite').DatabaseSync, eventHub: import('./events/event-hub.mjs').EventHub }} options */
  constructor({ database, eventHub }) {
    this.eventHub = eventHub;
    this.timer = null;
    this.insertTick = database.prepare('INSERT OR IGNORE INTO bgs_ticks (tick_time, first_seen_at) VALUES (?, ?)');
  }

  start() {
    this.check();
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Never throws; a failed check just waits for the next one. */
  async check() {
    try {
      const response = await fetch(TICK_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const { lastGalaxyTick } = await response.json();
      if (typeof lastGalaxyTick !== 'string' || Number.isNaN(Date.parse(lastGalaxyTick))) throw new Error('unexpected response');

      const tickTime = toJournalTimestamp(lastGalaxyTick);
      const { changes } = this.insertTick.run(tickTime, new Date().toISOString());
      if (changes > 0) {
        logger.info(`New BGS tick: ${tickTime}`);
        this.eventHub.publish('ticks', { tickTime });
      }
    } catch (error) {
      logger.debug(`Could not check the BGS tick: ${error.message}`);
    }
  }
}
