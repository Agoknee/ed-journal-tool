import { Router } from 'express';

const KEEP_ALIVE_INTERVAL_MS = 25 * 1000;

/**
 * Server-sent events stream so the dashboard can refresh when journals or stats change.
 * @param {import('../../events/event-hub.mjs').EventHub} eventHub
 */
export function createEventRoutes(eventHub) {
  const router = Router();

  // GET /api/events (text/event-stream)
  router.get('/', (request, response) => {
    response.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    response.flushHeaders();
    response.write('retry: 3000\n\n');

    const sendUpdate = (update) => {
      response.write(`event: ${update.topic}\ndata: ${JSON.stringify(update)}\n\n`);
    };
    const keepAliveTimer = setInterval(() => response.write(': keep-alive\n\n'), KEEP_ALIVE_INTERVAL_MS);

    eventHub.on('update', sendUpdate);
    request.on('close', () => {
      clearInterval(keepAliveTimer);
      eventHub.off('update', sendUpdate);
    });
  });

  return router;
}
