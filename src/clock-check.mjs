import { logger } from './logger.mjs';

/**
 * Carrier jump and cooldown timers count down to times set by the game server, so they're only
 * accurate if this computer's clock matches it. This compares the local clock with Frontier's
 * server time (at startup, then hourly) and warns if they differ noticeably. Nothing is sent
 * besides the request itself.
 */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const SERVER_TIME_URL = 'https://api.orerve.net/2.0/server/time';
const SAMPLE_COUNT = 3;
const SAMPLE_SPACING_MS = 1100;
const REQUEST_TIMEOUT_MS = 3000;
const WARNING_THRESHOLD_S = 1.5;

/** Measures (local - server) seconds using the sample with the shortest round trip. */
async function measureClockOffset() {
  let bestSample = null;
  for (let sampleIndex = 0; sampleIndex < SAMPLE_COUNT; sampleIndex++) {
    if (sampleIndex > 0) await new Promise((resolve) => setTimeout(resolve, SAMPLE_SPACING_MS));
    const startedAt = Date.now();
    const response = await fetch(SERVER_TIME_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const { unixTimestamp } = await response.json();
    const finishedAt = Date.now();
    if (!Number.isFinite(unixTimestamp)) throw new Error('unexpected response');

    const roundTripMs = finishedAt - startedAt;
    // The server reports whole seconds, so its time is taken as the middle of that second.
    const offsetSeconds = (startedAt + finishedAt) / 2000 - (unixTimestamp + 0.5);
    if (!bestSample || roundTripMs < bestSample.roundTripMs) bestSample = { roundTripMs, offsetSeconds };
  }
  return { ...bestSample, uncertaintySeconds: 0.5 + bestSample.roundTripMs / 2000 };
}

/**
 * Checks the clock at startup and then hourly. The latest result is in `status` and each check
 * publishes a "clock" update so the dashboard can show or clear its warning.
 */
export class ClockMonitor {
  /** @param {{ eventHub: import('./events/event-hub.mjs').EventHub }} options */
  constructor({ eventHub }) {
    this.eventHub = eventHub;
    this.timer = null;
    /** null until the first check; isOff is only true when the offset is clearly beyond measurement error. */
    this.status = null;
  }

  start() {
    this.check();
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Never throws; a failed check keeps the previous result's warning state. */
  async check() {
    try {
      const { offsetSeconds, uncertaintySeconds } = await measureClockOffset();
      const isOff = Math.abs(offsetSeconds) > Math.max(WARNING_THRESHOLD_S, uncertaintySeconds + 0.5);
      this.status = { checkedAt: new Date().toISOString(), offsetSeconds, uncertaintySeconds, isOff };

      const summary = `${offsetSeconds >= 0 ? '+' : ''}${offsetSeconds.toFixed(2)}s, ±${uncertaintySeconds.toFixed(2)}s`;
      if (isOff) {
        const direction = offsetSeconds > 0 ? 'ahead of' : 'behind';
        logger.warn(`This computer's clock is about ${Math.abs(offsetSeconds).toFixed(1)}s ${direction} the game server (${summary}). `
          + 'Carrier jump and cooldown timers will be off by that much; synchronize the system clock to fix it.');
      } else {
        logger.debug(`Clock matches the game server (${summary}).`);
      }
      this.eventHub.publish('clock', this.status);
    } catch (error) {
      logger.debug(`Could not check the clock against the game server: ${error.message}`);
    }
  }
}
