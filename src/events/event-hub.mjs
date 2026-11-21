import { EventEmitter } from 'node:events';

/**
 * Broadcasts application updates (journal changes, stats changes, scan progress, clock checks, notes, BGS ticks)
 * to listeners such as the server-sent events endpoint.
 */
export class EventHub extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }

  /**
   * @param {'journals' | 'stats' | 'scan' | 'clock' | 'notes' | 'ticks'} topic
   * @param {object} payload
   */
  publish(topic, payload = {}) {
    this.emit('update', { topic, payload, timestamp: new Date().toISOString() });
  }
}
